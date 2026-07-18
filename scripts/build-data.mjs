// Builds site/data/streaks.json locally: the longest *active* hitting streaks
// in MLB. The heavy lifting lives in src/streaks.mjs (shared with the
// refresher Lambda); this wrapper just writes the payload to disk for local
// dev and as the site's bundled fallback copy.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStreaksPayload } from "../src/streaks.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_FILE = join(ROOT, "site", "data", "streaks.json");

const SEASON = Number(process.env.SEASON) || undefined;

async function main() {
  const startedAt = Date.now();
  console.log(`Building hitting-streak data...`);

  const payload = await buildStreaksPayload({ season: SEASON, log: console.log });

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  const leader = payload.streaks[0];
  console.log(
    `Wrote ${payload.streaks.length} streaks to ${OUT_FILE} in ${secs}s.` +
      (leader ? ` Leader: ${leader.name} (${leader.streak} games).` : " No active streaks found.")
  );
}

main().catch((err) => {
  console.error("Failed to build streak data:", err);
  process.exit(1); // fail loudly rather than ship stale data
});
