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

/** blocked → waiting → running → stopped → archived; newest activity first within. */
export function sortByAttention<T extends SessionRow>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      KIND_ORDER[a.attention.kind] - KIND_ORDER[b.attention.kind] ||
      a.attention.rank - b.attention.rank ||
      b.lastActivityAt - a.lastActivityAt,
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

const SECTION_LABEL: Record<AttentionKind, string> = {
  blocked: "Blocked",
  waiting: "Your turn",
  running: "Running",
  stopped: "Stopped",
  archived: "Archived",
};

/** Sections always in the same order so the board does not reshuffle under the cursor. */
export function sectionsOf<T extends SessionRow>(rows: readonly T[]): Section<T>[] {
  const sorted = sortByAttention(rows);
  return (Object.keys(KIND_ORDER) as AttentionKind[])
    .map((kind) => ({ kind, label: SECTION_LABEL[kind], rows: sorted.filter((s) => s.attention.kind === kind) }))
    .filter((s) => s.rows.length > 0);
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

/** Counts for the nav badge and the tab title: things that want a human. */
export function needsYou(rows: readonly SessionRow[]): number {
  return rows.filter((s) => s.attention.kind === "blocked" || s.attention.kind === "waiting").length;
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
