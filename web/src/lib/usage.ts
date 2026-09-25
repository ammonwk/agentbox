/** Usage-window math for the Accounts page, the session header and the
 *  placement preview. Pure: `now` is always passed in. */

import type { AccountUsage, AccountView, ClaimView, UsageWindow } from "../../../src/core/types";
import { clamp, fmtCountdown } from "./format";

export type Tone = "ok" | "warn" | "bad";

/** Amber is "worth knowing", red is "this is why the next session will not fit". */
export function usageTone(usedPct: number | null | undefined): Tone {
  if (usedPct == null) return "ok";
  if (usedPct >= 90) return "bad";
  if (usedPct >= 75) return "warn";
  return "ok";
}

/**
 * A weekly bar with outstanding claims stacked on top of real use.
 *
 * `used` is what the provider reports; `claimed` is the part of the
 * outstanding claims that still fits under 100. When used + claims go past
 * 100 the account is over-committed, which is exactly the state the balancer
 * gates on (`W' ≥ 100`), so it is flagged rather than silently clipped.
 */
export interface BarSegments {
  used: number;
  claimed: number;
  /** used + outstanding, unclipped — the balancer's W'. */
  effective: number;
  overCommitted: boolean;
}

export function barSegments(usedPct: number, outstanding: number): BarSegments {
  const used = clamp(usedPct, 0, 100);
  const out = Math.max(0, outstanding);
  const claimed = clamp(out, 0, 100 - used);
  const effective = usedPct + out;
  return { used, claimed, effective, overCommitted: effective >= 100 };
}

/** Sum of what an account's live claims still hold, lapsed ones excluded. */
export function outstandingOf(claims: readonly ClaimView[]): number {
  return claims.reduce((n, c) => n + (c.lapsed ? 0 : c.outstanding), 0);
}

/** "resets in 3h 12m", "not started", "resetting". */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt == null) return "not started";
  const ms = resetsAt - now;
  if (ms <= 0) return "resetting";
  return `resets in ${fmtCountdown(ms)}`;
}

/** Fraction of the window already elapsed, for the "time" tick on a bar. */
export function windowElapsed(w: Pick<UsageWindow, "resetsAt" | "windowMs">, now: number): number | null {
  if (w.resetsAt == null || w.windowMs <= 0) return null;
  const start = w.resetsAt - w.windowMs;
  return clamp((now - start) / w.windowMs, 0, 1);
}

const KIND_LABEL: Record<UsageWindow["kind"], string> = {
  short: "5-hour",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** The provider's label wins when it says something the kind does not. */
export function windowLabel(w: UsageWindow): string {
  const base = w.label?.trim() || KIND_LABEL[w.kind];
  if (w.scope && !base.toLowerCase().includes(w.scope.model.toLowerCase())) {
    return `${base} · ${w.scope.model}`;
  }
  return base;
}

const KIND_ORDER: Record<UsageWindow["kind"], number> = { short: 0, daily: 1, weekly: 2, monthly: 3 };

/** Short first, then unscoped weekly, then scoped ones alphabetically. */
export function sortWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  return [...windows].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      Number(!!a.scope) - Number(!!b.scope) ||
      (a.scope?.model ?? "").localeCompare(b.scope?.model ?? ""),
  );
}

/** The two windows that matter for a compact readout: short and main weekly. */
export function headlineWindows(usage: AccountUsage): { short: UsageWindow | null; weekly: UsageWindow | null } {
  const short = usage.windows.find((w) => w.kind === "short" && !w.scope) ?? null;
  const weekly = usage.windows.find((w) => w.kind === "weekly" && !w.scope) ?? null;
  return { short, weekly };
}

/** "5h 62% · wk 41%" — the whole account in one glance, for chips and headers. */
export function usageSummary(account: Pick<AccountView, "usage">): string {
  const { short, weekly } = headlineWindows(account.usage);
  const parts: string[] = [];
  if (short) parts.push(`5h ${Math.round(short.usedPct)}%`);
  if (weekly) parts.push(`wk ${Math.round(weekly.usedPct)}%`);
  if (parts.length === 0) return account.usage.windows.length ? `${account.usage.windows.length} windows` : "no usage data";
  return parts.join(" · ");
}
