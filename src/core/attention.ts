/** Board order: what needs you first.
 *
 * One function so the board, the rail badge and the master session cannot
 * disagree about what is urgent.
 */

import type { Attention, Session } from "./types";

const RANK = { blocked: 0, waiting: 1, running: 2, stopped: 3, closed: 4 } as const;

export function attentionOf(s: Session, blockedReason: string | null = null): Attention {
  // Not yours: it ranks and reads with the working sessions, saying why.
  if (retrying(s)) {
    const reason =
      s.status === "blocked" || !s.turnError
        ? (blockedReason ?? `stopped on an error; agentbox retries it ${retryClock(s.autoResume!.at)}`)
        : `${turnErrorReason(s.turnError, s.host === "external")}; agentbox retries it ${retryClock(s.autoResume!.at)}`;
    return { kind: "running", rank: RANK.running, reason };
  }
  switch (s.status) {
    case "blocked":
      return { kind: "blocked", rank: RANK.blocked, reason: blockedReason ?? "waiting on a prompt" };
    case "waiting":
      return {
        kind: "waiting",
        rank: RANK.waiting,
        reason:
          s.host === "subagent"
            ? s.subagent?.answerWaiting
              ? "finished; its answer waits for its caller to collect"
              : "idle; its caller's turn"
            : s.turnError
              ? turnErrorReason(s.turnError, s.host === "external")
              : s.host === "external"
                ? "your turn (in another terminal)"
                : "your turn",
      };
    case "running":
      return { kind: "running", rank: RANK.running, reason: "working" };
    case "stopped":
      return { kind: "stopped", rank: RANK.stopped, reason: "not running — resume to continue" };
    case "closed":
      return { kind: "closed", rank: RANK.closed, reason: "closed" };
  }
}

/** Stopped on an error (a turn error or an error screen) that agentbox will
 *  retry by itself (`Session.autoResume`): nothing for you to do, so the
 *  board draws it as working and nothing tells you it is blocked. A 5-hour
 *  reset it waits out is still your turn; so is an error once the retries
 *  are spent. */
export function retrying(s: Pick<Session, "status" | "autoResume">): boolean {
  return s.autoResume?.after === "error" && (s.status === "blocked" || s.status === "waiting");
}

/** Most urgent first; within a rank, the one you last sent something to
 *  first — not the one whose agent last moved, which reshuffles on its own. */
export function byAttention<T extends Session & { attention: Attention }>(a: T, b: T): number {
  return a.attention.rank - b.attention.rank || b.lastPromptAt - a.lastPromptAt;
}

/** Why a turn that ended on the provider needs you, one line. */
function turnErrorReason(e: NonNullable<Session["turnError"]>, elsewhere: boolean): string {
  const at = elsewhere ? " (in another terminal)" : "";
  switch (e.kind) {
    case "output-cap":
      return `its reply was cut off by the output token limit — it waits for a message to continue${at}`;
    case "transient":
      return `stopped on an error: ${oneLine(e.detail, 90)} — a retry may get it going${at}`;
    case "fatal":
      return `stopped on an error a retry cannot fix: ${oneLine(e.detail, 90)}${at}`;
  }
}

/** When the fleet's next try is, for a reason line: "at 1:51 AM", or "shortly"
 *  once that is past and it waits its turn behind other sessions' nudges. */
export function retryClock(at: number, now = Date.now()): string {
  return at <= now ? "shortly" : `at ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function oneLine(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
