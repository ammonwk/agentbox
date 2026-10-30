/** Where a new session goes.
 *
 * A pure function from each account's usage and outstanding claims to a
 * choice, with every candidate's numbers attached so the UI can show why and
 * the assignments table can replay it later. docs/v2.md ("Placing a new
 * session") is the prose version of this file; keep them in step.
 *
 * Claims are in weekly percentage points, and turned into any other window's
 * points by what one weekly point is there, measured (rates.ts): on Claude a
 * claim of 5 weekly points is about 21% of a 5-hour window (a full one is 24
 * weekly points), on Go 12.5% (40), and 2.5% of Go's monthly.
 *
 * The limits do two different jobs. The 5-hour window is a wall: a session
 * that runs into it stops where it stands until the window resets. Every
 * longer one — the weekly, Go's monthly, a model's own weekly — is a budget:
 * whatever is left of it when it resets is lost, so it should be spent, and
 * the one that runs out first, counting claims, is the account's budget (an
 * account 18% into its week with 4% of its month left has 8 weekly points to
 * spend, until the month resets). So the 5-hour decides where a session *can*
 * go — an account on pace to hit it before it resets takes nothing new, and
 * one without room in it for this session's claim ranks below every one with
 * — and among the accounts with room, the one whose budget resets soonest
 * wins. What expires first is spent first: an account's last points are worth
 * nothing in a day and a half, while another's can wait five. Spreading by
 * need instead (the most left per hour) leaves every account a little short
 * whenever there is less work than budget, and the one about to reset loses
 * its share for good.
 *
 * "Room" is therefore a line, not the whole window: an account is loaded
 * until its 5-hour window is forecast `shortLoadPct` full (half), and the
 * next session goes to the next account to reset. The other half is the
 * margin for sessions that turn out bigger than forecast. An account that
 * cannot finish its weekly at that rate before it resets is loaded further,
 * as far as it needs, up to `MAX_LOAD`.
 *
 * The pace is measured, not claimed: claims are what sessions placed here were
 * expected to spend, and an account also runs what the balancer never placed
 * — a lead's teammates, a session run by hand, one that turned out bigger than
 * its claim. The last readings say how fast the window is really filling. So
 * where there is a pace, it is the forecast, and a claim adds to it only for
 * the part of the pace's span its session was not yet here to be measured: a
 * session started ten minutes ago is mostly claim, one running for an hour is
 * already in the pace.
 */

import { claimFor } from "./claim";
import { coldPerWeekly } from "./rates";
import { statedUntil, statedWaitMs } from "./retrywait";
import type { Refusal } from "./refusals";
import type {
  Account,
  AccountAuth,
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
  /** Each active session pinned here: its outstanding weekly points, and
   *  since when it has been spending here (started, or woken onto it). */
  claims: { outstanding: number; since: number }[];
  /** Its login as identity.ts reads it: "missing" (none in its home) and
   *  "expired" (its refresh token is past its end, or the CLI cleared it) run
   *  nothing; every session started there dies on its first call. */
  auth?: AccountAuth["state"] | null;
  /** Its provider lately stopped a session at a limit, or for want of
   *  funds, and that still holds (`stoppedSince`). */
  stopped?: { at: number; detail: string; until: number } | null;
  /** The provider is refusing the model being started to this account
   *  (`refusedRoutes`): what the sessions already on it were last told. */
  refused?: Refusal | null;
  /** How many of each window's points one weekly point is here, by window
   *  id (`Rates.perWeeklyOf`); a window it leaves out, `coldPerWeekly`. */
  perWeekly?: Record<string, number>;
}

