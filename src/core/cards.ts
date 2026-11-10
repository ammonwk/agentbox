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
 * taken back; once typed it cannot. A session with a decision open holds it
 * as it would a wait (`openAsks`): it may be parked, but it does not close
 * itself. Typed is not read: the answer is delivered once the asker has taken
 * a turn on it (`TAKEN`). Until then, and for good when the asker is gone, you
 * closed it, or it closes before reading it, the answer waits on the card
 * (`unread`), for whichever session asks (`agentbox card list --answered
 * --unread`) and says it has it (`card ack`). A session handed over to a
 * successor (`agentbox handover`) gives it its cards (`moveCards`), as it does
 * its children.
 *
 * A session can also ask by ending its turn `STATUS: needs …`, which only
 * someone opening the conversation reads. Once such a turn has sat an hour and
 * been parked, the ask becomes a card (`carryAsks`): one per session, which a
 * later ask of the same session rewrites. It closes the moment you say anything
 * to the session (`Fleet` "yours": typed, `agentbox send` at your terminal, a
 * card's answer typed in), when the session closes, and when its next turn ends
 * on no ask. A session with a card of its own open (the steward's, `card add`)
 * gets none: that one already asks.
 *
 * Cards are the user's, not a conversation, so they live in the database.
 * A decision's default and its time are the asker's to act on; agentbox only
 * shows that the time has passed.
 */

import { getDb } from "./db";
import { FleetError, type Fleet } from "./fleet";
import { turnStatus } from "./turnstatus";
import type { Card, CardKind, CardState, Session } from "./types";

export const CARD_KINDS: readonly CardKind[] = ["decision", "merged", "note"];
/** How long an answer waits before it is typed into the session: the undo. */
const UNDO_MS = 8_000;
/** New decisions inside this long are one push. */
const PUSH_BATCH_MS = 20_000;
/** How many answered and withdrawn cards the app is sent; the rest are in the database. */
const DONE_SHOWN = 200;
const TITLE_MAX = 200;
const SHORT_MAX = 1200;
const LONG_MAX = 200_000;
/** A turn that ended `STATUS: needs …` this long ago, parked, nobody having said anything since: the ask becomes a
 *  card. In the 7 days to 11-09 you answered 74% of such asks in the conversation within the hour, 84% within two. */
const ASK_AFTER_MS = 60 * 60_000;
/** One older than this is history (its work moved on, or you chose to leave it), not a new question. */
const ASK_WITHIN_MS = 24 * 60 * 60_000;
const ASK_CHECK_MS = 60_000;
/** The start of the key of a card `carryAsks` made. */
const ASK_KEY = "needs:";

type Row = {
  id: number; kind: CardKind; title: string; short: string; long: string | null; pr: string | null; options: string | null; recommend: string | null;
  default_text: string | null; default_at: number | null; key: string | null; session_id: string | null; about: string | null;
  state: CardState; answer: string | null; answered_at: number | null; delivered_at: number | null; tried_at: number | null;
  typed_at: number | null; taken: number; later_at: number | null; created_at: number; closed_why: string | null; undo: string | null;
};

/** A session has the answer: one said so (`ack`, which sets `delivered_at`),
 *  or the asker's transcript took a prompt after the answer was typed and the
 *  model was called after that. A prompt alone is not enough: 8utngauw
 *  recorded card 671's and was closed before any reply. Providers that do not
 *  report model calls (`lastTurnAt`) go by the prompt. */
const TAKEN = `(delivered_at IS NOT NULL OR COALESCE((SELECT json_extract(facts, '$.lastPromptAt') >= cards.typed_at
  AND COALESCE(json_extract(facts, '$.lastTurnAt'), json_extract(facts, '$.lastPromptAt')) >= cards.typed_at
  FROM sessions WHERE sessions.id = cards.session_id), 0))`;
const UNREAD = `state = 'answered' AND answer <> '' AND NOT ${TAKEN}`;
const CARDS = `SELECT cards.*, ${TAKEN} AS taken FROM cards`;

function toCard(r: Row, withLong: boolean): Card {
  return {
    id: r.id, kind: r.kind, title: r.title, short: r.short, hasLong: !!r.long, ...(withLong ? { long: r.long } : {}),
    pr: r.pr, options: r.options ? (JSON.parse(r.options) as string[]) : [], recommend: r.recommend, default: r.default_text, defaultAt: r.default_at, key: r.key,
    sessionId: r.session_id, about: r.about, state: r.state, answer: r.answer, answeredAt: r.answered_at,
    deliveredAt: r.delivered_at ?? (r.taken ? r.typed_at : null), unread: r.state === "answered" && !!r.answer && !r.taken,
    laterAt: r.later_at, createdAt: r.created_at, closedWhy: r.closed_why,
  };
}

export interface NewCard {
  kind: CardKind;
  title: string;
  short: string;
  long?: string | null;
  pr?: string | null;
  options?: string[];
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
    // A typed answer the asker never took waits on the card for the successor.
    `UPDATE cards SET session_id = ?, typed_at = NULL WHERE session_id = ? AND (state IN ('open','later') OR (${UNREAD}))`,
    [to, from],
  ).changes;
}

/** The sessions with a decision of theirs still open, and which: its answer
 *  comes back to them, so they are not finished (`Fleet.workHeld`). */
export function openAsks(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // An answer still in its undo window, not yet typed in, holds its session too: 11-09 the idle closer shut x4spn85d in
  // the seconds after Ammon answered card 1037 with an MFA code, and the answer, good for 30s, went nowhere.
  const rows = getDb().query(`SELECT id, session_id FROM cards WHERE kind = 'decision' AND session_id IS NOT NULL AND (state IN ('open','later')
    OR (state = 'answered' AND typed_at IS NULL AND delivered_at IS NULL AND answered_at > ?))`).all(Date.now() - 3_600_000) as { id: number; session_id: string }[];
  for (const r of rows) out.set(r.session_id, [...(out.get(r.session_id) ?? []), `card ${r.id}`]);
  return out;
}

/** The card the ask a session's last turn ended on (`STATUS: needs …`) makes;
 *  null when it ended on none. Its `lastMessage` is only the end of the
 *  message: the words above the line are for the caller to put in `long`. */
function askOf(s: Session): NewCard | null {
  const status = turnStatus(s.lastMessage);
  if (status?.kind !== "needs") return null;
  const ask = status.text.replace(/^needs\s+\S+[\s—:–-]*/i, "") || status.text;
  return {
    kind: "decision",
    title: /^.*?[?.](?=\s|$)/.exec(ask)?.[0] ?? ask,
    short: ask,
    recommend: /[^.;?!—]*\brecommend\b[^.;?!]*/i.exec(ask)?.[0]?.trim() ?? null,
    // The turn's: once you have said something to the session, only its next turn asks again.
    key: `${ASK_KEY}${s.id}:${s.lastActivityAt}`,
    sessionId: s.id,
    about: s.id,
  };
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
    this.fleet.on("yours", (id: string) => this.closeAsk(id, "you answered it in the conversation"));
    setInterval(() => void this.carryAsks().catch((e) => console.error("agentbox: asks:", e)), ASK_CHECK_MS).unref?.();
  }

  /** Close the card a session's ask became, if one is open. */
  private closeAsk(sessionId: string, why: string): void {
    const { changes } = getDb().run(
      `UPDATE cards SET state = 'closed', closed_why = ?, answered_at = ?, undo = NULL WHERE session_id = ? AND key LIKE '${ASK_KEY}%' AND state IN ('open','later')`,
      [why, this.now(), sessionId],
    );
    if (changes) this.changed();
  }

  /** A card for each ask left in a conversation an hour, kept to the session's latest ask, and closed once it has none. */
  private async carryAsks(): Promise<void> {
    const rows = getDb().query(`SELECT id, key, short, session_id, about FROM cards WHERE kind = 'decision' AND state IN ('open','later')`).all() as Pick<Row, "id" | "key" | "short" | "session_id" | "about">[];
    const asks = new Map(rows.filter((r) => r.key?.startsWith(ASK_KEY)).map((r) => [r.session_id!, r]));
    const covered = new Set(rows.filter((r) => !r.key?.startsWith(ASK_KEY)).flatMap((r) => [r.session_id, r.about]));
    const said = async (s: Session) => {
      const page = await this.fleet.timeline(s.id, null, 5).catch(() => null);
      const last = page?.events.filter((e) => e.kind === "assistant").at(-1);
      return last?.kind === "assistant" ? last.text.slice(0, LONG_MAX) : null;
    };
    const now = this.now();
    for (const [id, card] of asks) {
      let s: Session;
      try {
        s = this.fleet.get(id);
      } catch {
        s = { closedAt: now } as Session;
      }
      if (s.closedAt !== null) this.closeAsk(id, "the session closed");
      else if (covered.has(id)) this.closeAsk(id, "the session asked with a card of its own");
      // Mid-turn, or told something it has not answered yet: the ask stands until that turn ends.
      else if ((s.status !== "waiting" && s.status !== "stopped") || (s.saidAt !== null && s.saidAt > s.lastActivityAt)) continue;
      else {
        const ask = askOf(s);
        if (!ask) this.closeAsk(id, "its next turn ended without asking");
        else if (ask.short.trim().slice(0, SHORT_MAX) !== card.short) {
          getDb().run(`UPDATE OR IGNORE cards SET title = ?, short = ?, long = ?, recommend = ?, key = ? WHERE id = ?`, [
            ask.title.trim().slice(0, TITLE_MAX), ask.short.trim().slice(0, SHORT_MAX), await said(s), ask.recommend ?? null, ask.key!, card.id,
          ]);
          this.changed();
        }
      }
    }
    for (const s of this.fleet.sessions()) {
      if (asks.has(s.id) || covered.has(s.id) || s.closedAt !== null || s.parkedAt === null || s.subagent || s.quiet) continue;
      const age = now - s.lastActivityAt;
      if (age < ASK_AFTER_MS || age > ASK_WITHIN_MS || (s.saidAt !== null && s.saidAt > s.lastActivityAt)) continue;
      const ask = askOf(s);
      if (!ask || getDb().query("SELECT 1 FROM cards WHERE key = ?").get(ask.key!)) continue;
      this.add({ ...ask, long: await said(s) });
    }
  }

  private row(id: number): Row {
    const r = getDb().query(`${CARDS} WHERE id = ?`).get(id) as Row | null;
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
    if (f.unread) where.push(UNREAD);
    if (f.sessionId) {
      where.push("session_id = ?");
      args.push(f.sessionId);
    }
    const rows = getDb().query(`${CARDS} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`).all(...args) as Row[];
    return rows.map((r) => toCard(r, false));
  }

  /** What the app is sent: every card still to be answered, and the newest of the rest. */
  shown(): Card[] {
    const db = getDb();
    const open = db.query(`${CARDS} WHERE state IN ('open','later') ORDER BY id DESC`).all() as Row[];
    const done = db.query(`${CARDS} WHERE state IN ('answered','closed') ORDER BY COALESCE(answered_at, created_at) DESC LIMIT ${DONE_SHOWN}`).all() as Row[];
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
      const have = getDb().query(`${CARDS} WHERE key = ?`).get(key) as Row | null;
      if (have) return toCard(have, false);
    }
    const text = (v: string | null | undefined, max = SHORT_MAX) => v?.trim().slice(0, max) || null;
    const options = (c.options ?? []).map((o) => text(o)).filter(Boolean);
    const { lastInsertRowid } = getDb().run(
      `INSERT INTO cards (kind, title, short, long, pr, options, recommend, default_text, default_at, key, session_id, about, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [c.kind, title, short, text(c.long, LONG_MAX), text(c.pr, 500), options.length ? JSON.stringify(options) : null, text(c.recommend), text(c.default), c.defaultAt ?? null, key, c.sessionId ?? null, c.about ?? null, Math.min(c.at ?? this.now(), this.now())],
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
    if (r.state === "answered" && (r.taken || r.typed_at !== null)) throw new FleetError(409, `card ${id} was answered already, and the answer has gone to its session`);
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

  /** Keep it for later. */
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
   *  was closed is left alone: the answer waits on the card, as it does until
   *  the asker takes a turn on it (`TAKEN`). `closedAt`, not
   *  its status: a stopped child under a stopped parent reads "closed" on the
   *  board and is resumed like any parked session. */
  private async deliver(id: number): Promise<void> {
    const r = this.row(id);
    if (r.state !== "answered" || !r.answer || r.delivered_at !== null || r.tried_at !== null) return;
    // Not before its undo has run out: an answer taken back and given again starts the wait over.
    if (this.now() < (r.answered_at ?? 0) + UNDO_MS - 250) return;
    getDb().run(`UPDATE cards SET tried_at = ? WHERE id = ?`, [this.now(), id]);
    this.changed();
    if (!r.session_id) return;
    let closedAt: number | null;
    try {
      closedAt = this.fleet.get(r.session_id).closedAt;
    } catch {
      return;
    }
    if (closedAt !== null) return;
    // Taken before it goes in: the prompt the transcript records is later.
    const at = this.now();
    try {
      await this.fleet.send(r.session_id, `[card ${r.id} “${r.title}”] ${r.answer}`, undefined, true);
    } catch (e) {
      console.error(`agentbox: card ${id}: its answer could not be typed into ${r.session_id}, and waits on the card: ${(e as Error).message}`);
      return;
    }
    getDb().run(`UPDATE cards SET typed_at = ?, undo = NULL WHERE id = ?`, [at, id]);
    this.changed();
  }
}
