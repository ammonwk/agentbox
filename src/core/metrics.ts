import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { SystemMeter, metricsAvailable } from "./system";
import {
  LoadMeter,
  ProcWatch,
  breakdown,
  argvOf,
  clockHz,
  describe,
  machineCores,
  readProcTable,
  sessionRows,
  sessionTags,
  sharedProcTable,
  subtreePss,
  type ProcRow,
  type ProcTable,
} from "./proc";
import type { CpuOwner, LoadDetail, MetricsState } from "./types";

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
  private watch = new ProcWatch();
  private fast: ReturnType<typeof setInterval> | null = null;
  private slow: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a slow filesystem queueing polls on top of each other. */
  private polling = false;
  private measuringPss = false;

  private cur: ProcTable | undefined;
  /** Each measured session's processes as of the last poll, by agent pid. */
  private owned = new Map<number, ProcRow[]>();
  /** Each process's systemd unit, for grouping `elsewhere`. */
  private units = new Map<number, { startTicks: number; unit: string }>();

  private state: MetricsState = { at: 0, system: null, load: {}, elsewhere: [] };

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
  async detail(id: string, pid: number): Promise<LoadDetail> {
    // On demand rather than from the poll: this is the one caller that wants
    // per-process PSS, and it is the most expensive read in the product.
    const cur = await readProcTable();
    const tagged = sessionTags(cur).get(id);
    return { history: this.meter.history(pid), procs: await breakdown(cur, pid, this.watch, { pss: true, tagged }) };
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const [table, system] = await Promise.all([
        sharedProcTable().catch(() => undefined),
        this.sys.sample().catch(() => undefined),
      ]);
      // The same table as the last poll (the fleet's, shared): nothing new to divide.
      if (table && table === this.cur) return;

      const prev = this.cur;
      if (table) this.cur = table;

      const load: MetricsState["load"] = {};
      let elsewhere = this.state.elsewhere;
      if (table) {
        const live = new Set<number>();
        // A subagent's subtree sits inside its caller's: each process once.
        const watched = new Map<number, ProcRow>();
        const tags = sessionTags(table);
        this.owned.clear();
        // Closed sessions are excluded: one that still holds a pid is a leak to
        // fix elsewhere, not a row on this bar.
        for (const s of source()) {
          if (s.pid === null) continue; // no pid means no reading — blank, not zero
          live.add(s.pid);
          const rows = sessionRows(table, s.pid, tags.get(s.id));
          const sample = this.meter.sample(table, s.pid, rows);
          if (!sample) continue;
          load[s.id] = sample;
          this.owned.set(s.pid, rows);
          for (const r of rows) watched.set(r.pid, r);
        }
        this.meter.retain(live);
        await this.watch.sample(table, [...watched.values()]);
        if (prev) elsewhere = this.elsewhere(prev, table, watched);
      }

      this.state = {
        at: Date.now(),
        // Keep the last good reading rather than blanking on one failed sweep.
        system: system ?? this.state.system,
        load,
        elsewhere,
      };
      metricsEvents.emit("metrics", this.state);
    } finally {
      this.polling = false;
    }
  }

  /**
   * The CPU no session accounts for, by the program it belongs to: the
   * browser, this server, a test run whose session has ended, the kernel.
   *
   * A program is a systemd unit: the desktop gives every app it launches a
   * scope, so a browser's thirty renderers are one row and are not lumped in
   * with the shell that launched them. Own utime+stime over the poll, live
   * processes only: what a short-lived child used is lost, which is why the
   * bar's total can exceed these plus the sessions.
   */
  private elsewhere(prev: ProcTable, cur: ProcTable, claimed: Map<number, ProcRow>): CpuOwner[] {
    const secs = (cur.at - prev.at) / 1000;
    if (secs <= 0) return [];
    for (const pid of this.units.keys()) if (!cur.byPid.has(pid)) this.units.delete(pid);
    const groups = new Map<string, { cpuPct: number; procs: number; top: ProcRow }>();
    for (const r of cur.byPid.values()) {
      if (claimed.has(r.pid)) continue;
      const was = prev.byPid.get(r.pid);
      if (!was || was.startTicks !== r.startTicks) continue;
      const pct = ((r.ownTicks - was.ownTicks) / (secs * clockHz() * machineCores())) * 100;
      if (pct <= 0) continue;
      const key = r.ppid === 2 || r.pid === 2 ? "kernel" : this.unitOf(r);
      const g = groups.get(key);
      if (!g) groups.set(key, { cpuPct: pct, procs: 1, top: r });
      else {
        g.cpuPct += pct;
        g.procs++;
        if (r.startTicks < g.top.startTicks) g.top = r;
      }
    }
    return [...groups]
      .sort((a, b) => b[1].cpuPct - a[1].cpuPct)
      .slice(0, 12)
      .map(([key, g]) => ({ name: this.nameOf(key, g.top), pid: g.top.pid, cpuPct: g.cpuPct, procs: g.procs }));
  }

  /** The unit a process runs in, read once per process. */
  private unitOf(r: ProcRow): string {
    const known = this.units.get(r.pid);
    if (known && known.startTicks === r.startTicks) return known.unit;
    let unit = "";
    try {
      unit = readFileSync(`/proc/${r.pid}/cgroup`, "utf8").trim().split("/").pop() ?? "";
    } catch {
      /* gone */
    }
    // A system service's or another user's process: its unit, or its own pid.
    unit ||= `pid ${r.pid}`;
    this.units.set(r.pid, { startTicks: r.startTicks, unit });
    return unit;
  }

  private nameOf(key: string, top: ProcRow): string {
    if (key === "kernel") return "kernel";
    if (key === serverUnit()) return "agentbox server";
    const argv = argvOf(top.pid);
    return describe({ ...top, cmd: argv?.join(" ") });
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
        const rows = this.owned.get(s.pid);
        if (!rows?.length) continue;
        const bytes = await subtreePss(rows).catch(() => undefined);
        if (bytes !== undefined) this.meter.putPss(s.pid, bytes);
      }
    } finally {
      this.measuringPss = false;
      if (this.slow) this.schedulePss(Math.max(SLOW_INTERVAL_MS, (performance.now() - started) / PSS_BUDGET));
    }
  }
}

let ownUnit: string | undefined;
function serverUnit(): string {
  if (ownUnit === undefined) {
    try {
      ownUnit = readFileSync("/proc/self/cgroup", "utf8").trim().split("/").pop() ?? "";
    } catch {
      ownUnit = "";
    }
  }
  return ownUnit;
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
export const procDetail = (id: string, pid: number): Promise<LoadDetail> => metrics.detail(id, pid);
