// Milestone alert logic (pure; SNS/S3 wiring lives in lambda/handler.mjs).
//
// A player earns one alert per milestone per streak: crossing 20 fires once,
// then nothing until 30, and a broken streak resets so a future run alerts
// again. Dedup state (state/milestones.json) maps playerId -> the highest
// milestone already announced for the streak identified by startDate; players
// below the first threshold drop out of the state, which is what resets them.

import { MILESTONES } from "./streaks.mjs";

const THRESHOLDS = MILESTONES.map((m) => m.length); // [20, 30, 40, 44, 56]

// -> { alerts: [{player, milestone}], nextState }
export function computeMilestoneAlerts(streaks, prevState = {}) {
  const alerts = [];
  const nextState = {};

  for (const player of streaks) {
    const reached = THRESHOLDS.filter((t) => t <= player.streak).at(-1);
    if (!reached) continue;

    const prev = prevState[player.playerId];
    const sameStreak = prev && prev.startDate === player.startDate;
    const alreadyAnnounced = sameStreak ? prev.milestone : 0;
    if (reached > alreadyAnnounced) alerts.push({ player, milestone: reached });

    nextState[player.playerId] = {
      milestone: Math.max(reached, alreadyAnnounced),
      startDate: player.startDate,
    };
  }

  return { alerts, nextState };
}

export function formatMilestoneAlert({ player, milestone }) {
  const label = MILESTONES.find((m) => m.length === milestone)?.label ?? `${milestone} games`;
  const liveNote =
    player.liveStatus === "hitToday"
      ? "\n(Includes a hit from a game still in progress — provisional until final.)"
      : "";
  return {
    subject: `DiMaggio Watch: ${player.name} reaches ${milestone} games`,
    message:
      `${player.name} (${player.teamName}) has hit in ${player.streak} straight games,\n` +
      `reaching the milestone: ${label}.\n\n` +
      `Streak began ${player.startDate}. ${player.gamesToRecord} more games to tie DiMaggio's 56.` +
      liveNote +
      `\n\nhttps://dimaggiowatch.com`,
  };
}
