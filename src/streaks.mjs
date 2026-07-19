// Shared streak-building logic, used by both the local CLI
// (scripts/build-data.mjs) and the refresher Lambda (lambda/handler.mjs).
//
// The official MLB /streaks endpoint sits behind authentication, so we compute
// streaks ourselves from public, unauthenticated endpoints:
//   1. Every team's active roster (position players only).
//   2. Each player's regular-season hitting game log.
//   3. Walk each game log backward to find the current hitting streak.
//
// Hitting-streak rule (official scoring): a streak extends on any game with a
// hit, breaks on a game with >=1 at-bat and no hit, and is unaffected by games
// with zero official at-bats (e.g. all walks / sac bunts / HBP). The one known
// gap is a sac-fly-only game with no hit, which officially ends a streak but
// has AB=0 here; this is rare and noted on the site.

const API = "https://statsapi.mlb.com/api/v1";
const SPORT_ID = 1; // MLB
const CONCURRENCY = 8;
const TOP_N = 25; // how many streaks to publish
const MIN_STREAK = 1; // only publish streaks of at least this many games

// How many MLB API requests the current scan has made (see takeApiCallCount).
let apiCalls = 0;

export const DIMAGGIO = { holder: "Joe DiMaggio", length: 56, year: 1941, team: "New York Yankees" };
// Milestones along the way to 56. Each is a meaningful marker in streak lore.
export const MILESTONES = [
  { length: 20, label: "20 games" },
  { length: 30, label: "30 games" },
  { length: 40, label: "40 games" },
  { length: 44, label: "44 — modern NL record (Pete Rose, 1978)" },
  { length: 56, label: "56 — DiMaggio's record" },
];

// --- tiny fetch helper with retry on 5xx / network errors --------------------
async function getJSON(url, attempt = 1) {
  if (attempt === 1) apiCalls++;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(300 * attempt);
    return getJSON(url, attempt + 1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run async fn over items with a fixed concurrency cap.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- data fetching -----------------------------------------------------------
async function getTeams(season) {
  const data = await getJSON(`${API}/teams?sportId=${SPORT_ID}&season=${season}`);
  return data.teams.map((t) => ({
    id: t.id,
    name: t.teamName, // "Yankees"
    fullName: t.name, // "New York Yankees"
    abbreviation: t.abbreviation, // "NYY"
  }));
}

async function getHitters(team) {
  const data = await getJSON(`${API}/teams/${team.id}/roster?rosterType=active`);
  return (data.roster || [])
    .filter((p) => p.position?.abbreviation !== "P") // skip pure pitchers
    .map((p) => ({
      id: p.person.id,
      name: p.person.fullName,
      team,
    }));
}

async function getGameLog(playerId, season) {
  const url =
    `${API}/people/${playerId}/stats` +
    `?stats=gameLog&group=hitting&season=${season}&sportId=${SPORT_ID}&gameType=R`;
  const data = await getJSON(url);
  const splits = data?.stats?.[0]?.splits ?? [];
  // Ascending by date already, but sort defensively.
  return splits
    .map((s) => ({
      date: s.date,
      atBats: Number(s.stat?.atBats ?? 0),
      hits: Number(s.stat?.hits ?? 0),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Walk a game log backward to compute the current active hitting streak.
function computeStreak(games) {
  let streak = 0;
  let startDate = null;
  let lastHitDate = null;
  const lastGameDate = games.length ? games[games.length - 1].date : null;

  for (let i = games.length - 1; i >= 0; i--) {
    const g = games[i];
    if (g.hits >= 1) {
      streak++;
      startDate = g.date;
      if (!lastHitDate) lastHitDate = g.date;
    } else if (g.atBats >= 1) {
      break; // hitless game with an official at-bat ends the streak
    }
    // atBats === 0 && hits === 0  -> game does not affect the streak
  }

  return { streak, startDate, lastHitDate, lastGameDate };
}

function nextMilestone(streak) {
  return MILESTONES.find((m) => m.length > streak) ?? null;
}

// Returns the number of MLB API calls made since the last take, and resets
// the counter. Call once per scan for logging/cost visibility.
export function takeApiCallCount() {
  const n = apiCalls;
  apiCalls = 0;
  return n;
}

async function computePlayerRecord({ playerId, name, team, teamName }, season) {
  const games = await getGameLog(playerId, season);
  const { streak, startDate, lastHitDate, lastGameDate } = computeStreak(games);
  return { playerId, name, team, teamName, streak, startDate, lastHitDate, lastGameDate };
}

// --- scans -------------------------------------------------------------------
// Full-league scan: every active roster, every position player (~430 API
// calls). Returns computed records for ALL players, unfiltered, so the result
// can serve as the baseline the quick scan merges over.
export async function scanLeague({ season, log = () => {} } = {}) {
  season = season || new Date().getUTCFullYear();

  const teams = await getTeams(season);
  log(`Found ${teams.length} teams.`);

  const rosterLists = await mapLimit(teams, CONCURRENCY, getHitters);
  const hitters = rosterLists.flat();
  log(`Scanning ${hitters.length} position players...`);

  const players = await mapLimit(hitters, CONCURRENCY, (p) =>
    computePlayerRecord(
      { playerId: p.id, name: p.name, team: p.team.abbreviation, teamName: p.team.name },
      season
    )
  );
  return { season, players };
}

// Watchlist scan: refetch only the given players' game logs (one API call
// each). `players` are records from a previous scan.
export async function rescanPlayers(players, { season, log = () => {} } = {}) {
  season = season || new Date().getUTCFullYear();
  log(`Rescanning ${players.length} watched players...`);
  return mapLimit(players, CONCURRENCY, (p) => computePlayerRecord(p, season));
}

// Pick the players worth watching between full scans: the top `count` by
// streak, extended to include ties at the cutoff. Bottom-of-board players
// outside this set may show stale until the next full scan.
export function pickWatchlist(players, count = 40) {
  const ranked = [...players]
    .filter((p) => p.streak >= 1)
    .sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name));
  let end = Math.min(count, ranked.length);
  while (end < ranked.length && ranked[end].streak === ranked[count - 1]?.streak) end++;
  return ranked.slice(0, end);
}

// Overlay freshly-rescanned records onto a baseline full-scan list.
export function mergePlayers(baseline, fresh) {
  const byId = new Map(fresh.map((p) => [p.playerId, p]));
  return baseline.map((p) => byId.get(p.playerId) ?? p);
}

// --- payload -----------------------------------------------------------------
// Builds the published streaks.json payload from computed player records.
export function buildPayload(players, season) {
  const streaks = players
    .filter((p) => p.streak >= MIN_STREAK && p.startDate)
    .sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name))
    .slice(0, TOP_N)
    .map((p, idx) => {
      const next = nextMilestone(p.streak);
      return {
        rank: idx + 1,
        ...p,
        gamesToRecord: Math.max(0, DIMAGGIO.length - p.streak),
        nextMilestone: next ? next.length : null,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    season,
    record: DIMAGGIO,
    milestones: MILESTONES,
    streaks,
  };
}

// Convenience: full scan straight to payload (local CLI path).
export async function buildStreaksPayload({ season, log = () => {} } = {}) {
  const scan = await scanLeague({ season, log });
  return buildPayload(scan.players, scan.season);
}
