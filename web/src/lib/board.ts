/** Ordering, filtering and sectioning for the session list. Pure.
 *
 * Urgency is not derived here: the server stamps `attention` on every session
 * so the list, the voice agent and the tab title can never disagree. This only
 * sorts and buckets by it. */

import { retrying } from "../../../src/core/attention";
import type { Attention, AttentionKind, ProviderId, Session, SessionStatus } from "../../../src/core/types";
import { baseName } from "./format";

export type SessionRow = Session & {
  attention: Attention;
  /** Work it left running in the background, in words (`workflow "babysit-fleet"`).
   *  Only a server that tracks it sends it; without it the status shows as usual. */
  backgroundWork?: string | null;
};

/** A session's status as drawn: blocked or waiting on an error agentbox
 *  retries by itself is `retrying`, drawn as working — red or amber there
 *  read as yours to fix. */
export type ShownStatus = SessionStatus | "retrying";

export function shownStatus(s: Pick<Session, "status" | "autoResume">): ShownStatus {
  return retrying(s) ? "retrying" : s.status;
}

/** The fallback order when two rows carry the same server rank. */
export const KIND_ORDER: Record<AttentionKind, number> = {
  blocked: 0,
  waiting: 1,
  running: 2,
  stopped: 3,
  closed: 4,
};

/** By attention, then latest prompt; assistant activity does not move a row. */
export function sortByAttention<T extends SessionRow>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      KIND_ORDER[a.attention.kind] - KIND_ORDER[b.attention.kind] ||
      a.attention.rank - b.attention.rank ||
      b.lastPromptAt - a.lastPromptAt,
  );
}

export interface BoardFilter {
  query: string;
}

export const EMPTY_FILTER: BoardFilter = { query: "" };

/** Where a session lives, for the Repo sort and its dot's shape. */
export function repoKey(s: Pick<Session, "repoRoot" | "cwd">): string {
  return s.repoRoot ?? s.cwd;
}

/** Folders that hold projects: the folder under one of these is the project. */
const CODE_ROOTS = new Set(["dev", "developer", "code", "src", "projects", "repos", "git", "work", "workspace"]);

/**
 * The project a session works on, for the prefix on its name: the folder
 * under a code folder (~/Dev/Plaibook/Plaibook-dev/… is "plaibook"), else
 * the repo's own folder. The first two folders are the home, never a match.
 */
export function projectOf(s: Pick<Session, "repoRoot" | "cwd">): string {
  const parts = repoKey(s).split("/").filter(Boolean);
  const i = parts.findIndex((p, n) => n >= 2 && n < parts.length - 1 && CODE_ROOTS.has(p.toLowerCase()));
  return (i === -1 ? baseName(repoKey(s)) : parts[i + 1]).toLowerCase();
}

export function filterSessions<T extends SessionRow>(rows: readonly T[], f: BoardFilter): T[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((s) => {
    if (!q) return true;
    return [s.label, s.title, s.cwd, s.branch, s.lastMessage, s.firstPrompt, s.id, s.model, s.provider]
      .some((x) => x != null && x.toLowerCase().includes(q));
  });
}

export interface Section<T> {
  /** Stable key: an attention kind, a repo path, "all", or "pinned". */
  key: string;
  /** Empty for the one unlabelled section of a flat sort. */
  label: string;
  /** What it colours the label by: the attention kind, when there is one. */
  kind?: AttentionKind;
  rows: T[];
}

/** How the session list is ordered.
 *  - mine: the last delivered prompt, from a person or an agent
 *  - all: the last time anything happened in it
 *  - status: blocked, your turn, running, stopped
 *  - repo: grouped by repository or folder */
export type SortKey = "mine" | "all" | "status" | "repo";

export const SORT_LABEL: Record<SortKey, string> = {
  mine: "Last prompt",
  all: "All activity",
  status: "Status",
  repo: "Repo",
};

/** The list's two tabs: sessions that did something lately, and the rest. */
export type RailView = "active" | "inactive";

/** How recent a session's last activity must be for the Active tab. */
export const ACTIVE_MS = 3 * 60 * 60_000;

/**
 * The rows of each tab. A session is active while it runs, when it did
 * something within ACTIVE_MS, or while it is pinned: a pin keeps its place at
 * the top. A tree goes whole to Active when any session in it is active, so a
 * lead and its teammates stay together.
 */
export function splitActive<T extends SessionRow>(rows: readonly T[], now: number): Record<RailView, T[]> {
  const up = parentsOf(rows);
  const rootOf = (id: string) => {
    let r = id;
    for (let p = up.get(r); p !== undefined; p = up.get(r)) r = p;
    return r;
  };
  const live = new Set(rows.filter((s) => s.status === "running" || s.pinOrder !== null || now - s.lastActivityAt < ACTIVE_MS).map((s) => rootOf(s.id)));
  const out: Record<RailView, T[]> = { active: [], inactive: [] };
  for (const s of rows) out[live.has(rootOf(s.id)) ? "active" : "inactive"].push(s);
  return out;
}

