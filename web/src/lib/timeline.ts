/** Folding timeline frames into what the client holds. Pure. */

import type { Btw, TimelineEvent } from "../../../src/core/types";

/**
 * Merge incoming events into what is held, keyed by `id`.
 *
 * - An id already held is **replaced in place**: a tool event is re-sent with
 *   the same id when its result lands, and it must not move or duplicate.
 * - New ids are added, and the whole list is ordered by `at`. Ties keep the
 *   order they arrived in (older page first, then held, then new), because two
 *   events stamped in the same millisecond — a tool call and its text — have
 *   no other order to go by.
 *
 * Returns the same array when nothing changed, so a caller can skip a render.
 */
export function mergeTimeline(
  held: readonly TimelineEvent[],
  incoming: readonly TimelineEvent[],
  where: "append" | "prepend" = "append",
): readonly TimelineEvent[] {
  if (incoming.length === 0) return held;
  const index = new Map<string, number>();
  held.forEach((e, i) => index.set(e.id, i));

  const next = held.slice();
  const fresh: TimelineEvent[] = [];
  let changed = false;
  for (const ev of incoming) {
    const at = index.get(ev.id);
    if (at !== undefined) {
      if (!sameEvent(next[at], ev)) {
        next[at] = ev;
        changed = true;
      }
    } else if (!fresh.some((f) => f.id === ev.id)) {
      fresh.push(ev);
    } else {
      // Same id twice in one frame: the later one is the newer truth.
      fresh[fresh.findIndex((f) => f.id === ev.id)] = ev;
    }
  }
  if (fresh.length === 0) return changed ? next : held;

  const combined = where === "prepend" ? [...fresh, ...next] : [...next, ...fresh];
  // Stable sort by time: Array.prototype.sort is stable in every engine we ship to.
  return combined
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.at - b.e.at || a.i - b.i)
    .map((x) => x.e);
}

function sameEvent(a: TimelineEvent | undefined, b: TimelineEvent): boolean {
  if (!a || a.kind !== b.kind || a.at !== b.at) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A run of consecutive tool events renders as one box; everything else alone. */
export type TimelineRow =
  | { type: "event"; event: Exclude<TimelineEvent, { kind: "tool" }> }
  | { type: "tools"; id: string; events: Extract<TimelineEvent, { kind: "tool" }>[] }
  /** AskUserQuestion: a card of its own, not a line in a run of tools. */
  | { type: "ask"; event: Extract<TimelineEvent, { kind: "tool" }> & { ask: NonNullable<Extract<TimelineEvent, { kind: "tool" }>["ask"]> } }
  /** Teammates going idle with nothing to report, back to back: one line. */
  | { type: "idle"; id: string; events: IdleEvent[] }
  /** A side question (Claude's /btw): not in the transcript, placed by when it was asked. */
  | { type: "btw"; btw: Btw }
  /** A finished turn's thinking and tool calls between two things said, folded to one line. */
  | { type: "steps"; id: string; rows: Exclude<TimelineRow, { type: "steps" }>[] };

type IdleEvent = Extract<TimelineEvent, { kind: "meta" }> & { mate: NonNullable<Extract<TimelineEvent, { kind: "meta" }>["mate"]> };

/** A teammate's turn ended and it said nothing with it. A lead hears one per turn per teammate. */
const quietIdle = (ev: TimelineEvent): ev is IdleEvent => ev.kind === "meta" && !!ev.mate && ev.mate.idle === "available" && !ev.mate.body;

export function groupTimeline(events: readonly TimelineEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const ev of events) {
    if (ev.kind === "tool" && ev.ask) {
      rows.push({ type: "ask", event: { ...ev, ask: ev.ask } });
    } else if (ev.kind === "tool") {
      const last = rows[rows.length - 1];
      if (last?.type === "tools") last.events.push(ev);
      else rows.push({ type: "tools", id: ev.id, events: [ev] });
    } else if (quietIdle(ev)) {
      const last = rows[rows.length - 1];
      if (last?.type === "idle") last.events.push(ev);
      else rows.push({ type: "idle", id: ev.id, events: [ev] });
    } else {
      rows.push({ type: "event", event: ev });
    }
  }
  return rows;
}

const rowAt = (r: TimelineRow): number =>
  r.type === "steps" ? rowAt(r.rows[0]!) : r.type === "tools" || r.type === "idle" ? r.events[0]!.at : r.type === "btw" ? r.btw.askedAt : r.event.at;

type Flat = Exclude<TimelineRow, { type: "steps" }>;
/** Work, not words: what a finished turn can fold away. */
const isWork = (r: TimelineRow): r is Flat =>
  r.type === "tools" ? !r.events.some((e) => e.status === "running") : r.type === "event" && r.event.kind === "thinking";

/**
 * Fold each run of work — thinking and tool calls — in a turn that is over
 * into one `steps` row. A turn is over once you (or anyone) wrote again after
 * it; the last turn stays as it is, so what is happening now is always in
 * full. A run of one thought or a single call is left alone: folding it saves
 * nothing.
 */
export function foldSteps(rows: TimelineRow[]): TimelineRow[] {
  let lastUser = -1;
  rows.forEach((r, i) => {
    if (r.type === "event" && r.event.kind === "user") lastUser = i;
  });
  const out: TimelineRow[] = [];
  let run: Flat[] = [];
  const flush = () => {
    const calls = run.reduce((n, r) => n + (r.type === "tools" ? r.events.length : 1), 0);
    if (calls >= 2) out.push({ type: "steps", id: `steps-${run[0]!.type === "tools" ? run[0]!.id : (run[0] as Extract<Flat, { type: "event" }>).event.id}`, rows: run });
    else out.push(...run);
    run = [];
  };
  rows.forEach((r, i) => {
    if (i < lastUser && isWork(r)) {
      run.push(r);
      return;
    }
    if (run.length) flush();
    out.push(r);
  });
  if (run.length) flush();
  return out;
}

/**
 * Side questions placed among the rows by when they were asked, after the
 * row they followed. One older than everything loaded waits for the page it
 * belongs on, unless `all` (the start of the conversation is loaded).
 */
export function withBtw(rows: TimelineRow[], items: readonly Btw[], all: boolean): TimelineRow[] {
  const live = items.filter((b) => b.status !== "dismissed");
  if (live.length === 0) return rows;
  const from = rows.length && !all ? rowAt(rows[0]!) : -Infinity;
  const out = [...rows];
  for (const btw of live) {
    if (btw.askedAt < from) continue;
    let i = out.length;
    while (i > 0 && rowAt(out[i - 1]!) > btw.askedAt) i--;
    out.splice(i, 0, { type: "btw", btw });
  }
  return out;
}

/** The first non-empty line, trimmed to `max` — the collapsed thinking row. */
export function firstLine(text: string, max = 140): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
