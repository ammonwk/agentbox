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
 * The two limits do different jobs. The weekly is a budget: whatever is left
 * of it when it resets is lost, so it should be spent. The 5-hour window is a
 * wall: a session that runs into it stops where it stands until the window
 * resets. So the 5-hour decides where a session *can* go — an account on pace
 * to hit it before it resets takes nothing new, and one without room in it for
 * this session's claim ranks below every one with — and among the accounts
 * with room, the one that would otherwise let the most weekly go unused wins:
 * weekly left per hour until its reset.
 *
 * The pace is measured, not claimed: claims are what sessions placed here were
 * expected to spend, and an account also runs what the balancer never placed
 * — a lead's teammates, a session run by hand, one that turned out bigger than
 * its claim. The last readings say how fast the window is really filling.
 */

import { claimFor } from "./claim";
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
  /** Readings of the short window over the last hour and a half, oldest first. */
  shortSamples?: { at: number; usedPct: number; resetsAt: number | null }[];
  /** Outstanding weekly points of each active session pinned here. */
  outstanding: number[];
  /** No login in its home (a new account mid-login, or the CLI logged out). */
  loggedOut?: boolean;
}

export interface PlaceRequest {
  provider: ProviderId;
  big: boolean;
  model?: string | null;
  /** The reasoning effort it starts with; scales the claim. */
  effort?: string | null;
  /** A specific account instead of the balancer's pick. */
  accountId?: string | null;
  accounts: AccountState[];
  settings: BalancerSettings;
  now: number;
}

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const FIVE_HOURS = 5 * HOUR;
/** The pace is over about this much of the recent past… */
const PACE_SPAN = 45 * 60_000;
/** …and not over less than this, which a single session's burst can dominate. */
const PACE_MIN_SPAN = 10 * 60_000;
/** Running out this long before the reset is a stall worth avoiding; less is a
 *  pause, and the account is otherwise about to be fresh. */
const STALL_MS = 10 * 60_000;

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
 * How fast the short window is filling, in its points an hour: from the
 * reading about `PACE_SPAN` ago (or the first of this window, if it started
 * since) to now. Readings are stored when they change, so a flat stretch has
 * none; the last one before the span stands for its start. Null when the
 * window is not running or the readings cover too little time.
 */
export function paceOf(short: UsageWindow, samples: AccountState["shortSamples"], now: number): number | null {
  if (short.resetsAt === null || short.resetsAt <= now || !samples?.length) return null;
  const same = samples.filter((s) => s.resetsAt !== null && Math.abs(s.resetsAt - short.resetsAt!) < 10 * 60_000 && s.at <= now);
  if (!same.length) return null;
  const base = [...same].reverse().find((s) => s.at <= now - PACE_SPAN) ?? same[0]!;
  const span = now - base.at;
  if (span < PACE_MIN_SPAN) return null;
  return Math.max(0, (short.usedPct - base.usedPct) / (span / HOUR));
}

const clockOf = (t: number): string => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * A weekly rate for a sentence: two decimals (these are fractions of a point
 * an hour, so fewer says nothing), three when two would print a tie the
 * ranking did not see. The candidate itself keeps three.
 */
function rates(a: number, b: number): [string, string] {
  const d = a.toFixed(2) === b.toFixed(2) ? 3 : 2;
  return [a.toFixed(d), b.toFixed(d)];
}

/** At its 5-hour limit now and not resetting within the horizon (which would
 *  have raised its room): a session placed there stalls on its first turn.
 *  Claims are an estimate; this is not. */
function atShortLimit(c: Candidate): boolean {
  return c.short !== null && c.short >= 100 && c.legRoom === 0;
}

/** On pace to hit the 5-hour limit well before the window resets. */
function runsOut(c: Candidate): boolean {
  return c.shortRunsOutAt !== null && c.shortResetsAt !== null && c.shortResetsAt - c.shortRunsOutAt > STALL_MS;
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
    shortPace: null,
    shortRunsOutAt: null,
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
    // Unfloored until the end: below zero is how far claims overrun the
    // window, which is what separates two accounts that both have none.
    let room = 100 - c.shortEffective;
    // At the pace it is filling, what is left of it when it resets: claims
    // or pace, whichever says less — they count the same sessions.
    const pace = paceOf(short, state.shortSamples, now);
    if (pace !== null) {
      c.shortPace = round1(pace);
      const hours = hoursLeft(short, now);
      room = Math.min(room, 100 - (c.short + pace * hours));
      if (pace > 0 && c.short < 100) {
        const at = now + ((100 - c.short) / pace) * HOUR;
        if (short.resetsAt !== null && at < short.resetsAt) c.shortRunsOutAt = Math.round(at);
      }
    }
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
      const weeklyRoom = ((100 - c.weeklyEffective) * 100) / settings.shortWindowInWeekly;
      room = Math.min(room, weeklyRoom);
    }
    c.legRoom = round1(Math.max(0, room));
    c.score = round1(room);
  } else if (weekly) {
    // No short window (codex since August 2026): nothing short-term to run
    // into, so every account has full leg room and the weekly rate decides.
    c.legRoom = 100;
    c.score = 100;
  } else {
    // Finite, so it survives JSON; sorts below any real room.
    c.score = -Number.MAX_VALUE;
  }

  if (!state.account.enabled) {
    c.eligible = false;
    c.reason = "turned off for new sessions";
  } else if (state.loggedOut) {
    c.eligible = false;
    c.reason = "not logged in";
  } else if (atShortLimit(c)) {
    c.eligible = false;
    c.reason = `5-hour limit reached (${c.short}%)`;
  } else if (runsOut(c)) {
    c.eligible = false;
    c.reason = `at its pace (+${c.shortPace}%/h) it hits its 5-hour limit at ${clockOf(c.shortRunsOutAt!)}, before it resets at ${clockOf(c.shortResetsAt!)}`;
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

  return c;
}