/** The timestamp a sort orders by, and the one a row shows. */
export function sortTime(s: Pick<Session, "lastPromptAt" | "lastActivityAt">, sort: SortKey): number {
  return sort === "all" ? s.lastActivityAt : s.lastPromptAt;
}

/** The subagents `s` runs right now: they stop, mid-task, when it does. */
export function runningSubagents<T extends Pick<Session, "parent" | "host">>(s: Pick<Session, "id">, sessions: readonly T[]): T[] {
  return sessions.filter((c) => c.parent === s.id && c.host === "subagent");
}

/** The sessions `s` started, at any depth, still on the board: closing it takes them with it. */
export function descendantsOf<T extends Pick<Session, "id" | "parent" | "status">>(s: Pick<Session, "id">, sessions: readonly T[]): T[] {
  const kids = new Map<string, T[]>();
  for (const c of sessions) {
    if (c.status === "closed" || !c.parent || c.parent === c.id) continue;
    kids.set(c.parent, [...(kids.get(c.parent) ?? []), c]);
  }
  const out: T[] = [];
  const walk = (p: string) => {
    for (const c of kids.get(p) ?? []) if (!out.includes(c)) { out.push(c); walk(c.id); }
  };
  walk(s.id);
  return out;
}

/** Those of them with a process left: closing `s` stops them mid-task. */
export function runningDescendants<T extends Pick<Session, "id" | "parent" | "status" | "host">>(
  s: Pick<Session, "id">,
  sessions: readonly T[],
): T[] {
  return descendantsOf(s, sessions).filter((c) => c.host !== "none");
}

/** A row placed in the tree: how deep it sits under the session that started
 *  it, and how many sessions it started are here under it. */
export type Nested<T> = T & { depth: number; kids: number };

/**
 * The row each row nests under: its parent, when the parent is one of `rows`.
 * A parent that is closed (and not shown), filtered out or gone leaves its
 * children at the root. So does a loop, which would otherwise hide itself.
 */
export function parentsOf(rows: readonly Pick<Session, "id" | "parent">[]): Map<string, string> {
  const ids = new Set(rows.map((r) => r.id));
  const up = new Map<string, string>();
  for (const r of rows) if (r.parent && r.parent !== r.id && ids.has(r.parent)) up.set(r.id, r.parent);
  for (const r of rows) {
    const seen = new Set<string>();
    for (let x: string | undefined = r.id; x !== undefined; x = up.get(x)) {
      if (seen.has(x)) {
        up.delete(x);
        break;
      }
      seen.add(x);
    }
  }
  return up;
}

const SECTION_LABEL: Record<AttentionKind, string> = {
  blocked: "Blocked",
  waiting: "Your turn",
  running: "Running",
  stopped: "Stopped",
  closed: "Closed",
};

function ordered<T extends SessionRow>(rows: readonly T[], sort: SortKey): T[] {
  if (sort === "status") return sortByAttention(rows);
  return [...rows].sort((a, b) => sortTime(b, sort) - sortTime(a, sort));
}

/** Pinned, in the order you dragged them into. */
export function pinnedOf<T extends Pick<Session, "id" | "pinOrder">>(rows: readonly T[]): T[] {
  return rows.filter((s) => s.pinOrder !== null).sort((a, b) => a.pinOrder! - b.pinOrder! || a.id.localeCompare(b.id));
}

/** The `pinOrder` that puts a session between two pinned ones, either of
 *  them absent at an end of the list. */
export function pinBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

/**
 * The list in sections. What you pinned comes first, in your order, whatever
 * the sort; it is always a top-level row there, with what it started under it.
 * Status sections always come in the same order and repos alphabetically, so
 * the list does not reshuffle under the cursor; the activity sorts are one
 * flat section. A session another one started sits under it, in its section
 * whatever its own status or repo, and only while `open` says its parent is
 * expanded.
 */
