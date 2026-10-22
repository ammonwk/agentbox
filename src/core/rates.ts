/** What a percent of each limit is worth, measured.
 *
 * Two kinds of number turn one limit into another, and both are measured
 * here rather than written down:
 *
 *   - Between windows: how many of a window's points one weekly point is.
 *     Claude's 5-hour window is about 4.1 of them (a full one is 24 weekly
 *     points), Go's 2.5 (40), Go's monthly 0.5 (a Go month is two Go weeks).
 *     Every window counts the same spending, whoever did it, so these hold
 *     however much is used outside agentbox: in the browser, on another
 *     machine.
 *   - The price: weekly points per API-dollar (cost-equivalent, pricing.ts)
 *     of what agentbox's own sessions spent. Spending agentbox cannot see
 *     raises an account's percent without raising that cost, so taken as an
 *     average it would make every point look dearer the more you use the
 *     browser. Outside use only ever adds, though, and only to the stretches
 *     it happened in. So a stretch whose points came much dearer than the
 *     median stretch's is left out, the price is what the rest show, and
 *     what a stretch rose by beyond it is counted as used outside.
 *
 * The evidence is the account's finest window (5-hour, where there is one)
 * over its lifetime: the readings that share its reset, in pieces of at most
 * six hours. Everything is fitted per plan, pooling its accounts, from
 * `usage_samples` and `token_samples`; both are kept for good, so each
 * number's history is fitted from the same data, and a change in one raises
 * a card (`changes`).
 */

import { sessionAccounts, sessionMoves, spendBetween, usageSamplesSince } from "./db";
import type { RatesReport, UsageWindow } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** How often the fit is redone: a plan changes over days, not hours. */
const REFIT_MS = 3 * HOUR;
/** The current numbers are fitted over this much of the recent past… */
const FIT_SPAN = 14 * DAY;
/** …each day of their history over the week up to it… */
const HISTORY_FIT_SPAN = 7 * DAY;
/** …for this many days. */
const HISTORY_DAYS = 60;
/** A lifetime longer than this (a week, where there is no 5-hour window) is
 *  cut into days: a whole percent of a week is several dollars of work. */
const CHUNK_MS = DAY;
/** Providers jitter a window's reset by seconds between readings. */
const SAME_RESET_MS = 10 * MIN;
/** A window's newest reading stands for its value only this long: readings
 *  are stored when they move, and at least hourly otherwise. */
const STALE_MS = 2 * HOUR;
/** A rise of the finest window under this says little about a ratio: the
 *  readings are whole percent. */
const MIN_RISE = 5;
const MIN_RATIO_UNITS = 5;
const MIN_R2 = 0.5;
/** A stretch whose points came this much dearer than the median one had use
 *  agentbox did not see in it. Below this is how much what a point costs
 *  varies with the mix of models: on Go a tenth of stretches come out half again dearer. */
const OUTSIDE_OVER = 2;
const MIN_PRICE_UNITS = 8;
/** API-dollars of agentbox's spending, at least, before there is a price. */
const MIN_PRICE_COST = 10;
/** A change smaller than this is not worth a card, however sure. */
const MIN_CHANGE = 0.1;

/** What the balancer and the pages need of an account. */
export interface RateAccount {
  id: string;
  provider: string;
  label: string;
  plan: string | null;
  /** Its windows as last read; which of them exist, and which are scoped. */
  windows: UsageWindow[];
}

/** A plan, as the evidence is pooled: the provider and its tier. Go's plan
 *  carries the workspace's name after " · ", which is no part of the tier. */
export function planOf(a: { provider: string; plan: string | null }): string {
  const tier = a.plan?.split(" · ")[0]?.trim();
  return tier ? `${a.provider} · ${tier}` : a.provider;
}

/** Until a ratio is measured: a 5-hour window is taken for 24 weekly points,
 *  as on Claude, and any other for its length in weeks. A weekly is one for
 *  one, and so is a scoped one: it moves with its model's spending only. */
export function coldPerWeekly(w: Pick<UsageWindow, "kind" | "windowMs" | "scope">): number {
  if (w.scope || w.kind === "weekly") return 1;
  if (w.kind === "short") return 100 / 24;
  return w.windowMs > 0 ? WEEK / w.windowMs : 1;
}

interface Reading {
  at: number;
  usedPct: number;
  resetsAt: number | null;
}

