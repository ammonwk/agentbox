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
 * with room, the one whose weekly resets soonest wins. What expires first is
 * spent first: an account's last points are worth nothing in a day and a
 * half, while another's can wait five. Spreading by need instead (the most
 * weekly left per hour) leaves every account a little short whenever there is
 * less work than budget, and the one about to reset loses its share for good.
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
import type { Refusal } from "./refusals";
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
  /** Each active session pinned here: its outstanding weekly points, and
   *  since when it has been spending here (started, or woken onto it). */
  claims: { outstanding: number; since: number }[];
  /** No login in its home (a new account mid-login, or the CLI logged out). */
  loggedOut?: boolean;
  /** Its provider lately refused a session for want of funds (`unfundedSince`). */
  unfunded?: { at: number; detail: string } | null;
  /** The provider is refusing the model being started to this account
   *  (`refusedRoutes`): what the sessions already on it were last told. */
  refused?: Refusal | null;
}

export interface PlaceRequest {
  provider: ProviderId;
  model?: string | null;
  /** The reasoning effort it starts with; scales the claim. */
  effort?: string | null;
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
const WEEK = 7 * 24 * HOUR;

/** "402 … Insufficient account funds": the account cannot pay, whatever its
 *  usage windows say. Not a rate limit: waiting a few minutes changes nothing. */
const UNFUNDED = /\b402\b|insufficient (?:account )?(?:funds|balance|credits?)|payment required|out of credits/i;
/** How long such a refusal rules the account out, when no window says when
 *  it resets: long enough not to feed it a session an hour, short enough that
 *  one topped up is tried again the same day. */
export const UNFUNDED_HOLD_MS = 12 * HOUR;

/** The newest refusal for want of funds among an account's limit stops, while it still holds. */
export function unfundedSince(hits: { at: number; detail: string }[], now: number): { at: number; detail: string } | null {
  const hit = hits.filter((h) => UNFUNDED.test(h.detail)).sort((a, b) => b.at - a.at)[0];
  return hit && now - hit.at < UNFUNDED_HOLD_MS ? hit : null;
}

/** A window longer than the week (omp's monthly) that is spent and has not
 *  reset: nothing can be placed there, however empty its week is. */
function spentLongWindow(windows: UsageWindow[], now: number): UsageWindow | null {
  return windows.find((w) => !w.scope && w.kind !== "short" && w.kind !== "weekly" && usedNow(w, now) >= 100) ?? null;
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
  req: Pick<PlaceRequest, "model" | "settings" | "now" | "unmetered">,
): Candidate {
  const { settings, now } = req;
  const outstanding = state.claims.reduce((a, c) => a + c.outstanding, 0);
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
    shortRoom: null,
    shortLoadTo: null,
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
    const inShort = (points: number) => (points * 100) / settings.shortWindowInWeekly;
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
    c.shortRoom = round1(room);
    // How full it may be loaded: the setting, or as full as it takes to get
    // through its weekly before that resets, when that is more.
    const windowH = (short.windowMs || FIVE_HOURS) / HOUR;
    const needs = c.weeklyPerHour === null ? 0 : (c.weeklyPerHour * windowH * 100) / settings.shortWindowInWeekly;
    c.shortLoadTo = round1(Math.min(MAX_LOAD, Math.max(settings.shortLoadPct, needs)));
    // Short-window room is only room if there is weekly behind it. An account
    // at 97% weekly with a fresh 5-hour window can run about an eighth of a
    // window before it hits the weekly wall, so that is its room — not 100.
    if (c.weeklyEffective !== null) {
      room = Math.min(room, inShort(100 - c.weeklyEffective));
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
  } else if (state.refused) {
    // Whoever meters it: a route that answers nothing runs nothing.
    const r = state.refused;
    c.eligible = false;
    c.refused = true;
    c.reason = `${req.model ?? "its model"} is refused here: ${r.sessions} sessions stand refused, the last at ${clockOf(r.at)} (${r.detail.replace(/\s+/g, " ").slice(-80)}), and none has answered since; tried again ${clockOf(r.until)}`;
  } else if (req.unmetered) {
    // Nothing of this account's will be used: no limit of its is in the way.
  } else if (spentLongWindow(state.windows, now)) {
    const w = spentLongWindow(state.windows, now)!;
    c.eligible = false;
    c.reason = `${w.label.toLowerCase()} limit reached (${round1(usedNow(w, now))}%)${w.resetsAt ? `, resets ${dayOf(w.resetsAt)}` : ""}`;
  } else if (state.unfunded) {
    c.eligible = false;
    c.reason = `out of funds: its provider refused a session at ${clockOf(state.unfunded.at)} (${state.unfunded.detail.replace(/\s+/g, " ").slice(-80)}); tried again ${dayOf(state.unfunded.at + UNFUNDED_HOLD_MS)}`;
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
 * Room for a session needing `need` of a 5-hour window: its claim fits in
 * what the window and the weekly behind it have left (`legRoom`), and the
 * window stays under its load line with it.
 */
function fits(c: Candidate, need: number): boolean {
  if (c.legRoom === null || c.legRoom < need) return false;
  return c.shortRoom === null || c.shortLoadTo === null || 100 - c.shortRoom + need <= c.shortLoadTo;
}

/** When its weekly resets, for ordering. One that has not started, or has
 *  reset since its last reading, loses nothing by waiting: last. */
function weeklyDue(c: Candidate, now: number): number {
  return c.weeklyResetsAt !== null && c.weeklyResetsAt > now ? c.weeklyResetsAt : Infinity;
}

/**
 * The ordering. First, whether the account has room for this session
 * (`fits`): one without would put it at risk of stopping mid-work. Among
 * those that have room, the one whose weekly resets soonest — what expires
 * first is spent first — then the most weekly left per hour until then. Among
 * those that do not, the most room (the least overrun, below zero), since
 * that is the least likely to stall. Then fewer outstanding claims, then name.
 *
 * Eligible accounts come before the rest whatever their numbers.
 */
function rank(candidates: Candidate[], need: number, now: number): Candidate[] {
  const fit = (c: Candidate): number => Number(fits(c, need));
  const known = (c: Candidate): number => (c.legRoom === null ? 0 : 1);
  // Infinity − Infinity is NaN, which a sort cannot use.
  const sooner = (a: Candidate, b: Candidate): number => (weeklyDue(a, now) === weeklyDue(b, now) ? 0 : weeklyDue(a, now) - weeklyDue(b, now));
  const order = (group: Candidate[]): Candidate[] =>
    [...group].sort(
      (a, b) =>
        fit(b) - fit(a) ||
        (fit(a) ? sooner(a, b) || (b.weeklyPerHour ?? -1) - (a.weeklyPerHour ?? -1) : 0) ||
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
  const claim = req.unmetered ? 0 : claimFor({ model: req.model, effort: req.effort }, req.settings);
  const candidates = req.accounts.map((a) => evaluate(a, req));
  const need = needOf(claim, req.settings);
  const ordered = rank(candidates, need, req.now);
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
    // has real weekly left, refusing outright would leave work undone that the
    // accounts could in fact do — so overflow onto the least-claimed one, and
    // say so. Only a truly exhausted (or switched-off) fleet refuses — and
    // an account at its 5-hour limit is exhausted for now, estimate or not.
    // One on pace to run out goes last: overflow is for estimates that
    // overran, and a measured pace is not an estimate.
    const open = candidates
      .filter((c) => req.accounts.find((a) => a.account.id === c.accountId)?.account.enabled && !c.refused && (c.weekly === null || c.weekly < 100) && !atShortLimit(c))
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
      why: `every ${req.provider} account is at its weekly or 5-hour limit, or turned off — pick one by hand to go anyway`,
    };
  }

  const chosen = eligible[0]!;
  return { ...base, accountId: chosen.accountId, mode: "auto", why: explain(chosen, eligible, need, req.now) };
}

/** "1d 14h", "3h 20m", "12m": how long until `at`. */
function until(at: number, now: number): string {
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m >= 24 * 60) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function explain(chosen: Candidate, eligible: Candidate[], need: number, now: number): string {
  if (eligible.length === 1) {
    return chosen.legRoom === null
      ? `${chosen.label} is the only account that can take it (usage unknown)`
      : `${chosen.label} is the only account that can take it`;
  }
  const next = eligible[1]!;
  if (chosen.legRoom === null) return `${chosen.label}: no usage reading for any account, so the first one`;
  if (!fits(chosen, need)) {
    return `no account has 5-hour room to spare for it; ${chosen.label} has the most (${chosen.legRoom} vs ${next.label} ${next.legRoom ?? "unknown"})`;
  }
  if (!fits(next, need)) {
    return `${chosen.label} is the only one with room in its 5-hour window for it (${chosen.legRoom} vs ${next.label} ${next.legRoom ?? "unknown"})`;
  }
  if (weeklyDue(chosen, now) < weeklyDue(next, now)) {
    const left = chosen.weeklyEffective === null ? "" : `, with ${round1(Math.max(0, 100 - chosen.weeklyEffective))} of it still to use`;
    const other = weeklyDue(next, now) === Infinity ? `${next.label}'s has not started` : `${next.label} in ${until(next.weeklyResetsAt!, now)}`;
    return `${chosen.label}'s weekly resets soonest (in ${until(chosen.weeklyResetsAt!, now)}; ${other})${left}, and it has room in its 5-hour window`;
  }
  if (chosen.weeklyPerHour !== null && next.weeklyPerHour !== null && chosen.weeklyPerHour !== next.weeklyPerHour) {
    const [a, b] = rates(chosen.weeklyPerHour, next.weeklyPerHour);
    return `${chosen.label} has the most weekly to use before they reset together (${a}/h vs ${next.label} ${b}/h), and room in its 5-hour window`;
  }
  return `${chosen.label} has the fewest sessions claiming it`;
}