export function sectionsOf<T extends SessionRow>(
  rows: readonly T[],
  open: (id: string) => boolean = () => true,
  sort: SortKey = "status",
): Section<Nested<T>>[] {
  const up = parentsOf(rows);
  for (const s of rows) if (s.pinOrder !== null) up.delete(s.id);
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of ordered(rows, sort)) {
    const p = up.get(s.id);
    if (p) kids.set(p, [...(kids.get(p) ?? []), s]);
    else roots.push(s);
  }
  const place = (s: T, depth: number, out: Nested<T>[]) => {
    const k = kids.get(s.id) ?? [];
    out.push({ ...s, depth, kids: k.length });
    if (open(s.id)) for (const c of k) place(c, depth + 1, out);
  };
  const build = (key: string, label: string, pick: (r: T) => boolean, kind?: AttentionKind): Section<Nested<T>> => {
    const out: Nested<T>[] = [];
    for (const r of roots) if (pick(r)) place(r, 0, out);
    return { key, label, kind, rows: out };
  };
  const pinned: Nested<T>[] = [];
  for (const r of pinnedOf(roots)) place(r, 0, pinned);
  const unpinned = (r: T) => r.pinOrder === null;
  let sections: Section<Nested<T>>[];
  if (sort === "status") {
    sections = (Object.keys(KIND_ORDER) as AttentionKind[]).map((kind) =>
      build(kind, SECTION_LABEL[kind], (r) => unpinned(r) && r.attention.kind === kind, kind),
    );
  } else if (sort === "repo") {
    const repos = [...new Set(roots.filter(unpinned).map(repoKey))].sort((a, b) => baseName(a).localeCompare(baseName(b)) || a.localeCompare(b));
    sections = repos.map((repo) => build(repo, baseName(repo), (r) => unpinned(r) && repoKey(r) === repo));
  } else {
    // A flat list under the pinned still wants a label, or it reads as more pins.
    sections = [build("all", pinned.length ? "Sessions" : "", unpinned)];
  }
  return [{ key: "pinned", label: "Pinned", rows: pinned }, ...sections].filter((s) => s.rows.length > 0);
}

/** The shapes a session's status dot takes, one per repo. */
export const SHAPES = ["circle", "square", "triangle", "diamond", "star", "cross", "down"] as const;
export type Shape = (typeof SHAPES)[number];

/**
 * Each repo's shape. The repos of the sessions on the list come first, most
 * sessions first, so what you can see gets distinct shapes before a folder
 * three closed sessions once ran in; ties go to the all-time count, which
 * barely moves. Past the seventh they repeat.
 */
export function repoShapes(rows: readonly Pick<Session, "repoRoot" | "cwd" | "status">[]): Map<string, Shape> {
  const live = new Map<string, number>();
  const all = new Map<string, number>();
  for (const r of rows) {
    const k = repoKey(r);
    all.set(k, (all.get(k) ?? 0) + 1);
    if (r.status !== "closed") live.set(k, (live.get(k) ?? 0) + 1);
  }
  const repos = [...all.keys()].sort(
    (a, b) => (live.get(b) ?? 0) - (live.get(a) ?? 0) || all.get(b)! - all.get(a)! || a.localeCompare(b),
  );
  return new Map(repos.map((repo, i) => [repo, SHAPES[i % SHAPES.length]!]));
}

/** The time's tooltip: latest prompt and latest activity. */
export function sentTip(s: Pick<Session, "lastPromptAt" | "lastActivityAt">): string {
  const at = (t: number) => new Date(t).toLocaleString();
  return `Last prompt ${at(s.lastPromptAt)}\nLast activity ${at(s.lastActivityAt)}`;
}

/** Next id for j/k, clamped at both ends. */
export function neighbourId(ordered: readonly { id: string }[], currentId: string | null, delta: 1 | -1): string | null {
  if (ordered.length === 0) return null;
  const i = ordered.findIndex((s) => s.id === currentId);
  if (i === -1) return ordered[delta === 1 ? 0 : ordered.length - 1].id;
  return ordered[Math.min(ordered.length - 1, Math.max(0, i + delta))].id;
}

/** The label a human gave wins over the derived title. */
export function titleOf(s: Pick<Session, "label" | "title" | "firstPrompt">): string {
  return s.label?.trim() || s.title?.trim() || s.firstPrompt?.split("\n")[0]?.slice(0, 80) || "Untitled session";
}

/** "agentbox · feat/x", or the cwd's basename when there is no repo. */
export function whereOf(s: Pick<Session, "repoRoot" | "cwd" | "branch">): { name: string; branch: string | null } {
  return { name: baseName(s.repoRoot ?? s.cwd), branch: s.branch };
}

/** 0–100, or null when either side is unknown. */
export function contextPct(s: Pick<Session, "contextUsed" | "contextLimit">): number | null {
  if (s.contextUsed == null || !s.contextLimit) return null;
  return Math.min(100, (s.contextUsed / s.contextLimit) * 100);
}

/** Counts for the nav badge and the tab title: things that want a human. A
 *  helper waiting on the session that started it is waiting on that session. */
export function needsYou(rows: readonly SessionRow[]): number {
  const up = parentsOf(rows.filter((s) => s.status !== "closed"));
  return rows.filter((s) => s.attention.kind === "blocked" || (s.attention.kind === "waiting" && !up.has(s.id))).length;
}

/**
 * The provider most of these rows share. Lists badge only the exceptions: a
 * board of Claude sessions does not need "Claude" on every line, but the one
 * Codex among them should say so.
 */
export function usualProvider(rows: readonly Pick<Session, "provider">[]): ProviderId | null {
  const n = new Map<ProviderId, number>();
  for (const r of rows) n.set(r.provider, (n.get(r.provider) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
