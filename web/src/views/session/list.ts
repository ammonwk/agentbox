/** Ordering and sectioning for the session list.
 *
 * Urgency is NOT derived here. The server stamps `attention` on every session
 * (`attentionOf` in conductor.ts) precisely so the Inbox, the sidebar badge
 * and this list can never disagree; this file only sorts and buckets by it.
 */

import type { SessionRow } from "../../api";

export type SectionId = "attention" | "working" | "quiet";

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
  if (s.attention.kind !== "none") return "attention";
  if (s.status === "running" || s.status === "spawning") return "working";
  return "quiet";
}

const SECTION_LABEL: Record<SectionId, string> = {
  attention: "Needs you",
  working: "Working",
  quiet: "Quiet",
};

/**
 * Bucket for scanning. Sections are always in the same order so the list does
 * not reshuffle under the cursor, and empty ones are dropped.
 */
export function sectionsFor(sessions: SessionRow[], showArchived: boolean): Section[] {
  const visible = sessions.filter((s) => showArchived || s.archivedAt == null);
  const sorted = sortSessions(visible);
  const order: SectionId[] = ["attention", "working", "quiet"];
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