export interface PlaceRequest {
  provider: ProviderId;
  model?: string | null;
  /** The reasoning effort it starts with; scales the claim. */
  effort?: string | null;
  /** What it claims, where sessions like it have run before
   *  (`Forecaster.claim`); absent, its model's listed claim (claim.ts). */
  claim?: number | null;
  /** A specific account instead of the balancer's pick. */
  accountId?: string | null;
  /** The model is someone else's to meter (one agentbox's devin bridge
   *  serves): the session claims nothing, and an account at its limit can
   *  still take it. Turned off and logged out still rule an account out. */
  unmetered?: boolean;
  accounts: AccountState[];
  settings: BalancerSettings;
  now: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** How far back a limit stop can still hold: a week's limit names a reset
 *  up to a week out. */
export const STOP_LOOKBACK_MS = 8 * DAY;
/** How long a limit stop holds when nothing says when it lifts (a 402 for
 *  want of funds): long enough not to feed it a session an hour, short
 *  enough that one topped up is tried again the same day. */
const STOP_HOLD_MS = 12 * HOUR;

/**
 * The newest of an account's limit stops (a session it ran was refused at a
 * limit, or for want of funds), while it still holds; this, not a reading at
 * 100%, is what rules an account out on its usage, since a provider can let a
 * spent window run on (Claude did, at a week read 100%). It holds until a
 * reading taken since has no window at its limit (it reset, was redeemed, or
 * the plan grew), else until the latest reset among the windows spent since
 * before it struck, else the wait or time it names, else `STOP_HOLD_MS`.
 * `model` picks which model-scoped windows count.
 */
export function stoppedSince(
  hits: { at: number; detail: string }[],
  now: number,
  usage?: { at: number | null; windows: UsageWindow[] },
  model?: string | null,
): { at: number; detail: string; until: number } | null {
  const hit = [...hits].sort((a, b) => b.at - a.at)[0];
  if (!hit) return null;
  const m = model?.toLowerCase() ?? null;
  const windows = (usage?.windows ?? []).filter((w) => !w.scope || (m !== null && m.includes(w.scope.model.toLowerCase())));
  const readSince = usage?.at != null && usage.at > hit.at && windows.length > 0;
  if (readSince && windows.every((w) => usedNow(w, now) < 100)) return null;
  const spent = windows
    .filter((w) => w.usedPct >= 100 && w.resetsAt !== null && w.resetsAt > now && w.resetsAt - (w.windowMs || WEEK) <= hit.at)
    .map((w) => w.resetsAt!);
  const wait = statedWaitMs(hit.detail);
  const until = spent.length ? Math.max(...spent) : wait !== null ? hit.at + wait : (statedUntil(hit.detail, hit.at) ?? hit.at + STOP_HOLD_MS);
  return until > now ? { ...hit, until } : null;
}

/** A day and time for a sentence: "Sun, Oct 11, 9:15 AM". */
function dayOf(at: number): string {
  return new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const FIVE_HOURS = 5 * HOUR;
/** However much weekly an account has to get through, its 5-hour window is
 *  never loaded past this: the rest is the margin for forecasts being wrong. */
const MAX_LOAD = 90;
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
 * The budgets that apply to a session of `model`: every window longer than
 * the 5-hour one, unscoped or scoped to that model, matched by name (the
 * provider says "Fable", the model string says "claude-fable-5-1").
 */
function budgetWindows(windows: UsageWindow[], model: string | null | undefined): UsageWindow[] {
  const m = model?.toLowerCase() ?? null;
  return windows.filter((w) => w.kind !== "short" && (!w.scope || (m !== null && m.includes(w.scope.model.toLowerCase()))));
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
export function paceOf(
  short: UsageWindow,
  samples: AccountState["shortSamples"],
  now: number,
): { perHour: number; since: number } | null {
  if (short.resetsAt === null || short.resetsAt <= now || !samples?.length) return null;
  const same = samples.filter((s) => s.resetsAt !== null && Math.abs(s.resetsAt - short.resetsAt!) < 10 * 60_000 && s.at <= now);
  if (!same.length) return null;
  const base = [...same].reverse().find((s) => s.at <= now - PACE_SPAN) ?? same[0]!;
  const span = now - base.at;
  if (span < PACE_MIN_SPAN) return null;
  return { perHour: Math.max(0, (short.usedPct - base.usedPct) / (span / HOUR)), since: base.at };
}

/** The share of a claim the pace has not seen: how much of the pace's span
 *  (`from` to `now`) had passed before its session was here to spend. */
function unseenShare(since: number, from: number, now: number): number {
  if (now <= from) return 1;
  return Math.min(1, Math.max(0, (since - from) / (now - from)));
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

/** On pace to hit the 5-hour limit well before the window resets. */
function runsOut(c: Candidate): boolean {
  return c.shortRunsOutAt !== null && c.shortResetsAt !== null && c.shortResetsAt - c.shortRunsOutAt > STALL_MS;
}

function evaluate(
  state: AccountState,
  req: Pick<PlaceRequest, "model" | "settings" | "now" | "unmetered">,
  claim: number,
): Candidate {
  const { settings, now } = req;
  const outstanding = state.claims.reduce((a, c) => a + c.outstanding, 0);
  const weekly = weeklyWindow(state.windows);
  const short = shortWindow(state.windows);
  const perWeekly = Object.fromEntries(state.windows.map((w) => [w.id, state.perWeekly?.[w.id] ?? coldPerWeekly(w)]));
  // Each budget with the claims on it, in its own percent; what is left of
  // it in weekly points. The one with the least left is the account's.
  const budgets = budgetWindows(state.windows, req.model).map((w) => {
    const used = round1(usedNow(w, now));
    const effective = round1(used + outstanding * perWeekly[w.id]!);
    return { w, used, effective, left: (100 - effective) / perWeekly[w.id]! };
  });
  const binding = [...budgets].sort((a, b) => a.left - b.left || Number(a.w !== weekly) - Number(b.w !== weekly))[0] ?? null;

  const c: Candidate = {
    accountId: state.account.id,
    label: state.account.label,
    eligible: true,
    reason: null,
    weekly: weekly ? round1(usedNow(weekly, now)) : null,
    weeklyEffective: weekly ? round1(usedNow(weekly, now) + outstanding) : null,
    budget: binding && {
      id: binding.w.id,
      label: binding.w.label,
      used: binding.used,
      effective: binding.effective,
      resetsAt: binding.w.resetsAt,
      left: round1(binding.left),
    },
    perHour: binding && Math.round((Math.max(0, binding.left) / Math.max(hoursLeft(binding.w, now), 0.25)) * 1000) / 1000,
    perWeekly,
    short: null,
    shortEffective: null,
    shortResetsAt: short?.resetsAt ?? null,
    need: short ? round1(claim * perWeekly[short.id]!) : null,
    legRoom: null,
    shortLoadTo: null,
    shortPace: null,
    shortRunsOutAt: null,
    outstanding: round1(outstanding),
    score: 0,
  };

  if (short) {
    c.short = round1(usedNow(short, now));
    const inShort = (points: number) => points * perWeekly[short.id]!;
    // Where the window is headed. Measured, when there is a pace: where it
    // stands at reset if it keeps filling this fast, plus the claims of
    // sessions too new for the pace to have seen (the rest are in it
    // already). Otherwise every claim is all there is to go on.
    const pace = paceOf(short, state.shortSamples, now);
    if (pace !== null) {
      c.shortPace = round1(pace.perHour);
      const unseen = state.claims.reduce((a, cl) => a + cl.outstanding * unseenShare(cl.since, pace.since, now), 0);
      c.shortEffective = round1(c.short + pace.perHour * hoursLeft(short, now) + inShort(unseen));
      if (pace.perHour > 0 && c.short < 100) {
        const at = now + ((100 - c.short) / pace.perHour) * HOUR;
        if (short.resetsAt !== null && at < short.resetsAt) c.shortRunsOutAt = Math.round(at);
      }
    } else {
      c.shortEffective = round1(c.short + inShort(outstanding));
    }
    // Unfloored until the end: below zero is how far it overruns the window,
    // which is what separates two accounts that both have none.
    let room = 100 - c.shortEffective;
    // A window about to reset is mostly fresh room: over the next
    // `resetHorizonMin` a new session spends little time in what is left of
    // this window and most of it in the next one.
    const horizonH = settings.resetHorizonMin / 60;
    const left = short.resetsAt !== null && short.resetsAt > now ? hoursLeft(short, now) : (short.windowMs || FIVE_HOURS) / HOUR;
    if (horizonH > 0 && left < horizonH) room += (100 - room) * (1 - left / horizonH);
    // How full it may be loaded: the setting, or as full as it takes to get
    // through its budget before that resets, when that is more.
    const windowH = (short.windowMs || FIVE_HOURS) / HOUR;
    const needs = c.perHour === null ? 0 : inShort(c.perHour * windowH);
    c.shortLoadTo = round1(Math.min(MAX_LOAD, Math.max(settings.shortLoadPct, needs)));
    c.legRoom = round1(Math.max(0, room));
    c.score = round1(room);
  } else if (binding) {
    // No short window (codex since August 2026): nothing short-term to run
    // into, so every account has full leg room and its budget decides.
    c.legRoom = 100;
    c.score = 100;
  } else {
    // Finite, so it survives JSON; sorts below any real room.
    c.score = -Number.MAX_VALUE;
  }

  // A window that reads 100% is not a refusal (`stopped` is): a provider can
  // let a spent window run on, so its account stays open, and ranks by when
  // it resets like any other. Claims are not counted against it either: how
  // much it has left is unknown, and the provider says when it is gone.
  const spokenFor = budgets.find((b) => b.used < 100 && b.effective >= 100);
  if (!state.account.enabled) {
    c.eligible = false;
    c.wall = true;
    c.reason = "turned off for new sessions";
  } else if (state.auth === "missing" || state.auth === "expired") {
    c.eligible = false;
    c.wall = true;
    c.reason = state.auth === "missing" ? "not logged in" : "its login has expired: log in again";
  } else if (state.refused) {
    // Whoever meters it: a route that answers nothing runs nothing.
    const r = state.refused;
    c.eligible = false;
    c.refused = true;
    c.wall = true;
    c.reason = `${req.model ?? "its model"} is refused here: ${r.sessions} sessions stand refused, the last at ${clockOf(r.at)} (${r.detail.replace(/\s+/g, " ").slice(-80)}), and none has answered since; tried again ${clockOf(r.until)}`;
  } else if (req.unmetered) {
    // Nothing of this account's will be used: no limit of its is in the way.
  } else if (state.stopped) {
    const s = state.stopped;
    c.eligible = false;
    c.wall = true;
    c.reason = `its provider stopped a session at ${clockOf(s.at)} (${s.detail.replace(/\s+/g, " ").slice(-80)}); tried again ${dayOf(s.until)}`;
  } else if (runsOut(c)) {
    c.eligible = false;
    c.reason = `at its pace (+${c.shortPace}%/h) it hits its 5-hour limit at ${clockOf(c.shortRunsOutAt!)}, before it resets at ${clockOf(c.shortResetsAt!)}`;
  } else if (spokenFor) {
    c.eligible = false;
    c.reason = `${spokenFor.w.label.toLowerCase()} is spoken for: ${spokenFor.used}% used + ${round1(spokenFor.effective - spokenFor.used)} claimed by running sessions`;
  }

  return c;
}

/**
 * Room for this session (`need`, its claim in the account's 5-hour points):
 * the window stays under its load line with it. The budget is no part of
 * this. An account with any of it left takes a session whatever that session
 * claims — the last points are only used by a session that may overrun them,
 * and one that does is moved on (`Fleet.continueStalled`) — and with that
 * claim on it the account is spoken for and takes no other.
 */
function fits(c: Candidate): boolean {
  if (c.legRoom === null) return false;
  const need = c.need ?? 0;
  return c.shortLoadTo === null ? c.legRoom >= need : 100 - c.legRoom + need <= c.shortLoadTo;
}

/** When its budget resets, for ordering. One that has not started, or has
 *  reset since its last reading, loses nothing by waiting: last. */
function due(c: Candidate, now: number): number {
  const at = c.budget?.resetsAt ?? null;
  return at !== null && at > now ? at : Infinity;
}

/**
 * The ordering. First, whether the account has room for this session
 * (`fits`): one without would put it at risk of stopping mid-work. Among
 * those that have room, the one whose budget resets soonest — what expires
 * first is spent first — then the most of it left per hour until then. Among
 * those that do not, the most room (the least overrun, below zero), since
 * that is the least likely to stall. Then fewer outstanding claims, then name.
 *
 * Eligible accounts come before the rest whatever their numbers.
 */
function rank(candidates: Candidate[], now: number): Candidate[] {
  const fit = (c: Candidate): number => Number(fits(c));
  const known = (c: Candidate): number => (c.legRoom === null ? 0 : 1);
  // Infinity − Infinity is NaN, which a sort cannot use.
  const sooner = (a: Candidate, b: Candidate): number => (due(a, now) === due(b, now) ? 0 : due(a, now) - due(b, now));
  const order = (group: Candidate[]): Candidate[] =>
    [...group].sort(
      (a, b) =>
        fit(b) - fit(a) ||
        (fit(a) ? sooner(a, b) || (b.perHour ?? -1) - (a.perHour ?? -1) : 0) ||
        known(b) - known(a) ||
        b.score - a.score ||
        a.outstanding - b.outstanding ||
        a.label.localeCompare(b.label),
    );
  return [...order(candidates.filter((c) => c.eligible)), ...order(candidates.filter((c) => !c.eligible))];
}

/** Weekly points left of its budget, claims counted; all of them when it has none. */
const leftOf = (c: Candidate): number => c.budget?.left ?? 100;

/**
 * Where a session cut off at `own`'s limit can carry on: the first of the
 * other accounts, in the balancer's order, that can take a session and whose
 * budget has room for what this one claims. Null when none can take a
 * session — it stays where it is.
 *
 * The room is asked of this placement alone. A new session may be given an
 * account's last points (`fits`), because one that overruns them is moved
 * on; this is that move, and the session has no other. Sent to the account
 * first to reset, it went to one with 1.2 points left while two more had 23
 * and 46. Where none has the room, the one with the most left.
 */
export function elsewhere(p: Placement, own: string): Candidate | null {
  const others = p.candidates.filter((c) => c.eligible && c.accountId !== own);
  return others.find((c) => leftOf(c) >= p.claim) ?? others.reduce<Candidate | null>((best, c) => (best && leftOf(best) >= leftOf(c) ? best : c), null);
}

export function place(req: PlaceRequest): Placement {
  // The claim is the model's, not one number for everything: a GLM-Flash
  // session and a Fable one are not the same guest (see claim.ts).
  const claim = req.unmetered ? 0 : (req.claim ?? claimFor({ model: req.model, effort: req.effort }, req.settings));
  const candidates = req.accounts.map((a) => evaluate(a, req, claim));
  const ordered = rank(candidates, req.now);
  const eligible = ordered.filter((c) => c.eligible);

  const base = { provider: req.provider, claim, candidates: ordered };

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
    // has real budget left, refusing outright would leave work undone that the
    // accounts could in fact do — so overflow onto the least-claimed one, and
    // say so. Only what claims ruled out is open to it: an account behind a
    // wall (`Candidate.wall`) stops a session on its first call, estimate or
    // not. One on pace to run out goes last: overflow is for estimates that
    // overran, and a measured pace is not an estimate.
    const open = candidates
      .filter((c) => !c.wall)
      .sort((a, b) => Number(runsOut(a)) - Number(runsOut(b)) || leftOf(b) - leftOf(a) || (b.legRoom ?? 0) - (a.legRoom ?? 0));
    const least = open[0];
    if (least) {
      return {
        ...base,
        accountId: least.accountId,
        mode: "overflow",
        why: `no ${req.provider} account has both an unclaimed budget and an open 5-hour window; ${least.label} is the least claimed${least.budget ? ` (${least.budget.label.toLowerCase()} ${least.budget.used}% used + ${round1(least.budget.effective - least.budget.used)} claimed)` : ""}`,
      };
    }
    // The model's doing, not the accounts': say so, since another model would go.
    const refused = candidates.filter((c) => c.refused);
    if (refused.length > 0) {
      return {
        ...base,
        accountId: null,
        mode: "none",
        why: `${req.model ?? `${req.provider}'s model`} is refused on every ${req.provider} account that could otherwise take it (${refused[0]!.label}: ${refused[0]!.reason}) — start it on another model, or pick an account by hand to try this one anyway`,
      };
    }
    return {
      ...base,
      accountId: null,
      mode: "none",
      why: `no ${req.provider} account can take a session (${ordered[0]!.label}: ${ordered[0]!.reason}) — pick one by hand to go anyway`,
    };
  }

  const chosen = eligible[0]!;
  return { ...base, accountId: chosen.accountId, mode: "auto", why: explain(chosen, eligible, req.now) };
}

/** "1d 14h", "3h 20m", "12m": how long until `at`. */
function until(at: number, now: number): string {
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m >= 24 * 60) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function explain(chosen: Candidate, eligible: Candidate[], now: number): string {
  if (eligible.length === 1) {
    return chosen.legRoom === null
      ? `${chosen.label} is the only account that can take it (usage unknown)`
      : `${chosen.label} is the only account that can take it`;
  }
  const next = eligible[1]!;
  if (chosen.legRoom === null) return `${chosen.label}: no usage reading for any account, so the first one`;
  if (!fits(chosen)) {
    return `no account has 5-hour room to spare for it; ${chosen.label} has the most (${chosen.legRoom} vs ${next.label} ${next.legRoom ?? "unknown"})`;
  }
  if (!fits(next)) {
    return `${chosen.label} is the only one with room in its 5-hour window for it (${chosen.legRoom} vs ${next.label} ${next.legRoom ?? "unknown"})`;
  }
  const b = chosen.budget;
  if (b && due(chosen, now) < due(next, now)) {
    const theirs = next.budget && next.budget.label !== b.label ? ` ${next.budget.label.toLowerCase()}` : "";
    const other = due(next, now) === Infinity ? `${next.label}'s${theirs} has not started` : `${next.label}'s${theirs} in ${until(due(next, now), now)}`;
    const left = b.used >= 100 ? `reading ${b.used}% but with nothing refused yet` : `with ${round1(Math.max(0, 100 - b.effective))}% of it still to use`;
    return `${chosen.label}'s ${b.label.toLowerCase()} resets soonest (in ${until(due(chosen, now), now)}; ${other}), ${left}, and it has room in its 5-hour window`;
  }
  if (chosen.perHour !== null && next.perHour !== null && chosen.perHour !== next.perHour) {
    const [x, y] = rates(chosen.perHour, next.perHour);
    return `${chosen.label} has the most of its budget to use before they reset together (${x} weekly points an hour vs ${next.label} ${y}), and room in its 5-hour window`;
  }
  return `${chosen.label} has the fewest sessions claiming it`;
}
