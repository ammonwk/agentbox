/** Turning a flat TranscriptEvent stream into what the Activity tab renders.
 *
 * Tool calls are the majority of events. Rendered one-per-block they bury the
 * assistant prose and the supervisor verdicts that a human is actually
 * scanning for, so consecutive tool events are gathered into a run and long
 * runs are collapsed in the middle. Errors are never collapsed: a hidden
 * failure defeats the entire point of this screen.
 */

import type { Session, SubagentProgress, ToolCall, TranscriptEvent } from "../../../../src/core/types";
import { isProviderError } from "../../../../src/core/provider-error";
import { subagentCallOf } from "./format";

export interface ToolEntry {
  seq: number;
  ts: number;
  call: ToolCall;
}

export type Row =
  | { kind: "event"; key: string; event: TranscriptEvent }
  | { kind: "toolRun"; key: string; entries: ToolEntry[] }
  | { kind: "prose"; key: string; seq: number; ts: number; text: string };

/**
 * Group the stream into what actually gets rendered: one row per tool call,
 * one row per continuous stretch of assistant prose, everything else as-is.
 *
 * **Tool calls.** ACP sends `tool_call` then `tool_call_update`, and whether
 * the server rewrites the original event or appends a second one at a new
 * `seq` is its business — `ToolCall.id` is documented as stable across a
 * call's updates, so a repeat id is folded onto the first sighting (which
 * holds the start order) carrying the newest payload (which holds the
 * outcome). Without this, an appending server renders every call twice.
 *
 * **Assistant prose.** The engine coalesces streamed deltas on a ~200ms timer,
 * which is right for the socket and cuts at arbitrary byte offsets — observed
 * live splitting the word "committed" across two events. One block per event
 * therefore turns every timer boundary into a paragraph break mid-sentence.
 * Consecutive `assistant` events are concatenated with **no separator**: they
 * are byte-adjacent fragments of one message, so anything inserted between
 * them corrupts the text. Merging here rather than asking the engine to chunk
 * differently keeps the display correct for any chunking, including none.
 */
export function groupEvents(events: TranscriptEvent[]): Row[] {
  const firstSeqOf = new Map<string, number>();
  const latestOf = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type !== "tool") continue;
    const id = event.call.id;
    if (!firstSeqOf.has(id)) firstSeqOf.set(id, event.seq);
    latestOf.set(id, event.call); // events arrive sorted by seq, so last wins
  }

  const rows: Row[] = [];
  let run: ToolEntry[] | null = null;
  // The open prose row, mutated as more deltas arrive. Its key is the FIRST
  // seq, so a growing message keeps its identity across renders and React
  // updates the text in place instead of remounting the block mid-stream.
  let prose: Extract<Row, { kind: "prose" }> | null = null;

  for (const event of events) {
    if (event.type === "tool") {
      // A deduplicated update is not rendered, so it interrupts nothing.
      if (firstSeqOf.get(event.call.id) !== event.seq) continue;
      prose = null;
      const entry = { seq: event.seq, ts: event.ts, call: latestOf.get(event.call.id) ?? event.call };
      if (run) {
        run.push(entry);
      } else {
        run = [entry];
        rows.push({ kind: "toolRun", key: `run-${event.seq}`, entries: run });
      }
      continue;
    }

    if (event.type === "assistant") {
      run = null;
      if (prose) {
        prose.text += event.text;
        prose.ts = event.ts;
      } else {
        prose = { kind: "prose", key: `p-${event.seq}`, seq: event.seq, ts: event.ts, text: event.text };
        rows.push(prose);
      }
      continue;
    }

    run = null;
    prose = null;
    rows.push({ kind: "event", key: `e-${event.seq}`, event });
  }

  return rows;
}

export interface FoldedEntry {
  entry: ToolEntry;
  /** Entries folded away immediately before this one; 0 for a contiguous row. */
  hiddenBefore: number;
}

export interface CollapsedRun {
  /** Entries to render, in stream order. */
  visible: FoldedEntry[];
  /** How many were folded away in total. 0 means nothing is hidden. */
  hiddenCount: number;
}

