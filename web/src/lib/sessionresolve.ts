/** Sessions named in agent output that are not on the board, looked up on the
 *  server: the board holds open and recent sessions, but an agent names old
 *  ones too (a search through past chats, a session it remembers). Each word
 *  is asked about once a page load; the ones that name a session are kept. */

import { useSyncExternalStore } from "react";
import { api } from "../api";

const known = new Map<string, string | null>();
const inflight = new Map<string, Promise<void>>();
let queued: string[] = [];
let next: Promise<void> | null = null;
let found: ReadonlyMap<string, string> = new Map();
const listeners = new Set<() => void>();
/** What the server takes in one ask. */
const CHUNK = 500;

/** Ask about the words not asked about yet. Null when every one already has
 *  an answer; else settles once they all do. */
export function resolveSessions(refs: Iterable<string>): Promise<void> | null {
  const waits = new Set<Promise<void>>();
  for (const r of refs) {
    if (known.has(r)) continue;
    let p = inflight.get(r);
    if (!p) {
      queued.push(r);
      next ??= new Promise<void>((done) => setTimeout(done, 30)).then(flush);
      p = next;
      inflight.set(r, p);
    }
    waits.add(p);
  }
  return waits.size ? Promise.all(waits).then(() => undefined) : null;
}

async function flush(): Promise<void> {
  const refs = queued;
  queued = [];
  next = null;
  const chunks: string[][] = [];
  for (let i = 0; i < refs.length; i += CHUNK) chunks.push(refs.slice(i, i + CHUNK));
  let answers: Record<string, string>[];
  try {
    answers = await Promise.all(chunks.map((c) => api.resolveSessions(c)));
  } catch {
    // Unanswered: asked again the next time one is drawn.
    for (const r of refs) inflight.delete(r);
    return;
  }
  const hits = Object.assign({}, ...answers) as Record<string, string>;
  for (const r of refs) {
    inflight.delete(r);
    known.set(r, hits[r] ?? null);
  }
  if (Object.keys(hits).length === 0) return;
  found = new Map([...found, ...Object.entries(hits)]);
  for (const l of listeners) l();
}

/** The words found so far → the agentbox id each names. */
export function resolvedSessions(): ReadonlyMap<string, string> {
  return found;
}

export function useResolvedSessions(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    resolvedSessions,
  );
}
