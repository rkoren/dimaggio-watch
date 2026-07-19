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
// live or newly final. `lastSeen` (playerId -> line) and `finalizedGamePks`
// should be persisted by the caller across cycles (module scope survives warm
// Lambda invocations): lastSeen so only NEW plate appearances trigger work,
// finalizedGamePks so each completed game is reconciled exactly once.
export async function runLiveCycle({
  getState, // async () -> full-scan baseline ({season, players}) or null
  publish, // async (payload) -> void; called after each detected change
  watchCount = 40,
  iterations = 3,
  intervalMs = 18_000,
  lastSeen = new Map(),
  finalizedGamePks = new Set(),
  log = () => {},
}) {
  const liveCtx = await getLiveContext();
  const newlyFinal = liveCtx.finalGames.filter((g) => !finalizedGamePks.has(g.gamePk));
  if (!liveCtx.liveGames.length && !newlyFinal.length) {
    log("No live games right now.");
    return { liveGames: 0, watched: 0, publishes: 0, finalized: 0 };
  }

  const state = await getState();
  if (!state) {
    log("No full-scan baseline yet; skipping live cycle.");
    return { liveGames: liveCtx.liveGames.length, watched: 0, publishes: 0, finalized: 0 };
  }

  const watchlist = pickWatchlist(state.players, watchCount);
  let players = state.players;
  let publishes = 0;

  // Reconcile just-completed games: rescan their watched players so the
  // streak outcome (break or extend) is official within a minute of the last
  // out — clearing live badges — instead of waiting for the next quick scan.
  // Marked done per gamePk even when no watched players are involved.
  const finalTeamIds = new Set(newlyFinal.flatMap((g) => g.teamIds));
  const toFinalize = watchlist.filter((p) => p.teamId && finalTeamIds.has(p.teamId));
  for (const g of newlyFinal) finalizedGamePks.add(g.gamePk);
  if (toFinalize.length) {
    log(`Reconciling ${toFinalize.length} watched player(s) whose game went final...`);
    const fresh = await rescanPlayers(toFinalize, { season: state.season, liveCtx, log });
    players = mergePlayers(players, fresh);
    await publish(buildPayload(players, state.season, liveCtx));
    publishes++;
    for (const p of toFinalize) lastSeen.delete(p.playerId); // done until their next game
  }

  const watched = watchlist.filter((p) => p.teamId && liveCtx.liveTeamIds.has(p.teamId));
  if (!watched.length) {
    log(`${liveCtx.liveGames.length} live games, but no watched players in them.`);
    return { liveGames: liveCtx.liveGames.length, watched: 0, publishes, finalized: toFinalize.length };
  }

  const watchedTeamIds = new Set(watched.map((p) => p.teamId));
  const gamePks = liveCtx.liveGames
    .filter((g) => g.teamIds.some((id) => watchedTeamIds.has(id)))
    .map((g) => g.gamePk);
  log(`Watching ${watched.length} players across ${gamePks.length} live games.`);

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
    await publish(buildPayload(players, state.season, liveCtx));
    publishes++;
  }

  return {
    liveGames: liveCtx.liveGames.length,
    watched: watched.length,
    publishes,
    finalized: toFinalize.length,
  };
}
