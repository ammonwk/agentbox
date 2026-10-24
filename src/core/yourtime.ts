/** How much of your own time the fleet takes, per day where you live: what
 *  you gave it, counted by kind, and the minutes that took
 *  (`GET /api/you/time`, `agentbox your-time`).
 *
 *  Counted from what agentbox already keeps, never by asking you anything:
 *
 *  - message: what you said to a session, wherever you typed it (the board,
 *    the phone, a terminal), read from the transcripts through the search
 *    index (`search.ts`, a pass a minute behind). Not yours, and not counted:
 *    anything signed by `agentbox send`, a schedule or agentbox itself
 *    (`readSent`); a card's answer as it is typed in (the card counts); a
 *    subagent's or another CLI's session (`origin` external: its messages are
 *    a script's), and a session's first message unless you started it,
 *    since every other launch prompt is the launcher's. An answer to a
 *    question dialog given on the board, and `agentbox send` from your own
 *    terminal, are recorded as they come (`you_acts`).
 *  - card: a card you answered (`cards`).
 *  - mfa: an MFA code you gave: a message or a card answer that is six
 *    digits and nothing else. `agentbox aws-grant` is the session using it,
 *    not you again.
 *  - login: an account login finished through agentbox (`you_acts`). One you
 *    ran yourself in a terminal leaves nothing agentbox can see.
 *
 *  The minutes. Each thing you gave takes some time before the moment it
 *  is recorded: reading what you answer and typing it. That is `costMs`: a
 *  minute to read a message or a card plus what you typed at 40 words a
 *  minute (a paste is not typing), ten at most; half a minute for an MFA code, two for
 *  a login. And where two of them are `GAP_MS` or less apart you were
 *  still there between them, reading the reply that came, so the gap counts
 *  too. The day's minutes are the length of what that covers.
 *
 *  Why that and not a price per kind: you answer in runs (six cards in three
 *  minutes, a back-and-forth of a dozen messages over an hour), and a price
 *  per item says the six cards took six minutes, or the hour's conversation
 *  twelve. Covering time says three and sixty, which is what a clock would
 *  have shown.
 *
 *  Eight minutes for the gap, measured: the spacing between one thing you
 *  gave and the next (the two weeks to 2026-10-23, about 870 of them) is two
 *  kinds mixed. Replies inside a sitting come fast and thin out (207 under a
 *  minute, 46 at four, 21 at eight, 11 at nine); returns spread over hours,
 *  an exponential fitted to the 15–90 minute spacings, about seven a minute
 *  at the short end. The first is above the second up to eight minutes and
 *  gone by ten, so a gap of eight or less is more likely you stayed than
 *  you came back. Over those two weeks a gap of three minutes would have
 *  made 1,103 minutes, five 1,299, eight 1,646, fifteen 2,304.
 */

import { getDb } from "./db";
import { userSaidSince } from "./search";
import { readSent, splitPastes, withoutNotes } from "./sent";

export type YourActKind = "message" | "card" | "mfa" | "login";
export const YOUR_ACT_KINDS: readonly YourActKind[] = ["message", "card", "mfa", "login"];

export interface YourAct {
  at: number;
  kind: YourActKind;
  /** Characters you typed for it, for its cost. */
  typed: number;
}

export interface YourDay {
  /** `YYYY-MM-DD` in `timezone`. */
  day: string;
  counts: Record<YourActKind, number>;
  minutes: number;
}

export interface YourTime {
  timezone: string;
  /** The rule `minutes` follows, in a line. */
  rule: string;
  /** Oldest first, today last; a day with nothing in it is there with zeros. */
  days: YourDay[];
}

const MIN = 60_000;
export const GAP_MS = 8 * MIN;
/** 40 words a minute, at six characters a word with its space. */
const TYPED_PER_MIN = 240;
const MFA = /^\d{6}$/;

export function costMs(a: YourAct): number {
  if (a.kind === "mfa") return MIN / 2;
  if (a.kind === "login") return 2 * MIN;
  return Math.min(10 * MIN, MIN + (a.typed / TYPED_PER_MIN) * MIN);
}

const RULE = `each item covers the minute before it (half a minute for an MFA code, two for a login) plus what you typed at 40 wpm, ten minutes at most; items at most ${GAP_MS / MIN} minutes apart count the gap between them; minutes = time covered`;

