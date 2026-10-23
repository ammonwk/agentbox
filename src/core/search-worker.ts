/** The worker that keeps `search.ts`'s index: given every session, it reads
 *  what each transcript gained since the last pass and posts back when done. */

import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { adapterFor } from "./providers";
import { transcriptFile, type TranscriptRef, type TranscriptReader } from "./providers/types";
import { openReader } from "./readercache";
import { searchDbPath, SEARCH_VERSION, type IndexJob } from "./search";
import type { TimelineEvent } from "./types";

declare const self: Worker;

/** A pasted log is not what anyone searches a conversation for. */
const TEXT_CAP = 20_000;
const PAGE = 1000;

function open(): Database {
  mkdirSync(dirname(searchDbPath()), { recursive: true });
  const db = new Database(searchDbPath(), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version !== SEARCH_VERSION) {
    db.exec(`DROP TABLE IF EXISTS progress; DROP TABLE IF EXISTS said; DROP TABLE IF EXISTS said_fts;`);
    db.exec(`PRAGMA user_version = ${SEARCH_VERSION}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS progress (session TEXT PRIMARY KEY, size INTEGER NOT NULL, cursor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS said (id INTEGER PRIMARY KEY, session TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (session, event));
    CREATE VIRTUAL TABLE IF NOT EXISTS said_fts USING fts5(text, content = 'said', content_rowid = 'id', tokenize = 'trigram');
    CREATE TRIGGER IF NOT EXISTS said_ai AFTER INSERT ON said BEGIN INSERT INTO said_fts (rowid, text) VALUES (new.id, new.text); END;
    CREATE TRIGGER IF NOT EXISTS said_ad AFTER DELETE ON said BEGIN INSERT INTO said_fts (said_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
  `);
  return db;
}

const db = open();
const progressOf = db.query("SELECT size, cursor FROM progress WHERE session = ?");
const setProgress = db.query("INSERT OR REPLACE INTO progress (session, size, cursor) VALUES (?, ?, ?)");
const forget = db.query("DELETE FROM said WHERE session = ?");
// An event comes again when it grew (devin's newest message): the newer text
// wins. Deleted by hand, since a REPLACE's delete fires no trigger.
const drop = db.query("DELETE FROM said WHERE session = ? AND event = ?");
const put = db.query("INSERT INTO said (session, event, at, kind, text) VALUES (?, ?, ?, ?, ?)");

function store(session: string, events: readonly TimelineEvent[]): void {
  for (const ev of events) {
    if ((ev.kind !== "user" && ev.kind !== "assistant") || !ev.text.trim()) continue;
    drop.run(session, ev.id);
    put.run(session, ev.id, ev.at, ev.kind, ev.text.slice(0, TEXT_CAP));
  }
}

/** Everything in the transcript, newest page first. */
async function readAll(session: string, reader: TranscriptReader): Promise<string> {
  let cursor = "";
  let before: string | null = null;
  do {
    const page = await reader.timeline({ before, limit: PAGE });
    if (!cursor) cursor = page.cursor;
    store(session, page.events);
    before = page.before;
  } while (before);
  return cursor;
}

async function catchUp(id: string, ref: TranscriptRef): Promise<boolean> {
  let size: number;
  try {
    size = statSync(transcriptFile(ref.path)).size;
  } catch {
    return false; // gone from disk
  }
  const done = progressOf.get(id) as { size: number; cursor: string } | null;
  if (done && done.size === size) return false;
  const { reader } = openReader(adapterFor(ref.provider), ref);
  if (done) {
    const next = await reader.since(done.cursor);
    if (!next.reset) {
      db.transaction(() => {
        store(id, next.events);
        setProgress.run(id, size, next.cursor);
      })();
      return true;
    }
  }
  // From the start, in one transaction: queries see the old rows until it commits.
  db.exec("BEGIN");
  try {
    forget.run(id);
    setProgress.run(id, size, await readAll(id, reader));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return true;
}

self.onmessage = async (e: MessageEvent<IndexJob>) => {
  const started = performance.now();
  let read = 0;
  for (const { id, ref } of e.data.sessions) {
    try {
      if (await catchUp(id, ref)) read++;
    } catch {
      // an unreadable transcript is skipped, and tried again next pass
    }
  }
  if (read > 20) console.log(`agentbox: indexed what was said in ${read} sessions in ${Math.round((performance.now() - started) / 1000)}s`);
  self.postMessage(read);
};
