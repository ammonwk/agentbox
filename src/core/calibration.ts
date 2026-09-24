/** Turning a week of metrics into better balancer settings.
 *
 * The balancer's numbers start as guesses: a session uses 5 weekly points, a
 * Big one 20, a full short window is worth 24. Every one of them is measurable
 * from what agentbox records anyway, and this file measures them. It proposes;
 * the settings only change when you apply the proposal.
 */

import {
  assignmentsSince,
  attributedPoints,
  getSettings,
  listSessionRecords,
  rateLimitHitsSince,
  usageSamplesSince,
  type UsageSampleRow,
} from "./db";
import type { BalancerSettings, CalibrationReport, Percentiles } from "./types";

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

/**
 * Weekly points per full short window, from how the two windows moved
 * together on each account.
 *
 * Unit of evidence: one short window's lifetime (readings sharing a
 * `resets_at`). Over it, the short window rose by Δs percent and the weekly by
 * Δw points, and if the weekly did not reset in between, Δw ≈ k·Δs/100. The
 * slope through the origin over all such windows is k. Whole windows rather
 * than consecutive readings, because the weekly is reported in whole percent
 * and a two-minute interval almost always shows it unmoved.
 */
export function estimateShortInWeekly(
  samples: UsageSampleRow[],
  shortId = "five_hour",
  weeklyId = "seven_day",
): { estimate: number | null; samples: number; r2: number | null } {
  const byAccount = new Map<string, UsageSampleRow[]>();
  for (const s of samples) {
    if (s.windowId !== shortId && s.windowId !== weeklyId) continue;
    const list = byAccount.get(s.accountId);
    if (list) list.push(s);
    else byAccount.set(s.accountId, [s]);
  }

  const pairs: [number, number][] = [];
  for (const rows of byAccount.values()) {
    rows.sort((a, b) => a.at - b.at);
    const weekly = rows.filter((r) => r.windowId === weeklyId);
    // The weekly as of time t: the newest weekly reading at or before t.
    const weeklyAt = (t: number): UsageSampleRow | null => {
      let found: UsageSampleRow | null = null;
      for (const w of weekly) {
        if (w.at > t) break;
        found = w;
      }
      return found;
    };
    const windows = new Map<number, UsageSampleRow[]>();
    for (const r of rows) {
      if (r.windowId !== shortId || r.resetsAt === null) continue;
      // Bucket to the minute: resets_at jitters by seconds between calls.
      const key = Math.round(r.resetsAt / 60_000);
      const list = windows.get(key);
      if (list) list.push(r);
      else windows.set(key, [r]);
    }
    for (const list of windows.values()) {
      if (list.length < 2) continue;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const ds = last.usedPct - first.usedPct;
      const w0 = weeklyAt(first.at);
      const w1 = weeklyAt(last.at);
      if (ds < 5 || !w0 || !w1) continue;
      // A weekly reset inside the window makes Δw meaningless.
      if (w0.resetsAt !== null && w1.resetsAt !== null && Math.abs(w0.resetsAt - w1.resetsAt) > 10 * 60_000) continue;
      const dw = w1.usedPct - w0.usedPct;
      if (dw < 0) continue;
      pairs.push([ds, dw]);
    }
  }

  if (pairs.length === 0) return { estimate: null, samples: 0, r2: null };
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pairs) {
    sxy += x * y;
    sxx += x * x;
  }
  const slope = sxy / sxx;
  // R² for a regression through the origin: 1 − SSres/SStot(uncentred).
  let ssRes = 0;
  let ssTot = 0;
  for (const [x, y] of pairs) {
    ssRes += (y - slope * x) ** 2;
    ssTot += y * y;
  }
  const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : null;
  return {
    estimate: Math.round(slope * 100 * 10) / 10,
    samples: pairs.length,
    r2: r2 === null ? null : Math.round(r2 * 100) / 100,
  };
}

/** Round a claim suggestion to a half point, never below one. */
const claimOf = (v: number): number => Math.max(1, Math.round(v * 2) / 2);

export function calibrate(days = 7, now = Date.now()): CalibrationReport {
  const since = now - days * DAY;
  const current = getSettings().balancer;

  const short = estimateShortInWeekly(usageSamplesSince(since));

  // What sessions consumed, counting only sessions that are finished — a
  // session still running has only consumed part of what it will.
  const finishedBefore = now - current.claimIdleMin * 60_000;
  const records = listSessionRecords(since).filter(
    (r) => r.accountId && r.claim > 0 && r.lastActivityAt < finishedBefore,
  );
  const used = attributedPoints(records.map((r) => r.id));
  const normal = records.filter((r) => !r.big).map((r) => used.get(r.id) ?? 0);
  const big = records.filter((r) => r.big).map((r) => used.get(r.id) ?? 0);

  const assignments = assignmentsSince(since).filter((a) => a.accountId);
  const hits = rateLimitHitsSince(since);
  const hitAfterPlacement = assignments.filter((a) =>
    hits.some((h) => h.accountId === a.accountId && h.at >= a.at && h.at - a.at < 5 * 3_600_000),
  ).length;

  const suggested: Partial<BalancerSettings> = {};
  if (short.estimate !== null && short.samples >= 5 && (short.r2 ?? 0) >= 0.5) {
    suggested.shortWindowInWeekly = short.estimate;
  }
  // p75 rather than the median: under-claiming lets sessions pile onto one
  // account and hit a wall, which costs more than an account left idle.
  const pn = percentiles(normal);
  if (normal.length >= 5 && pn.p75 !== null) suggested.claimNormal = claimOf(pn.p75);
  const pb = percentiles(big);
  if (big.length >= 3 && pb.p75 !== null) suggested.claimBig = claimOf(pb.p75);

  return {
    days,
    shortWindowInWeekly: short,
    sessionUse: {
      normal: { ...pn, samples: normal.length },
      big: { ...pb, samples: big.length },
    },
    placements: assignments.length,
    hitAfterPlacement,
    suggested,
    current,
  };
}
