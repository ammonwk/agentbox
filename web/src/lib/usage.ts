/** Usage-window math for the Accounts page, the session header and the
 *  placement preview. Pure: `now` is always passed in. */

import type { AccountUsage, AccountView, ClaimView, UsageWindow } from "../../../src/core/types";
import { service } from "../../../src/core/providers/account";
import { clamp, fmtCountdown, fmtPts } from "./format";

const WEEK = 7 * 86_400_000;

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

/** How a 5-hour forecast (`Candidate.shortEffective`) was reached, to follow
 *  "15%": a measured pace carried to the reset, or claims alone. */
export function shortForecastHow(pace: number | null | undefined): string {
  return pace != null ? `by its reset at ${fmtPts(pace)}%/h and new claims` : "with claims";
}

/** Sum of what an account's live claims still hold, lapsed ones excluded. */
export function outstandingOf(claims: readonly ClaimView[]): number {
  return claims.reduce((n, c) => n + (c.lapsed ? 0 : c.outstanding), 0);
}

/**
 * Used percent as of `now`, by the balancer's rule: a reading whose window has
 * since reset counts as empty, not as its old value. Matters when polling has
 * stopped (an expired token) and the last reading outlives its window.
 */
export function usedNow(w: Pick<UsageWindow, "usedPct" | "resetsAt">, now: number): number {
  return w.resetsAt != null && w.resetsAt <= now ? 0 : w.usedPct;
}

/** "resets in 3h 12m", "not started", "reset since last reading". */
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt == null) return "not started";
  const ms = resetsAt - now;
  if (ms <= 0) return "reset since last reading";
  return `resets in ${fmtCountdown(ms)}`;
}

/** Fraction of the window already elapsed, for the "time" tick on a bar. */
export function windowElapsed(w: Pick<UsageWindow, "resetsAt" | "windowMs">, now: number): number | null {
  if (w.resetsAt == null || w.windowMs <= 0 || w.resetsAt <= now) return null;
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

/** What a service with no windows to report says of its limits, for an
 *  account that has none: "no limit" in place of the bars, this as its why. */
export function noLimitOf(a: Pick<AccountView, "service" | "usage">): string | null {
  return a.usage.windows.length === 0 ? service(a.service)?.limits ?? null : null;
}

/** "Morph", "OpenCode Go · Acme", or the CLI's own plan, without repeating
 *  the label it sits beside. */
export function planOf(a: Pick<AccountView, "plan" | "label">): string | null {
  return a.plan && a.plan !== a.label ? a.plan : null;
}

/**
 * A provider's accounts taken as one tank, against when its windows reset:
 * if the last week's use carried on, does it run dry before refills come
 * ("stop"), leave limits to reset unspent ("under", by how much faster it
 * would have to go), or neither ("on")? `perWeek` is that pace in whole
 * limits a week, of the `accounts` it was judged on.
 * Null with nothing spent to judge by.
 */
export type ProviderPace = TankPace & { window: string };

/**
 * Each account's main window of one kind (weekly, monthly…) is a share of the
 * tank; the pace is what they all used in the last week (`burn`).
 * Spending goes to the window that resets first, as the balancer would, so
 * the forecast is the best case: a stop it predicts is one no placement
 * avoids, and the pace it asks for is the least that spends every window
 * before it resets. The kind that binds first is the answer.
 */
export function providerPace(accounts: readonly AccountView[], now: number): ProviderPace | null {
  const live = accounts.filter((a) => a.enabled && a.auth.state !== "expired" && a.auth.state !== "missing" && !a.usage.refusedAt);
  const paces = (["daily", "weekly", "monthly"] as const).flatMap((kind) => {
    const ws = live.flatMap((a) => a.usage.windows.filter((w) => w.kind === kind && !w.scope && w.windowMs > 0).map((w) => ({ w, burn: a.burn[w.id] ?? 0 })));
    const p = ws.length ? tankPace(ws, now) : null;
    return p ? [{ ...p, window: KIND_LABEL[kind].toLowerCase() }] : [];
  });
  const stops = paces.filter((p) => p.kind === "stop");
  if (stops.length) return stops.reduce((a, b) => (b.inMs < a.inMs ? b : a));
  // How much faster you can go is capped by the kind nearest its limit.
  const on = paces.find((p) => p.kind === "on");
  if (on) return on;
  return paces.reduce<ProviderPace | null>((a, b) => (!a || (a.kind === "under" && b.kind === "under" && b.pct < a.pct) ? b : a), null);
}

type TankPace = { perWeek: number; accounts: number } & (
  | { kind: "stop"; inMs: number }
  | { kind: "under"; pct: number }
  | { kind: "on" }
);

function tankPace(ws: readonly { w: UsageWindow; burn: number }[], now: number): TankPace | null {
  const W = ws[0]!.w.windowMs;
  const spent = ws.reduce((n, x) => n + x.burn, 0);
  if (spent <= 0) return null;
  const rate = spent / WEEK; // points per ms, the whole pool's
  const at = { perWeek: spent / 100, accounts: ws.length };
  // Where each window stands now; one past its reset has started over empty.
  const tank = ws.map(({ w }) => {
    let reset = w.resetsAt ?? now + W;
    const left = reset <= now ? 100 : 100 - clamp(w.usedPct, 0, 100);
    while (reset <= now) reset += W;
    return { left, reset: reset - now };
  });

  // When the pool runs dry, spending first what resets first. A quarter out
  // is far enough for a pace a little over what refills to show.
  const sim = tank.map((t) => ({ ...t }));
  for (let t = 0; t < 13 * WEEK; ) {
    const next = Math.min(...sim.map((s) => s.reset));
    const avail = sim.reduce((n, s) => n + s.left, 0);
    if (rate * (next - t) >= avail) return { kind: "stop", inMs: t + avail / rate, ...at };
    let budget = rate * (next - t);
    for (const s of [...sim].sort((a, b) => a.reset - b.reset)) {
      const d = Math.min(s.left, budget);
      s.left -= d;
      budget -= d;
    }
    for (const s of sim) if (s.reset === next) Object.assign(s, { left: 100, reset: next + W });
    t = next;
  }

  // The least pace that spends every window before it resets: what resets
  // by each reset, soonest first, has to be spent by then.
  let needed = 0;
  let sum = 0;
  for (const t of [...tank].sort((a, b) => a.reset - b.reset)) {
    sum += t.left;
    needed = Math.max(needed, sum / t.reset);
  }
  return needed > rate ? { kind: "under", pct: (needed / rate - 1) * 100, ...at } : { kind: "on", ...at };
}

/** "dead stop in 1d 2h", "increase pace by 60%", "on pace". */
export function paceText(p: ProviderPace): string {
  if (p.kind === "stop") return `dead stop in ${fmtCountdown(p.inMs)}`;
  if (p.kind === "under") return `increase pace by ${p.pct >= 10 ? Math.round(p.pct) : fmtPts(p.pct)}%`;
  return "on pace";
}

/** The why under it: the pace it was judged at, against what there is. */
export function paceWhy(p: ProviderPace): string {
  const at = `The last week used ${fmtPts(p.perWeek)} of ${p.accounts} ${p.window} limit${p.accounts === 1 ? "" : "s"}.`;
  if (p.kind === "stop") return `${at} If that carries on, even placed on whichever resets first, every one is spent in ${fmtCountdown(p.inMs)}.`;
  if (p.kind === "under") return `${at} At that pace some ${p.window} limits reset with use left; ${fmtPts(p.pct)}% faster spends them all.`;
  return `${at} Every ${p.window} limit is spent by its reset, and none runs dry before refills come.`;
}
