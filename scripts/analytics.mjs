// Lightweight visitor analytics from S3 server access logs — no client-side
// tracking, no cookies, no third parties. Every visitor polls streaks.json
// straight from the data bucket, so the bucket's access logs double as a
// visitor log.
//
//   node scripts/analytics.mjs [days]     (default: last 7)
//
// Requires the AWS CLI with account credentials (same as infra/deploy.sh).
// Notes: S3 delivers access logs best-effort, usually within a few hours, so
// "today" is always incomplete. Polling cadence is 60s idle / 15s live, so
// requests ≈ visitor-minutes; unique IPs per day ≈ distinct visitors.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const days = Math.max(1, Number(process.argv[2]) || 7);
const ACCOUNT = execFileSync("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"])
  .toString()
  .trim();
const LOGS_URI = `s3://dimaggio-watch-logs-${ACCOUNT}/s3-access/`;
const CACHE = join(tmpdir(), "dimaggio-watch-access-logs");

mkdirSync(CACHE, { recursive: true });
console.log(`Syncing access logs from ${LOGS_URI} (best-effort delivery; recent hours lag)...`);
execFileSync("aws", ["s3", "sync", "--quiet", LOGS_URI, CACHE]);

// S3 access log fields are space-separated, but [timestamps] and "quoted
// strings" contain spaces; tokenize accordingly.
function tokenize(line) {
  const tokens = [];
  const re = /\[([^\]]*)\]|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

const since = new Date(Date.now() - days * 86_400_000);
const perDay = new Map(); // date -> {gets, ips:Set, uas:Map}

for (const file of readdirSync(CACHE)) {
  for (const line of readFileSync(join(CACHE, file), "utf8").split("\n")) {
    if (!line) continue;
    const t = tokenize(line);
    // [2]=time "18/Jul/2026:23:59:59 +0000", [3]=remote IP, [4]=requester,
    // [6]=operation, [7]=key, [16]=user agent
    const [, , time, ip, requester, , op, key] = t;
    const ua = t[16] ?? "-";
    if (op !== "REST.GET.OBJECT" || key !== "streaks.json") continue;
    if (requester !== "-") continue; // authenticated = our own Lambda/CLI, not a visitor
    const [d, mon, rest] = time.split("/");
    const date = new Date(`${d} ${mon} ${rest.split(":")[0]}`);
    if (isNaN(date) || date < since) continue;
    const dayKey = date.toISOString().slice(0, 10);
    if (!perDay.has(dayKey)) perDay.set(dayKey, { gets: 0, ips: new Set(), uas: new Map() });
    const day = perDay.get(dayKey);
    day.gets++;
    day.ips.add(ip);
    day.uas.set(ua, (day.uas.get(ua) ?? 0) + 1);
  }
}

if (!perDay.size) {
  console.log(`No visitor requests logged in the last ${days} day(s) yet.`);
  console.log("(Log delivery lags a few hours; if logging was just enabled, check back tomorrow.)");
  process.exit(0);
}

console.log(`\nVisitors to streaks.json, last ${days} day(s):\n`);
console.log("date         requests  unique IPs  ~visitor-minutes");
for (const [dayKey, d] of [...perDay.entries()].sort()) {
  console.log(
    `${dayKey}   ${String(d.gets).padStart(8)}  ${String(d.ips.size).padStart(10)}  ${String(d.gets).padStart(16)}`
  );
}

const uas = new Map();
for (const d of perDay.values()) for (const [ua, n] of d.uas) uas.set(ua, (uas.get(ua) ?? 0) + n);
console.log("\nTop user agents:");
for (const [ua, n] of [...uas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
  console.log(`  ${String(n).padStart(6)}  ${ua.slice(0, 90)}`);
}
