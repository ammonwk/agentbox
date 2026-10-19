/** What a session will still spend, from what it has been doing.
 *
 * A claim (claim.ts) is what a session's model is expected to use. It is all
 * there is to go on at placement, and it is a poor guide after: over ten
 * weeks of this machine's sessions the model explained under 1% of what a
 * session went on to spend. Two things a session shows while it runs explain
 * most of what can be explained:
 *
 *   - what it spent in the last ten minutes: nothing means it is winding down
 *     (99% of such moments were followed by nothing more), and the more it is
 *     burning the more is still to come;
 *   - what it has spent so far this stretch: a session that has already done
 *     a lot keeps going longer than one that has only begun.
 *
 * So the forecast is a table of averages: for every moment of every past
 * stretch of work, which pair of buckets it was in and how much that stretch
 * went on to spend; the mean per pair is what a session in that pair now is
 * expected to spend. A stretch is a run of token samples with no gap over an
 * hour — the longest a prompt cache lives, after which a claim lapses and the
 * session wakes wherever there is room (claims.ts). It is fitted per
 * provider, since a dollar-equivalent of codex is not one of claude, from the
 * token samples the fleet records anyway (cost-equivalent, pricing.ts), and
 * turned into the account's weekly points at its plan's price (rates.ts).
 *
 * Idle time, the spend of the last half hour and hour, the stretch's age, the
 * hour of day, the model and who started it were tried too; none adds to
 * these two.
 */

import { tokenSampleAt, tokenSamplesAfter, tokenSamplesSince } from "./db";
import { familyOf } from "./claim";
import type { ForecastReport, ProviderId } from "./types";

const MIN = 60_000;
const DAY = 86_400_000;

/** A quiet gap this long ends a stretch. */
export const STRETCH_GAP_MS = 60 * MIN;
/** "Lately", for the first predictor. */
const RECENT_MS = 10 * MIN;
/** A stretch is read this often when fitting, so the table is an average over time. */
const STEP_MS = 5 * MIN;
/** Cost-equivalent spent in the last ten minutes: nothing, a trickle, working, working hard, flat out. */
export const RECENT_EDGES = [0.001, 0.2, 1, 4];
/** Cost-equivalent spent so far this stretch. */
export const SO_FAR_EDGES = [0.1, 1, 4, 16, 64];
/** A pair of buckets seen in fewer stretches than this says nothing yet. */
const MIN_STRETCHES = 20;
/** A session whose first sample comes this soon after it started had spent
 *  nothing before; any later, what it holds was spent before we looked. */
const FRESH_MS = 5 * MIN;

export interface Sample {
  at: number;
  /** Cumulative cost-equivalent. */
  cost: number;
}

/** The two predictors, in cost-equivalent. */
export interface Reading {
  recent: number;
  soFar: number;
}

const bucket = (v: number, edges: number[]): number => {
  let i = 0;
  while (i < edges.length && v >= edges[i]!) i++;
  return i;
};

const keyOf = (provider: string, r: Reading): string => `${provider}|${bucket(r.recent, RECENT_EDGES)}|${bucket(r.soFar, SO_FAR_EDGES)}`;

/** What the session had spent before `samples[i]`'s stretch began. */
function baseOf(samples: Sample[], i: number, startedAt: number): number {
  if (i > 0) return samples[i - 1]!.cost;
  return samples[0]!.at - startedAt < FRESH_MS ? 0 : samples[0]!.cost;
}

/**
 * The stretch a session is in at `now` and where it stands in it, from its
 * samples (oldest first; `startedAt` says whether the first of them is the
 * session's beginning). Null when it is in none: no samples, or the last is
 * over an hour old — unless it is `open`, mid-turn, when a long silence is a
 * long tool call and the stretch goes on.
 */
export function readingAt(samples: Sample[], startedAt: number, now: number, open = false): Reading | null {
  let end = samples.length - 1;
  while (end >= 0 && samples[end]!.at > now) end--;
  if (end < 0 || (!open && now - samples[end]!.at > STRETCH_GAP_MS)) return null;
  let start = end;
  while (start > 0 && samples[start]!.at - samples[start - 1]!.at <= STRETCH_GAP_MS) start--;
  const base = baseOf(samples, start, startedAt);
  const soFar = samples[end]!.cost - base;
  let before = 0;
  for (let i = end; i >= start; i--) {
    if (samples[i]!.at <= now - RECENT_MS) {
      before = samples[i]!.cost - base;
      break;
    }
  }
  return { recent: Math.max(0, soFar - before), soFar: Math.max(0, soFar) };
}

interface Cell {
  /** Cost-equivalent still to come, summed over every reading in the cell. */
  sum: number;
  readings: number;
  stretches: number;
}

export type ForecastTable = Map<string, Cell>;

/** What stretches went on to spend from their start, summed: per provider,
 *  model family and whether it was the session's first, and per provider
 *  under family `*`. */
export type StartTable = Map<string, { sum: number; stretches: number }>;

