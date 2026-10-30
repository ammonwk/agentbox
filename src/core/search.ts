/** What was said in every session, searchable: the part of the rail's search
 *  under the sessions whose title has it.
 *
 *  Transcripts are tens of gigabytes, almost all of it tool calls, their
 *  output and thinking; what you and the agents said is about 1% of it. A
 *  scan at query time takes a ripgrep pass over all of it (15 s and more), so
 *  the said text alone is kept in an FTS5 table (`cache/search.db`) and a
 *  query is a lookup. Trigrams, so a fragment matches mid-word as the title
 *  filter does.
 *
 *  A worker keeps it current (`search-worker.ts`): the first pass reads every
 *  transcript once, through the providers' own readers, and after it only
 *  sessions whose transcript grew, from where it left off. It is a cache:
 *  deleting the file rebuilds it. */

import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "./paths";
import type { TranscriptRef } from "./providers/types";

export const searchDbPath = (): string => join(agentboxHome(), "cache", "search.db");

/** Bumped when what is kept changes: the worker drops the old index and reads everything again. */
export const SEARCH_VERSION = 1;

export interface IndexJob {
  sessions: { id: string; ref: TranscriptRef }[];
}

/** How often the worker looks for transcripts that grew. */
const CATCH_UP_MS = 60_000;

/** Keep the index current from now on: a pass a minute, never two at once.
 *  `sessions` lists every session with a transcript, newest first. */
export function startSearchIndex(sessions: () => IndexJob["sessions"]): void {
  const worker = new Worker(new URL("./search-worker.ts", import.meta.url));
  let busy = false;
  worker.onmessage = () => {
    busy = false;
  };
  worker.onerror = (e) => {
    busy = false;
    console.error("agentbox: indexing what was said failed:", e.message);
  };
  const pass = () => {
    if (busy) return;
    busy = true;
    worker.postMessage({ sessions: sessions() } satisfies IndexJob);
  };
  setTimeout(pass, 30_000).unref?.();
  setInterval(pass, CATCH_UP_MS).unref?.();
}

export interface SaidHit {
  sessionId: string;
  at: number;
  kind: "user" | "assistant";
  /** The timeline event it was said in, to open the session at. */
  event: string;
  /** The matching line, cut down around the match. */
  snippet: string;
}

let reader: Database | null = null;

/** The index, read-only; null until the worker has built it. */
function index(): Database | null {
  if (!reader) {
    try {
      statSync(searchDbPath());
      reader = new Database(searchDbPath(), { readonly: true });
    } catch {
      return null;
    }
  }
  return reader;
}

/** The sessions where `q` was said, the most recent mention first, one hit
 *  each. Empty under three characters, which a trigram cannot match. */
export function searchSaid(q: string, limit: number, include: (sessionId: string) => boolean): SaidHit[] {
  const needle = q.trim();
  const reader = needle.length < 3 ? null : index();
  if (!reader) return [];
  const rows = reader
    .query(
      `SELECT said.session, said.event, said.at, said.kind, said.text FROM said_fts JOIN said ON said.id = said_fts.rowid
       WHERE said_fts MATCH ? ORDER BY said_fts.rowid DESC LIMIT 2000`,
    )
    .all(`"${needle.replaceAll('"', '""')}"`) as { session: string; event: string; at: number; kind: "user" | "assistant"; text: string }[];
  // The newest rows, not the newest mentions: sorting every match by time
  // took seconds for a common word, on the server's thread. A rarer phrase
  // has fewer matches than the limit, and those come out in time order.
  rows.sort((a, b) => b.at - a.at);
  const out: SaidHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.session) || !include(r.session)) continue;
    seen.add(r.session);
    out.push({ sessionId: r.session, event: r.event, at: r.at, kind: r.kind, snippet: snippetOf(r.text, needle) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Each message in one session where `q` was said, in the order it was
 *  said: what finding in a conversation steps through. Empty under three
 *  characters, which a trigram cannot match. */
export function searchSaidIn(session: string, q: string): { event: string; at: number; kind: "user" | "assistant" }[] {
  const needle = q.trim();
  const reader = needle.length < 3 ? null : index();
  if (!reader) return [];
  return reader
    .query(
      `SELECT said.event, said.at, said.kind FROM said_fts JOIN said ON said.id = said_fts.rowid
       WHERE said_fts MATCH ? AND said.session = ? ORDER BY said.id LIMIT 2000`,
    )
    .all(`"${needle.replaceAll('"', '""')}"`, session) as { event: string; at: number; kind: "user" | "assistant" }[];
}

/** Every message a person or program sent a session since `since`, oldest
 *  first; `launch` when it is part of what the session was launched with:
 *  said before its first reply. A launch prompt can be several rows (omp
 *  records each paragraph of a typed-in prompt as one). */
export function userSaidSince(since: number): { session: string; at: number; text: string; launch: boolean }[] {
  const reader = index();
  if (!reader) return [];
  const rows = reader.query("SELECT session, at, text FROM said WHERE kind = 'user' AND at >= ? ORDER BY at").all(since) as { session: string; at: number; text: string }[];
  const replied = new Map(
    (
      reader
        .query(
          `SELECT session, min(at) AS at FROM said WHERE kind = 'assistant'
             AND session IN (SELECT DISTINCT session FROM said WHERE kind = 'user' AND at >= ?) GROUP BY session`,
        )
        .all(since) as { session: string; at: number }[]
    ).map((r) => [r.session, r.at]),
  );
  return rows.map((r) => ({ ...r, launch: r.at < (replied.get(r.session) ?? Infinity) }));
}

function snippetOf(text: string, needle: string): string {
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  const from = Math.max(0, at - 40); // little enough that the match is on the rail's two lines
  const s = text.slice(from, from + 200).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + s;
}
