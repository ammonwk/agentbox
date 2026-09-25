/** Board order: what needs you first.
 *
 * One function so the board, the rail badge and the master session cannot
 * disagree about what is urgent.
 */

import type { Attention, Session } from "./types";

const RANK = { blocked: 0, waiting: 1, running: 2, stopped: 3, archived: 4 } as const;

export function attentionOf(s: Session, blockedReason: string | null = null): Attention {
  switch (s.status) {
    case "blocked":
      return { kind: "blocked", rank: RANK.blocked, reason: blockedReason ?? "waiting on a prompt" };
    case "waiting":
      return {
        kind: "waiting",
        rank: RANK.waiting,
        reason: s.host === "external" ? "your turn (in another terminal)" : "your turn",
      };
    case "running":
      return { kind: "running", rank: RANK.running, reason: "working" };
    case "stopped":
      return { kind: "stopped", rank: RANK.stopped, reason: "not running — resume to continue" };
    case "archived":
      return { kind: "archived", rank: RANK.archived, reason: "archived" };
  }
}

/** Most urgent first; within a rank, the one you last sent something to
 *  first — not the one whose agent last moved, which reshuffles on its own. */
export function byAttention<T extends Session & { attention: Attention }>(a: T, b: T): number {
  return a.attention.rank - b.attention.rank || b.lastPromptAt - a.lastPromptAt;
}
