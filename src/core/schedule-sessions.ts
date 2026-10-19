/**
 * Which sessions a schedule started (src/core/scheduler.ts).
 *
 * A one-time schedule is deleted once it has started its session, and a
 * recurring one keeps only its most recent: neither is a record of every
 * session a schedule began. This is, so one that has finished can be closed
 * without touching a session a person started.
 *
 * A plain table, created on first use: it is a fact about agentbox's own
 * starts, not one the provider's transcript or the sessions table can carry.
 */

import { getDb } from "./db";
import { dbPath } from "./paths";

/** The database whose schema this has already ensured: a changed one (tests) is a new one. */
let ensuredAt: string | null = null;

function ensure(): void {
  const path = dbPath();
  if (ensuredAt === path) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS schedule_sessions (
      session_id  TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      started_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedule_sessions_schedule ON schedule_sessions (schedule_id);
  `);
  ensuredAt = path;
}

/** Note that `scheduleId` started `sessionId`. */
export function markScheduled(sessionId: string, scheduleId: string, at: number): void {
  ensure();
  getDb().run(
    `INSERT INTO schedule_sessions (session_id, schedule_id, started_at) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET schedule_id = excluded.schedule_id`,
    [sessionId, scheduleId, at],
  );
}

/** Every open session a schedule started, newest first. */
export function listScheduledSessions(): { sessionId: string; scheduleId: string; startedAt: number }[] {
  ensure();
  const rows = getDb()
    .query(
      `SELECT ss.session_id, ss.schedule_id, ss.started_at
       FROM schedule_sessions ss JOIN sessions s ON s.id = ss.session_id
       WHERE s.archived_at IS NULL
       ORDER BY ss.started_at DESC`,
    )
    .all() as { session_id: string; schedule_id: string; started_at: number }[];
  return rows.map((r) => ({ sessionId: r.session_id, scheduleId: r.schedule_id, startedAt: r.started_at }));
}
