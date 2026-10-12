/** Which accounts a model is refusing work on.
 *
 * A provider can refuse a model outright ("Model is unavailable"), or refuse
 * it to one account ("This Go model requires Global regions"): every call
 * answers 4xx whatever is sent, and a session placed there dies on its first
 * turn. Nothing in an account's usage windows says so. What does is the
 * sessions already there: each transcript records what the provider last did
 * with its model (`TranscriptFacts.modelOutcome`), and this file reads the
 * route's state off those, for the balancer to rule the account out
 * (docs/v2.md, "Placing a new session").
 *
 * A route is a model on an account. It is refusing while two or more sessions
 * stand refused on it and no session that is still getting answers has had
 * one since: one refused session may be its own doing, two with nothing
 * getting through between them is the route. An hour after the last refusal
 * it is tried again, with one session at a time: while that one has not
 * heard, the route stays shut; answered, it is open; refused, it is shut for
 * another hour.
 *
 * Each account is judged on its own sessions, since a refusal can be one
 * account's (a workspace setting) and a transcript cannot tell that from the
 * model being down. An account nothing has run the model on is tried, unless
 * two or more accounts are refused and none is getting answers: two accounts
 * turned down alike is the model, and the rest need not find out one dead
 * session at a time.
 */

import type { ModelOutcome } from "./providers/types";

const HOUR = 3_600_000;
/** How long after the last refusal a route takes nothing new. */
export const REFUSAL_HOLD_MS = HOUR;
/** How far back a refusal still counts toward the two. */
export const REFUSAL_LOOKBACK_MS = 24 * HOUR;
const REFUSED_SESSIONS = 2;
/** How many accounts refused alike, none answering, speak for the untried. */
const REFUSED_ACCOUNTS = 2;

/** One session on a route: what it was last told, or (both null) that it
 *  was started and has not heard yet. */
export interface RouteOutcome extends ModelOutcome {
  accountId: string | null;
  startedAt?: number;
}

export interface Refusal {
  /** The newest refusal. */
  at: number;
  detail: string;
  /** How many sessions stand refused. */
  sessions: number;
  /** When the route takes a session again. */
  until: number;
}

/** How long a session let through to try a route is waited on. */
const TRIAL_MS = 10 * 60_000;

/** One account's own sessions on the model: refused, on trial (still refused
 *  as far as anyone knows, but due a session to find out), open, or (null)
 *  none to go on. */
function own(outcomes: RouteOutcome[], now: number): { refused: Refusal; trial: boolean } | "open" | null {
  const heard = outcomes.filter((o) => o.okAt !== null || o.refusedAt !== null);
  if (heard.length === 0) return null;
  // A refused session's earlier answers are not the route working now, and
  // may not be this account's at all (it woke here from another).
  const answered = Math.max(0, ...heard.filter((o) => o.refusedAt === null).map((o) => o.okAt ?? 0));
  const standing = heard
    .filter((o) => o.refusedAt !== null && o.refusedAt > answered && o.refusedAt > now - REFUSAL_LOOKBACK_MS)
    .sort((a, b) => b.refusedAt! - a.refusedAt!);
  const last = standing[0];
  if (!last || standing.length < REFUSED_SESSIONS) return "open";
  const refusal = { at: last.refusedAt!, detail: last.detail ?? "", sessions: standing.length };
  const held = last.refusedAt! + REFUSAL_HOLD_MS;
  if (now < held) return { refused: { ...refusal, until: held }, trial: false };
  // Past the hold: one session tries it, and the rest wait to hear how it went.
  const trial = Math.max(0, ...outcomes.filter((o) => o.okAt === null && o.refusedAt === null).map((o) => o.startedAt ?? 0));
  const out = trial >= held && now < trial + TRIAL_MS;
  return { refused: { ...refusal, until: out ? trial + TRIAL_MS : now }, trial: !out };
}

/**
 * The accounts among `accountIds` that `model` is refusing work on now.
 * `outcomes` are the sessions of the last `REFUSAL_LOOKBACK_MS`, any model,
 * any account.
 */
export function refusedRoutes(outcomes: RouteOutcome[], model: string | null | undefined, accountIds: string[], now: number): Map<string, Refusal> {
  const out = new Map<string, Refusal>();
  if (!model) return out;
  const onModel = outcomes.filter((o) => o.model === model);
  const untried: string[] = [];
  const shut: Refusal[] = [];
  let open = 0;
  for (const id of accountIds) {
    const state = own(onModel.filter((o) => o.accountId === id), now);
    if (state === null) untried.push(id);
    else if (state === "open") open++;
    else {
      shut.push(state.refused);
      if (!state.trial) out.set(id, state.refused);
    }
  }
  if (open === 0 && shut.length >= REFUSED_ACCOUNTS) {
    const newest = [...shut].sort((a, b) => b.at - a.at)[0]!;
    for (const id of untried) out.set(id, newest);
  }
  return out;
}
