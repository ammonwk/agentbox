/** What each session still claims.
 *
 * A session claims weekly points when it is placed — what its model is
 * expected to use (`claimFor` in claim.ts), or `claimNormal` when the model
 * is unknown. What it has consumed is what it has spent on its account, at
 * the account's plan's price (rates.ts): its own spending, never a share of a
 * rise someone else's use in the browser caused. What it still holds is what
 * it is expected to go on to use: once it has spent anything, a forecast from
 * how it is spending (forecast.ts); until then, what is left of its claim.
 * Either way the balancer does not count a session's usage twice, once in the
 * live percentage and again in the claim.
 */

import type { ClaimView } from "./types";

export interface ClaimInput {
  sessionId: string;
  accountId: string;
  title: string;
  claim: number;
  /** When its prompt cache goes cold (`Session.cacheWarmUntil`). */
  warmUntil: number;
  /** Mid-turn right now. A running session's claim never lapses. */
  running: boolean;
  /** Since when it has been spending on this account. */
  since: number;
  /** Weekly points it is expected to still use, from what it has been
   *  spending (forecast.ts); null when there is nothing to forecast from. */
  expected?: number | null;
}

/**
 * Claims per account. A claim lapses once its session's cache has gone cold:
 * a session left open overnight should not hold an account's weekly hostage,
 * it wakes on whichever account has room by then, and if it is picked up
 * again its use shows in the live percentage anyway.
 */
export function claimsByAccount(sessions: ClaimInput[], consumed: Map<string, number>, now: number): Map<string, ClaimView[]> {
  const out = new Map<string, ClaimView[]>();
  for (const s of sessions) {
    if (s.claim <= 0) continue;
    const used = consumed.get(s.sessionId) ?? 0;
    const lapsed = !s.running && now > s.warmUntil;
    const view: ClaimView = {
      sessionId: s.sessionId,
      title: s.title,
      claim: s.claim,
      consumed: Math.round(used * 100) / 100,
      outstanding: lapsed ? 0 : Math.round(Math.max(0, s.expected ?? s.claim - used) * 100) / 100,
      basis: s.expected == null ? "claim" : "forecast",
      lapsed,
      since: s.since,
    };
    const list = out.get(s.accountId);
    if (list) list.push(view);
    else out.set(s.accountId, [view]);
  }
  return out;
}
