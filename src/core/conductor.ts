import type { ConductorItem, PrInfo, Session } from "./types";

/**
 * What needs you right now. The whole point of the Conductor page: one list of
 * the things that are stuck, finished, or waiting on your judgement — sorted so
 * the thing that costs you the most sits on top.
 */
export function buildConductor(sessions: Session[], prs: PrInfo[]): ConductorItem[] {
  const items: ConductorItem[] = [];

  for (const s of sessions) {
    if (s.status === "failed") {
      items.push({
        kind: "failed",
        sessionId: s.id,
        title: s.title,
        detail: `Failed on ${s.repo}${s.exitCode !== null ? ` (exit ${s.exitCode})` : ""}`,
        urgency: 0,
        updatedAt: s.updatedAt,
      });
    } else if (s.status === "dead") {
      items.push({
        kind: "failed",
        sessionId: s.id,
        title: s.title,
        detail: "Session died mid-run — restart it",
        urgency: 1,
        updatedAt: s.updatedAt,
      });
    } else if (s.status === "done" && s.prNumber) {
      items.push({
        kind: "review",
        sessionId: s.id,
        title: s.title,
        detail: `PR #${s.prNumber} is open — review and merge`,
        urgency: 2,
        updatedAt: s.updatedAt,
      });
    } else if (s.status === "waiting" && s.blocked) {
      items.push({
        kind: "review",
        sessionId: s.id,
        title: s.title,
        detail: "Waiting on your approval",
        urgency: 2,
        updatedAt: s.updatedAt,
      });
    }
  }

  for (const p of prs) {
    const hasSession = sessions.some((s) => s.prNumber === p.number && s.repo === p.repo);
    if (hasSession) continue; // already surfaced via the session above
    items.push({
      kind: "pr",
      sessionId: null,
      title: p.title,
      detail: `${p.repo}#${p.number}${p.isDraft ? " (draft)" : ""} — ${p.author}`,
      urgency: p.isDraft ? 4 : 3,
      updatedAt: new Date(p.updatedAt).getTime(),
    });
  }

  items.sort((a, b) => a.urgency - b.urgency || b.updatedAt - a.updatedAt);
  return items;
}
