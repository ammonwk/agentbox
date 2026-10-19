/** References to *other* sessions in agent output, as links to that session:
 *  an agentbox id (`3xhmmee5`), a tmux session name (`ab-3xhmmee5`), the
 *  provider's own session id (`c6323d94-…`, `plum-seashore`) or a worktree
 *  path under `…/worktrees/<id>`. Pure: the caller says which ids exist and
 *  what the provider ids belong to; nothing here reads the board.
 *
 *  Deliberately loose, like `prlinks`: any eight-letter word from the id
 *  alphabet is a candidate, and only one that names a session on the board
 *  becomes a link, so ordinary prose never lights up. */

import type { Session } from "../../../src/core/types";

export interface SessionIndex {
  /** agentbox ids on the board. */
  ids: ReadonlySet<string>;
  /** provider session id → the agentbox id of the session that has it. */
  provider: ReadonlyMap<string, string>;
}

export interface SessionRef {
  /** Offsets into the text, end exclusive. */
  start: number;
  end: number;
  /** The agentbox id to open. */
  id: string;
}

/** The alphabet `newSessionId` (src/core/fleet.ts) draws from: eight of them,
 *  no 0/o/1/l, so an eight-letter word is not an id. */
const BOX_ID = "[2-9a-km-z]{8}";
/** One segment of a path: enough for `~/.local/share/…/worktrees/<id>`. */
const PATH_SEG = "[\\w.~@$+-]+";

let grown: SessionIndex = { ids: new Set(), provider: new Map() };

/** Every session the page has seen on the board, the same object until one
 *  it has not seen comes: the board is rebuilt every frame, and what prose
 *  links to (and the regex below) is worked out again only when this
 *  changes. A session that left the board stays: it is still a session, and
 *  its link still opens it. */
export function buildSessionIndex(sessions: readonly Pick<Session, "id" | "agentSessionId">[]): SessionIndex {
  if (sessions.every((s) => grown.ids.has(s.id) && (!s.agentSessionId || grown.provider.get(s.agentSessionId) === s.id))) return grown;
  const ids = new Set(grown.ids);
  const provider = new Map(grown.provider);
  for (const s of sessions) {
    ids.add(s.id);
    if (s.agentSessionId) provider.set(s.agentSessionId, s.id);
  }
  grown = { ids, provider };
  return grown;
}

const compiled = new WeakMap<SessionIndex, RegExp>();

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One pass over the text: tmux, worktree, provider id, then a bare agentbox
 *  id — longest shape first, so `ab-3xhmmee5` and `…/worktrees/3xhmmee5` are
 *  taken whole rather than as the id inside them. The provider ids are the
 *  board's own, alternated longest first so a shorter one never cuts a longer
 *  one short. */
function compile(index: SessionIndex): RegExp {
  const hit = compiled.get(index);
  if (hit) return hit;
  const providers = [...index.provider.keys()]
    .filter((id) => id.length >= 6 && /^[A-Za-z0-9_-]+$/.test(id))
    .sort((a, b) => b.length - a.length)
    .map(esc);
  const parts = [
    `(?<tmux>\\bab-(?<tmid>${BOX_ID})\\b)`,
    `(?<wt>\\/?(?:${PATH_SEG}/)*worktrees/(?<wtid>${BOX_ID}))`,
    providers.length ? `(?<pv>(?<![\\w-])(?:${providers.join("|")})(?![\\w-]))` : null,
    `(?<box>(?<![\\w-])(?<boxid>${BOX_ID})(?![\\w-]))`,
  ].filter((p): p is string => p !== null);
  const re = new RegExp(parts.join("|"), "g");
  compiled.set(index, re);
  return re;
}

/** Every reference in `text` that names a session on the board. */
export function sessionRefs(text: string, index: SessionIndex): SessionRef[] {
  const out: SessionRef[] = [];
  for (const m of text.matchAll(compile(index))) {
    const g = m.groups ?? {};
    const id = g.tmid ?? g.wtid ?? (g.pv ? (index.provider.get(g.pv) ?? null) : null) ?? g.boxid ?? null;
    if (!id || !index.ids.has(id)) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, id });
  }
  return out;
}

/** A provider's session id as Claude and Codex write it. */
const UUID = /(?<![\w-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\w-])/gi;
const BOX_WORD = new RegExp(`(?<![\\w-])${BOX_ID}(?![\\w-])`, "g");

/** Words in `text` shaped like a session's id that the board does not know:
 *  the ones to ask the server about, since it holds all of history and the
 *  board only the recent part. A bare agentbox id must have a digit in it
 *  unless it was written as code (`loose`), so plain prose is not looked up
 *  word by word. */
export function sessionCandidates(text: string, index: SessionIndex, loose: boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(UUID)) if (!index.provider.has(m[0])) out.push(m[0]);
  for (const m of text.matchAll(BOX_WORD)) if (!index.ids.has(m[0]) && (loose || /\d/.test(m[0]))) out.push(m[0]);
  return out;
}

let merged: { index: SessionIndex; found: ReadonlyMap<string, string>; out: SessionIndex } | null = null;

/** The board's index with the sessions the server found by name added
 *  (`found`: a word → the agentbox id it names). */
export function withResolved(index: SessionIndex, found: ReadonlyMap<string, string>): SessionIndex {
  if (found.size === 0) return index;
  if (merged?.index === index && merged.found === found) return merged.out;
  const ids = new Set(index.ids);
  const provider = new Map(index.provider);
  for (const [ref, id] of found) {
    ids.add(id);
    if (ref !== id) provider.set(ref, id);
  }
  merged = { index, found, out: { ids, provider } };
  return merged.out;
}
