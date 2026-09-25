/** Where a new session goes.
 *
 * A pure function from each account's usage and outstanding claims to a
 * choice, with every candidate's numbers attached so the UI can show why and
 * the assignments table can replay it later. docs/v2.md ("Placing a new
 * session") is the prose version of this file; keep them in step.
 *
 * Everything is in weekly percentage points. A short (5-hour) window is
 * converted with `shortWindowInWeekly`: a claim of 5 weekly points on an
 * account where one full short window is worth 24 of them occupies about 21%
 * of that short window.
 *
 * Why the weekly limit is a gate and room is the ranking: running into either
 * limit stalls a session *now*, and the weekly limit is also a budget to spend
 * before it resets. So an account can take new sessions while any weekly is
 * left unclaimed, and among those the one with the most room wins — room being
 * what is left of the short window, capped by what is left of the weekly
 * (in short-window units) — with ties going to whichever account would
 * otherwise let the most weekly expire unused.
 */

import type {
  Account,
  BalancerSettings,
  Candidate,
  Placement,
  ProviderId,
  UsageWindow,
} from "./types";

export interface AccountState {
  account: Pick<Account, "id" | "label" | "enabled">;
  windows: UsageWindow[];
  /** Outstanding weekly points of each active session pinned here. */
  outstanding: number[];
  /** Logged in as the same login as this account: one usage pool, which
   *  places and claims under that account only. */
  sameAs?: string | null;
}

export interface PlaceRequest {
  provider: ProviderId;
  big: boolean;
  model?: string | null;
  /** A specific account instead of the balancer's pick. */
  accountId?: string | null;
  accounts: AccountState[];
  settings: BalancerSettings;
  now: number;
}

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;

/** The unscoped weekly window, if the provider reports one. */
export function weeklyWindow(windows: UsageWindow[]): UsageWindow | null {
  return windows.find((w) => w.kind === "weekly" && !w.scope) ?? null;
}

function shortWindow(windows: UsageWindow[]): UsageWindow | null {
  return windows.find((w) => w.kind === "short" && !w.scope) ?? null;
}

/**
 * A weekly limit that applies only to the model being started, matched by
 * name: the provider says "Fable", the model string says "claude-fable-5-1".
 */
function scopedWindow(windows: UsageWindow[], model: string | null | undefined): UsageWindow | null {
  if (!model) return null;
  const m = model.toLowerCase();
  return (
    windows.find((w) => w.kind === "weekly" && w.scope && m.includes(w.scope.model.toLowerCase())) ?? null
  );
}

/**
 * Used percent as of `now`. A reading whose window has since reset is stale in
 * the one direction that matters — the window is empty now — so it counts as
 * zero rather than as its old value.
 */
function usedNow(w: UsageWindow, now: number): number {
  if (w.resetsAt !== null && w.resetsAt <= now) return 0;
  return w.usedPct;
}

/** Hours until the window resets. A window with nothing used has not started,
 *  so it has its whole length ahead of it. */
