/** Ordering, filtering and sectioning for the Sessions board. Pure.
 *
 * Urgency is not derived here: the server stamps `attention` on every session
 * so the board, the rail and the tab title can never disagree. This only
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
  archived: 4,
};

/**
 * blocked → waiting → running → stopped → archived; within each, the session
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
  provider: ProviderId | "all";
  /** An account id, "all", or "none" for sessions not pinned to one. */
  account: string;
  /** A repo root path, or "all". */
  repo: string;
  showArchived: boolean;
}

export const EMPTY_FILTER: BoardFilter = {
  query: "",
  provider: "all",
  account: "all",
  repo: "all",
  showArchived: false,
};

/** Where a session lives, for grouping and the repo filter. */
export function repoKey(s: Pick<Session, "repoRoot" | "cwd">): string {
  return s.repoRoot ?? s.cwd;
}

export function filterSessions<T extends SessionRow>(rows: readonly T[], f: BoardFilter): T[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((s) => {
    if (!f.showArchived && s.status === "archived") return false;
    if (f.provider !== "all" && s.provider !== f.provider) return false;
    if (f.account === "none" ? s.accountId !== null : f.account !== "all" && s.accountId !== f.account) return false;
    if (f.repo !== "all" && repoKey(s) !== f.repo) return false;
    if (!q) return true;
    return [s.label, s.title, s.cwd, s.branch, s.lastMessage, s.firstPrompt, s.id, s.model]
      .some((x) => x != null && x.toLowerCase().includes(q));
  });
}

export interface Section<T> {
  kind: AttentionKind;
  label: string;
  rows: T[];
}

/** A row placed in the tree: how deep it sits under the session that started
 *  it, and how many sessions it started are here under it. */
export type Nested<T> = T & { depth: number; kids: number };

/**
 * The row each row nests under: its parent, when the parent is one of `rows`.
 * A parent that is archived (and not shown), filtered out or gone leaves its
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
  archived: "Archived",
};

/**
 * Sections always in the same order so the board does not reshuffle under the
 * cursor. A session another one started sits under it, in its section whatever
 * its own status, and only while `open` says its parent is expanded.
 */
export function sectionsOf<T extends SessionRow>(rows: readonly T[], open: (id: string) => boolean = () => true): Section<Nested<T>>[] {
  const up = parentsOf(rows);
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const s of sortByAttention(rows)) {
    const p = up.get(s.id);
    if (p) kids.set(p, [...(kids.get(p) ?? []), s]);
    else roots.push(s);
  }
  const place = (s: T, depth: number, out: Nested<T>[]) => {
    const k = kids.get(s.id) ?? [];
    out.push({ ...s, depth, kids: k.length });
    if (open(s.id)) for (const c of k) place(c, depth + 1, out);
  };
  return (Object.keys(KIND_ORDER) as AttentionKind[])
    .map((kind) => {
      const out: Nested<T>[] = [];
      for (const r of roots) if (r.attention.kind === kind) place(r, 0, out);
      return { kind, label: SECTION_LABEL[kind], rows: out };
    })
    .filter((s) => s.rows.length > 0);
}

/** The time column's tooltip: when you last wrote, and when the agent last moved. */
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
  const up = parentsOf(rows.filter((s) => s.status !== "archived"));
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