/**
 * The ordering. First, whether the account has room in its 5-hour window for
 * this session's claim (`need`, in that window's points): one without would
 * put it at risk of stopping mid-work. Among those that have room, the most
 * weekly left per hour until the weekly resets — use it or lose it. Among
 * those that do not, the most room (the least overrun, below zero), since that
 * is the least likely to stall. Then fewer outstanding claims, then name.
 *
 * Eligible accounts come before the rest whatever their numbers.
 */
function rank(candidates: Candidate[], need: number): Candidate[] {
  const fits = (c: Candidate): number => (c.legRoom !== null && c.legRoom >= need ? 1 : 0);
  const known = (c: Candidate): number => (c.legRoom === null ? 0 : 1);
  const order = (group: Candidate[]): Candidate[] =>
    [...group].sort(
      (a, b) =>
        fits(b) - fits(a) ||
        (fits(a) ? (b.weeklyPerHour ?? -1) - (a.weeklyPerHour ?? -1) : 0) ||
        known(b) - known(a) ||
        b.score - a.score ||
        a.outstanding - b.outstanding ||
        a.label.localeCompare(b.label),
    );
  return [...order(candidates.filter((c) => c.eligible)), ...order(candidates.filter((c) => !c.eligible))];
}

/** A claim in the short window's points: 3 weekly points is an eighth of a window at 24. */
function needOf(claim: number, settings: BalancerSettings): number {
  return (claim * 100) / settings.shortWindowInWeekly;
}

export function place(req: PlaceRequest): Placement {
  // The claim is the model's, not one number for everything: a GLM-Flash
  // session and a Fable one are not the same guest (see claim.ts).
  const claim = claimFor({ model: req.model, effort: req.effort, big: req.big }, req.settings);
  const candidates = req.accounts.map((a) => evaluate(a, req));
  const need = needOf(claim, req.settings);
  const ordered = rank(candidates, need);
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
    // say so. Only a truly exhausted (or switched-off) fleet refuses — and
    // an account at its 5-hour limit is exhausted for now, estimate or not.
    // One on pace to run out goes last: overflow is for estimates that
    // overran, and a measured pace is not an estimate.
    const open = candidates
      .filter((c) => req.accounts.find((a) => a.account.id === c.accountId)?.account.enabled && (c.weekly === null || c.weekly < 100) && !atShortLimit(c))
      .sort(
        (a, b) =>
          Number(runsOut(a)) - Number(runsOut(b)) ||
          (a.weeklyEffective ?? 0) - (b.weeklyEffective ?? 0) ||
          (b.legRoom ?? 0) - (a.legRoom ?? 0),
      );
    const least = open[0];
    if (least) {
      return {
        ...base,
        accountId: least.accountId,
        mode: "overflow",
        why: `no ${req.provider} account has both unclaimed weekly and an open 5-hour window; ${least.label} is the least claimed (${least.weekly}% used + ${least.outstanding} claimed)`,
      };
    }
    return {
      ...base,
      accountId: null,
      mode: "none",
      why: `every ${req.provider} account is at its weekly or 5-hour limit, or turned off — pick one by hand to go anyway`,
    };
  }

  const chosen = eligible[0]!;
  return { ...base, accountId: chosen.accountId, mode: "auto", why: explain(chosen, eligible, need) };
}

function explain(chosen: Candidate, eligible: Candidate[], need: number): string {
  if (eligible.length === 1) {
    return chosen.legRoom === null
      ? `${chosen.label} is the only account that can take it (usage unknown)`
      : `${chosen.label} is the only account that can take it`;
  }
  const next = eligible[1]!;
  if (chosen.legRoom === null) return `${chosen.label}: no usage reading for any account, so the first one`;
  const fits = (c: Candidate) => c.legRoom !== null && c.legRoom >= need;
  if (!fits(chosen)) {
    return `no account has 5-hour room to spare for it; ${chosen.label} has the most (${chosen.legRoom} vs ${next.label} ${next.legRoom ?? "unknown"})`;
  }
  if (!fits(next)) {
    return `${chosen.label} is the only one with room in its 5-hour window for it (${chosen.legRoom} vs ${next.label} ${next.legRoom ?? "unknown"})`;
  }
  if (chosen.weeklyPerHour !== null && next.weeklyPerHour !== null && chosen.weeklyPerHour !== next.weeklyPerHour) {
    const [a, b] = rates(chosen.weeklyPerHour, next.weeklyPerHour);
    return `${chosen.label} has the most weekly to use before it resets (${a}/h vs ${next.label} ${b}/h), and room in its 5-hour window`;
  }
  return `${chosen.label} has the fewest sessions claiming it`;
}