function hoursLeft(w: UsageWindow, now: number): number {
  if (w.resetsAt === null || w.resetsAt <= now) return (w.windowMs || WEEK) / HOUR;
  return (w.resetsAt - now) / HOUR;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * A weekly rate for a sentence: two decimals (these are fractions of a point
 * an hour, so fewer says nothing), three when two would print a tie the
 * ranking did not see. The candidate itself keeps three.
 */
function rates(a: number, b: number): [string, string] {
  const d = a.toFixed(2) === b.toFixed(2) ? 3 : 2;
  return [a.toFixed(d), b.toFixed(d)];
}

function evaluate(
  state: AccountState,
  req: Pick<PlaceRequest, "model" | "settings" | "now">,
): Candidate {
  const { settings, now } = req;
  const outstanding = state.outstanding.reduce((a, b) => a + b, 0);
  const weekly = weeklyWindow(state.windows);
  const short = shortWindow(state.windows);
  const scoped = scopedWindow(state.windows, req.model);

  const c: Candidate = {
    accountId: state.account.id,
    label: state.account.label,
    eligible: true,
    reason: null,
    weekly: null,
    weeklyEffective: null,
    weeklyResetsAt: weekly?.resetsAt ?? null,
    short: null,
    shortEffective: null,
    shortResetsAt: short?.resetsAt ?? null,
    legRoom: null,
    weeklyPerHour: null,
    outstanding: round1(outstanding),
    score: 0,
  };

  if (weekly) {
    c.weekly = round1(usedNow(weekly, now));
    c.weeklyEffective = round1(c.weekly + outstanding);
    c.weeklyPerHour = Math.round((Math.max(0, 100 - c.weeklyEffective) / Math.max(hoursLeft(weekly, now), 0.25)) * 1000) / 1000;
  }

  if (short) {
    c.short = round1(usedNow(short, now));
    c.shortEffective = round1(c.short + (outstanding * 100) / settings.shortWindowInWeekly);
    let room = Math.max(0, 100 - c.shortEffective);
    // A window about to reset is mostly fresh room: over the next
    // `resetHorizonMin` a new session spends little time in what is left of
    // this window and most of it in the next one.
    const horizonH = settings.resetHorizonMin / 60;
    const left = short.resetsAt !== null && short.resetsAt > now ? hoursLeft(short, now) : (short.windowMs || FIVE_HOURS) / HOUR;
    if (horizonH > 0 && left < horizonH) room += (100 - room) * (1 - left / horizonH);
    // Short-window room is only room if there is weekly behind it. An account
    // at 97% weekly with a fresh 5-hour window can run about an eighth of a
    // window before it hits the weekly wall, so that is its room — not 100.
    if (c.weeklyEffective !== null) {
      const weeklyRoom = (Math.max(0, 100 - c.weeklyEffective) * 100) / settings.shortWindowInWeekly;
      room = Math.min(room, weeklyRoom);
    }
    c.legRoom = round1(room);
  } else if (weekly) {
    // No short window (codex since August 2026): nothing short-term to run
    // into, so every account has full leg room and the weekly rate decides.
    c.legRoom = 100;
  }

  if (!state.account.enabled) {
    c.eligible = false;
    c.reason = "turned off for new sessions";
  } else if (state.sameAs) {
    c.eligible = false;
    c.reason = `same login as ${state.sameAs} — one usage pool, placed there`;
  } else if (c.weeklyEffective !== null && c.weeklyEffective >= 100) {
    c.eligible = false;
    c.reason =
      outstanding > 0
        ? `weekly is spoken for: ${c.weekly}% used + ${c.outstanding} claimed by running sessions`
        : `weekly limit reached (${c.weekly}%)`;
  } else if (scoped && usedNow(scoped, now) + outstanding >= 100) {
    c.eligible = false;
    c.reason = `${scoped.scope!.model} weekly limit reached (${round1(usedNow(scoped, now))}%)`;
  }

  c.score = c.legRoom ?? -1;
  return c;
}

/**
 * How far below the leader's room still counts as a tie: `tieBand`, but never
 * more than half the leader's room. The band is for "about as much room",
 * and when the best account has only 8 points (its last 2% of weekly), an
 * account with none is not about as much — a flat 10 tied them, the tie went
 * to the empty one on weekly per hour, and the 2% was never used.
 */
function bandWidth(best: number, tieBand: number): number {
  return Math.min(tieBand, best / 2);
}

/**
 * The ordering: leg room first, but anything within the band (`bandWidth`) of
 * the leader is a tie, settled by weekly left per hour (use it or lose it),
 * then by fewer outstanding claims, then by name for determinism.
 *
 * The band is anchored to the leader rather than applied pairwise, because a
 * pairwise "within 10 points" is not transitive and would make the order
 * depend on input order. And it is anchored among *eligible* accounts only: a
 * switched-off account with a fresh window must not move the band that decides
 * between the ones that can actually take the session.
 */
function rank(candidates: Candidate[], tieBand: number): Candidate[] {
  const order = (group: Candidate[]): Candidate[] => {
    const known = group.filter((c) => c.legRoom !== null);
    const best = known.length ? Math.max(...known.map((c) => c.legRoom!)) : null;
    const band = (c: Candidate): number =>
      c.legRoom === null ? 2 : best !== null && c.legRoom >= best - bandWidth(best, tieBand) ? 0 : 1;
    return [...group].sort(
      (a, b) =>
        band(a) - band(b) ||
        (band(a) === 1 ? b.legRoom! - a.legRoom! : 0) ||
        (b.weeklyPerHour ?? -1) - (a.weeklyPerHour ?? -1) ||
        a.outstanding - b.outstanding ||
        a.label.localeCompare(b.label),
    );
  };
  return [...order(candidates.filter((c) => c.eligible)), ...order(candidates.filter((c) => !c.eligible))];
}

export function place(req: PlaceRequest): Placement {
  const claim = req.big ? req.settings.claimBig : req.settings.claimNormal;
  const candidates = req.accounts.map((a) => evaluate(a, req));
  const ordered = rank(candidates, req.settings.tieBand);
  const eligible = ordered.filter((c) => c.eligible);

  const base = { provider: req.provider, big: req.big, claim, candidates: ordered };

  if (req.accountId) {
    const chosen = candidates.find((c) => c.accountId === req.accountId);
    if (!chosen) {
      return { ...base, accountId: null, mode: "none", why: `no ${req.provider} account ${req.accountId}` };
    }
    return {
      ...base,
      accountId: chosen.accountId,
      mode: "manual",
      why: chosen.eligible
        ? `you picked ${chosen.label}`
        : `you picked ${chosen.label}, which the balancer would not have: ${chosen.reason}`,
    };
  }

  if (req.accounts.length === 0) {
    return { ...base, accountId: null, mode: "none", why: `no ${req.provider} account is set up` };
  }
  if (eligible.length === 0) {
    // Claims are estimates. When every account is spoken for but some still
    // has real weekly left, refusing outright would leave work undone that the
    // accounts could in fact do — so overflow onto the least-claimed one, and
    // say so. Only a truly exhausted (or switched-off) fleet refuses.
    const open = candidates
      .filter((c) => req.accounts.find((a) => a.account.id === c.accountId)?.account.enabled && (c.weekly === null || c.weekly < 100))
      .sort((a, b) => (a.weeklyEffective ?? 0) - (b.weeklyEffective ?? 0) || (b.legRoom ?? 0) - (a.legRoom ?? 0));
    const least = open[0];
    if (least) {
      return {
        ...base,
        accountId: least.accountId,
        mode: "overflow",
        why: `every ${req.provider} account's weekly is fully claimed by running sessions; ${least.label} is the least claimed (${least.weekly}% used + ${least.outstanding} claimed)`,
      };
    }
    return {
      ...base,
      accountId: null,
      mode: "none",
      why: `every ${req.provider} account is at its weekly limit or turned off — pick one by hand to go anyway`,
    };
  }

  const chosen = eligible[0]!;
  return { ...base, accountId: chosen.accountId, mode: "auto", why: explain(chosen, eligible, req.settings.tieBand) };
}

function explain(chosen: Candidate, eligible: Candidate[], tieBand: number): string {
  if (eligible.length === 1) {
    return chosen.legRoom === null
      ? `${chosen.label} is the only account that can take it (usage unknown)`
      : `${chosen.label} is the only account with weekly left`;
  }
  const next = eligible[1]!;
  if (chosen.legRoom === null) return `${chosen.label}: no usage reading for any account, so the first one`;
  const outsideBand = next.legRoom === null || chosen.legRoom - next.legRoom > bandWidth(chosen.legRoom, tieBand);
  if (outsideBand && chosen.shortEffective !== null) {
    return `${chosen.label} has the most room (${chosen.legRoom} vs ${next.label} ${next.legRoom}, counting both its 5-hour and its weekly)`;
  }
  if (chosen.weeklyPerHour !== null && next.weeklyPerHour !== null && chosen.weeklyPerHour !== next.weeklyPerHour) {
    const [a, b] = rates(chosen.weeklyPerHour, next.weeklyPerHour);
    return `${chosen.label} has the most weekly to use before it resets (${a}/h vs ${next.label} ${b}/h)`;
  }
  return `${chosen.label} has the fewest sessions claiming it`;
}
