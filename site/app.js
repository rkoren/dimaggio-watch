// DiMaggio Watch — renders the active hitting streaks.
// Data comes from the live S3 URL (published by the refresher Lambda every few
// minutes; see config.js), with the bundled ./data/streaks.json as a fallback.
// The page polls for updates so a long-lived tab stays current.
const RECORD = 56;
// Adaptive refetch cadence: the pipeline republishes within seconds of an
// at-bat while watched players are in live games, so poll fast when the
// payload has live rows and settle down when nothing is happening.
const POLL_LIVE_MS = 15_000;
const POLL_IDLE_MS = 60_000;
const DATA_SOURCES = [window.STREAKS_DATA_URL, "./data/streaks.json"].filter(Boolean);

const $ = (id) => document.getElementById(id);

function fmtDate(iso) {
  if (!iso) return "";
  // iso is "YYYY-MM-DD"; parse as local-naive to avoid TZ drift.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function fmtUpdated(iso) {
  const dt = new Date(iso);
  return dt.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fmtAgo(iso) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return fmtUpdated(iso);
}

function verdict(streak) {
  const toTie = RECORD - streak;
  if (streak >= RECORD) return `Has <strong>matched DiMaggio</strong> — history in the making.`;
  if (toTie <= 5) return `Just <strong>${toTie}</strong> away from tying DiMaggio's 56.`;
  if (streak >= 30) return `On the board — <strong>${toTie}</strong> games from the record.`;
  return `<strong>${toTie}</strong> games shy of DiMaggio's 56-game record.`;
}

function renderHero(leader, milestones) {
  $("hero-name").textContent = leader.name;
  $("hero-team").innerHTML =
    `${escapeHtml(leader.teamName)} · streak began ${fmtDate(leader.startDate)}` +
    liveBadge(leader.liveStatus);
  $("hero-num").textContent = leader.streak;
  $("hero-verdict").innerHTML = verdict(leader.streak);

  const pct = Math.min(100, (leader.streak / RECORD) * 100);
  $("track-fill").style.width = pct + "%";

  const marks = $("track-marks");
  marks.innerHTML = "";
  for (const m of milestones) {
    const left = (m.length / RECORD) * 100;
    const el = document.createElement("div");
    el.className = "mark" + (leader.streak >= m.length ? " mark--hit" : "");
    el.style.left = left + "%";
    el.innerHTML = `<span class="mark__label">${m.length}</span>`;
    marks.appendChild(el);
  }
  $("hero").hidden = false;
}

function renderBoard(streaks) {
  const list = $("board-list");
  list.innerHTML = "";
  const max = streaks[0]?.streak || RECORD;

  for (const s of streaks) {
    const li = document.createElement("li");
    li.className = "row";

    const milestone = s.streak >= 20 ? `<span class="tag">${milestoneTag(s.streak)}</span>` : "";
    const live = liveBadge(s.liveStatus);
    const barPct = Math.max(4, (s.streak / Math.max(max, RECORD * 0.4)) * 100);

    li.innerHTML = `
      <div class="row__rank">${s.rank}</div>
      <div>
        <div class="row__name">${escapeHtml(s.name)}${milestone}${live}</div>
        <div class="row__meta">${escapeHtml(s.teamName)} · since ${fmtDate(s.startDate)} · last game ${fmtDate(s.lastGameDate)}</div>
      </div>
      <div class="row__streak">${s.streak}<span>GAMES</span></div>
      <div class="row__bar"><i style="width:${Math.min(100, barPct)}%"></i></div>
    `;
    list.appendChild(li);
  }
  $("board").hidden = false;
}

// Badge for a player currently in a live game. "hitToday" means the shown
// streak count already includes a hit from the in-progress game; "inJeopardy"
// means they're hitless with at least one at-bat so far.
function liveBadge(liveStatus) {
  if (liveStatus === "hitToday")
    return `<span class="tag tag--live"><i class="live-dot"></i>live · hit today</span>`;
  if (liveStatus === "inJeopardy")
    return `<span class="tag tag--live tag--jeopardy"><i class="live-dot"></i>live · hitless so far</span>`;
  return "";
}

function milestoneTag(streak) {
  if (streak >= RECORD) return "Tied DiMaggio";
  if (streak >= 44) return "Past 44";
  if (streak >= 40) return "40+";
  if (streak >= 30) return "30+";
  return "20+";
}

function renderRecordMilestones(milestones) {
  const labels = milestones.map((m) => m.label).join(" · ");
  $("record-milestones").textContent = `Milestones on the way: ${labels}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Try the live URL first, then the bundled fallback copy.
async function loadData() {
  let lastErr;
  for (const url of DATA_SOURCES) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

let lastGeneratedAt = null;

function renderUpdatedLine(data) {
  if (!data.generatedAt) {
    $("updated").textContent = "";
    return;
  }
  $("updated").textContent =
    `Updated ${fmtAgo(data.generatedAt)} · ${data.season} season`;
  $("updated").title = fmtUpdated(data.generatedAt);
}

function render(data) {
  $("loading").hidden = true;
  $("error").hidden = true;
  renderRecordMilestones(data.milestones || []);
  renderUpdatedLine(data);

  const hasStreaks = data.streaks && data.streaks.length > 0;
  $("empty").hidden = hasStreaks;
  if (!hasStreaks) {
    $("hero").hidden = true;
    $("board").hidden = true;
    return;
  }

  renderHero(data.streaks[0], data.milestones || []);
  renderBoard(data.streaks);
}

let latestData = null;

async function refresh({ firstLoad = false } = {}) {
  try {
    const data = await loadData();
    latestData = data;
    // Re-render only when the payload actually changed.
    if (data.generatedAt !== lastGeneratedAt) {
      lastGeneratedAt = data.generatedAt;
      render(data);
    }
  } catch (err) {
    console.error(err);
    if (firstLoad) {
      $("loading").hidden = true;
      $("error").hidden = false;
    }
    // On a background poll failure, keep showing the last good data.
  }
}

function nextPollDelay() {
  const anyLive = latestData?.streaks?.some((s) => s.liveStatus);
  return anyLive ? POLL_LIVE_MS : POLL_IDLE_MS;
}

// Poll only while the tab is visible: background tabs stop entirely, and
// coming back refetches immediately so the board is never stale on return.
let pollTimer = null;

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLoop, nextPollDelay());
}

async function pollLoop() {
  if (document.hidden) return; // resumed by visibilitychange
  await refresh();
  schedulePoll();
}

document.addEventListener("visibilitychange", async () => {
  clearTimeout(pollTimer);
  if (!document.hidden) {
    await refresh();
    schedulePoll();
  }
});

async function main() {
  await refresh({ firstLoad: true });
  schedulePoll();
  // Keep the relative "updated Xm ago" line ticking between polls.
  setInterval(() => {
    if (latestData) renderUpdatedLine(latestData);
  }, 30_000);
}

main();