/**
 * Fold the middle of a long run. Errors always survive the fold, as do the
 * first `head` and last `tail` entries — the start of a run says what the
 * agent set out to do and the end says where it got to.
 *
 * Subagent calls survive the fold too. A dispatch, a wait or a collect is
 * the *structure* of a fan-out run — the handful of rows that say "it sent
 * work to four auditors and is collecting their findings" — and hiding one
 * behind "show 3 more tool calls" is how a ten-minute wait reads as a hung
 * shell command.
 */
export function collapseRun(
  entries: ToolEntry[],
  opts: { head?: number; tail?: number; threshold?: number } = {},
): CollapsedRun {
  const head = opts.head ?? 2;
  const tail = opts.tail ?? 3;
  const threshold = opts.threshold ?? head + tail + 2;

  if (entries.length <= threshold) {
    return { visible: entries.map((entry) => ({ entry, hiddenBefore: 0 })), hiddenCount: 0 };
  }

  const keep = new Set<number>();
  for (let i = 0; i < head; i++) keep.add(i);
  for (let i = entries.length - tail; i < entries.length; i++) keep.add(i);
  entries.forEach((e, i) => {
    if (e.call.status === "error" || subagentCallOf(e.call) !== null) keep.add(i);
  });

  // `hiddenBefore` is carried per row rather than inferred from `seq` gaps:
  // seq is only documented as monotonic, not as incrementing by one.
  const visible: FoldedEntry[] = [];
  let pending = 0;
  let hiddenCount = 0;
  entries.forEach((entry, i) => {
    if (keep.has(i)) {
      visible.push({ entry, hiddenBefore: pending });
      pending = 0;
    } else {
      pending++;
      hiddenCount++;
    }
  });
  return { visible, hiddenCount };
}

/**
 * Why the Activity tab has nothing to show. Four different situations look
 * identical as "zero events", and telling a four-day-old session with a 480KB
 * log that "nothing has happened yet" is the loudest kind of wrong.
 *
 * `missing` is inferred rather than reported: the session carries evidence it
 * produced history (tool calls counted, or a final assistant message) while the
 * event stream is empty. That combination cannot occur on a session that
 * genuinely did nothing.
 *
 * It used to mean "pre-rework log". It does not any more: `EventLog.load()`
 * now appends a real `error` event when a log has content that yields no
 * parseable events, so a legacy transcript announces itself and never reaches
 * this branch. What is left is the case the server stays silent about by
 * design — the log file is absent or unreadable, where it appends nothing
 * rather than create a file for a session someone merely looked at.
 */
export type ActivityEmpty =
  | { kind: "disconnected" }
  | { kind: "missing"; toolCalls: number; hasMessage: boolean }
  | { kind: "starting" }
  | { kind: "silent" };

export function activityEmptyReason(
  session: Pick<Session, "status" | "toolCalls" | "lastMessage">,
  live: boolean,
): ActivityEmpty {
  // Not subscribed: we do not know what this session has, so claim nothing.
  if (!live) return { kind: "disconnected" };

  const hasMessage = session.lastMessage != null && session.lastMessage !== "";
  if (session.toolCalls > 0 || hasMessage) {
    return { kind: "missing", toolCalls: session.toolCalls, hasMessage };
  }

  if (session.status === "spawning" || session.status === "running") {
    return { kind: "starting" };
  }
  return { kind: "silent" };
}

/** Tool-call outcome tallies for a run's header line. */
export function runSummary(entries: ToolEntry[]): { total: number; errors: number; running: number } {
  let errors = 0;
  let running = 0;
  for (const e of entries) {
    if (e.call.status === "error") errors++;
    else if (e.call.status === "running" || e.call.status === "pending") running++;
  }
  return { total: entries.length, errors, running };
}

// ---------------------------------------------------------------- retries

/**
 * The seqs of human prompts whose turn never got an answer, and so deserve a
 * Retry button.
 *
 * A prompt's span runs from its own event to the next prompt of any kind; it
 * counts as failed when the span records a turn that ended `error`, an `error`
 * event before the agent produced any work (a provider dying on the very
 * first call writes to stderr, not to the conversation), or an assistant
 * "message" that is really the provider's error surfaced as text — the retired
 * Stealth Ox model answered every prompt with a short `404 …` notice and still
 * ended its turn `end_turn`, so stopReason alone cannot be trusted.
 *
 * Mid-turn failures are deliberately not marked once the agent has produced
 * prose or tool activity: those turns did real work, an automatic
 * "Continue." has usually already resumed them, and a Retry button there
 * invites re-running a half-finished turn.
 */
