// Live-game event detection (Backlog Phase 3): while watched players are in
// live games, poll those games' boxscores every ~18s; when a watched player's
// batting line changes (a completed plate appearance), refetch just their
// game log, recompute, and republish the board within seconds of the play.
//
// Used by the Lambda's "live" mode (fires every minute; one cycle spans most
// of that minute) and by scripts/live-dryrun.mjs for local proofs.

import {
  getLiveContext,
  getBoxscoreLines,
  rescanPlayers,
  pickWatchlist,
  mergePlayers,
  buildPayload,
} from "./streaks.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One live-watch cycle. Cheap early exits: one schedule call when nothing is
// live. `lastSeen` (playerId -> line) should be persisted by the caller
// across cycles (module scope survives warm Lambda invocations) so only NEW
// plate appearances trigger work; on a cold start the first poll re-syncs
// every live watched player once.
export async function runLiveCycle({
  getState, // async () -> full-scan baseline ({season, players}) or null
  publish, // async (payload) -> void; called after each detected change
  watchCount = 40,
  iterations = 3,
  intervalMs = 18_000,
  lastSeen = new Map(),
  log = () => {},
}) {
  const liveCtx = await getLiveContext();
  if (!liveCtx.liveGames.length) {
    log("No live games right now.");
    return { liveGames: 0, watched: 0, publishes: 0 };
  }

  const state = await getState();
  if (!state) {
    log("No full-scan baseline yet; skipping live cycle.");
    return { liveGames: liveCtx.liveGames.length, watched: 0, publishes: 0 };
  }

  const watchlist = pickWatchlist(state.players, watchCount);
  const watched = watchlist.filter((p) => p.teamId && liveCtx.liveTeamIds.has(p.teamId));
  if (!watched.length) {
    log(`${liveCtx.liveGames.length} live games, but no watched players in them.`);
    return { liveGames: liveCtx.liveGames.length, watched: 0, publishes: 0 };
  }

  const watchedTeamIds = new Set(watched.map((p) => p.teamId));
  const gamePks = liveCtx.liveGames
    .filter((g) => g.teamIds.some((id) => watchedTeamIds.has(id)))
    .map((g) => g.gamePk);
  log(`Watching ${watched.length} players across ${gamePks.length} live games.`);

  let players = state.players;
  let publishes = 0;
  for (let iter = 1; iter <= iterations; iter++) {
    if (iter > 1) await sleep(intervalMs);

    const lines = new Map();
    await Promise.all(
      gamePks.map(async (pk) => {
        for (const [id, line] of await getBoxscoreLines(pk)) lines.set(id, line);
      })
    );

    const changed = watched.filter((p) => {
      const line = lines.get(p.playerId);
      return line && line !== lastSeen.get(p.playerId);
    });
    if (!changed.length) {
      log(`poll ${iter}/${iterations}: no new plate appearances`);
      continue;
    }
    for (const p of changed) lastSeen.set(p.playerId, lines.get(p.playerId));
    log(
      `poll ${iter}/${iterations}: plate appearance -> ` +
        changed.map((p) => `${p.name} (${lines.get(p.playerId)})`).join(", ")
    );

    const fresh = await rescanPlayers(changed, { season: state.season, liveCtx, log });
    players = mergePlayers(players, fresh);
    await publish(buildPayload(players, state.season));
    publishes++;
  }

  return { liveGames: liveCtx.liveGames.length, watched: watched.length, publishes };
}
