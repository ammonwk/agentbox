/** Is this agent all right, and how much of its budget is gone?
 *
 * Everything a reader wants to know about a running agent is derivable from
 * the event stream we already keep — but "derivable" is not the same as
 * "known". A person handed `idleMs: 372000` is doing the machine's job, and a
 * calling model handed the same number spends a turn deciding what it means.
 * So the judgement happens once, here, and every reader shares it: the MCP
 * tools, the status line, and anything that reads an agent's record on disk.
 *
 * Two questions, deliberately separated.
 *
 * `verdict` answers "is something wrong", and it answers in words. The states
 * are the ones that have actually cost time: an agent repeating itself, an
 * agent that has gone silent, an agent about to run out of context or clock.
 *
 * `budget` answers "how much is left", and it refuses to guess. There is no
 * denominator for "how much of this task is done" — a model asked to estimate
 * its own remaining work is not a reliable narrator, and a made-up percentage
 * is worse than none. What an agent does have is three real budgets with hard
 * ceilings: its context window, its wall clock, and money. Consumption against
 * a known ceiling needs no estimation and answers the question a person is
 * actually asking, which is "let it run, or kill it".
 */

import { STOPPED_BY_CALLER, type ToolRecord } from "./types";

/** No observable event at all, while not inside a tool call. The agent is
 *  neither thinking out loud nor running anything. */
const QUIET_MS = 180_000;

/** A single tool call still running. Not wrong — a test suite takes minutes —
 *  but it is the difference between "wedged" and "waiting", and a reader who
 *  cannot tell them apart will eventually kill the wrong one. */
const SLOW_TOOL_MS = 300_000;

/** Running this long having made no tool call at all. The cheapest signal that
 *  an agent is answering from thin air rather than reading anything. */
const SILENT_MS = 120_000;

/** How many recent tool calls the loop detector looks at, and how many
 *  identical ones inside that window it takes to say so. Three is the point at
 *  which a person watching would say "it is doing that again". */
const LOOP_WINDOW = 6;
const LOOP_REPEATS = 3;

/** Context and clock fractions at which the ceiling is close enough to matter.
 *  Below these an agent is simply working. */
const CONTEXT_HIGH = 0.85;
const CLOCK_HIGH = 0.8;

export type Concern = "looping" | "quiet" | "context" | "overrunning" | "slow-tool" | "silent";

/**
 * Worst first. This is the order a reader should be told things in, and it is
 * about consequence rather than certainty: an agent going round in circles is
 * spending money to no end, which is worse than one that is merely close to a
 * ceiling it may never reach.
 */
const SEVERITY: Concern[] = ["looping", "quiet", "context", "overrunning", "slow-tool", "silent"];

/**
 * Concerns worth interrupting a caller for.
 *
 * Deliberately the two unambiguous ones. Ending a blocked call early costs the
 * caller the completion notification it was relying on, so it must be reserved
 * for cases where the honest answer is "this is not working" — not for a long
 * test run, and not for an agent merely two thirds through its context.
 */
const ESCALATES = new Set<Concern>(["looping", "quiet"]);

export interface Finding {
  concern: Concern;
  /** One line, in words, that a person or a model can act on. */
  note: string;
}

export interface Verdict {
  /** The worst thing true right now, or null when the agent is simply working. */
  concern: Concern | null;
  note: string | null;
  /** Everything true, worst first. */
  findings: Finding[];
  /** Whether this is bad enough to end a caller's blocked wait early. */
  escalate: boolean;
}

/**
 * What a reader assembles about one agent.
 *
 * The same shape whether it came from a live `Subagent` in this process or was
 * reconstructed from a finished agent's transcript on disk — which is what
 * makes one judgement serve every reader, including the ones that will never
 * see the object.
 */
export interface AgentSnapshot {
  name: string;
  cwd: string;
  branch: string | null;
  model: string;
  readOnly: boolean;
  state: "running" | "idle" | "dead";
  /** ms since epoch. */
  startedAt: number;
  /** When the turn in flight began; 0 when nothing is running. */
  turnStartedAt: number;
  /** The last observable event of any kind. */
  lastEventAt: number;
  /** What that event was, as a short label. */
  lastAction: string;
  turnToolCalls: number;
  totalToolCalls: number;
  uncollected: number;
  contextUsed: number | null;
  /** The model's window, as omp reported it. Null when it never did. */
  contextSize: number | null;
  costUsd: number | null;
  maxTurnMs: number;
  /** Recent tool calls, oldest first. The loop detector's only input. */
  recent: ToolRecord[];
  /** How long the newest tool call has been running, or null if none is. */
  inFlightToolMs: number | null;
  /** Why the agent is gone, if it is. Distinguishes an agent its caller
   *  finished with from one whose process fell over, which are opposite facts
   *  that both arrive here as `dead`. */
  endedReason?: string | null;
  /** The prose of the turn in flight, if the reader captured any. */
  partial?: string;
}

export interface Budget {
  contextUsed: number | null;
  contextSize: number | null;
  /** 0-1, or null when the window is unknown. */
  contextFraction: number | null;
  turnMs: number;
  maxTurnMs: number;
  clockFraction: number;
  costUsd: number | null;
  /** Tool calls per minute this turn, or null before there is enough turn to
   *  divide by. Distinguishes converging from thrashing. */
  toolsPerMinute: number | null;
}

export function budget(s: AgentSnapshot, now = Date.now()): Budget {
  const turnMs = s.turnStartedAt ? Math.max(0, now - s.turnStartedAt) : 0;
  const minutes = turnMs / 60_000;
  return {
    contextUsed: s.contextUsed,
    contextSize: s.contextSize,
    contextFraction:
      s.contextUsed !== null && s.contextSize !== null && s.contextSize > 0
        ? s.contextUsed / s.contextSize
        : null,
    turnMs,
    maxTurnMs: s.maxTurnMs,
    clockFraction: s.maxTurnMs > 0 ? turnMs / s.maxTurnMs : 0,
    costUsd: s.costUsd,
    toolsPerMinute: minutes >= 0.5 ? s.turnToolCalls / minutes : null,
  };
}

