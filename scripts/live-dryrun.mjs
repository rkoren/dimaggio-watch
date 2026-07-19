// Local proof of the Phase-3 live watcher — no AWS, no publishing.
//
//   node scripts/live-dryrun.mjs [minutes]
//
// Builds a fresh full-scan baseline (~430 MLB API calls, ~1-2 min), then runs
// live cycles against tonight's in-progress games, printing each detected
// plate appearance and what the published board's top would look like,
// instead of writing to S3. Run it while games are on TV and compare.

import { scanLeague, getLiveContext, takeApiCallCount } from "../src/streaks.mjs";
import { runLiveCycle } from "../src/live.mjs";

const minutes = Math.max(1, Number(process.argv[2]) || 3);
const log = (msg) => console.log(`  ${msg}`);

console.log("Building local full-scan baseline (~1-2 min)...");
const liveCtx = await getLiveContext();
const scan = await scanLeague({ liveCtx, log });
console.log(`Baseline ready: ${scan.players.length} players, ${takeApiCallCount()} API calls.\n`);

const lastSeen = new Map();
const deadline = Date.now() + minutes * 60_000;
let cycle = 0;

while (Date.now() < deadline) {
  console.log(`--- live cycle ${++cycle} (${new Date().toLocaleTimeString()}) ---`);
  const result = await runLiveCycle({
    getState: async () => ({ season: scan.season, players: scan.players }),
    publish: async (payload) => {
      const top = payload.streaks.slice(0, 5);
      console.log("  WOULD PUBLISH — top of board:");
      for (const s of top) {
        const live = s.liveStatus ? `  [${s.liveStatus}]` : "";
        console.log(`    ${s.rank}. ${s.name} (${s.team}) — ${s.streak}${live}`);
      }
    },
    lastSeen,
    log,
  });
  console.log(
    `  cycle summary: ${result.liveGames} live games, ${result.watched} watched, ` +
      `${result.publishes} would-be publishes, ${takeApiCallCount()} API calls\n`
  );
  if (!result.liveGames) break; // nothing on; no point looping
}
console.log("Dry run complete.");
