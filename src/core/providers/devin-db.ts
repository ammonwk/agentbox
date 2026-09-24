/** Read-only access to devin's `sessions.db`.
 *
 * The database is written by every live devin process (it is 2.4 GB on a
 * working machine, WAL mode), so everything here is a small indexed query on a
 * read-only connection, and a busy or locked database is an answer of "no new
 * information" (null), never an exception. Callers keep their last good value.
 *
 * Tables used (devin 3000.11):
 *   sessions(id, working_directory, model, agent_mode, created_at,
 *            last_activity_at, title, hidden, …)   — times in epoch SECONDS
 *   prompt_history(id, content, timestamp, session_id, is_shell)
 *
 * `prompt_history` is written when a prompt is SENT, while the transcript
 * export and `last_activity_at` land when the turn ends — which is what lets
 * the reader tell that a turn is in progress.
 */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

export interface DevinSessionRow {
  id: string;
  working_directory: string;
  model: string;
  created_at: number;
  last_activity_at: number;
  title: string | null;
}

export interface DevinPrompt {
  id: number;
  content: string;
  timestamp: number;
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
    // Wait briefly for a writer's lock rather than failing the poll outright.
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

const SESSION_COLS = "id, working_directory, model, created_at, last_activity_at, title";

export function sessionsSince(path: string, sinceSec: number): DevinSessionRow[] | null {
  return q(path, (db) =>
    db
      .query(`SELECT ${SESSION_COLS} FROM sessions WHERE last_activity_at >= ? AND hidden = 0`)
      .all(sinceSec) as DevinSessionRow[],
  );
}

export function sessionById(path: string, id: string): DevinSessionRow | null {
  return q(path, (db) => (db.query(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id) as DevinSessionRow) ?? null);
}

/** Newest prompt time per session for prompts sent at or after `sinceSec` —
 *  a session whose turn is running has a prompt newer than its activity. */
export function promptTimesSince(path: string, sinceSec: number): Map<string, number> | null {
  return q(path, (db) => {
    const rows = db
      .query(
        "SELECT session_id, MAX(timestamp) AS t FROM prompt_history WHERE timestamp >= ? AND is_shell = 0 GROUP BY session_id",
      )
      .all(sinceSec) as { session_id: string; t: number }[];
    return new Map(rows.map((r) => [r.session_id, r.t]));
  });
}

/** A cheap signature of a session's prompts, to skip refetching them. */
export function promptHead(path: string, id: string): { maxId: number; count: number } | null {
  return q(path, (db) => {
    const r = db
      .query("SELECT COALESCE(MAX(id), 0) AS maxId, COUNT(*) AS count FROM prompt_history WHERE session_id = ? AND is_shell = 0")
      .get(id) as { maxId: number; count: number };
    return r;
  });
}

export function promptsOf(path: string, id: string): DevinPrompt[] | null {
  return q(
    path,
    (db) =>
      db
        .query("SELECT id, content, timestamp FROM prompt_history WHERE session_id = ? AND is_shell = 0 ORDER BY id")
        .all(id) as DevinPrompt[],
  );
}

/** For tests: drop cached handles so a fixture can be deleted. */
export function closeDevinDbs(): void {
  for (const h of handles.values()) h.db.close();
  handles.clear();
}
