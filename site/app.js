// DiMaggio Watch — renders the active hitting streaks from data/streaks.json.
const RECORD = 56;

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

function verdict(streak) {
  const toTie = RECORD - streak;
  if (streak >= RECORD) return `Has <strong>matched DiMaggio</strong> — history in the making.`;
  if (toTie <= 5) return `Just <strong>${toTie}</strong> away from tying DiMaggio's 56.`;
  if (streak >= 30) return `On the board — <strong>${toTie}</strong> games from the record.`;
  return `<strong>${toTie}</strong> games shy of DiMaggio's 56-game record.`;
}

function renderHero(leader, milestones) {
  $("hero-name").textContent = leader.name;
  $("hero-team").textContent = `${leader.teamName} · streak began ${fmtDate(leader.startDate)}`;
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
    const barPct = Math.max(4, (s.streak / Math.max(max, RECORD * 0.4)) * 100);

    li.innerHTML = `
      <div class="row__rank">${s.rank}</div>
      <div>
        <div class="row__name">${escapeHtml(s.name)}${milestone}</div>
        <div class="row__meta">${escapeHtml(s.teamName)} · since ${fmtDate(s.startDate)} · last game ${fmtDate(s.lastGameDate)}</div>
      </div>
      <div class="row__streak">${s.streak}<span>GAMES</span></div>
      <div class="row__bar"><i style="width:${Math.min(100, barPct)}%"></i></div>
    `;
    list.appendChild(li);
  }
  $("board").hidden = false;
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

async function main() {
  try {
    const res = await fetch("./data/streaks.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    $("loading").hidden = true;
    renderRecordMilestones(data.milestones || []);
    $("updated").textContent = data.generatedAt
      ? `Updated ${fmtUpdated(data.generatedAt)} · ${data.season} season`
      : "";

    if (!data.streaks || data.streaks.length === 0) {
      $("empty").hidden = false;
      return;
    }

    renderHero(data.streaks[0], data.milestones || []);
    renderBoard(data.streaks);
  } catch (err) {
    console.error(err);
    $("loading").hidden = true;
    $("error").hidden = false;
  }
}

main();
