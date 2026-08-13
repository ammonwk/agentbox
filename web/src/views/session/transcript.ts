/** Turning a flat TranscriptEvent stream into what the Activity tab renders.
 *
 * Tool calls are the majority of events. Rendered one-per-block they bury the
 * assistant prose and the supervisor verdicts that a human is actually
 * scanning for, so consecutive tool events are gathered into a run and long
 * runs are collapsed in the middle. Errors are never collapsed: a hidden
 * failure defeats the entire point of this screen.
 */

import type { Session, ToolCall, TranscriptEvent } from "../../../../src/core/types";

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
    if (e.call.status === "error") keep.add(i);
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
