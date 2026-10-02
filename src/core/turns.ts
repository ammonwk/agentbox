/** Everything you said to a session, for the message rail.
 *
 *  A long conversation is thousands of events, and the timeline only ever
 *  holds a page of them. The rail needs every message you sent, from the
 *  first, with where each sits in the conversation. That is one full read of
 *  the transcript — a second and more of a 50 MB one — once per session, ever:
 *  the index is saved (`TurnStore`), and after it only what was appended
 *  since its cursor is read, the same increments the timeline socket follows.
 *  What is kept is small: the turns themselves, capped, a count of the events,
 *  and the place of the recent ones and of calls still waiting on a result
 *  (an event is re-sent under its id — a call when its result lands, devin's
 *  newest message as it grows — and must not be counted twice). */

import type { TimelineEvent, TimelinePage, Turn, TurnList } from "./types";
import { dropPasteTags, readSent } from "./sent";
import { devinAskAnswers } from "./providers/devin-transcript";

/** The provider tools that ask you something; their result is your answer. */
const QUESTION_TOOLS = new Set(["AskUserQuestion", "ask_user_question", "request_user_input", "request_user_input_async"]);
/** How the Project session (removed) opened a message it wrote for you while
 *  you were away; kept so old transcripts still read right. */
const FROM_PROJECT = /^\[From the Project session\b/;
const TEXT_CAP = 600;
const FULL_PAGE = 1000;

/** The rail's view of one event, or null when it is not something you said. */
export function turnOf(ev: TimelineEvent, seq: number): Turn | null {
  if (ev.kind === "user") {
    const sent = readSent(ev.text.trim());
    const raw = dropPasteTags(sent.text).trim();
    if (sent.agent || FROM_PROJECT.test(raw)) return { id: ev.id, at: ev.at, kind: "agent", text: cap(raw), seq };
    const text = raw || (ev.images ? `(${ev.images} image${ev.images === 1 ? "" : "s"})` : "");
    if (!text) return null;
    const command = /^\/[a-z][\w:-]*(\s|$)/.test(text) || text.startsWith("! ");
    return { id: ev.id, at: ev.at, kind: command ? "command" : "prompt", text: cap(text), seq };
  }
  if (ev.kind === "tool" && QUESTION_TOOLS.has(ev.name) && ev.status === "ok" && ev.output) {
    return { id: ev.id, at: ev.at, kind: "answer", text: cap(answerText(questionsOf(ev.input) ?? [ev.summary], ev.output)), seq };
  }
  return null;
}

/** The questions a question tool asked, from its input; null when it does not parse (it is capped). */
function questionsOf(input: string | undefined): string[] | null {
  try {
    const qs = (JSON.parse(input ?? "") as { questions?: { question?: string; title?: string }[] }).questions;
    const out = (qs ?? []).map((q) => (q.question ?? q.title ?? "").trim()).filter(Boolean);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * The questions and what you chose. Claude's result reads `User has answered
 * your questions: "Which?"="This one", "And?"="That". You can now continue…`,
 * quotes inside unescaped, so each answer is found after its known question.
 * devin's reads `User answered your questions:` and a JSON object, which
 * `devinAskAnswers` parses. Anything else is shown as it came.
 */
export function answerText(questions: readonly string[], output: string): string {
  const json = devinAskAnswers(output);
  if (json) {
    const out = questions.map((q) => (json[q] !== undefined ? `${q}\n→ ${json[q]}` : null)).filter((x): x is string => x !== null);
    if (out.length) return out.join("\n");
  }
  const lines: string[] = [];
  for (const q of questions) {
    const at = output.indexOf(`"${q}"="`);
    if (at === -1) continue;
    const rest = output.slice(at + q.length + 4);
    const end = [rest.indexOf('", "'), rest.indexOf('". '), rest.lastIndexOf('"')].filter((i) => i >= 0);
    lines.push(`${q}\n→ ${rest.slice(0, end.length ? Math.min(...end) : undefined)}`);
  }
  return lines.length ? lines.join("\n") : `${questions.join("\n")}\n${output.trim()}`;
}

function cap(s: string): string {
  return s.length > TEXT_CAP ? `${s.slice(0, TEXT_CAP - 1)}…` : s;
}

export interface TurnSource {
  timeline(id: string, before: string | null, limit: number): Promise<TimelinePage>;
  since(id: string, cursor: string): Promise<{ events: TimelineEvent[]; cursor: string; reset: boolean }>;
}

/** Where indexes are kept between servers; `load` gives back what `save`
 *  was given, or null when there is none or it is from other code. */
export interface TurnStore {
  load(id: string): unknown;
  save(id: string, entry: unknown): void;
}

interface Entry {
  cursor: string;
  turns: Turn[];
  /** Events counted so far. */
  count: number;
  /** The place of each recent event and each call still running: what can
   *  come again. */
  seen: Map<string, number>;
  /** Calls without their result yet. */
  open: Set<string>;
  /** Folded since it was last saved, and when that was. */
  dirty: boolean;
  savedAt: number;
}

/** Events behind the newest whose places are kept (calls still running aside). */
const SEEN_KEEP = 2_000;
/** Sessions whose index is kept in memory; the rest wait in the store. */
const MAX_ENTRIES = 32;
/** An index that moved is saved at most this often (and when it leaves memory). */
const SAVE_MS = 60_000;

export class TurnIndex {
  /** Most recently used last. */
  private entries = new Map<string, Entry>();
  /** One read at a time per session; a second caller waits for the first. */
  private pending = new Map<string, Promise<TurnList>>();

  constructor(
    private readonly source: TurnSource,
    private readonly store?: TurnStore,
  ) {}

  list(id: string): Promise<TurnList> {
    const running = this.pending.get(id);
    if (running) return running;
    const p = this.refresh(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  private async refresh(id: string): Promise<TurnList> {
    let e = this.entries.get(id) ?? this.restore(id);
    if (e) {
      const next = await this.source.since(id, e.cursor);
      if (next.reset) e = undefined;
      else {
        this.fold(e, next.events);
        e.cursor = next.cursor;
        if (next.events.length > 0) e.dirty = true;
      }
    }
    if (!e) e = await this.build(id);
    this.entries.delete(id);
    this.entries.set(id, e);
    if (e.dirty && Date.now() - e.savedAt >= SAVE_MS) this.save(id, e);
    for (const [old, x] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (x.dirty) this.save(old, x);
      this.entries.delete(old);
    }
    return { turns: e.turns.slice(), total: e.count };
  }

  /** The whole transcript, newest page first, folded oldest first. */
  private async build(id: string): Promise<Entry> {
    const pages: TimelineEvent[][] = [];
    let cursor = "";
    let before: string | null = null;
    do {
      const page: TimelinePage = await this.source.timeline(id, before, FULL_PAGE);
      if (!cursor) cursor = page.cursor;
      pages.push(page.events);
      before = page.before;
    } while (before);
    const e: Entry = { cursor, turns: [], count: 0, seen: new Map(), open: new Set(), dirty: true, savedAt: 0 };
    for (let i = pages.length - 1; i >= 0; i--) this.fold(e, pages[i]!);
    this.save(id, e);
    return e;
  }

  private save(id: string, e: Entry): void {
    e.dirty = false;
    e.savedAt = Date.now();
    this.store?.save(id, { cursor: e.cursor, turns: e.turns, count: e.count, seen: [...e.seen], open: [...e.open] });
  }

  private restore(id: string): Entry | undefined {
    const s = this.store?.load(id) as { cursor: string; turns: Turn[]; count: number; seen: [string, number][]; open: string[] } | null | undefined;
    if (!s || typeof s.cursor !== "string" || !Array.isArray(s.turns) || !Array.isArray(s.seen) || !Array.isArray(s.open)) return undefined;
    return { cursor: s.cursor, turns: s.turns, count: s.count, seen: new Map(s.seen), open: new Set(s.open), dirty: false, savedAt: Date.now() };
  }

  private fold(e: Entry, events: readonly TimelineEvent[]): void {
    for (const ev of events) {
      if (ev.kind === "tool") {
        if (ev.status === "running") e.open.add(ev.id);
        else e.open.delete(ev.id);
      }
      let seq = e.seen.get(ev.id);
      if (seq === undefined) {
        seq = e.count++;
        e.seen.set(ev.id, seq);
        const t = turnOf(ev, seq);
        if (t) e.turns.push(t);
        continue;
      }
      // A question's tool event comes back with your answer in it, and takes
      // the place it was first counted at.
      if (e.turns.some((t) => t.id === ev.id)) continue;
      const t = turnOf(ev, seq);
      if (!t) continue;
      const at = e.turns.findIndex((x) => x.seq > t.seq);
      e.turns.splice(at === -1 ? e.turns.length : at, 0, t);
    }
    // Finished events long past do not come again.
    if (e.seen.size > 2 * SEEN_KEEP) {
      for (const [id, seq] of e.seen) if (seq < e.count - SEEN_KEEP && !e.open.has(id)) e.seen.delete(id);
    }
  }
}