export function failedPromptSeqs(events: TranscriptEvent[]): Set<number> {
  const failed = new Set<number>();
  let pending: number | null = null;
  let sawWork = false;
  for (const ev of events) {
    if (ev.type === "user") {
      pending = ev.from === "human" ? ev.seq : null;
      sawWork = false;
      continue;
    }
    if (pending === null) continue;
    if (ev.type === "assistant") {
      // A provider error arrives as the turn's only assistant message; real
      // prose marks the span as having done work and closes the question.
      if (isProviderError(ev.text)) {
        failed.add(pending);
        pending = null;
      } else {
        sawWork = true;
      }
    } else if (ev.type === "tool") {
      sawWork = true;
    } else if (ev.type === "turn") {
      if (ev.stopReason === "error") failed.add(pending);
      pending = null;
    } else if (ev.type === "error" && !sawWork) {
      failed.add(pending);
    }
  }
  return failed;
}

// -------------------------------------------------------------- subagents

export type RosterStatus = SubagentProgress["status"];

/** One dispatched subagent, as the Activity strip shows it. */
export interface RosterEntry {
  name: string;
  agent: string | null;
  task: string | null;
  status: RosterStatus;
  durationMs: number | null;
  toolCount: number | null;
  tokens: number | null;
  cost: number | null;
  /** What the subagent is inside right now, when a snapshot said so. */
  currentTool: string | null;
  lastIntent: string | null;
  /** True once an `agent://<name>` read collected this subagent's result. */
  collected: boolean;
  /** ts of the event that last described this subagent — elapsed extrapolates from it. */
  at: number;
}

/**
 * The subagent roster of a run, merged out of the transcript.
 *
 * Dispatches name the subagents and carry their task text; progress
 * snapshots describe them live; collects mark results as read. Later events
 * win, so the roster answers "where is the fan-out now", not "what happened
 * in full" — the per-subagent history stays in the transcript rows.
 */
export function subagentRoster(events: TranscriptEvent[]): RosterEntry[] {
  const byName = new Map<string, RosterEntry>();
  const order: string[] = [];

  const upsert = (name: string): RosterEntry => {
    let e = byName.get(name);
    if (!e) {
      e = {
        name, agent: null, task: null, status: "pending", durationMs: null,
        toolCount: null, tokens: null, cost: null, currentTool: null,
        lastIntent: null, collected: false, at: 0,
      };
      byName.set(name, e);
      order.push(name);
    }
    return e;
  };

  for (const event of events) {
    if (event.type !== "tool") continue;
    const call = event.call;
    const sa = subagentCallOf(call);
    if (sa?.kind === "dispatch") {
      for (const t of sa.tasks) {
        const e = upsert(t.name);
        e.agent = t.agent;
        if (!e.task && t.task) e.task = t.task;
        e.at = event.ts;
      }
    } else if (sa?.kind === "collect") {
      const e = upsert(sa.name);
      e.collected = true;
      e.at = event.ts;
    }
    if (call.subs) {
      for (const s of call.subs) {
        const e = upsert(s.id);
        if (s.agent) e.agent = s.agent;
        if (!e.task && s.task) e.task = s.task;
        e.status = s.status;
        e.durationMs = s.durationMs || null;
        e.toolCount = s.toolCount;
        e.tokens = s.tokens;
        e.cost = s.cost;
        e.currentTool = s.currentTool ?? null;
        e.lastIntent = s.lastIntent ?? null;
        e.at = event.ts;
      }
    }
  }

  return order.map((n) => byName.get(n)!);
}

// ---------------------------------------------------------- subagent drilldown

/** One reconstructed tool call of a subagent, for the drilldown timeline. */
export interface SubagentStep {
  ts: number;
  tool: string;
  args: string | null;
}

/**
 * Everything the transcript can say about one subagent, assembled for the
 * strip's drilldown view.
 *
 * omp runs subagents in-process, so there is no per-subagent event log to
 * read — but every progress snapshot the parent streamed is a data point, and
 * each carries `recentTools` (newest first) plus a cumulative `toolCount`.
 * When `toolCount` jumps by k between snapshots, the k newest `recentTools`
 * entries are exactly the calls that completed in between; reversing them
 * rebuilds the subagent's tool history in order. The one genuine primary
 * source is the collect call, whose output is the subagent's final result.
 */
