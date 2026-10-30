/** A `TranscriptReader` over any append-only JSONL transcript.
 *
 * Claude and codex differ in what a record means, not in how a transcript is
 * read, paged or followed. A provider supplies a `TranscriptFormat` — a fold
 * for facts and a projection from one record to timeline pieces — and this
 * does the rest: incremental reads, a cursor that survives server restarts,
 * paging by record index, and joining a tool call to a result that arrived in
 * a later record.
 *
 * Memory stays bounded by the file's record count, not its bytes: what is kept
 * is the fold's running facts, `JsonlTail`'s offset index, and one small entry
 * per tool call. Events are always re-projected from disk on demand.
 */

import { statSync } from "node:fs";
import type { TimelineEvent, TimelinePage } from "../types";
import { JsonlTail, StaleIndex, type JsonlTailState } from "./jsonl";
import { branched, currentLeaf, hiddenRanges, isHidden, leafThrough, settled, versionsOf, wentBack, type Branches, type PromptRows } from "./branches";
import type { TranscriptFacts, TranscriptReader, TranscriptRef } from "./types";

export type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;

/** What one record contributes to the timeline. */
export type Piece =
  | { kind: "event"; event: TimelineEvent }
  /** A tool call, still without its result. `event.id` must be stable. */
  | { kind: "call"; callId: string; event: ToolEvent }
  /** The result of an earlier (or same-record) call. `at` is when the result
   *  record was written, so a call can show how long it took. */
  | { kind: "result"; callId: string; output: string; error: boolean; answers?: Record<string, string>; at?: number };

export interface TranscriptFormat {
  /** Fold one record into the running facts. Called once per record, in order. */
  add(value: any, index: number): void;
  /** Forget everything: the file was replaced. */
  reset(): void;
  facts(): TranscriptFacts;
  /** The tool-call ids a record opens and closes. Must be cheap: it runs on
   *  every record of every read, where `pieces` only runs for what is shown. */
  links(value: any): { calls?: string[]; results?: string[] } | null;
  pieces(value: any, index: number): Piece[];
  /** Fold sources other than the main file (claude's subagent transcripts).
   *  True when anything new was read. */
  refreshExtra?(): boolean;
  /** Your messages and where each continued from (`branches.ts`), for a
   *  format whose transcript is a tree: only one path through it is shown. */
  branches?(): Branches;
  /** The id of the record a branch ends at, to point the conversation at it. */
  leafId?(leaf: number): string | null;
  /** Where an event's record is: its index, when the id says it, or text
   *  only its record's line holds. Null when the id is none of this format's. */
  locate?(id: string): { index: number } | { text: string } | null;
  /** The fold's running state (extras included), for `restore` in a later
   *  process. A format without it is read from the start on every restart. */
  state?(): unknown;
  /** Take up a saved state; throws when it does not fit. */
  restore?(s: unknown): void;
}

/** The records a page leaves out, and the messages that say why. */
interface Path {
  branches: Branches | null;
  rows: PromptRows | null;
  hidden: [number, number][] | null;
}

/** What `JsonlTranscriptReader.saveState` returns. */
interface SavedReader {
  tail: JsonlTailState;
  next: number;
  resets: number;
  ino: number;
  callIds: string[];
  /** [call record, result record or -1] per id in `callIds`. */
  callAt: Int32Array;
  format: unknown;
}

/** Past this many records behind, `since` sends a fresh page instead. */
const MAX_SINCE_RECORDS = 5_000;
const RESET_PAGE = 100;
export const OUTPUT_CAP = 8 * 1024;
export const INPUT_CAP = 4 * 1024;

/** Keep both ends of long tool output: the command is at the start and the
 *  verdict, error or test summary is at the end, and either is what a reader
 *  — or `agentbox grep` — is looking for. */
