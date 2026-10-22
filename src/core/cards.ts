/**
 * Cards: what a session hands the user to decide or to know, and the user's
 * answer on its way back to the session that asked.
 *
 * A session adds a card (`agentbox card add`): a decision the user owes, a
 * pull request that merged, a note. The app's Review page shows them one at
 * a time. An answer is typed into the asking session as the user's own
 * words, `[card 12 “title”] …`, through the send path, which wakes a parked
 * session and resumes a stopped one. An empty answer means "seen" and is
 * typed nowhere: forty merged cards must not wake their session forty times.
 *
 * The answer is held `UNDO_MS` before it is typed, so the last gesture can be
 * taken back; once typed it cannot. When the asking session is gone or
 * closed the answer waits on the card (`unread`), for whichever session asks
 * (`agentbox card list --answered --unread`) and says it has it (`card ack`).
 * An agent whose main conversation is replaced gives the old one's cards
 * to the new one (`moveCards`), as it does its children.
 *
 * Cards are the user's, not a conversation, so they live in the database.
 * A decision's default and its time are the asker's to act on; agentbox only
 * shows that the time has passed.
 */

import { getDb } from "./db";
import { FleetError, type Fleet } from "./fleet";
import type { Card, CardKind, CardState } from "./types";

export const CARD_KINDS: readonly CardKind[] = ["decision", "merged", "note"];
/** How long an answer waits before it is typed into the session: the undo. */
export const UNDO_MS = 8_000;
/** New decisions inside this long are one push. */
const PUSH_BATCH_MS = 20_000;
/** How many answered and withdrawn cards the app is sent; the rest are in the database. */
const DONE_SHOWN = 200;
const TITLE_MAX = 200;
const SHORT_MAX = 1200;
const LONG_MAX = 200_000;

type Row = {
  id: number; kind: CardKind; title: string; short: string; long: string | null; pr: string | null; recommend: string | null;
  default_text: string | null; default_at: number | null; key: string | null; session_id: string | null; about: string | null;
  state: CardState; answer: string | null; answered_at: number | null; delivered_at: number | null; tried_at: number | null;
  later_at: number | null; created_at: number; closed_why: string | null; undo: string | null;
};

function toCard(r: Row, withLong: boolean): Card {
  return {
    id: r.id, kind: r.kind, title: r.title, short: r.short, hasLong: !!r.long, ...(withLong ? { long: r.long } : {}),
    pr: r.pr, recommend: r.recommend, default: r.default_text, defaultAt: r.default_at, key: r.key,
    sessionId: r.session_id, about: r.about, state: r.state, answer: r.answer, answeredAt: r.answered_at,
    deliveredAt: r.delivered_at, unread: r.state === "answered" && !!r.answer && r.delivered_at === null,
    laterAt: r.later_at, createdAt: r.created_at, closedWhy: r.closed_why,
  };
}

export interface NewCard {
  kind: CardKind;
  title: string;
  short: string;
  long?: string | null;
  pr?: string | null;
  recommend?: string | null;
  default?: string | null;
  defaultAt?: number | null;
  key?: string | null;
  sessionId?: string | null;
  about?: string | null;
  /** When it happened, for one added after the fact; never later than now. */
  at?: number | null;
  /** False: a decision that does not push to your devices (an agent's Feed already shows it). */
  notify?: boolean;
}

export interface CardFilter {
  state?: CardState;
  unread?: boolean;
  sessionId?: string;
}

/** Cards of a session that is being replaced go to the one that follows it:
 *  those still to be answered, and answers it never got. */
export function moveCards(from: string, to: string): number {
  return getDb().run(
    `UPDATE cards SET session_id = ? WHERE session_id = ? AND (state IN ('open','later') OR (state = 'answered' AND delivered_at IS NULL AND answer <> ''))`,
    [to, from],
  ).changes;
}

export class Cards {
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushing: Card[] = [];

