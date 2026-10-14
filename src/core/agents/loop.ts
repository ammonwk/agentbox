/**
 * An agent's own schedule: at each time of a recurring rule, an optional
 * check command decides whether to run, and the prompt goes to the agent's
 * current conversation, whichever session that is now. Agentbox owns the loop,
 * so it survives a conversation moving to a new session, a restart, and the
 * agent forgetting to set its next timer.
 *
 * The check runs in the agent's directory: exit 0 runs (what it prints goes
 * before the prompt), exit 1 skips this time, anything else is a failure
 * that skips and is shown. A time that comes while the agent is mid-turn
 * waits for the turn to end; times missed meanwhile fold into that one.
 */
import { z } from "zod";
import { FleetError } from "../fleet";
import { isRecurring, nextRun, parseWhen, type ScheduleRule } from "../schedule";

export type AgentLoop = {
  /** As typed: "every hour", "every weekday at 9am". */
  when: string;
  rule: ScheduleRule;
  check: string | null;
  prompt: string;
  /** The next time, or null when the rule has none. */
  nextAt: number | null;
  /** A time that came and has not run yet: the agent was mid-turn. */
  due?: number | null;
  lastAt?: number | null;
  /** What the last time did, in words. */
  last?: string | null;
};

export const LoopInput = z
  .object({ when: z.string().trim().min(1).max(200), check: z.string().trim().max(4000).nullable().optional(), prompt: z.string().trim().min(1).max(8000) })
  .strict();

/** How long a check may run, and how much of what it prints is said. */
export const CHECK_TIMEOUT_S = 120;
export const CHECK_MAX = 16_000;

export function makeLoop(value: unknown, now: number): AgentLoop {
  const p = LoopInput.parse(value);
  const parsed = parseWhen(p.when, now);
  if ("error" in parsed) throw new FleetError(400, parsed.error);
  const rule = parsed.rule;
  if (!isRecurring(rule) || rule.kind === "red") throw new FleetError(400, "A loop repeats at a time: “every hour”, “every weekday at 9am”");
  return { when: p.when, rule, check: p.check || null, prompt: p.prompt, nextAt: nextRun(rule, now), due: null, lastAt: null, last: null };
}

/** The loop as of `now`: a time that has come becomes `due` (folding any
 *  earlier one still waiting), and `nextAt` moves past `now`. */
export function advance(loop: AgentLoop, now: number): AgentLoop {
  if (loop.nextAt === null || loop.nextAt > now) return loop;
  return { ...loop, due: loop.due ?? loop.nextAt, nextAt: nextRun(loop.rule, now) };
}

/** What the agent is told: the check's output, then the prompt. */
export function loopText(loop: AgentLoop, checkOut: string): string {
  const out = checkOut.trim();
  const said = out.length > CHECK_MAX ? `${out.slice(0, CHECK_MAX)}\n[agentbox: the check's output was cut here.]` : out;
  return [`Your loop (${loop.when})${said ? ". Its check said:" : ":"}`, said, loop.prompt].filter(Boolean).join("\n\n");
}
