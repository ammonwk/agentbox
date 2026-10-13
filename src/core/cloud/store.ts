/** The local half of the mailbox, in `cloud/cloud.db` (its own file, so
 *  the cloud never touches box.db's migrations).
 *
 *  - `outbox`: messages this machine's agents sent, until the cloud takes
 *    them. A message is kept here only while it is not yet accepted, so an
 *    agent can send while offline; its body is dropped once the cloud has it
 *    or gives a final no. Its client id makes a retry the same message.
 *  - `inbox`: what this machine did with each message the cloud leased to
 *    it, and whether the cloud has heard. Never the body: the agent's
 *    transcript is the record of what it was told.
 *  - `kv`: the last workspace directory, so a machine is found by name while
 *    the cloud cannot be reached. */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { ensureCloudDir } from "./config";

export type OutboxState = "pending" | "accepted" | "refused" | "abandoned";
export interface OutboxRow {
  client_id: string;
  /** What was asked, hashed: the same id with another message is refused. */
  fingerprint: string;
  target: string;
  target_name: string;
  target_agent: string | null;
  sender_agent: string | null;
  body: string | null;
  wake: number;
  created_at: number;
  state: OutboxState;
  message_id: string | null;
  error: string | null;
  tries: number;
  next_try_at: number;
}

export type InboxOutcome = "delivered" | "refused" | "failed" | "uncertain";
export interface InboxRow {
  message_id: string;
  /** The installation it was sent to: only that credential can answer for it. */
  installation_id: string;
  session_id: string | null;
  receipt_id: string | null;
  outcome: InboxOutcome | null;
  reason: string | null;
  acked: number;
  at: number;
}

const MIGRATIONS = [
  `
  CREATE TABLE outbox (
    client_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    target TEXT NOT NULL,
    target_name TEXT NOT NULL,
    target_agent TEXT,
    sender_agent TEXT,
    body TEXT,
    wake INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    message_id TEXT,
    error TEXT,
    tries INTEGER NOT NULL DEFAULT 0,
    next_try_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX outbox_pending ON outbox(state, next_try_at);
  CREATE TABLE inbox (
    message_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    session_id TEXT,
    receipt_id TEXT,
    outcome TEXT,
    reason TEXT,
    acked INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  );
  CREATE INDEX inbox_unacked ON inbox(installation_id, acked) WHERE acked = 0;
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

/** A pending message the cloud has not taken within a day is given up. */
export const OUTBOX_TTL_MS = 24 * 60 * 60_000;

export class CloudStore {
  readonly db: Database;

  constructor(path = join(ensureCloudDir(), "cloud.db")) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    const v = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      })();
    }
  }

  // ---- outbox

  outbox(clientId: string): OutboxRow | null {
    return this.db.query("SELECT * FROM outbox WHERE client_id = ?").get(clientId) as OutboxRow | null;
  }

  queue(r: Pick<OutboxRow, "client_id" | "fingerprint" | "target" | "target_name" | "target_agent" | "sender_agent" | "body"> & { wake: boolean }, now: number): OutboxRow {
    this.db
      .query(
        `INSERT INTO outbox (client_id, fingerprint, target, target_name, target_agent, sender_agent, body, wake, created_at, state, next_try_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`,
      )
      .run(r.client_id, r.fingerprint, r.target, r.target_name, r.target_agent, r.sender_agent, r.body, r.wake ? 1 : 0, now);
    return this.outbox(r.client_id)!;
  }

  due(now: number): OutboxRow[] {
    return this.db.query("SELECT * FROM outbox WHERE state = 'pending' AND next_try_at <= ? ORDER BY created_at LIMIT 50").all(now) as OutboxRow[];
  }

  accepted(clientId: string, messageId: string): void {
    this.db.query("UPDATE outbox SET state = 'accepted', message_id = ?, body = NULL, error = NULL WHERE client_id = ?").run(messageId, clientId);
  }

  refused(clientId: string, error: string): void {
    this.db.query("UPDATE outbox SET state = 'refused', body = NULL, error = ? WHERE client_id = ?").run(error, clientId);
  }

  /** Not reached: try again later, backing off to five minutes. A message
   *  older than a day is given up. */
  retryLater(clientId: string, error: string, now: number): void {
    const row = this.outbox(clientId);
    if (!row) return;
    if (now - row.created_at > OUTBOX_TTL_MS) {
      this.db.query("UPDATE outbox SET state = 'abandoned', body = NULL, error = ? WHERE client_id = ?").run(`the cloud could not be reached for a day: ${error}`, clientId);
      return;
    }
    const wait = Math.min(300_000, 2_000 * 2 ** row.tries);
    this.db.query("UPDATE outbox SET tries = tries + 1, next_try_at = ?, error = ? WHERE client_id = ?").run(now + wait, error, clientId);
  }

  recentOutbox(limit = 50): OutboxRow[] {
    return this.db.query("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?").all(limit) as OutboxRow[];
  }

  // ---- kv

  get<T>(key: string): T | null {
    const row = this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  put(key: string, value: unknown): void {
    this.db.query("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
  }

  // ---- inbox

  inbox(messageId: string): InboxRow | null {
    return this.db.query("SELECT * FROM inbox WHERE message_id = ?").get(messageId) as InboxRow | null;
  }

  /** The boundary before typing: once this is written, the message is never
   *  typed again, whatever happens next. */
  begin(messageId: string, installationId: string, sessionId: string, receiptId: string, now: number): void {
    this.db.exec("PRAGMA synchronous = FULL");
    try {
      this.db
        .query("INSERT INTO inbox (message_id, installation_id, session_id, receipt_id, at) VALUES (?, ?, ?, ?, ?)")
        .run(messageId, installationId, sessionId, receiptId, now);
    } finally {
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
  }

  decide(messageId: string, installationId: string, outcome: InboxOutcome, reason: string | null, now: number): void {
    this.db
      .query(
        `INSERT INTO inbox (message_id, installation_id, outcome, reason, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO UPDATE SET outcome = excluded.outcome, reason = excluded.reason, at = excluded.at`,
      )
      .run(messageId, installationId, outcome, reason, now);
  }

  acked(messageId: string): void {
    this.db.query("UPDATE inbox SET acked = 1 WHERE message_id = ?").run(messageId);
  }

  unacked(installationId: string): InboxRow[] {
    return this.db.query("SELECT * FROM inbox WHERE installation_id = ? AND acked = 0 AND outcome IS NOT NULL LIMIT 100").all(installationId) as InboxRow[];
  }

  counts(): { outbox: Record<string, number>; inbox: Record<string, number> } {
    const tally = (sql: string) => Object.fromEntries((this.db.query(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]));
    return {
      outbox: tally("SELECT state AS k, count(*) AS n FROM outbox GROUP BY state"),
      inbox: tally("SELECT coalesce(outcome, 'delivering') AS k, count(*) AS n FROM inbox GROUP BY 1"),
    };
  }
}
