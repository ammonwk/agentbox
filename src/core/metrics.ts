import { EventEmitter } from "node:events";
import { SystemMeter, metricsAvailable } from "./system";
import {
  LoadMeter,
  backgroundShells,
  breakdown,
  readProcTable,
  subtree,
  subtreePss,
  type ProcTable,
} from "./proc";
import type { MetricsState, ProcDetail } from "./types";

/**
 * The machine, and what each session is taking from it.
 *
 * ── Why this is a third channel, not part of hot or cold ───────────────────
 * `hot` is pushed *on change* and `cold` is pushed *when its fingerprint
 * differs*. Metrics are neither: they change on every sample, so "on change" is
 * every time and fingerprint-suppression is actively wrong. Folding them into
 * `hot` would be worse than merely redundant — an idle board emits no `hot` at
 * all, so the bar would show one real reading on connect and then freeze at it
 * for the life of the tab. That is not a hypothetical: switchyard shipped it,
 * and the bar read 86% while every core sat at 98%. A stale number is
 * indistinguishable from a current one.
 *
 * So: its own message, its own fixed cadence, never suppressed.
 *
 * ── Why it only runs when someone is watching ──────────────────────────────
 * agentbox is a local server that spends most of its life idle with no tab
 * open. Reading the whole process table every two seconds for nobody is pure
 * waste, so the server refcounts websocket clients and this starts and stops
 * with them. Nothing here is on the boot path.
 *
 * ── The two lanes ──────────────────────────────────────────────────────────
 * CPU rides the 2s poll; PSS gets its own lane, at least 20s apart and
 * stretched so a sweep takes at most PSS_BUDGET of it, and runs sequentially.
 * See the cost note in proc.ts — running fifteen smaps walks at once would
 * spike the very number we are trying to report, and with hundreds of
 * processes one sweep is seconds of kernel time.
 */

export const metricsEvents = new EventEmitter();
metricsEvents.setMaxListeners(0);

export const FAST_INTERVAL_MS = 2_000;
export const SLOW_INTERVAL_MS = 20_000;
/** The share of the PSS lane's time a sweep may take. */
const PSS_BUDGET = 0.05;

class Metrics {
  private sys = new SystemMeter();
  private meter = new LoadMeter();
  private fast: ReturnType<typeof setInterval> | null = null;
  private slow: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a slow filesystem queueing polls on top of each other. */
  private polling = false;
  private measuringPss = false;

  /** The last two tables, so the drilldown has an interval to divide by. */
  private prev: ProcTable | undefined;
  private cur: ProcTable | undefined;

  private state: MetricsState = { at: 0, system: null, load: {} };

  snapshot(): MetricsState {
    return this.state;
  }

  start(): void {
    if (this.fast || !metricsAvailable()) return;
    void this.poll();
    this.fast = setInterval(() => void this.poll(), FAST_INTERVAL_MS);
    this.fast.unref?.();
    this.schedulePss(SLOW_INTERVAL_MS);
  }

  stop(): void {
    if (this.fast) clearInterval(this.fast);
    if (this.slow) clearTimeout(this.slow);
    this.fast = null;
    this.slow = null;
    // Deliberately keep `state` and the meters: a tab reopening within seconds
    // gets its sparkline history back instead of restarting from a flat line.
  }

  /** The live process table, for `GET /api/sessions/:id/load`. */
  async detail(pid: number): Promise<ProcDetail[]> {
    // On demand rather than from the poll: this is the one caller that wants
    // per-process PSS, and it is the most expensive read in the product.
    const cur = await readProcTable();
    const detail = await breakdown(this.cur ?? this.prev, cur, pid, { pss: true });
    return detail;
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const [table, system] = await Promise.all([
        readProcTable().catch(() => undefined),
        this.sys.sample().catch(() => undefined),
      ]);

      if (table) {
        this.prev = this.cur;
        this.cur = table;
      }

      const load: MetricsState["load"] = {};
      if (table) {
        const live = new Set<number>();
        // Closed sessions are excluded: one that still holds a pid is a leak to
        // fix elsewhere, not a row on this bar.
        for (const s of source()) {
          if (s.pid === null) continue; // no pid means no reading — blank, not zero
          live.add(s.pid);
          const sample = this.meter.sample(table, s.pid);
          if (!sample) continue;
          // Only for parked sessions: while a turn is in flight every shell is
          // a foreground tool call, and counting those says nothing.
          if (s.status !== "running") {
            const n = await backgroundShells(table, s.pid).catch(() => 0);
            if (n > 0) sample.backgroundShells = n;
          }
          load[s.id] = sample;
        }
        this.meter.retain(live);
      }

      this.state = {
        at: Date.now(),
        // Keep the last good reading rather than blanking on one failed sweep.
        system: system ?? this.state.system,
        load,
      };
      metricsEvents.emit("metrics", this.state);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The accurate memory pass: PSS for each session's whole subtree.
   *
   * Sequential across sessions on purpose. Running a dozen smaps_rollup walks
   * at once would spike the very number we are trying to report, and nothing
   * here is time-critical — the reading is twenty seconds old by design. The
   * next fast poll picks the results up out of the meter.
   */
  private schedulePss(ms: number): void {
    if (this.slow) clearTimeout(this.slow);
    this.slow = setTimeout(() => void this.measurePss(), ms);
    this.slow.unref?.();
  }

  private async measurePss(): Promise<void> {
    if (this.measuringPss) return;
    this.measuringPss = true;
    const started = performance.now();
    try {
      const table = this.cur;
      if (!table) return;
      for (const s of source()) {
        if (s.pid === null) continue;
        const rows = subtree(table, s.pid);
        if (rows.length === 0) continue;
        const bytes = await subtreePss(rows).catch(() => undefined);
        if (bytes !== undefined) this.meter.putPss(s.pid, bytes);
      }
    } finally {
      this.measuringPss = false;
      if (this.slow) this.schedulePss(Math.max(SLOW_INTERVAL_MS, (performance.now() - started) / PSS_BUDGET));
    }
  }
}

const metrics = new Metrics();

/** Where the sampler gets the sessions to measure. Set by the server to the
 *  fleet's view; a function rather than an import so this module does not
 *  depend on the fleet (and its tests do not need one). */
export interface MeasuredSession {
  id: string;
  pid: number | null;
  status: string;
}
let source: () => MeasuredSession[] = () => [];
export function setMetricsSource(fn: () => MeasuredSession[]): void {
  source = fn;
}

/**
 * Start or stop the sampler to match the number of connected clients.
 *
 * Called from the server's websocket open/close. Idempotent in both directions,
 * because a burst of reconnects must not stack intervals.
 */
export function setMetricsWatchers(n: number): void {
  if (n > 0) metrics.start();
  else metrics.stop();
}

export const metricsSnapshot = (): MetricsState => metrics.snapshot();
export const procDetail = (pid: number): Promise<ProcDetail[]> => metrics.detail(pid);