const startKey = (provider: string, family: string, first: boolean): string => `${provider}|${family}|${first ? 1 : 0}`;

export interface SessionSeries {
  provider: string;
  startedAt: number;
  samples: Sample[];
  /** For `fitStarts`: its model, and whether the balancer placed it (a session
   *  begun by hand in a terminal is not what a placed one looks like). */
  model?: string | null;
  placed?: boolean;
}

/** Each finished stretch of `s`: its samples' range, what the session had
 *  spent before it, and what it spent in all. */
function* stretchesOf(s: SessionSeries, until: number): Generator<{ i: number; j: number; base: number; final: number }> {
  const xs = s.samples;
  let i = 0;
  while (i < xs.length) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1]!.at - xs[j]!.at <= STRETCH_GAP_MS) j++;
    const base = baseOf(xs, i, s.startedAt);
    const final = xs[j]!.cost - base;
    // A cumulative count that went down is a transcript that was rewritten.
    if (xs[j]!.at + STRETCH_GAP_MS < until && final >= 0) yield { i, j, base, final };
    i = j + 1;
  }
}

/**
 * What a stretch spends from its start, for a claim: a session's first
 * stretch when the balancer placed it, and every later one (a wake) whoever
 * started it.
 */
export function fitStarts(sessions: SessionSeries[], until: number): StartTable {
  const table: StartTable = new Map();
  for (const s of sessions) {
    for (const { i, final } of stretchesOf(s, until)) {
      const first = i === 0 && s.samples[0]!.at - s.startedAt < FRESH_MS;
      if (first && !s.placed) continue;
      for (const key of [startKey(s.provider, familyOf(s.model), first), startKey(s.provider, "*", first)]) {
        const cell = table.get(key) ?? { sum: 0, stretches: 0 };
        cell.sum += final;
        cell.stretches++;
        table.set(key, cell);
      }
    }
  }
  return table;
}

/** Cost-equivalent a stretch on `provider` is expected to spend from its
 *  start: the average of `model`'s family, or with `model` absent of every
 *  model's. Null where too few have run to say. */
export function startCost(table: StartTable, provider: string, first: boolean, model?: string | null): number | null {
  const cell = table.get(startKey(provider, model === undefined ? "*" : familyOf(model), first));
  return cell && cell.stretches >= MIN_STRETCHES ? cell.sum / cell.stretches : null;
}

/**
 * The table, from sessions' samples. Only stretches that had ended by `until`
 * count — one still running has not shown what it will spend. Each cell is
 * kept twice: under its provider, and under `*` for a provider with too
 * little history of its own.
 */
export function fitForecast(sessions: SessionSeries[], until: number): ForecastTable {
  const table: ForecastTable = new Map();
  for (const s of sessions) {
    const xs = s.samples;
    for (const { i, j, base, final } of stretchesOf(s, until)) {
      const seen = new Set<string>();
      let at = i; // the newest sample at or before t
      let old = i; // the newest at or before t − RECENT_MS, when there is one
      for (let t = xs[i]!.at; t <= xs[j]!.at + STRETCH_GAP_MS; t += STEP_MS) {
        while (at < j && xs[at + 1]!.at <= t) at++;
        while (old < j && xs[old + 1]!.at <= t - RECENT_MS) old++;
        const soFar = Math.max(0, xs[at]!.cost - base);
        const before = xs[old]!.at <= t - RECENT_MS ? xs[old]!.cost - base : 0;
        const reading = { recent: Math.max(0, soFar - before), soFar };
        for (const key of [keyOf(s.provider, reading), keyOf("*", reading)]) {
          let cell = table.get(key);
          if (!cell) table.set(key, (cell = { sum: 0, readings: 0, stretches: 0 }));
          cell.sum += Math.max(0, final - soFar);
          cell.readings++;
          if (!seen.has(key)) {
            seen.add(key);
            cell.stretches++;
          }
        }
      }
    }
  }
  return table;
}

/** Cost-equivalent a session reading `r` is expected to still spend this
 *  stretch: its provider's average, else every provider's, else unknown. */
export function expectedCost(table: ForecastTable, provider: string, r: Reading): number | null {
  for (const p of [provider, "*"]) {
    const cell = table.get(keyOf(p, r));
    if (cell && cell.stretches >= MIN_STRETCHES) return cell.sum / cell.readings;
  }
  return null;
}

// ------------------------------------------------------------------- live

/** The table is refitted this often, from this much history. */
const REFIT_MS = DAY;
const HISTORY_MS = 60 * DAY;
/** A session's forecast is recomputed this often. */
const MEMO_MS = MIN;
/** How far back a session's samples are read for its stretch. One running
 *  longer than this is in the top bucket whatever came before. */
const LOOKBACK_MS = DAY;

export interface ForecastInput {
  sessionId: string;
  provider: ProviderId;
  accountId: string;
  startedAt: number;
  /** Mid-turn: its stretch goes on however long it has been silent. */
  open: boolean;
}

/**
 * Forecasts for live sessions, from the database: the table refitted daily,
 * each session's answer for a minute, priced by `price` (`Rates.price`).
 */
