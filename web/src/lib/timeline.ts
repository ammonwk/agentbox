/** Folding timeline frames into what the client holds. Pure. */

import type { TimelineEvent } from "../../../src/core/types";

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
  | { type: "idle"; id: string; events: IdleEvent[] };

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

/** The first non-empty line, trimmed to `max` — the collapsed thinking row. */
export function firstLine(text: string, max = 140): string {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
