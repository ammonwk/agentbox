/** Turning a week of metrics into better balancer settings, and showing what
 * the balancer measures for itself.
 *
 * What a session uses before it has run is a guess, and measurable from what
 * agentbox records anyway; this file measures it. It proposes; the settings
 * only change when you apply the proposal. What a percent of each limit is
 * worth is measured too (rates.ts), and used as it is: there is no setting.
 */

import { assignmentsSince, getSettings, listSessionRecords, rateLimitHitsSince, tokenSampleAt } from "./db";
import type { Rates } from "./rates";
import type { BalancerSettings, CalibrationReport, ForecastReport, Percentiles } from "./types";

const DAY = 86_400_000;

export function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { p50: null, p75: null, p90: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => {
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return Math.round((sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)) * 100) / 100;
  };
  return { p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}

/** Round a claim suggestion to a half point, never below one. */
const claimOf = (v: number): number => Math.max(1, Math.round(v * 2) / 2);

export function calibrate(forecast: ForecastReport, rates: Rates, days = 7, now = Date.now()): CalibrationReport {
  const since = now - days * DAY;
  const current = getSettings().balancer;

  // What sessions consumed, counting only sessions that are finished — a
  // session still running has only consumed part of what it will.
  const finishedBefore = now - current.claimIdleMin * 60_000;
  const records = listSessionRecords(since).filter(
    (r) => r.accountId && r.claim > 0 && r.lastActivityAt < finishedBefore,
  );
  // What each spent, at its plan's price; one on a plan with none yet says nothing.
  const normal = records.flatMap((r) => {
    const price = rates.price(r.accountId!);
    return price === null ? [] : [(tokenSampleAt(r.id, now)?.costEquiv ?? 0) * price];
  });

  const assignments = assignmentsSince(since).filter((a) => a.accountId);
  const hits = rateLimitHitsSince(since);
  const hitAfterPlacement = assignments.filter((a) =>
    hits.some((h) => h.accountId === a.accountId && h.at >= a.at && h.at - a.at < 5 * 3_600_000),
  ).length;

  const suggested: Partial<BalancerSettings> = {};
  // p75 rather than the median: under-claiming lets sessions pile onto one
  // account and hit a wall, which costs more than an account left idle.
  const pn = percentiles(normal);
  if (normal.length >= 5 && pn.p75 !== null) suggested.claimNormal = claimOf(pn.p75);

  return {
    days,
    rates: rates.report(),
    sessionUse: { ...pn, samples: normal.length },
    placements: assignments.length,
    hitAfterPlacement,
    suggested,
    current,
    forecast,
  };
}
