/** Access to opencode's `opencode.db`: read-only.
 *
 * Every opencode server writes it (the background service and each
 * `--standalone` TUI's private one); it is gigabytes on a working machine, in
 * WAL mode. So everything here is a small indexed query on a read-only
 * connection, and a busy or locked database is an answer of "no new
 * information" (null), never an exception. Callers keep their last good value.
 *
 * Tables used (opencode 2.0):
 *   session_v2(id, parent_id, directory, title, model, time_created,
 *              time_updated, time_idle, time_viewed, time_archived,
 *              tokens_*, cost, …)                     — times in epoch ms
 *   session_message(id, session_id, type, seq, time_created, time_updated,
 *              data)   — indexed on (session_id, seq) and
 *              (session_id, time_created, id). Rows are written as events
 *              happen and an assistant row is UPDATED in place while its step
 *              runs (text streams in, tools go running → completed).
 *   event_sequence(aggregate_id, seq) — a session's event counter. A message
 *              row takes the seq of the event that created it, and updates
 *              take seqs of their own, so this moves on any change at all.
 *
 * The pre-2.0 tables (`session`, `message`, `part`) are not read: opencode
 * migrated what it kept into these.
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

export interface OpencodeSessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string | null;
  /** JSON `{id, providerID, variant?}`, or null. */
  model: string | null;
  time_created: number;
  time_updated: number;
  time_idle: number | null;
  time_viewed: number | null;
}

/** A listed session with when its newest message was written: the session
 *  row is not touched by every message, so its own times lag. */
export interface OpencodeListedRow extends OpencodeSessionRow {
  last_msg: number | null;
}

export interface OpencodeMessageRow {
  seq: number;
  type: string;
  time_created: number;
  time_updated: number;
  data: string;
}

export interface OpencodeChildRow {
  id: string;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
}

interface Handle {
  db: Database;
  ino: number;
}

const handles = new Map<string, Handle>();

function open(path: string): Database | null {
  let ino: number;
  try {
    ino = statSync(path).ino;
  } catch {
    const h = handles.get(path);
    h?.db.close();
    handles.delete(path);
    return null;
  }
  const cached = handles.get(path);
  if (cached && cached.ino === ino) return cached.db;
  cached?.db.close();
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 200");
    handles.set(path, { db, ino });
    return db;
  } catch {
    handles.delete(path);
    return null;
  }
}

/** Run a query; null on any SQLite error (busy, locked, schema drift). */
function q<T>(path: string, fn: (db: Database) => T): T | null {
  const db = open(path);
  if (!db) return null;
  try {
    return fn(db);
  } catch {
    return null;
  }
}

const SESSION_COLS = "id, parent_id, directory, title, model, time_created, time_updated, time_idle, time_viewed";

/**
 * Top-level, unarchived sessions with anything at or after `sinceMs`. The
 * newest message's time comes from the (session_id, time_created) index, one
 * lookup a session; the session table itself is small (hundreds of rows).
 */
export function sessionsSince(path: string, sinceMs: number): OpencodeListedRow[] | null {
  return q(path, (db) =>
    db
      .query(
        `SELECT ${SESSION_COLS}, (SELECT MAX(m.time_created) FROM session_message m WHERE m.session_id = s.id) AS last_msg
         FROM session_v2 s
         WHERE s.parent_id IS NULL AND s.time_archived IS NULL
           AND (s.time_updated >= ?1 OR s.time_created >= ?1 OR s.time_idle >= ?1 OR s.time_viewed >= ?1)`,
      )
      .all(sinceMs) as OpencodeListedRow[],
  );
}

export function sessionById(path: string, id: string): OpencodeSessionRow | null {
  return q(path, (db) => (db.query(`SELECT ${SESSION_COLS} FROM session_v2 WHERE id = ?`).get(id) as OpencodeSessionRow) ?? null);
}

/** Top-level sessions in `directory` touched (made, viewed, or gone idle) at
 *  or after `sinceMs` — the candidates for a TUI started then. */
export function sessionsTouchedIn(path: string, sinceMs: number): OpencodeSessionRow[] | null {
  return q(path, (db) =>
    db
      .query(
        `SELECT ${SESSION_COLS} FROM session_v2
         WHERE parent_id IS NULL AND (time_created >= ?1 OR time_viewed >= ?1 OR time_idle >= ?1)`,
      )
      .all(sinceMs) as OpencodeSessionRow[],
  );
}

/** The session's event counter; moves on any change to its messages. */
export function eventSeq(path: string, id: string): number | null {
  return q(path, (db) => (db.query("SELECT seq FROM event_sequence WHERE aggregate_id = ?").get(id) as { seq: number } | null)?.seq ?? 0);
}

/** A session's messages from `fromSeq` on, oldest first. */
export function messagesFrom(path: string, id: string, fromSeq: number): OpencodeMessageRow[] | null {
  return q(
    path,
    (db) =>
      db
        .query("SELECT seq, type, time_created, time_updated, data FROM session_message WHERE session_id = ? AND seq >= ? ORDER BY seq")
        .all(id, fromSeq) as OpencodeMessageRow[],
  );
}

/** Messages by seq, for the rows a timeline page shows. */
export function messagesBySeq(path: string, id: string, seqs: readonly number[]): Map<number, OpencodeMessageRow> | null {
  return q(path, (db) => {
    const out = new Map<number, OpencodeMessageRow>();
    for (let i = 0; i < seqs.length; i += 500) {
      const part = seqs.slice(i, i + 500);
      const rows = db
        .query(
          `SELECT seq, type, time_created, time_updated, data FROM session_message WHERE session_id = ? AND seq IN (${part.map(() => "?").join(",")})`,
        )
        .all(id, ...part) as OpencodeMessageRow[];
      for (const r of rows) out.set(r.seq, r);
    }
    return out;
  });
}

/** Sessions a session started (its subagents), with their running token
 *  totals. Not indexed, but the table is small. */
export function childrenOf(path: string, ids: readonly string[]): OpencodeChildRow[] | null {
  if (ids.length === 0) return [];
  return q(
    path,
    (db) =>
      db
        .query(
          `SELECT id, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write FROM session_v2 WHERE parent_id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids) as OpencodeChildRow[],
  );
}

/** For tests: drop cached handles so a fixture can be deleted. */
export function closeOpencodeDbs(): void {
  for (const h of handles.values()) h.db.close();
  handles.clear();
}