function thousands(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 6) / 10}h`;
}

/**
 * The budget line: consumption against ceilings, with no estimate anywhere in
 * it.
 *
 * Context leads because it is the only one of the three that can spoil a turn
 * without warning, and the one a caller can do something about by narrowing
 * the task.
 */
export function renderBudget(b: Budget): string {
  const parts: string[] = [];
  if (b.contextUsed !== null) {
    const pct = b.contextFraction === null ? "" : ` (${Math.round(b.contextFraction * 100)}%)`;
    const of = b.contextSize === null ? "" : `/${thousands(b.contextSize)}`;
    parts.push(`ctx ${thousands(b.contextUsed)}${of}${pct}`);
  }
  parts.push(`${duration(b.turnMs)} of ${duration(b.maxTurnMs)}`);
  if (b.costUsd !== null) parts.push(`$${b.costUsd.toFixed(2)}`);
  if (b.toolsPerMinute !== null) parts.push(`${b.toolsPerMinute.toFixed(1)} tools/min`);
  return parts.join(" - ");
}

/** What makes two tool calls "the same one again". Kind and title alone would
 *  call every file read a repeat; the input is what separates re-reading one
 *  file from working through a directory. */
function signature(t: ToolRecord): string {
  return `${t.kind} ${t.title} ${t.input ?? ""}`;
}

function repeated(recent: ToolRecord[]): ToolRecord | null {
  const window = recent.slice(-LOOP_WINDOW);
  const counts = new Map<string, { n: number; rec: ToolRecord }>();
  for (const t of window) {
    const key = signature(t);
    const hit = counts.get(key);
    if (hit) hit.n++;
    else counts.set(key, { n: 1, rec: t });
  }
  for (const { n, rec } of counts.values()) if (n >= LOOP_REPEATS) return rec;
  return null;
}

/**
 * What is wrong with this agent, if anything.
 *
 * Only a running agent can be in trouble: an idle one is finished, and a dead
 * one has its own, louder, reporting. Every branch produces a sentence rather
 * than a number, because the sentence is the part that is actually usable.
 */
export function verdict(s: AgentSnapshot, now = Date.now()): Verdict {
  const findings: Finding[] = [];
  if (s.state === "running") {
    const idleMs = s.lastEventAt ? now - s.lastEventAt : 0;
    const b = budget(s, now);

    const loop = repeated(s.recent);
    if (loop !== null) {
      findings.push({
        concern: "looping",
        note:
          `repeating the same call - ${loop.title || loop.kind} ${LOOP_REPEATS}+ times in its ` +
          `last ${LOOP_WINDOW}. It is unlikely to get a different answer; interrupt it and ` +
          `say what to do instead.`,
      });
    }

    // "Quiet" and "waiting on a tool" look identical from a clock alone, and
    // telling them apart is most of the point: one is wedged and the other is
    // running your test suite. The in-flight tool call decides which.
    if (s.inFlightToolMs !== null) {
      if (s.inFlightToolMs > SLOW_TOOL_MS) {
        findings.push({
          concern: "slow-tool",
          note:
            `one call has been running ${duration(s.inFlightToolMs)}: ` +
            `${s.lastAction || "a tool call"}. Working, not stuck - but check it is not a ` +
            `command that will never return.`,
        });
      }
    } else if (idleMs > QUIET_MS) {
      findings.push({
        concern: "quiet",
        note:
          `nothing observable for ${duration(idleMs)} - no tool call, no output. The last ` +
          `thing it did was ${s.lastAction || "start"}.`,
      });
    }

    if (s.turnToolCalls === 0 && b.turnMs > SILENT_MS) {
      findings.push({
        concern: "silent",
        note:
          `${duration(b.turnMs)} in and no tool calls at all. Whatever it reports will come ` +
          `from the model rather than from your repository.`,
      });
    }

    if (b.contextFraction !== null && b.contextFraction > CONTEXT_HIGH) {
      findings.push({
        concern: "context",
        note:
          `${Math.round(b.contextFraction * 100)}% of its context window is gone. It will ` +
          `start losing the beginning of its task; expect a worse answer than it would have ` +
          `given an hour ago.`,
      });
    }

    if (b.clockFraction > CLOCK_HIGH) {
      findings.push({
        concern: "overrunning",
        note:
          `${duration(b.turnMs)} of its ${duration(b.maxTurnMs)} wall clock. When that runs ` +
          `out the turn is interrupted and you get a partial.`,
      });
    }
  }

  findings.sort((a, z) => SEVERITY.indexOf(a.concern) - SEVERITY.indexOf(z.concern));
  const worst = findings[0] ?? null;
  return {
    concern: worst?.concern ?? null,
    note: worst?.note ?? null,
    findings,
    escalate: findings.some((f) => ESCALATES.has(f.concern)),
  };
}

/**
 * The verdict as a single word, for a roster where there is room for one.
 *
 * `dead` is split in two on purpose. Nearly every agent ends up dead, because
 * being finished with is how an agent ends; rendering that the same as a
 * process that fell over would make the loud case invisible inside the
 * ordinary one.
 */
export function healthWord(
  v: Verdict,
  s: Pick<AgentSnapshot, "state" | "endedReason">,
): string {
  if (s.state === "dead") {
    return s.endedReason === STOPPED_BY_CALLER ? "finished" : "died";
  }
  if (s.state === "idle") return "idle";
  return v.concern ?? "working";
}
