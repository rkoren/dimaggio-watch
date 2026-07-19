// Refresher Lambda: rebuilds the streaks payload and publishes it to S3,
// where the site fetches it directly (no Amplify rebuild needed).
//
// Three modes, selected by the EventBridge rule's input ({"mode": "..."}):
//
//   full  (every few hours) — scan the whole league (~430 MLB API calls),
//         publish the board, and save the complete result to
//         state/full-scan.json as the baseline + watchlist source.
//   quick (every couple minutes) — rescan only the ~40 players with the top
//         streaks from the last full scan, merge over that baseline, publish.
//         Falls back to a full scan if the state is missing or stale, so the
//         pipeline self-heals from an empty bucket.
//   live  (every minute) — if watched players are in live games, poll those
//         games' boxscores every ~18s and republish within seconds of a
//         watched player's completed plate appearance (src/live.mjs).
//         Exits after a single schedule call when nothing is live.
//
// Published objects:
//   streaks.json            — the live payload the site polls
//   history/YYYY-MM-DD.json — daily snapshot (last write of the day wins)
//   state/full-scan.json    — internal baseline (world-readable like the rest
//                             of the bucket; it's all public MLB data)
//
// See infra/template.yaml for the schedules.

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  scanLeague,
  rescanPlayers,
  pickWatchlist,
  mergePlayers,
  buildPayload,
  getLiveContext,
  mlbToday,
  takeApiCallCount,
} from "./src/streaks.mjs";
import { runLiveCycle } from "./src/live.mjs";

const s3 = new S3Client({});
const BUCKET = process.env.DATA_BUCKET;
const STATE_KEY = "state/full-scan.json";
const WATCH_COUNT = Number(process.env.WATCH_COUNT) || 40;
// A baseline older than this forces a full scan (normally refreshed every 3h).
const STATE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

async function readState() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: STATE_KEY }));
    return JSON.parse(await res.Body.transformToString());
  } catch {
    return null; // missing/unreadable -> caller falls back to a full scan
  }
}

function putJSON(key, value, cacheControl) {
  return s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(value, null, 2) + "\n",
      ContentType: "application/json",
      CacheControl: cacheControl,
    })
  );
}

// Survive warm invocations: liveLastSeen so the live loop only reacts to NEW
// plate appearances; liveFinalized so each completed game is reconciled once
// (a cold start re-reconciles today's final games once — harmless).
const liveLastSeen = new Map();
const liveFinalized = new Set();

export async function handler(event = {}) {
  if (!BUCKET) throw new Error("DATA_BUCKET env var is not set");

  const startedAt = Date.now();
  const season = Number(process.env.SEASON) || undefined;
  let mode = ["full", "live"].includes(event.mode) ? event.mode : "quick";

  if (mode === "live") {
    const result = await runLiveCycle({
      getState: readState,
      publish: (payload) => putJSON("streaks.json", payload, "no-cache"),
      watchCount: WATCH_COUNT,
      lastSeen: liveLastSeen,
      finalizedGamePks: liveFinalized,
      log: console.log,
    });
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    const apiCalls = takeApiCallCount();
    console.log(
      `[live] ${result.liveGames} live games, ${result.watched} watched, ` +
        `${result.finalized} reconciled, ${result.publishes} publishes in ${secs}s ` +
        `using ${apiCalls} MLB API calls.`
    );
    return { ok: true, mode, apiCalls, ...result };
  }

  // The player's in-progress game (if any) must not break their streak
  // mid-game; quick/full scans need the same live awareness.
  const liveCtx = await getLiveContext();

  let players;
  let seasonUsed = season || new Date().getUTCFullYear();
  if (mode === "quick") {
    const state = await readState();
    const fresh = state && Date.now() - new Date(state.scannedAt).getTime() < STATE_MAX_AGE_MS;
    if (!fresh) {
      console.log("Baseline missing or stale; falling back to a full scan.");
      mode = "full";
    } else {
      seasonUsed = state.season;
      const watchlist = pickWatchlist(state.players, WATCH_COUNT);
      const rescanned = await rescanPlayers(watchlist, { season: seasonUsed, liveCtx, log: console.log });
      players = mergePlayers(state.players, rescanned);
    }
  }

  if (mode === "full") {
    const scan = await scanLeague({ season, liveCtx, log: console.log });
    players = scan.players;
    seasonUsed = scan.season;
    await putJSON(STATE_KEY, { scannedAt: new Date().toISOString(), season: seasonUsed, players }, "no-cache");
  }

  const payload = buildPayload(players, seasonUsed, liveCtx);

  // no-cache => browsers revalidate with If-None-Match and get a cheap 304
  // from S3 when the data hasn't changed.
  await putJSON("streaks.json", payload, "no-cache");
  // Keyed to the MLB (US Eastern) day, not UTC: night games span UTC
  // midnight, so a UTC key would freeze mid-game provisional stats. The last
  // write of an ET day lands well after every game is final, making each
  // snapshot a reconciled end-of-day record (the seed for the pace chart).
  await putJSON(`history/${mlbToday()}.json`, payload, "public, max-age=3600");

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  const apiCalls = takeApiCallCount();
  const leader = payload.streaks[0];
  console.log(
    `[${mode}] Published ${payload.streaks.length} streaks in ${secs}s using ${apiCalls} MLB API calls.` +
      (leader ? ` Leader: ${leader.name} (${leader.streak} games).` : " No active streaks.")
  );
  return {
    ok: true,
    mode,
    apiCalls,
    generatedAt: payload.generatedAt,
    leader: leader?.name ?? null,
    streaks: payload.streaks.length,
  };
}
