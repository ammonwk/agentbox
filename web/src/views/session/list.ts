/** Ordering and sectioning for the session list.
 *
 * Urgency is NOT derived here. The server stamps `attention` on every session
 * (`attentionOf` in conductor.ts) precisely so the Inbox, the sidebar badge
 * and this list can never disagree; this file only sorts and buckets by it.
 */

import type { AttentionKind } from "../../../../src/core/types";
import type { SessionRow } from "../../api";

export type SectionId = "attention" | "working" | "idle" | "quiet";

/**
 * The kinds that mean a human has something to *do*. `idle` is deliberately
 * not among them: it means "a turn ended and nothing is wrong", which
 * described 15 of 22 real sessions permanently — filing that under "Needs you"
 * is the same overstatement that produced a 72-item Inbox. It still carries a
 * rank, so it still orders the board; it just does not shout.
 */
const ACTIONABLE = new Set<AttentionKind>(["approval", "failed", "flagged", "review"]);

export interface Section {
  id: SectionId;
  label: string;
  sessions: SessionRow[];
}

/** Attention rank first (0 = most urgent), then most recently touched. */
export function sortSessions(sessions: SessionRow[]): SessionRow[] {
  return [...sessions].sort(
    (a, b) => a.attention.rank - b.attention.rank || b.updatedAt - a.updatedAt,
  );
}

function sectionOf(s: SessionRow): SectionId {
  if (ACTIONABLE.has(s.attention.kind)) return "attention";
  if (s.status === "running" || s.status === "spawning") return "working";
  if (s.attention.kind === "idle") return "idle";
  return "quiet";
}

const SECTION_LABEL: Record<SectionId, string> = {
  attention: "Needs you",
  working: "Working",
  idle: "Idle",
  quiet: "Quiet",
};

/**
 * Bucket for scanning. Sections are always in the same order so the list does
 * not reshuffle under the cursor, and empty ones are dropped.
 */
export function sectionsFor(sessions: SessionRow[], showArchived: boolean): Section[] {
  const visible = sessions.filter((s) => showArchived || s.archivedAt == null);
  const sorted = sortSessions(visible);
  const order: SectionId[] = ["attention", "working", "idle", "quiet"];
  return order
    .map((id) => ({ id, label: SECTION_LABEL[id], sessions: sorted.filter((s) => sectionOf(s) === id) }))
    .filter((sec) => sec.sessions.length > 0);
}

/** Flattened order, which is what arrow-key navigation walks. */
export function flatten(sections: Section[]): SessionRow[] {
  return sections.flatMap((s) => s.sessions);
}

/** Next id for ↑/↓, clamped at both ends so the cursor never falls off. */
export function neighbourId(
  ordered: SessionRow[],
  currentId: string | null,
  delta: 1 | -1,
): string | null {
  if (ordered.length === 0) return null;
  const i = ordered.findIndex((s) => s.id === currentId);
  if (i === -1) return ordered[delta === 1 ? 0 : ordered.length - 1].id;
  const next = Math.min(ordered.length - 1, Math.max(0, i + delta));
  return ordered[next].id;
}
