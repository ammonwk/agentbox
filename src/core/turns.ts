/** Everything you said to a session, for the message rail.
 *
 *  A long conversation is thousands of events, and the timeline only ever
 *  holds a page of them. The rail needs every message you sent, from the
 *  first, with where each sits in the conversation. That is one full read of
 *  the transcript, once per session; after it, only what was appended since
 *  its cursor is read, the same increments the timeline socket follows. What
 *  is kept is small: the turns themselves, capped, and the place of every
 *  event counted (a tool event is re-sent under its id when its result
 *  lands, and must not be counted twice). */

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

interface Entry {
  cursor: string;
  turns: Turn[];
  /** Every event counted so far, and its place. */
  seen: Map<string, number>;
}

export class TurnIndex {
  private entries = new Map<string, Entry>();
  /** One read at a time per session; a second caller waits for the first. */
  private pending = new Map<string, Promise<TurnList>>();

  constructor(private readonly source: TurnSource) {}

  list(id: string): Promise<TurnList> {
    const running = this.pending.get(id);
    if (running) return running;
    const p = this.refresh(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  private async refresh(id: string): Promise<TurnList> {
    let e = this.entries.get(id);
    if (e) {
      const next = await this.source.since(id, e.cursor);
      if (next.reset) e = undefined;
      else {
        this.fold(e, next.events);
        e.cursor = next.cursor;
      }
    }
    if (!e) {
      e = await this.build(id);
      this.entries.set(id, e);
    }
    return { turns: e.turns.slice(), total: e.seen.size };
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
    const e: Entry = { cursor, turns: [], seen: new Map() };
    for (let i = pages.length - 1; i >= 0; i--) this.fold(e, pages[i]!);
    return e;
  }

  private fold(e: Entry, events: readonly TimelineEvent[]): void {
    for (const ev of events) {
      let seq = e.seen.get(ev.id);
      if (seq === undefined) {
        seq = e.seen.size;
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
  }
}