/** One stretch of the finest window's life on one account. */
export interface Unit {
  accountId: string;
  from: number;
  to: number;
  /** How far the finest window rose, in its percent… */
  dBase: number;
  /** …and each other unscoped window over the same stretch, where it did not reset. */
  d: Record<string, number>;
  /** API-dollars agentbox's sessions spent on the account in it. */
  cost: number;
  /** A window read 100% at its end: a provider stops counting there. */
  capped: boolean;
}

interface Measure {
  value: number;
  samples: number;
  r2: number | null;
  /** Its standard error, for saying whether two of them differ. */
  se: number;
}

interface Fit {
  /** Window points per weekly point, where measured. */
  perWeekly: Record<string, Measure>;
  price: Measure | null;
}

interface PlanMeta {
  plan: string;
  provider: string;
  accounts: RateAccount[];
  base: UsageWindow;
  weekly: UsageWindow;
  /** Every unscoped window of the plan's accounts. */
  windows: UsageWindow[];
}

export interface RateChange {
  key: string;
  title: string;
  short: string;
}

const sameReset = (a: number | null, b: number | null): boolean => a !== null && b !== null && Math.abs(a - b) < SAME_RESET_MS;

/** The newest reading at or before `t`, while it still stands for the value then. */
function asOf(rs: Reading[], t: number): Reading | null {
  let lo = 0;
  let hi = rs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rs[mid]!.at <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const r = found >= 0 ? rs[found]! : null;
  return r && t - r.at <= STALE_MS ? r : null;
}

/** Readings per account and window, oldest first, from the one source with
 *  the most of them: codex's endpoint and rollouts can disagree, and
 *  interleaved they would rise and fall by the difference. A twin home's
 *  readings are its owner's: one login, one pool, and a home added later
 *  would otherwise start the account's history over. */
function readingsSince(since: number, owner: (id: string) => string): Map<string, Map<string, Reading[]>> {
  const bySeries = new Map<string, { accountId: string; windowId: string; source: string; rows: Reading[] }>();
  for (const r of usageSamplesSince(since)) {
    const accountId = owner(r.accountId);
    const k = `${accountId}\0${r.windowId}\0${r.source}`;
    let s = bySeries.get(k);
    if (!s) bySeries.set(k, (s = { accountId, windowId: r.windowId, source: r.source, rows: [] }));
    s.rows.push({ at: r.at, usedPct: r.usedPct, resetsAt: r.resetsAt });
  }
  const out = new Map<string, Map<string, Reading[]>>();
  for (const s of bySeries.values()) {
    let byWindow = out.get(s.accountId);
    if (!byWindow) out.set(s.accountId, (byWindow = new Map()));
    const have = byWindow.get(s.windowId);
    if (!have || have.length < s.rows.length) byWindow.set(s.windowId, s.rows.sort((a, b) => a.at - b.at));
  }
  return out;
}

interface SpendSeries {
  at: number[];
  /** Running total of API-dollars. */
  cum: number[];
}

/**
 * What agentbox's sessions spent on each account, as a running total over
 * time: each token sample's rise, on the account its session was on then
 * (its last move onto one, else the account it is on now). Read a day at a
 * time, yielding between days, and kept: a refit reads only the days since.
 */
class Spend {
  readonly byAccount = new Map<string, SpendSeries>();
  private loadedTo = 0;
  private last = new Map<string, number>();