  constructor(
    private readonly fleet: Fleet,
    /** Something changed that the app state shows. */
    private readonly changed: () => void,
    /** New decisions, once per batch. */
    private readonly push: (cards: Card[]) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Answers the last server did not get to: typed now, each tried once. */
  start(): void {
    const rows = getDb().query(`SELECT * FROM cards WHERE state = 'answered' AND answer <> '' AND delivered_at IS NULL AND tried_at IS NULL`).all() as Row[];
    for (const r of rows) this.deliverLater(r.id, Math.max(0, (r.answered_at ?? 0) + UNDO_MS - this.now()));
  }

  private row(id: number): Row {
    const r = getDb().query("SELECT * FROM cards WHERE id = ?").get(id) as Row | null;
    if (!r) throw new FleetError(404, `no card ${id}`);
    return r;
  }

  get(id: number): Card {
    return toCard(this.row(id), true);
  }

  /** Newest first. */
  list(f: CardFilter = {}): Card[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (f.state) {
      where.push("state = ?");
      args.push(f.state);
    }
    if (f.unread) where.push("state = 'answered' AND answer <> '' AND delivered_at IS NULL");
    if (f.sessionId) {
      where.push("session_id = ?");
      args.push(f.sessionId);
    }
    const rows = getDb().query(`SELECT * FROM cards ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`).all(...args) as Row[];
    return rows.map((r) => toCard(r, false));
  }

  /** What the app is sent: every card still to be answered, and the newest of the rest. */
  shown(): Card[] {
    const db = getDb();
    const open = db.query(`SELECT * FROM cards WHERE state IN ('open','later') ORDER BY id DESC`).all() as Row[];
    const done = db.query(`SELECT * FROM cards WHERE state IN ('answered','closed') ORDER BY COALESCE(answered_at, created_at) DESC LIMIT ${DONE_SHOWN}`).all() as Row[];
    return [...open, ...done].map((r) => toCard(r, false));
  }

  /** Add one; with a `key` already used, the card that has it, untouched. */
  add(c: NewCard): Card {
    if (!CARD_KINDS.includes(c.kind)) throw new FleetError(400, `a card's kind is one of ${CARD_KINDS.join(", ")}`);
    const title = c.title.trim().slice(0, TITLE_MAX);
    const short = c.short.trim().slice(0, SHORT_MAX);
    if (!title || !short) throw new FleetError(400, "a card needs a title and a short version");
    const key = c.key?.trim() || null;
    if (key) {
      const have = getDb().query("SELECT * FROM cards WHERE key = ?").get(key) as Row | null;
      if (have) return toCard(have, false);
    }
    const text = (v: string | null | undefined, max = SHORT_MAX) => v?.trim().slice(0, max) || null;
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO cards (kind, title, short, long, pr, recommend, default_text, default_at, key, session_id, about, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [c.kind, title, short, text(c.long, LONG_MAX), text(c.pr, 500), text(c.recommend), text(c.default), c.defaultAt ?? null, key, c.sessionId ?? null, c.about ?? null, Math.min(c.at ?? this.now(), this.now())],
    );
    const card = this.get(Number(lastInsertRowid));
    this.changed();
    if (card.kind === "decision" && c.notify !== false) this.pushSoon(card);
    return card;
  }

  private pushSoon(card: Card): void {
    this.pushing.push(card);
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const batch = this.pushing.filter((c) => this.row(c.id).state === "open");
      this.pushing = [];
      if (batch.length) this.push(batch);
    }, PUSH_BATCH_MS);
    this.pushTimer.unref?.();
  }

  /** The user's answer; "" for a card that only wanted seeing. Typed into the
   *  asking session after `UNDO_MS`, unless taken back. */
  answer(id: number, text: string): Card {
    const r = this.row(id);
    if (r.state === "closed") throw new FleetError(409, `card ${id} was withdrawn: ${r.closed_why ?? "the question went away"}`);
    if (r.state === "answered" && r.delivered_at !== null) throw new FleetError(409, `card ${id} was answered already, and the answer has gone to its session`);
    const answer = text.trim();
    if (!answer && r.kind === "decision") throw new FleetError(400, "a decision needs an answer; keep it for later instead");
    const at = this.now();
    getDb().run(`UPDATE cards SET state = 'answered', answer = ?, answered_at = ?, tried_at = NULL, undo = ? WHERE id = ?`, [
      answer, at, JSON.stringify({ state: r.state === "answered" ? "open" : r.state, laterAt: r.later_at }), id,
    ]);
    if (answer) this.deliverLater(id, UNDO_MS);
    this.changed();
    return this.get(id);
  }

  /** Keep it for later: to the back of the stack. */
  later(id: number): Card {
    const r = this.row(id);
    if (r.state !== "open" && r.state !== "later") throw new FleetError(409, `card ${id} is ${r.state}`);
    getDb().run(`UPDATE cards SET state = 'later', later_at = ?, undo = ? WHERE id = ?`, [this.now(), JSON.stringify({ state: r.state, laterAt: r.later_at }), id]);
    this.changed();
    return this.get(id);
  }

  /** Take back the last thing done to it: an answer not yet typed, a "later". */
  undo(id: number): Card {
    const r = this.row(id);
    if (!r.undo) throw new FleetError(409, `nothing to undo on card ${id}`);
    if (r.state === "answered" && (r.delivered_at !== null || r.tried_at !== null)) throw new FleetError(409, "the answer has already gone to its session");
    const was = JSON.parse(r.undo) as { state: CardState; laterAt: number | null };
    getDb().run(`UPDATE cards SET state = ?, later_at = ?, answer = NULL, answered_at = NULL, undo = NULL WHERE id = ?`, [was.state, was.laterAt, id]);
    this.changed();
    return this.get(id);
  }

  /** The asker withdraws it. */
  close(id: number, why: string): Card {
    const r = this.row(id);
    if (r.state === "answered") throw new FleetError(409, `card ${id} was answered already`);
    getDb().run(`UPDATE cards SET state = 'closed', closed_why = ?, answered_at = ?, undo = NULL WHERE id = ?`, [why.trim() || null, this.now(), id]);
    this.changed();
    return this.get(id);
  }

  /** A session has the answer that was waiting on the card. */
  ack(id: number): Card {
    const r = this.row(id);
    if (r.state !== "answered") throw new FleetError(409, `card ${id} has no answer yet`);
    if (r.delivered_at === null) getDb().run(`UPDATE cards SET delivered_at = ?, undo = NULL WHERE id = ?`, [this.now(), id]);
    this.changed();
    return this.get(id);
  }

  private deliverLater(id: number, ms: number): void {
    const t = setTimeout(() => void this.deliver(id).catch((e) => console.error(`agentbox: card ${id}:`, e)), ms);
    t.unref?.();
  }

  /** Type the answer into the session that asked, once. One that is gone or
   *  closed is left alone: the answer waits on the card. */
  private async deliver(id: number): Promise<void> {
    const r = this.row(id);
    if (r.state !== "answered" || !r.answer || r.delivered_at !== null || r.tried_at !== null) return;
    // Not before its undo has run out: an answer taken back and given again starts the wait over.
    if (this.now() < (r.answered_at ?? 0) + UNDO_MS - 250) return;
    getDb().run(`UPDATE cards SET tried_at = ? WHERE id = ?`, [this.now(), id]);
    this.changed();
    if (!r.session_id) return;
    let status: string;
    try {
      status = this.fleet.get(r.session_id).status;
    } catch {
      return;
    }
    if (status === "closed") return;
    try {
      await this.fleet.send(r.session_id, `[card ${r.id} “${r.title}”] ${r.answer}`, undefined, true);
    } catch (e) {
      console.error(`agentbox: card ${id}: its answer could not be typed into ${r.session_id}, and waits on the card: ${(e as Error).message}`);
      return;
    }
    getDb().run(`UPDATE cards SET delivered_at = ?, undo = NULL WHERE id = ?`, [this.now(), id]);
    this.changed();
  }
}
