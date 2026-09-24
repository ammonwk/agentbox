/** Formatting the balancer's reasoning for the new-session dialog and the
 *  Accounts page. Pure. */

import type { Candidate, Placement } from "../../../src/core/types";
import { fmtPts } from "./format";

export interface CandidateCells {
  accountId: string;
  label: string;
  /** "92 → 97": used, then with outstanding claims. */
  weekly: string;
  short: string;
  legRoom: string;
  perHour: string;
  score: string;
  eligible: boolean;
  /** "eligible", or the reason in a sentence. */
  verdict: string;
  chosen: boolean;
}

/** `a → b`, or just `a` when claims add nothing, or `—` when unknown. */
export function arrow(a: number | null, b: number | null): string {
  if (a == null && b == null) return "—";
  if (a == null) return `→ ${fmtPts(b)}`;
  if (b == null || Math.round(a * 10) === Math.round(b * 10)) return fmtPts(a);
  return `${fmtPts(a)} → ${fmtPts(b)}`;
}

export function candidateCells(c: Candidate, chosenId: string | null): CandidateCells {
  return {
    accountId: c.accountId,
    label: c.label,
    weekly: arrow(c.weekly, c.weeklyEffective),
    short: arrow(c.short, c.shortEffective),
    legRoom: c.legRoom == null ? "—" : fmtPts(c.legRoom),
    perHour: c.weeklyPerHour == null ? "—" : `${c.weeklyPerHour.toFixed(2)}/h`,
    score: Number.isFinite(c.score) ? c.score.toFixed(1) : "—",
    eligible: c.eligible,
    verdict: c.eligible ? "eligible" : c.reason ?? "not eligible",
    chosen: c.accountId === chosenId,
  };
}

/**
 * Rows in the order a human reads a ranking: the choice first, then eligible
 * by score, then the ineligible ones (by score too, so "nearly" sorts above
 * "hopeless").
 */
export function candidateTable(p: Placement, manualId?: string | null): CandidateCells[] {
  const chosen = manualId ?? p.accountId;
  return [...p.candidates]
    .sort(
      (a, b) =>
        Number(b.accountId === chosen) - Number(a.accountId === chosen) ||
        Number(b.eligible) - Number(a.eligible) ||
        b.score - a.score,
    )
    .map((c) => candidateCells(c, chosen));
}

/** Headline for the preview: "Auto → claude-work", "No account can take it". */
export function placementHeadline(p: Placement, manualLabel?: string | null): string {
  if (manualLabel) return `Manual → ${manualLabel}`;
  if (p.mode === "none" || !p.accountId) return "No account can take a new session";
  const c = p.candidates.find((x) => x.accountId === p.accountId);
  const how = p.mode === "manual" ? "Manual" : p.mode === "overflow" ? "Overflow" : "Auto";
  return `${how} → ${c?.label ?? p.accountId}`;
}