export class Forecaster {
  private table: ForecastTable = new Map();
  private starts: StartTable = new Map();
  private fittedAt = 0;
  private memo = new Map<string, { at: number; points: number | null }>();

  /** Weekly points per cost-equivalent on an account; null where there is no price yet. */
  constructor(private readonly rate: (accountId: string) => number | null) {}

  private fit(now: number): void {
    if (this.fittedAt && now - this.fittedAt < REFIT_MS) return;
    this.fittedAt = now;
    const { sessions, until } = history(now - HISTORY_MS);
    this.table = fitForecast(sessions, until);
    this.starts = fitStarts(sessions, until);
    this.memo.clear();
  }

  /** Weekly points per cost-equivalent on the median of `accountIds` that has a price. */
  private medianRate(accountIds: string[]): number | null {
    const rates = accountIds
      .map((id) => this.rate(id))
      .filter((r): r is number => r !== null)
      .sort((a, b) => a - b);
    return rates.length ? rates[Math.floor((rates.length - 1) / 2)]! : null;
  }

  /**
   * The claim of a session about to start (`first`) or wake: weekly points
   * such stretches of work have gone on to use — those of `model`'s family,
   * or of the whole provider when `model` is left out — at the price of the
   * provider's median account (`accountIds`: the claim is made before an
   * account is chosen). Null where too few have run, or nothing has a price.
   */
  claim(s: { provider: ProviderId; model?: string | null; first: boolean; accountIds: string[] }, now: number): number | null {
    this.fit(now);
    const cost = startCost(this.starts, s.provider, s.first, s.model);
    const perCost = cost === null ? null : this.medianRate(s.accountIds);
    return cost === null || perCost === null ? null : Math.round(cost * perCost * 100) / 100;
  }

  /**
   * Weekly points `s` is expected to still use on its account this stretch.
   * Null when there is nothing to forecast from — it has spent nothing yet,
   * the table has no such sessions, or its account's points have no price —
   * and its claim stands.
   */
  expected(s: ForecastInput, now: number): number | null {
    this.fit(now);
    const hit = this.memo.get(s.sessionId);
    if (hit && now - hit.at < MEMO_MS) return hit.points;
    const points = this.compute(s, now);
    this.memo.set(s.sessionId, { at: now, points });
    return points;
  }

  private compute(s: ForecastInput, now: number): number | null {
    if (this.table.size === 0) return null;
    const perCost = this.rate(s.accountId);
    if (perCost === null) return null;
    const from = now - LOOKBACK_MS;
    const before = tokenSampleAt(s.sessionId, from);
    const samples = [...(before ? [before] : []), ...tokenSamplesAfter(s.sessionId, from)].map((r) => ({ at: r.at, cost: r.costEquiv }));
    const reading = readingAt(samples, s.startedAt, now, s.open);
    if (!reading) return null;
    const cost = expectedCost(this.table, s.provider, reading);
    return cost === null ? null : cost * perCost;
  }

  /** The table as the Calibration page shows it: per provider, in the weekly
   *  points of its accounts' median price. */
  report(accounts: { id: string; provider: string }[], now: number): ForecastReport {
    this.fit(now);
    const providers: ForecastReport["providers"] = [];
    for (const provider of [...new Set(accounts.map((a) => a.provider))]) {
      const perCost = this.medianRate(accounts.filter((a) => a.provider === provider).map((a) => a.id));
      const cells: ForecastReport["providers"][number]["cells"] = [];
      for (let r = 0; r <= RECENT_EDGES.length; r++) {
        for (let c = 0; c <= SO_FAR_EDGES.length; c++) {
          const cell = this.table.get(`${provider}|${r}|${c}`);
          if (!cell) continue;
          const known = perCost !== null && cell.stretches >= MIN_STRETCHES;
          cells.push({ recent: r, soFar: c, stretches: cell.stretches, points: known ? Math.round((cell.sum / cell.readings) * perCost * 100) / 100 : null });
        }
      }
      if (cells.length) providers.push({ provider, pointsPerCost: perCost, cells });
    }
    return { fittedAt: this.fittedAt, recentEdges: RECENT_EDGES, soFarEdges: SO_FAR_EDGES, providers };
  }
}

/** Every session's samples since `since`, and the newest sample's time. Only
 *  sessions that hold claims: one another session started is in its caller's. */
function history(since: number): { sessions: SessionSeries[]; until: number } {
  const sessions: SessionSeries[] = [];
  let until = 0;
  let cur: (SessionSeries & { id: string }) | null = null;
  for (const r of tokenSamplesSince(since)) {
    if (!cur || cur.id !== r.sessionId) {
      cur = { id: r.sessionId, provider: r.provider, model: r.model, placed: !!r.placed, startedAt: r.startedAt, samples: [] };
      sessions.push(cur);
    }
    cur.samples.push({ at: r.at, cost: r.costEquiv });
    if (r.at > until) until = r.at;
  }
  return { sessions, until };
}