export interface SubagentDetail {
  name: string;
  agent: string | null;
  task: string | null;
  status: RosterStatus;
  toolCount: number;
  tokens: number;
  cost: number;
  durationMs: number;
  /** Text of the `agent://<name>` collect call, once it completes. */
  result: string | null;
  resultError: boolean;
  /** Reconstructed tool calls, oldest first. */
  steps: SubagentStep[];
  /** ts of the first event that mentioned this subagent. */
  startedTs: number;
  /** ts of the last snapshot — a running subagent's "now" extrapolates from it. */
  lastTs: number;
  currentTool: string | null;
  currentToolArgs: string | null;
  lastIntent: string | null;
}

export function subagentDetail(events: TranscriptEvent[], name: string): SubagentDetail | null {
  const detail: SubagentDetail = {
    name, agent: null, task: null, status: "pending", toolCount: 0, tokens: 0, cost: 0,
    durationMs: 0, result: null, resultError: false, steps: [], startedTs: 0, lastTs: 0,
    currentTool: null, currentToolArgs: null, lastIntent: null,
  };
  let seen = false;
  let prevToolCount = 0;

  const record = (s: SubagentProgress, ts: number) => {
    if (!seen) {
      seen = true;
      detail.startedTs = ts;
    }
    detail.lastTs = ts;
    detail.status = s.status;
    if (s.agent) detail.agent = s.agent;
    if (!detail.task && s.task) detail.task = s.task;
    // Cumulative counters never go backwards: a snapshot interleaved from
    // another parent call may carry an older view, and adopting it would
    // make the drilldown un-see tools the roster already counts.
    detail.toolCount = Math.max(detail.toolCount, s.toolCount);
    detail.tokens = Math.max(detail.tokens, s.tokens);
    detail.cost = Math.max(detail.cost, s.cost);
    detail.durationMs = Math.max(detail.durationMs, s.durationMs);
    detail.currentTool = s.currentTool ?? null;
    detail.currentToolArgs = s.currentToolArgs ?? null;
    detail.lastIntent = s.lastIntent ?? null;

    // Snapshots can interleave from several parent calls (dispatch, wait,
    // hub); toolCount is cumulative per subagent, so a monotonic high-water
    // mark keeps a stale interleaved snapshot from double-counting tools.
    const gained = Math.max(0, s.toolCount - prevToolCount);
    if (gained > 0 && s.recentTools?.length) {
      for (const t of s.recentTools.slice(0, gained).reverse()) {
        detail.steps.push({ ts, tool: t.tool, args: t.args ?? null });
      }
    }
    prevToolCount = Math.max(prevToolCount, s.toolCount);
  };

  for (const event of events) {
    if (event.type !== "tool") continue;
    const call = event.call;
    const sa = subagentCallOf(call);
    if (sa?.kind === "dispatch") {
      for (const t of sa.tasks) {
        if (t.name !== name) continue;
        if (!seen) {
          seen = true;
          detail.startedTs = event.ts;
        }
        detail.agent = t.agent;
        if (!detail.task && t.task) detail.task = t.task;
      }
    } else if (sa?.kind === "collect" && sa.name === name) {
      detail.result = call.output;
      detail.resultError = call.status === "error";
    }
    if (call.subs) {
      for (const s of call.subs) {
        if (s.id === name) record(s, event.ts);
      }
    }
  }

  return seen ? detail : null;
}

/** Tally for the strip's header line and the board row.
 *
 * `pending` — dispatched, no progress snapshot seen yet — is deliberately not
 * counted as running: a transcript from before snapshots existed (or the gap
 * between dispatch and omp's first snapshot) would otherwise read as a fan-out
 * that is busy when we simply have not heard from it.
 */
export function rosterCounts(roster: RosterEntry[]): {
  total: number; running: number; failed: number; done: number;
} {
  let running = 0, failed = 0, done = 0;
  for (const e of roster) {
    if (e.status === "running") running++;
    else if (e.status === "failed") failed++;
    else if (e.status === "completed") done++;
  }
  return { total: roster.length, running, failed, done };
}
