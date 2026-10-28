/** Folding timeline frames into what the client holds. Pure. */

import type { Btw, TimelineEvent } from "../../../src/core/types";
import { sendOf, type SendCall } from "./sendtool";

/**
 * Merge incoming events into what is held, keyed by `id`.
 *
 * Order is the transcript's: the order the agent saw things in, which the
 * server sends events in. It is never re-sorted by `at`, which is only the
 * time to show: a CLI may write a record after one stamped later (Claude
 * stamps a message typed mid-turn with when it was typed, but writes it after
 * the step it waited behind), and sorting by time would put it where the
 * agent never saw it.
 *
 * - An id already held is **replaced in place**: a tool event is re-sent with
 *   the same id when its result lands, and it must not move or duplicate.
 * - New ids go after what is held (a live increment) or before it (an older
 *   page), in the order they came.
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
  return where === "prepend" ? [...fresh, ...next] : [...next, ...fresh];
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
  /** A message to another agent: shown as the message, not as a tool call. */
  | { type: "sent"; event: Extract<TimelineEvent, { kind: "tool" }>; send: SendCall }
  /** Teammates going idle with nothing to report, back to back: one line. */
  | { type: "idle"; id: string; events: IdleEvent[] }
  /** A side question (Claude's /btw): not in the transcript, placed by when it was asked. */
  | { type: "btw"; btw: Btw }
  /** The work between two things the agent said, folded to one line. `live`
   *  while the agent still works on it; `from` and `to` bound the work. */
  | { type: "trace"; id: string; rows: Exclude<TimelineRow, { type: "trace" }>[]; live: boolean; from: number; to: number }
  /** When the agent's turn ended: it stopped working and the next thing said
   *  is yours. Placed after the turn's last row, and only once it is over. */
  | { type: "end"; id: string; at: number };

type IdleEvent = Extract<TimelineEvent, { kind: "meta" }> & { mate: NonNullable<Extract<TimelineEvent, { kind: "meta" }>["mate"]> };

/** A teammate's turn ended and it said nothing with it. A lead hears one per turn per teammate. */
const quietIdle = (ev: TimelineEvent): ev is IdleEvent => ev.kind === "meta" && !!ev.mate && ev.mate.idle === "available" && !ev.mate.body;

export function groupTimeline(events: readonly TimelineEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  for (const ev of events) {
    const send = ev.kind === "tool" && !ev.ask ? sendOf(ev) : null;
    if (ev.kind === "tool" && ev.ask) {
      rows.push({ type: "ask", event: { ...ev, ask: ev.ask } });
    } else if (ev.kind === "tool" && send) {
      rows.push({ type: "sent", event: ev, send });
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
  r.type === "trace" ? r.from : r.type === "end" ? r.at : r.type === "sent" ? r.event.at : r.type === "tools" || r.type === "idle" ? r.events[0]!.at : r.type === "btw" ? r.btw.askedAt : r.event.at;

type Flat = Exclude<TimelineRow, { type: "trace" }>;

/** When a row's work ended: a tool call's result, or the row itself. */
const rowEnd = (r: Flat): number =>
  r.type === "tools" ? Math.max(...r.events.map((e) => (typeof e.endedAt === "number" && e.endedAt > e.at ? e.endedAt : e.at))) : rowAt(r);

/** The id each event in a row is found by in the page (`data-ev`). */
export function rowEventIds(r: Flat): string[] {
  return r.type === "tools" || r.type === "idle" ? r.events.map((e) => e.id) : r.type === "btw" || r.type === "end" ? [] : [r.event.id];
}

/** What stays in view: a message to the agent, its question to you, and your side questions. */
const inView = (r: Flat): boolean => (r.type === "event" && r.event.kind === "user") || r.type === "ask" || r.type === "btw";

/** A teammate's message with something in it wakes the agent: a turn of its own. */
const wakes = (r: Flat): boolean => r.type === "event" && r.event.kind === "meta" && !!r.event.mate?.body;

/**
 * Each turn as you read it: the message to the agent, then everything it said,
 * with the work between one thing it said and the next folded into a `trace`
 * row. A turn runs from one message to the agent to the next. While `live`,
 * the agent still works on the last turn: the work after the last thing it
 * said is an open-ended trace, even before any has landed.
 *
 * A turn that is over gets an `end` row: the time it handed the mic back. It
 * comes after the turn's last row, so it reads when the agent stopped, not
 * when it started writing. A side question is no turn boundary — it is an
 * aside inside one.
 */
export function traceTurns(rows: TimelineRow[], live: boolean): TimelineRow[] {
  const out: TimelineRow[] = [];
  let work: Flat[] = [];
  // A trace takes its id and start from what came before it — the message
  // that began the turn, or the last thing the agent said — so it keeps both
  // while its rows land and when the next thing it says closes it.
  let anchor = { id: "start", at: 0 };
  const fold = (open: boolean, until?: number) => {
    // Only info lines ("Started on …", "Interrupted") are no work to fold.
    if (!open && work.every((r) => r.type === "event" && r.event.kind === "meta" && !r.event.mate)) out.push(...work);
    else {
      const from = anchor.at || (work[0] ? rowAt(work[0]) : Date.now());
      const to = until ?? work.reduce((t, r) => Math.max(t, rowEnd(r)), from);
      out.push({ type: "trace", id: `trace-${anchor.id}`, rows: work, live: open, from, to });
    }
    work = [];
  };
  // The time the agent stopped: after the last thing it did, once the turn is
  // over. A row that only begins a turn (your message, a side question) is no
  // end of one, and an end is never followed by a second.
  const endTurn = () => {
    const last = out[out.length - 1];
    if (!last || last.type === "end" || last.type === "btw" || last.type === "ask") return;
    if (last.type === "event" && last.event.kind === "user") return;
    out.push({ type: "end", id: `end-${out.length}`, at: last.type === "trace" ? last.to : rowEnd(last) });
  };
  for (const r of rows as Flat[]) {
    if (inView(r)) {
      fold(false);
      // A question to you ends the turn: it waits for your answer next.
      if (r.type !== "btw") endTurn();
      out.push(r);
      anchor = { id: rowEventIds(r)[0] ?? `btw-${rowAt(r)}`, at: rowAt(r) };
    } else if (r.type === "event" && (r.event.kind === "assistant" || r.event.kind === "refusal")) {
      // A refusal is not work to hide: it is why the reply is missing, and
      // what the provider said about it.
      fold(false, rowAt(r));
      out.push(r);
      anchor = { id: r.event.id, at: rowAt(r) };
    } else if (wakes(r)) {
      fold(false);
      endTurn();
      anchor = { id: rowEventIds(r)[0]!, at: rowAt(r) };
      work.push(r);
    } else {
      work.push(r);
    }
  }
  fold(live);
  if (!live) endTurn();
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
