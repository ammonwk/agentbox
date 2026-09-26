/** Ordering, filtering and sectioning for the session list. Pure.
 *
 * Urgency is not derived here: the server stamps `attention` on every session
 * so the list, the voice agent and the tab title can never disagree. This only
 * sorts and buckets by it. */

import type { Attention, AttentionKind, ProviderId, Session } from "../../../src/core/types";
import { baseName } from "./format";

export type SessionRow = Session & { attention: Attention };

/** The fallback order when two rows carry the same server rank. */
export const KIND_ORDER: Record<AttentionKind, number> = {
  blocked: 0,
  waiting: 1,
  running: 2,
  stopped: 3,
  closed: 4,
};

/**
 * blocked → waiting → running → stopped → closed; within each, the session
 * you last sent something to first. Your own messages, not the agent's
 * activity: an agent finishing a step, or another agent messaging it, does
 * not move a row, so the order is the one you made.
 */
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

export function filterSessions<T extends SessionRow>(rows: readonly T[], f: BoardFilter): T[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((s) => {
    if (!q) return true;
    return [s.label, s.title, s.cwd, s.branch, s.lastMessage, s.firstPrompt, s.id, s.model, s.provider]
      .some((x) => x != null && x.toLowerCase().includes(q));
  });
}

export interface Section<T> {
  /** Stable key: an attention kind, a repo path, or "all". */
  key: string;
  /** Empty for the one unlabelled section of a flat sort. */
  label: string;
  /** What it colours the label by: the attention kind, when there is one. */
  kind?: AttentionKind;
  rows: T[];
}

/** How the session list is ordered.
 *  - mine: the last time you sent it something (your order, not the agents')
 *  - all: the last time anything happened in it
 *  - status: blocked, your turn, running, stopped
 *  - repo: grouped by repository or folder */
export type SortKey = "mine" | "all" | "status" | "repo";

export const SORT_LABEL: Record<SortKey, string> = {
  mine: "Your activity",
  all: "All activity",
  status: "Status",
  repo: "Repo",
};

/** The timestamp a sort orders by, and the one a row shows. */
export function sortTime(s: Pick<Session, "lastPromptAt" | "lastActivityAt">, sort: SortKey): number {
  return sort === "all" ? s.lastActivityAt : s.lastPromptAt;
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

/**
 * The list in sections. Status sections always come in the same order and
 * repos alphabetically, so the list does not reshuffle under the cursor; the
 * activity sorts are one flat section. A session another one started sits
 * under it, in its section whatever its own status or repo, and only while
 * `open` says its parent is expanded.
 */
export function sectionsOf<T extends SessionRow>(
  rows: readonly T[],
  open: (id: string) => boolean = () => true,
  sort: SortKey = "status",
): Section<Nested<T>>[] {
  const up = parentsOf(rows);
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
  let sections: Section<Nested<T>>[];
  if (sort === "status") {
    sections = (Object.keys(KIND_ORDER) as AttentionKind[]).map((kind) => build(kind, SECTION_LABEL[kind], (r) => r.attention.kind === kind, kind));
  } else if (sort === "repo") {
    const repos = [...new Set(roots.map(repoKey))].sort((a, b) => baseName(a).localeCompare(baseName(b)) || a.localeCompare(b));
    sections = repos.map((repo) => build(repo, baseName(repo), (r) => repoKey(r) === repo));
  } else {
    sections = [build("all", "", () => true)];
  }
  return sections.filter((s) => s.rows.length > 0);
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

/** The time's tooltip: when you last wrote, and when the agent last moved. */
export function sentTip(s: Pick<Session, "lastPromptAt" | "lastActivityAt">): string {
  const at = (t: number) => new Date(t).toLocaleString();
  return `You last sent it something ${at(s.lastPromptAt)}\nLast activity ${at(s.lastActivityAt)}`;
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