/** Pure: the acts, grouped into the `days` local days that end today. */
export function foldYourTime(acts: readonly YourAct[], days: number, timezone: string, now: number): YourTime {
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const key = (t: number): string => dayOf.format(t);
  // Counted back on the calendar, not in 24-hour steps, which a 23-hour day would skip.
  const today = Date.parse(`${key(now)}T00:00:00Z`);
  const order = Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * 24 * 60 * MIN).toISOString().slice(0, 10));
  const byDay = new Map(order.map((d) => [d, [] as YourAct[]]));
  for (const a of acts) byDay.get(key(a.at))?.push(a);
  return {
    timezone,
    rule: RULE,
    days: order.map((day) => {
      const list = byDay.get(day)!.sort((a, b) => a.at - b.at);
      const counts = Object.fromEntries(YOUR_ACT_KINDS.map((k) => [k, 0])) as Record<YourActKind, number>;
      let covered = 0;
      let span: { from: number; to: number } | null = null;
      for (const a of list) {
        counts[a.kind]++;
        const start = a.at - costMs(a);
        if (!span) span = { from: start, to: a.at };
        else if (a.at - span.to > GAP_MS) {
          covered += span.to - span.from;
          // A long message's lead never reaches back over time already counted.
          span = { from: Math.max(start, span.to), to: a.at };
        } else span = { from: Math.min(span.from, start), to: a.at };
      }
      if (span) covered += span.to - span.from;
      return { day, counts, minutes: Math.round(covered / MIN) };
    }),
  };
}

/** What you typed in a message: the text outside its pastes and image references. */
function typedIn(text: string): number {
  return splitPastes(text)
    .filter((p) => p.kind === "text")
    .reduce((n, p) => n + p.text.replace(/\[Image #\d+:[^\]]*\]/g, "").trim().length, 0);
}

/** A message as one of your acts, or null when it is not yours to count. */
export function messageAct(raw: string, at: number): YourAct | null {
  const sent = readSent(raw);
  if (sent.agent) return null;
  const text = withoutNotes(sent.text).trim();
  // A card's answer, typed into its session: the card is counted.
  if (/^\[card \d+ “/.test(text)) return null;
  if (MFA.test(text)) return { at, kind: "mfa", typed: 6 };
  return { at, kind: "message", typed: typedIn(text) };
}

/** Something agentbox saw you do as it happened, that no transcript or card
 *  records: `launch` is a session you started, so its first message is yours. */
export type RecordedAct = "launch" | "message" | "login";

export function recordYourAct(kind: RecordedAct, sessionId: string | null, at = Date.now()): void {
  getDb().query("INSERT INTO you_acts (at, kind, session_id) VALUES (?, ?, ?)").run(at, kind, sessionId);
}

/** Every act since `since`. */
export function yourActs(since: number): YourAct[] {
  const db = getDb();
  // A subagent's or a script's CLI is not started by agentbox: those are external.
  const started = new Map((db.query("SELECT id, provider FROM sessions WHERE origin = 'agentbox'").all() as { id: string; provider: string }[]).map((r) => [r.id, r.provider]));
  const recorded = db.query("SELECT at, kind, session_id AS sessionId FROM you_acts WHERE at >= ? OR kind = 'launch'").all(since) as {
    at: number;
    kind: RecordedAct;
    sessionId: string | null;
  }[];
  const yours = new Set(recorded.flatMap((r) => (r.kind === "launch" && r.sessionId ? [r.sessionId] : [])));
  const acts: YourAct[] = recorded.flatMap((r) => (r.kind !== "launch" && r.at >= since ? [{ at: r.at, kind: r.kind, typed: 0 }] : []));

  // A transcript copied into another session (a fork) carries the same
  // messages at the same moments, and claude records a slash command twice
  // a few milliseconds apart: one of each is counted.
  const seen = new Set<string>();
  const last = new Map<string, number>();
  for (const m of userSaidSince(since)) {
    const provider = started.get(m.session);
    if (!provider || (m.first && !yours.has(m.session))) continue;
    // opencode types this into its own session, seconds apart, when a run stops short.
    if (provider === "opencode" && m.text.trim() === "Continue.") continue;
    const once = `${m.at}\n${m.text}`;
    const again = `${m.session}\n${m.text}`;
    const before = last.get(again);
    last.set(again, m.at);
    if (seen.has(once) || (before !== undefined && m.at - before < 1000)) continue;
    seen.add(once);
    const act = messageAct(m.text, m.at);
    if (act) acts.push(act);
  }

  const cards = db.query("SELECT answer, answered_at AS at FROM cards WHERE state = 'answered' AND answered_at >= ?").all(since) as { answer: string | null; at: number }[];
  for (const c of cards) {
    const answer = (c.answer ?? "").trim();
    acts.push(MFA.test(answer) ? { at: c.at, kind: "mfa", typed: 6 } : { at: c.at, kind: "card", typed: answer.length });
  }
  return acts;
}

/** The search index moves once a minute, and a read of two weeks takes a
 *  few hundred milliseconds of the server's thread: kept that long. */
let kept: { key: string; at: number; time: YourTime } | null = null;

export function yourTime(days: number, timezone: string, now = Date.now()): YourTime {
  const key = `${days} ${timezone}`;
  if (kept && kept.key === key && now - kept.at < MIN) return kept.time;
  // A day and a half more than asked: the oldest local day starts before `days` × 24h ago.
  const time = foldYourTime(yourActs(now - (days + 1.5) * 24 * 60 * MIN), days, timezone, now);
  kept = { key, at: now, time };
  return time;
}