  async load(since: number, now: number, owner: (id: string) => string): Promise<void> {
    const moves = new Map<string, { at: number; accountId: string }[]>();
    for (const m of sessionMoves()) {
      const list = moves.get(m.sessionId);
      if (list) list.push(m);
      else moves.set(m.sessionId, [m]);
    }
    const sessions = sessionAccounts();
    const accountAt = (sessionId: string, at: number): string | null => {
      let on = sessions.get(sessionId)?.accountId ?? null;
      for (const m of moves.get(sessionId) ?? []) {
        if (m.at > at) break;
        on = m.accountId;
      }
      return on && owner(on);
    };
    let from = Math.max(this.loadedTo, since);
    while (from < now) {
      const to = Math.min(now, from + DAY);
      for (const [sessionId, at, cost] of spendBetween(from, to)) {
        const prev = this.last.get(sessionId);
        this.last.set(sessionId, cost);
        // A session's first sample holds what it spent before it: counted
        // only for one that started inside what is read.
        const inc = prev !== undefined ? cost - prev : (sessions.get(sessionId)?.startedAt ?? 0) >= since ? cost : 0;
        const acct = inc > 0 ? accountAt(sessionId, at) : null;
        if (!acct) continue;
        let series = this.byAccount.get(acct);
        if (!series) this.byAccount.set(acct, (series = { at: [], cum: [] }));
        series.at.push(at);
        series.cum.push((series.cum[series.cum.length - 1] ?? 0) + inc);
      }
      from = this.loadedTo = to;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

function costBetween(s: SpendSeries | undefined, from: number, to: number): number {
  if (!s) return 0;
  const cumAt = (t: number): number => {
    let lo = 0;
    let hi = s.at.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.at[mid]! <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 ? s.cum[found]! : 0;
  };
  return cumAt(to) - cumAt(from);
}

/** The finest unscoped window, and the unscoped weekly: the evidence and the unit. */
function baseOf(windows: UsageWindow[]): { base: UsageWindow; weekly: UsageWindow } | null {
  const unscoped = windows.filter((w) => !w.scope);
  const weekly = unscoped.find((w) => w.kind === "weekly");
  const base = [...unscoped].sort((a, b) => a.windowMs - b.windowMs)[0];
  return weekly && base ? { base, weekly } : null;
}

/** An account's stretches of work, read off its finest window. */
function unitsOf(
  a: RateAccount,
  base: UsageWindow,
  others: UsageWindow[],
  readings: Map<string, Reading[]> | undefined,
  spend: SpendSeries | undefined,
): Unit[] {
  const rs = (readings?.get(base.id) ?? []).filter((r) => r.resetsAt !== null);
  const out: Unit[] = [];
  const close = (first: Reading, last: Reading): void => {
    if (last.at <= first.at) return;
    const dBase = last.usedPct - first.usedPct;
    if (dBase < 0) return;
    let capped = last.usedPct >= 100;
    const d: Record<string, number> = {};
    for (const w of others) {
      const series = readings?.get(w.id);
      if (!series) continue;
      const x0 = asOf(series, first.at);
      const x1 = asOf(series, last.at);
      if (!x0 || !x1) continue;
      if (x1.usedPct >= 100) capped = true;
      if (!sameReset(x0.resetsAt, x1.resetsAt) || x1.usedPct < x0.usedPct) continue;
      d[w.id] = x1.usedPct - x0.usedPct;
    }
    out.push({ accountId: a.id, from: first.at, to: last.at, dBase, d, cost: costBetween(spend, first.at, last.at), capped });
  };
  let first: Reading | null = null;
  let prev: Reading | null = null;
  for (const r of rs) {
    if (first && prev && !sameReset(prev.resetsAt, r.resetsAt)) {
      close(first, prev);
      first = null;
    } else if (first && prev && r.at - first.at > CHUNK_MS) {
      close(first, prev);
      first = prev;
    }
    first ??= r;
    prev = r;
  }
  if (first && prev) close(first, prev);
  return out;
}

/** Slope through the origin of `y` on `x`, and its R². */
function slope(pairs: [number, number][]): Measure | null {
  if (pairs.length < MIN_RATIO_UNITS) return null;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pairs) {
    sxy += x * y;
    sxx += x * x;
  }
  if (sxx <= 0 || sxy <= 0) return null;
  const k = sxy / sxx;
  let res = 0;
  let tot = 0;
  for (const [x, y] of pairs) {
    res += (y - k * x) ** 2;
    tot += y * y;
  }
  const r2 = tot > 0 ? Math.max(0, 1 - res / tot) : null;
  return r2 !== null && r2 < MIN_R2 ? null : { value: k, samples: pairs.length, r2, se: Math.sqrt(res / (pairs.length - 1) / sxx) };
}

/** The cost-weighted median of the points per dollar. */
function weightedMedian(xs: { r: number; w: number }[]): number {
  const sorted = [...xs].sort((a, b) => a.r - b.r);
  const total = sorted.reduce((n, x) => n + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.r;
  }
  return sorted[sorted.length - 1]!.r;
}

function fitUnits(units: Unit[], meta: Pick<PlanMeta, "base" | "weekly" | "windows">): Fit {
  const usable = units.filter((u) => !u.capped);
  const ratio = (id: string): Measure | null =>
    slope(usable.filter((u) => u.dBase >= MIN_RISE && u.d[id] !== undefined).map((u) => [u.dBase, u.d[id]!]));
  const perWeekly: Record<string, Measure> = {};
  const coarse = meta.base.id === meta.weekly.id;
  // Weekly points per point of the finest window.
  const w = coarse ? { value: 1, samples: 0, r2: null, se: 0 } : ratio(meta.weekly.id);
  if (w && !coarse) perWeekly[meta.base.id] = { value: 1 / w.value, samples: w.samples, r2: w.r2, se: w.se / w.value ** 2 };
  if (w) {
    for (const x of meta.windows) {
      if (x.id === meta.base.id || x.id === meta.weekly.id) continue;
      const r = ratio(x.id);
      if (r) perWeekly[x.id] = { value: r.value / w.value, samples: r.samples, r2: r.r2, se: r.se / w.value };
    }
  }
  const baseRate = baseRateOf({ perWeekly }, meta);
  if (!baseRate) return { perWeekly, price: null };
  const pts = usable.filter((u) => u.cost > 0).map((u) => ({ x: u.cost, y: u.dBase / baseRate }));
  if (pts.length < MIN_PRICE_UNITS) return { perWeekly, price: null };
  // The stretches with no outside use in them: those whose points did not
  // come much dearer than the median stretch's.
  const median = weightedMedian(pts.map((p) => ({ r: p.y / p.x, w: p.x })));
  const clean = pts.filter((p) => p.y / p.x <= median * OUTSIDE_OVER);
  const sx = clean.reduce((n, p) => n + p.x, 0);
  if (clean.length < MIN_PRICE_UNITS || sx < MIN_PRICE_COST) return { perWeekly, price: null };
  const value = clean.reduce((n, p) => n + p.y, 0) / sx;
  const se = Math.sqrt(clean.reduce((n, p) => n + (p.y - value * p.x) ** 2, 0)) / sx;
  return { perWeekly, price: { value, samples: clean.length, r2: null, se } };
}

/** Points of the finest window per weekly point: 1 where it is the week
 *  itself (codex), else as measured. */
const baseRateOf = (fit: Pick<Fit, "perWeekly">, meta: Pick<PlanMeta, "base" | "weekly">): number | undefined =>
  meta.base.id === meta.weekly.id ? 1 : fit.perWeekly[meta.base.id]?.value;

/** Two estimates differ, beyond three standard errors of their difference. */
const differ = (a: Measure, b: Measure): boolean => Math.abs(a.value - b.value) > 3 * Math.hypot(a.se, b.se);

export class Rates {
  private fittedAt = 0;
  private plans = new Map<string, PlanMeta & { units: Unit[]; fit: Fit; history: RatesReport["plans"][number]["history"] }>();
  private planOfAccount = new Map<string, string>();
  /** The plans the last fit saw, to refit at once when one is added. */
  private shape = "";
  private spend = new Spend();
  private fitting: Promise<void> | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Refit when it is due, or when the accounts have changed. */
  refresh(accounts: RateAccount[], owner: (id: string) => string): void {
    const now = this.now();
    const shape = accounts.map((a) => `${a.id}:${planOf(a)}:${a.windows.map((w) => w.id).join(",")}`).sort().join(";");
    if (this.fitting || (this.fittedAt && now - this.fittedAt < REFIT_MS && shape === this.shape)) return;
    this.fittedAt = now;
    this.shape = shape;
    this.fitting = this.fit(accounts, owner, now)
      .catch((e) => console.error("agentbox: fitting what a percent is worth failed:", e))
      .finally(() => {
        this.fitting = null;
      });
  }

  /** The fit in progress, if any: for a caller that wants the numbers now. */
  settled(): Promise<void> {
    return this.fitting ?? Promise.resolve();
  }

  private async fit(accounts: RateAccount[], owner: (id: string) => string, now: number): Promise<void> {
    const since = now - (HISTORY_DAYS * DAY + HISTORY_FIT_SPAN);
    await this.spend.load(since, now, owner);
    const readings = readingsSince(since, owner);
    const metas = new Map<string, PlanMeta>();
    const planOfAccount = new Map<string, string>();
    for (const a of accounts) {
      const b = baseOf(a.windows);
      if (!b) continue;
      const plan = planOf(a);
      planOfAccount.set(a.id, plan);
      const m = metas.get(plan);
      if (m) {
        m.accounts.push(a);
        for (const w of a.windows) if (!w.scope && !m.windows.some((x) => x.id === w.id)) m.windows.push(w);
      } else metas.set(plan, { plan, provider: a.provider, accounts: [a], ...b, windows: a.windows.filter((w) => !w.scope) });
    }
    const plans: typeof this.plans = new Map();
    for (const m of metas.values()) {
      const others = m.windows.filter((w) => w.id !== m.base.id);
      const units = m.accounts.flatMap((a) => unitsOf(a, m.base, others, readings.get(a.id), this.spend.byAccount.get(a.id)));
      const fit = fitUnits(units.filter((u) => u.to > now - FIT_SPAN), m);
      const history: RatesReport["plans"][number]["history"] = [];
      const today = new Date(now).setHours(0, 0, 0, 0);
      for (let k = HISTORY_DAYS - 1; k >= 0; k--) {
        const end = today - k * DAY;
        const f = fitUnits(units.filter((u) => u.to > end - HISTORY_FIT_SPAN && u.to <= end), m);
        history.push({ at: end, price: f.price?.value ?? null, perWeekly: Object.fromEntries(Object.entries(f.perWeekly).map(([id, x]) => [id, x.value])) });
      }
      plans.set(m.plan, { ...m, units, fit, history });
    }
    this.plans = plans;
    this.planOfAccount = planOfAccount;
  }

  /** How many of `w`'s points one weekly point of `accountId` is: measured on
   *  its plan, or until then `coldPerWeekly`. */
  perWeekly(accountId: string, w: UsageWindow): number {
    if (w.scope || w.kind === "weekly") return 1;
    return this.plans.get(this.planOfAccount.get(accountId) ?? "")?.fit.perWeekly[w.id]?.value ?? coldPerWeekly(w);
  }

  /** Every window of an account, by id: what the balancer converts claims with. */
  perWeeklyOf(accountId: string, windows: UsageWindow[]): Record<string, number> {
    return Object.fromEntries(windows.map((w) => [w.id, this.perWeekly(accountId, w)]));
  }

  /** Weekly points per API-dollar of agentbox's spending on its plan; null
   *  until enough has been spent to say. */
  price(accountId: string): number | null {
    return this.plans.get(this.planOfAccount.get(accountId) ?? "")?.fit.price?.value ?? null;
  }

  /** What an account's weekly rose by over the units ending since `since`,
   *  split into what agentbox's sessions spent at the price and what it did
   *  not see. A unit within noise of the price is all agentbox's. Null where
   *  there is no price. */
  split(accountId: string, since: number, until = this.now()): { ours: number; outside: number; units: number } | null {
    const p = this.plans.get(this.planOfAccount.get(accountId) ?? "");
    const price = p?.fit.price?.value;
    const baseRate = p && baseRateOf(p.fit, p);
    if (!p || !price || !baseRate) return null;
    let ours = 0;
    let outside = 0;
    let units = 0;
    for (const u of p.units) {
      if (u.accountId !== accountId || u.to <= since || u.to > until || u.capped) continue;
      units++;
      const rose = u.dBase / baseRate;
      const spent = price * u.cost;
      // Two readings each off by up to a whole percent, and what a
      // stretch's mix of models does to what its points cost.
      const noise = Math.max(2 / baseRate, (OUTSIDE_OVER - 1) * spent);
      ours += Math.min(rose, spent);
      if (rose - spent > noise) outside += rose - spent;
    }
    return { ours: round2(ours), outside: round2(outside), units };
  }

  report(): RatesReport {
    const now = this.now();
    return {
      fittedAt: this.fittedAt,
      plans: [...this.plans.values()].map((p) => ({
        plan: p.plan,
        provider: p.provider,
        weeklyId: p.weekly.id,
        windows: [p.base, ...p.windows.filter((w) => w.id !== p.base.id)].map((w) => {
          const m = p.fit.perWeekly[w.id];
          return { id: w.id, label: w.label, kind: w.kind, perWeekly: w.id === p.weekly.id ? 1 : (m?.value ?? null), samples: m?.samples ?? 0, r2: m?.r2 ?? null, cold: w.id === p.weekly.id ? null : coldPerWeekly(w) };
        }),
        price: p.fit.price?.value ?? null,
        priceUnits: p.fit.price?.samples ?? 0,
        accounts: p.accounts.map((a) => ({ id: a.id, label: a.label, split: this.split(a.id, now - WEEK, now) })),
        history: p.history,
      })),
    };
  }

  /**
   * What moved: each plan's ratios and price over the last three days
   * against the two weeks before (a step), and over the last week against the
   * week two weeks and a month before (a slide too slow for the first: Claude's
   * week went from $2,930 to $2,500 over twelve days without tripping it). A
   * ratio cannot be moved by use agentbox does not see, so one that moves is
   * the provider's doing. The price can: an account used heavily in the
   * browser looks dear. So a dearer point counts only where most of the
   * plan's accounts with recent work moved the same way, which a provider's
   * change does and your own use of one does not. `seen` is what was last
   * reported per plan and number, so a change is said once, by whichever
   * comparison sees it first, rather than every day until the baseline
   * catches up.
   */
  changes(seen: Record<string, number>): { changes: RateChange[]; seen: Record<string, number> } {
    const now = this.now();
    const out: RateChange[] = [];
    const next = { ...seen };
    const comparisons = [
      { recentFrom: now - 3 * DAY, baseFrom: now - 17 * DAY, baseTo: now - 3 * DAY, recent: "the last three days", base: "the two weeks before" },
      { recentFrom: now - 7 * DAY, baseFrom: now - 21 * DAY, baseTo: now - 14 * DAY, recent: "the last week", base: "the week two weeks before" },
      { recentFrom: now - 7 * DAY, baseFrom: now - 35 * DAY, baseTo: now - 28 * DAY, recent: "the last week", base: "the week a month before" },
    ];
    for (const p of this.plans.values()) {
      for (const c of comparisons) {
        const recentUnits = p.units.filter((u) => u.to > c.recentFrom);
        const recent = fitUnits(recentUnits, p);
        const base = fitUnits(p.units.filter((u) => u.to > c.baseFrom && u.to <= c.baseTo), p);
        const say = (metric: string, a: Measure, b: Measure, title: (is: number) => string, short: (is: number, was: number) => string): void => {
          // Said in what a person reads: a full window's weekly points, a
          // week's dollars. Both are 100 over the measure.
          const was = 100 / a.value;
          const is = 100 / b.value;
          const k = `${p.plan}|${metric}`;
          const ref = next[k] ?? was;
          if (!differ(a, b) || Math.abs(is / was - 1) < MIN_CHANGE || Math.abs(is / ref - 1) < MIN_CHANGE) return;
          next[k] = is;
          out.push({ key: `rates:${k}:${new Date(now).toISOString().slice(0, 10)}`, title: title(is), short: short(is, was) });
        };
        for (const w of p.windows) {
          const a = base.perWeekly[w.id];
          const b = recent.perWeekly[w.id];
          if (w.id === p.weekly.id || !a || !b) continue;
          const name = w.label.toLowerCase();
          say(
            w.id,
            a,
            b,
            (is) => `${p.plan}: a full ${name} window is now ${fmt(is)} weekly points`,
            (is, was) =>
              `Over ${c.recent} one full ${name} window of ${p.plan} took ${fmt(is)} weekly points; over ${c.base}, ${fmt(was)}. Every window counts the same use, whoever spent it, so this is the provider's doing. The balancer already uses the new number.`,
          );
        }
        const a = base.price;
        const b = recent.price;
        if (!a || !b) continue;
        // Dearer points are a smaller week, which use agentbox does not see
        // looks like too; a bigger week it cannot fake. A smaller one counts
        // where most accounts with recent work moved with it, as a provider's
        // change moves them all and your use of one account in the browser
        // moves that one. Each by half the change at least: one account's
        // week is noisier than the plan's (Claude's slide of 14% was 5–34%
        // on its five accounts).
        const smaller = b.value > a.value;
        const moved = p.accounts
          .map((acct) => recentUnits.filter((u) => u.accountId === acct.id && !u.capped && u.cost > 0))
          .filter((us) => us.length >= 3)
          .map((us) => us.reduce((n, u) => n + u.dBase, 0) / (baseRateOf(p.fit, p) ?? 1) / us.reduce((n, u) => n + u.cost, 0));
        const agree = moved.filter((x) => x > a.value === smaller && Math.abs(x / a.value - 1) >= MIN_CHANGE / 2).length;
        if (smaller && (moved.length < 2 || agree * 2 <= moved.length)) continue;
        say(
          "price",
          a,
          b,
          (is) => `${p.plan}: a week is now worth about $${Math.round(is).toLocaleString("en-US")} at API prices`,
          (is, was) =>
            `Over ${c.recent} a full week of ${p.plan} bought about $${Math.round(is).toLocaleString("en-US")} of API-priced work, against $${Math.round(was).toLocaleString("en-US")} over ${c.base}. ` +
            (smaller
              ? `${agree} of the ${moved.length} accounts with recent work moved the same way, so it is the provider's doing rather than one account used where agentbox cannot see. `
              : "Use agentbox does not see can only make a week look smaller, so a bigger one is the provider's doing. ") +
            "Which models ran moves this too: a model that costs more against the plan than at API prices makes a week look smaller.",
        );
      }
    }
    return { changes: out, seen: next };
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmt = (n: number): string => (n >= 10 ? String(Math.round(n)) : n.toFixed(1));