export function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max / 2);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [${s.length - head - tail} more chars] …\n${s.slice(-tail)}`;
}

/**
 * A tool call's input as JSON of at most about `max` chars that still
 * parses: the longest strings lose their tails, not the JSON its closing
 * braces, so the timeline can lay the fields out rather than show raw text.
 */
export function capJson(value: unknown, max: number): string {
  const whole = JSON.stringify(value ?? {});
  if (whole.length <= max) return whole;
  for (let limit = max >> 1; limit >= 64; limit >>= 1) {
    const s = JSON.stringify(value, (_k, v) => (typeof v === "string" && v.length > limit ? `${v.slice(0, limit)}… [${v.length - limit} more chars]` : v));
    if (s.length <= max) return s;
  }
  return cap(whole, max);
}

export class JsonlTranscriptReader implements TranscriptReader {
  private tail: JsonlTail;
  /** Next record index the fold expects; a lower one means the file was replaced. */
  private next = 0;
  private resets = 0;
  private ino = -1;
  /** callId -> [record index of the call, record index of its result or -1]. */
  private calls = new Map<string, [number, number]>();
  /** When the CLI last went idle, by its own word (`idleSince`). */
  private idle: number | null = null;
  /** The newest message is shown as taken back. */
  private takenBack = false;
  /** Read something since the last `refresh`, whoever pulled it: a page read
   *  for the timeline must not swallow the change the fleet reports. */
  private dirty = false;

  constructor(
    readonly ref: TranscriptRef,
    private readonly format: TranscriptFormat,
  ) {
    this.tail = new JsonlTail(ref.path);
  }

  private resetState(): void {
    this.format.reset();
    this.calls.clear();
    this.next = 0;
    this.resets++;
  }

  /** The file changed under the record index: read it whole, once again. */
  private rebuild(): void {
    this.resetState();
    this.tail.forget();
    this.ino = -1;
  }

  /** Run `fn` against the record index, starting the read over once if the
   *  transcript was rewritten under it (its starts are its own alone). */
  private retryIfStale<T>(fn: () => T): T {
    this.pull();
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof StaleIndex)) throw e;
      this.rebuild();
      this.pull();
      return fn();
    }
  }

  /**
   * The CLI has been idle since `at` (null: no word, or not running). A
   * message it never answered from before then was taken back, and is not
   * shown. True when that changes what is shown; cursors from before then
   * no longer hold, so a reader of them starts again from a fresh page.
   */
  idleSince(at: number | null): boolean {
    this.idle = at;
    return this.settle();
  }

  private settle(): boolean {
    const b = this.format.branches?.();
    const now = !!b && settled(b, this.idle);
    if (now === this.takenBack) return false;
    this.takenBack = now;
    this.resets++;
    return true;
  }

  private epoch(): string {
    return `${this.ino}.${this.resets}`;
  }

  /** Read what was appended into the fold and the call index. */
  private pull(): boolean {
    let changed = false;
    const { reset } = this.tail.read((rec) => {
      if (rec.index < this.next) this.resetState();
      this.next = rec.index + 1;
      changed = true;
      // A fold that throws on one odd record must not wedge the tail: the
      // tail has already counted this record and will not offer it again.
      try {
        this.format.add(rec.value, rec.index);
        const l = this.format.links(rec.value);
        if (l) {
          for (const id of l.calls ?? []) this.calls.set(id, [rec.index, -1]);
          for (const id of l.results ?? []) {
            const c = this.calls.get(id);
            if (c && c[1] < 0) c[1] = rec.index;
          }
        }
      } catch {
        /* skip the record, keep the reader */
      }
    });
    if (reset && !changed) {
      this.resetState();
      changed = true;
    }
    // A reply, or the next message, settles whether the last one was taken back.
    if (changed) {
      this.settle();
      this.dirty = true;
    }
    if (reset || this.ino === -1) {
      try {
        this.ino = statSync(this.ref.path).ino;
      } catch {
        /* gone; the cursor still works until it reappears */
      }
    }
    return changed;
  }

  /** Everything a later process needs to carry on from here, or null when
   *  the format cannot say where it is. */
  saveState(): unknown {
    if (!this.format.state) return null;
    const callIds = [...this.calls.keys()];
    const callAt = new Int32Array(callIds.length * 2);
    let i = 0;
    for (const [call, result] of this.calls.values()) {
      callAt[i++] = call;
      callAt[i++] = result;
    }
    const saved: SavedReader = { tail: this.tail.state(), next: this.next, resets: this.resets, ino: this.ino, callIds, callAt, format: this.format.state() };
    return saved;
  }

  /** Carry on from a saved state. False, and nothing changed, when it does
   *  not describe the file as it is now: the reader then reads from the start. */
  loadState(saved: unknown): boolean {
    const s = saved as SavedReader | null;
    if (!s || !this.format.restore || this.next !== 0 || !(s.callAt instanceof Int32Array)) return false;
    if (!this.tail.restore(s.tail)) return false;
    try {
      this.format.restore(s.format);
    } catch {
      this.tail = new JsonlTail(this.ref.path);
      this.format.reset();
      return false;
    }
    this.next = s.next;
    this.resets = s.resets;
    this.ino = s.ino;
    for (let i = 0; i < s.callIds.length; i++) this.calls.set(s.callIds[i]!, [s.callAt[2 * i]!, s.callAt[2 * i + 1]!]);
    return true;
  }

  async refresh(): Promise<{ changed: boolean; facts: TranscriptFacts }> {
    this.pull();
    let changed = this.dirty;
    this.dirty = false;
    if (this.format.refreshExtra) {
      try {
        if (this.format.refreshExtra()) changed = true;
      } catch {
        /* extras are best effort */
      }
    }
    return { changed, facts: this.format.facts() };
  }

  private cursorAt(index: number): string {
    return `${this.epoch()}:${index}`;
  }

  /** The record index a cursor points at, if it belongs to this file as read now. */
  private parse(cursor: string | null | undefined): number | null {
    if (!cursor) return null;
    const i = cursor.lastIndexOf(":");
    if (i < 0 || cursor.slice(0, i) !== this.epoch()) return null;
    const n = Number(cursor.slice(i + 1));
    return Number.isInteger(n) && n >= 0 && n <= this.tail.recordCount ? n : null;
  }

  /** Pieces for one record, never throwing. */
  private piecesOf(value: any, index: number): Piece[] {
    try {
      return this.format.pieces(value, index);
    } catch {
      return [];
    }
  }

  /** The result piece for `callId`, reading its record if it is not loaded. */
  private resultOf(callId: string, loaded: Map<number, any>): Extract<Piece, { kind: "result" }> | null {
    const c = this.calls.get(callId);
    if (!c || c[1] < 0) return null;
    let value = loaded.get(c[1]);
    if (value === undefined) {
      value = this.tail.range(c[1], c[1] + 1)[0]?.value;
      if (value === undefined) return null;
      loaded.set(c[1], value);
    }
    for (const p of this.piecesOf(value, c[1])) if (p.kind === "result" && p.callId === callId) return p;
    return null;
  }

  private withResult(ev: ToolEvent, r: Extract<Piece, { kind: "result" }> | null): ToolEvent {
    if (!r) return ev;
    const done: ToolEvent = { ...ev, output: r.output, status: r.error ? "error" : "ok" };
    if (typeof r.at === "number" && r.at > ev.at) done.endedAt = r.at;
    if (ev.ask && r.answers) done.ask = { ...ev.ask, answers: r.answers };
    return done;
  }

  /** Events of records `[from, to)`, grouped by record. Results are folded
   *  into their calls; a result whose call is outside the range is dropped
   *  here, because the page that holds the call already shows it. */
  private project(from: number, to: number, loaded: Map<number, any>, path: Path): { index: number; events: TimelineEvent[] }[] {
    const recs = this.tail.range(from, to);
    for (const r of recs) loaded.set(r.index, r.value);
    const out: { index: number; events: TimelineEvent[] }[] = [];
    for (const r of recs) {
      const events: TimelineEvent[] = [];
      if (!path.hidden || !isHidden(path.hidden, r.index)) {
        for (const p of this.piecesOf(r.value, r.index)) {
          if (p.kind === "event") events.push(this.versioned(p.event, r.index, path));
          else if (p.kind === "call") events.push(this.withResult(p.event, this.resultOf(p.callId, loaded)));
        }
      }
      out.push({ index: r.index, events });
    }
    return out;
  }

  /**
   * The path shown: the conversation as it stands, or through one version of
   * a message (`via`). Null `hidden` when the transcript never branched.
   */
  private pathOf(via?: string | null): Path {
    const b = this.format.branches?.() ?? null;
    const n = this.tail.recordCount;
    if (!b || (!branched(b) && !this.takenBack)) return { branches: null, rows: null, hidden: null };
    const at = via ? this.parse(via) : null;
    const leaf = at === null ? currentLeaf(b, n, this.takenBack) : leafThrough(b.prompts, at, n);
    return { branches: b, rows: b.prompts, hidden: hiddenRanges(b.prompts, leaf) };
  }

  /** The id of the last record of the branch through one version of a
   *  message (`via`): what to point the conversation at to carry on there.
   *  Null when it is not a version this file has. */
  leafIdOf(via: string): string | null {
    this.pull();
    const at = this.parse(via);
    const b = this.format.branches?.();
    if (at === null || !b || !this.format.leafId) return null;
    return this.format.leafId(leafThrough(b.prompts, at, this.tail.recordCount));
  }

  /** A message with other versions says which they are. */
  private versioned(ev: TimelineEvent, index: number, path: Path): TimelineEvent {
    if (ev.kind !== "user" || !path.rows) return ev;
    const all = versionsOf(path.rows, index);
    if (!all) return ev;
    return { ...ev, versions: { index: all.indexOf(index), of: all.map((i) => this.cursorAt(i)) } };
  }

  /** The newest `limit` events ending before record `end` (whole records, so
   *  a page can run a few events over). */
  private page(end: number, limit: number, path: Path): { events: TimelineEvent[]; start: number } {
    const loaded = new Map<number, any>();
    const groups: { index: number; events: TimelineEvent[] }[][] = [];
    let count = 0;
    let start = end;
    const chunk = Math.max(64, limit * 2);
    let lo = end;
    while (lo > 0 && count < limit) {
      const from = Math.max(0, lo - chunk);
      const got = this.project(from, lo, loaded, path);
      const keep: { index: number; events: TimelineEvent[] }[] = [];
      for (let i = got.length - 1; i >= 0 && count < limit; i--) {
        keep.unshift(got[i]!);
        count += got[i]!.events.length;
        start = got[i]!.index;
      }
      groups.unshift(keep);
      lo = from;
    }
    const events = groups.flat().flatMap((g) => g.events);
    return { events, start: Math.min(start, end) };
  }

  /** The oldest `limit` events from record `start` on (whole records), and
   *  the record after the last one read. */
  private forward(start: number, limit: number, path: Path): { events: TimelineEvent[]; end: number } {
    const loaded = new Map<number, any>();
    const n = this.tail.recordCount;
    const events: TimelineEvent[] = [];
    let end = start;
    const chunk = Math.max(64, limit * 2);
    while (end < n && events.length < limit) {
      for (const g of this.project(end, Math.min(n, end + chunk), loaded, path)) {
        if (events.length >= limit) break;
        events.push(...g.events);
        end = g.index + 1;
      }
    }
    return { events, end };
  }

  async timeline(opts: { before?: string | null; after?: string; limit: number; via?: string | null }): Promise<TimelinePage> {
    return this.retryIfStale(() => {
      const n = this.tail.recordCount;
      const limit = Math.max(1, opts.limit);
      const path = this.pathOf(opts.via);
      let page: TimelinePage;
      if (opts.after !== undefined) {
        const start = opts.after === "" ? 0 : (this.parse(opts.after) ?? n);
        const { events, end } = this.forward(start, limit, path);
        page = { events, before: start > 0 ? this.cursorAt(start) : null, after: end < n ? this.cursorAt(end) : null, cursor: this.cursorAt(n) };
      } else {
        const { events, start } = this.page(this.parse(opts.before) ?? n, limit, path);
        page = { events, before: start > 0 ? this.cursorAt(start) : null, cursor: this.cursorAt(n) };
      }
      if (opts.via) page.via = opts.via;
      return page;
    });
  }

  /** Found once, an event's record stays where it is until the file is read anew. */
  private located = new Map<string, number>();

  async locate(id: string): Promise<string | null> {
    return this.retryIfStale(() => {
      const key = `${this.epoch()} ${id}`;
      let at = this.located.get(key);
      if (at === undefined) {
        const hint = this.format.locate?.(id);
        if (!hint) return null;
        const n = this.tail.recordCount;
        const found = ("index" in hint ? [hint.index] : this.tail.find(hint.text)).find((i) => {
          if (i >= n) return false;
          const rec = this.tail.range(i, i + 1)[0];
          return !!rec && this.piecesOf(rec.value, i).some((p) => p.kind !== "result" && p.event.id === id);
        });
        if (found === undefined) return null;
        at = found;
        if (this.located.size >= 256) this.located.delete(this.located.keys().next().value!);
        this.located.set(key, at);
      }
      return this.cursorAt(at);
    });
  }

  async since(cursor: string): Promise<{ events: TimelineEvent[]; cursor: string; reset: boolean }> {
    return this.retryIfStale(() => {
      const n = this.tail.recordCount;
      const from = this.parse(cursor);
      const path = this.pathOf();
      // A message that went back to before what the reader has hides some of
      // it: start again from the conversation as it now stands.
      if (from === null || n - from > MAX_SINCE_RECORDS || (path.branches && wentBack(path.branches, from))) {
        const { events } = this.page(n, RESET_PAGE, path);
        return { events, cursor: this.cursorAt(n), reset: true };
      }
      if (from === n) return { events: [], cursor: this.cursorAt(n), reset: false };

      const loaded = new Map<number, any>();
      const recs = this.tail.range(from, n);
      for (const r of recs) loaded.set(r.index, r.value);
      const events: TimelineEvent[] = [];
      for (const r of recs) {
        if (path.hidden && isHidden(path.hidden, r.index)) continue;
        for (const p of this.piecesOf(r.value, r.index)) {
          if (p.kind === "event") events.push(this.versioned(p.event, r.index, path));
          else if (p.kind === "call") events.push(this.withResult(p.event, this.resultOf(p.callId, loaded)));
          else {
            // A result for a call the client already has: send the call again,
            // same id, now finished. Calls inside this batch were folded above.
            // Only the result the index holds for the call counts, so a page and
            // a stream never disagree about which one it was.
            const c = this.calls.get(p.callId);
            if (!c || c[0] >= from || c[1] !== r.index) continue;
            const call = this.tail.range(c[0], c[0] + 1)[0];
            if (!call) continue;
            const piece = this.piecesOf(call.value, call.index).find(
              (q): q is Extract<Piece, { kind: "call" }> => q.kind === "call" && q.callId === p.callId,
            );
            if (piece) events.push(this.withResult(piece.event, p));
          }
        }
      }
      return { events, cursor: this.cursorAt(n), reset: false };
    });
  }
}
