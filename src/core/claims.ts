/** What each session still claims, and how observed usage is split among them.
 *
 * A session claims `claimNormal` or `claimBig` weekly points when it is
 * placed. As it runs, the account's weekly percentage rises, and that rise is
 * apportioned across the account's sessions by how much each did in the same
 * interval (token-weighted cost, see pricing.ts). What a session has been
 * apportioned is its consumption; its outstanding claim is what is left of its
 * estimate. Without this the balancer would count every session's usage twice:
 * once in the live percentage and again in the claim.
 *
 * The apportioned amounts are also the calibration data: after a week, the
 * distribution of what sessions actually consumed says what the claim sizes
 * should be.
 */

import {
  attributedPoints,
  insertAttribution,
  lastUsageSample,
  tokenSampleAt,
} from "./db";
import type { BalancerSettings, ClaimView } from "./types";

export interface ClaimInput {
  sessionId: string;
  accountId: string;
  title: string;
  big: boolean;
  claim: number;
  lastActivityAt: number;
  /** Mid-turn right now. A running session's claim never lapses. */
  running: boolean;
}

/**
 * Claims per account. A claim lapses once its session has been idle for
 * `claimIdleMin`: a session left open overnight should not hold an account's
 * weekly hostage, and if it is picked up again its use shows in the live
 * percentage anyway.
 */
export function claimsByAccount(
  sessions: ClaimInput[],
  consumed: Map<string, number>,
  settings: BalancerSettings,
  now: number,
): Map<string, ClaimView[]> {
  const out = new Map<string, ClaimView[]>();
  for (const s of sessions) {
    if (s.claim <= 0) continue;
    const used = consumed.get(s.sessionId) ?? 0;
    const lapsed = !s.running && now - s.lastActivityAt > settings.claimIdleMin * 60_000;
    const view: ClaimView = {
      sessionId: s.sessionId,
      title: s.title,
      big: s.big,
      claim: s.claim,
      consumed: Math.round(used * 100) / 100,
      outstanding: lapsed ? 0 : Math.round(Math.max(0, s.claim - used) * 100) / 100,
      lapsed,
    };
    const list = out.get(s.accountId);
    if (list) list.push(view);
    else out.set(s.accountId, [view]);
  }
  return out;
}

/** Split `delta` points in proportion to `weights`; zero-weight entries get
 *  nothing, and nothing is split when every weight is zero. */
export function apportion(delta: number, weights: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  let total = 0;
  for (const w of weights.values()) if (w > 0) total += w;
  if (delta <= 0 || total <= 0) return out;
  for (const [id, w] of weights) if (w > 0) out.set(id, (delta * w) / total);
  return out;
}

export interface WeeklyReading {
  windowId: string;
  at: number;
  usedPct: number;
  resetsAt: number | null;
}

/** Two readings belong to the same window when their resets agree to within
 *  ten minutes; providers jitter `resets_at` by seconds between calls. */
function sameWindow(a: WeeklyReading, b: WeeklyReading): boolean {
  if (a.resetsAt === null || b.resetsAt === null) return a.resetsAt === b.resetsAt || b.usedPct >= a.usedPct;
  return Math.abs(a.resetsAt - b.resetsAt) < 10 * 60_000;
}

/**
 * Turns weekly readings into attributions. Keeps the previous reading per
 * account in memory, seeded from the database so a restart does not lose the
 * interval in progress.
 */
export class Attributor {
  private last = new Map<string, WeeklyReading>();

  /**
   * A new weekly reading for `accountId`, with the sessions pinned there that
   * could have caused a rise. Returns what was attributed, for tests and logs.
   */
  observe(accountId: string, reading: WeeklyReading, sessionIds: string[]): Map<string, number> {
    // Seeded from the database on first sight. The usage service may already
    // have stored this very reading, in which case the seed *is* the reading:
    // remember it and wait for the next one rather than seeding again, or no
    // interval would ever have two ends.
    const seeded = !this.last.has(accountId);
    const prev = seeded ? this.seed(accountId, reading.windowId) : this.last.get(accountId)!;
    if (prev && reading.at <= prev.at) {
      if (seeded) this.last.set(accountId, prev);
      return new Map();
    }
    this.last.set(accountId, reading);
    if (!prev || !sameWindow(prev, reading)) return new Map();

    const delta = reading.usedPct - prev.usedPct;
    if (delta <= 0) return new Map();

    const weights = new Map<string, number>();
    for (const id of sessionIds) {
      const before = tokenSampleAt(id, prev.at);
      const after = tokenSampleAt(id, reading.at);
      if (!after) continue;
      weights.set(id, after.costEquiv - (before?.costEquiv ?? 0));
    }
    const shares = apportion(delta, weights);
    for (const [id, points] of shares) insertAttribution(id, accountId, reading.at, points);
    return shares;
  }

  private seed(accountId: string, windowId: string): WeeklyReading | null {
    const row = lastUsageSample(accountId, windowId);
    return row ? { windowId, at: row.at, usedPct: row.usedPct, resetsAt: row.resetsAt } : null;
  }
}

export const consumedBy = attributedPoints;
