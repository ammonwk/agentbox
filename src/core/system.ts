import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { worktreeRoot } from "./paths";
import type { SystemState, TempReading } from "./types";

/**
 * The state of the machine itself.
 *
 * Per-session load answers "which agent is eating the laptop". This answers the
 * question underneath it: "is the laptop coping at all". They are different
 * questions and the second is not the sum of the first — a machine can sit at
 * 40% CPU and still feel dead because it is thermally throttled, swapping, or
 * waiting on disk.
 *
 * Everything here is a small read from /proc or /sys; the whole sweep is a few
 * milliseconds, which is why it rides the fast poll rather than earning a lane.
 *
 * Every reader returns `undefined` rather than throwing when its file is not
 * there, and the UI renders nothing for an absent field. That is what makes
 * this degrade instead of fail on a kernel without PSI, a desktop without a
 * battery, or a machine whose hwmon publishes nothing we can name.
 */

/** Whether this platform can be measured at all. Linux-only by construction. */
export function metricsAvailable(): boolean {
  return process.platform === "linux" && existsSync("/proc/stat");
}

// ─── CPU ────────────────────────────────────────────────────────────────────

interface CpuTicks {
  total: number;
  idle: number;
}

export function parseCpuLine(parts: string[]): CpuTicks {
  const n = parts.map(Number);
  // user nice system idle iowait irq softirq steal guest guest_nice
  const idle = (n[3] ?? 0) + (n[4] ?? 0);
  const total = n.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { total, idle };
}

/** Cumulative CPU counters mean nothing alone; these need two reads. */
async function readCpuTicks(): Promise<{ all: CpuTicks; cores: CpuTicks[] }> {
  const text = await readFile("/proc/stat", "utf8");
  let all: CpuTicks = { total: 0, idle: 0 };
  const cores: CpuTicks[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu")) break; // cpu lines come first; stop early
    const parts = line.split(/\s+/);
    const label = parts[0]!;
    const ticks = parseCpuLine(parts.slice(1));
    if (label === "cpu") all = ticks;
    else cores[Number(label.slice(3))] = ticks;
  }
  return { all, cores };
}

/** Busy fraction between two cumulative readings, clamped into 0..1. */
export function busy(prev: CpuTicks | undefined, cur: CpuTicks): number {
  if (!prev) return 0;
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - (cur.idle - prev.idle) / dt));
}

// ─── Temperatures ───────────────────────────────────────────────────────────

/**
 * Which hwmon inputs are worth reading, resolved once.
 *
 * Enumerating /sys/class/hwmon on every poll would mean a directory walk and
 * thirty stats for data whose *shape* never changes between reboots. The paths
 * are stable; only the values move.
 */
interface SensorPath {
  name: string;
  input: string;
  critical?: number;
}

let sensorPaths: SensorPath[] | null = null;

async function resolveSensors(): Promise<SensorPath[]> {
  if (sensorPaths) return sensorPaths;
  const out: SensorPath[] = [];
  const root = "/sys/class/hwmon";
  if (!existsSync(root)) return (sensorPaths = out);

  for (const dir of await readdir(root).catch(() => [])) {
    const base = `${root}/${dir}`;
    const chip = (await readFile(`${base}/name`, "utf8").catch(() => "")).trim();
    if (!chip) continue;
    for (const f of await readdir(base).catch(() => [])) {
      const m = /^(temp\d+)_input$/.exec(f);
      if (!m) continue;
      const stem = `${base}/${m[1]}`;
      const label = (await readFile(`${stem}_label`, "utf8").catch(() => "")).trim();
      const crit = Number(await readFile(`${stem}_crit`, "utf8").catch(() => "")) / 1000;

      const name = friendly(chip, label);
      if (!name) continue; // a sensor we cannot name is a sensor nobody can act on
      out.push({ name, input: `${stem}_input`, critical: crit > 0 ? crit : undefined });
    }
  }
  return (sensorPaths = out);
}

/**
 * Only the sensors somebody would act on.
 *
 * This laptop publishes around thirty temperature inputs, most of them
 * unlabelled ACPI zones that cannot be attributed to any component. Showing all
 * of them would be a wall of numbers; these four are the ones with a story.
 */
export function friendly(chip: string, label: string): string | null {
  if (chip === "coretemp" && label === "Package id 0") return "cpu";
  if (chip === "k10temp" && (label === "Tctl" || label === "")) return "cpu"; // AMD
  if (chip === "nvme" && label === "Composite") return "ssd";
  if (chip.startsWith("iwlwifi")) return "wifi";
  if (chip === "spd5118") return "ram";
  return null;
}

async function readTemps(): Promise<TempReading[]> {
  const sensors = await resolveSensors();
  const seen = new Map<string, TempReading>();
  for (const s of sensors) {
    const raw = Number(await readFile(s.input, "utf8").catch(() => NaN));
    if (!Number.isFinite(raw)) continue;
    const celsius = raw / 1000;
    const reading: TempReading = {
      name: s.name,
      celsius,
      critical: s.critical,
      pressure: s.critical ? celsius / s.critical : undefined,
    };
    // Two DIMMs both report as "ram"; keep the hotter, which is the one that
    // would throttle first and the only one worth a slot in the bar.
    const prior = seen.get(s.name);
    if (!prior || celsius > prior.celsius) seen.set(s.name, reading);
  }
  return [...seen.values()];
}

// ─── Throttling ─────────────────────────────────────────────────────────────

const THROTTLE_DIR = "/sys/devices/system/cpu/cpu0/thermal_throttle";

/**
 * Both the count and the accumulated time.
 *
 * The count alone only supports a boolean — "it happened since the last poll" —
 * and thermal throttling fires in bursts of tens of milliseconds, so a boolean
 * flickers. The total time gives a duty cycle instead: what fraction of the
 * last interval the package spent throttled, which is both steadier and the
 * number that corresponds to how slow things actually feel.
 */
async function readThrottle(): Promise<{ count?: number; totalMs?: number }> {
  const num = async (f: string) => {
    const n = Number(await readFile(`${THROTTLE_DIR}/${f}`, "utf8").catch(() => NaN));
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    count: await num("package_throttle_count"),
    totalMs: await num("package_throttle_total_time_ms"),
  };
}

/**
 * Throttle duty and state from two cumulative readings.
 *
 * Split out from the sampler so the delta arithmetic — the part with an actual
 * bug surface — is testable without a kernel.
 */
export function throttleDelta(
  prev: { count?: number; totalMs?: number } | undefined,
  cur: { count?: number; totalMs?: number },
  elapsedMs: number,
): { throttleDuty: number; throttling: boolean } {
  if (!prev || elapsedMs <= 0) return { throttleDuty: 0, throttling: false };
  const dMs = (cur.totalMs ?? 0) - (prev.totalMs ?? 0);
  const dCount = (cur.count ?? 0) - (prev.count ?? 0);
  return {
    throttleDuty: dMs >= 0 ? Math.min(1, dMs / elapsedMs) : 0,
    throttling: dCount > 0 || dMs > 0,
  };
}

/** Aggregate current clock across cores, and the ceiling, in MHz. */
async function readFreq(cores: number): Promise<{ mhz?: number; mhzMax?: number }> {
  const max = Number(
    await readFile("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq", "utf8").catch(() => NaN),
  );
  let sum = 0;
  let n = 0;
  for (let i = 0; i < cores; i++) {
    const v = Number(
      await readFile(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`, "utf8").catch(
        () => NaN,
      ),
    );
    if (Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return {
    mhz: n ? Math.round(sum / n / 1000) : undefined,
    mhzMax: Number.isFinite(max) ? Math.round(max / 1000) : undefined,
  };
}

// ─── Pressure, memory, power ────────────────────────────────────────────────

async function readPsi(kind: string): Promise<number | undefined> {
  const text = await readFile(`/proc/pressure/${kind}`, "utf8").catch(() => "");
  // "some avg10=70.96 avg60=68.02 ..." — avg10 is the responsive one.
  const m = /some avg10=([\d.]+)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+) kB/.exec(line);
    if (m) out[m[1]!] = Number(m[2]) * 1024;
  }
  return out;
}

async function readPower(): Promise<Partial<SystemState>> {
  const num = async (p: string) => {
    const v = Number(await readFile(p, "utf8").catch(() => NaN));
    return Number.isFinite(v) ? v : undefined;
  };
  const ac = await num("/sys/class/power_supply/AC/online");
  const pct = await num("/sys/class/power_supply/BAT0/capacity");
  const status = (
    await readFile("/sys/class/power_supply/BAT0/status", "utf8").catch(() => "")
  ).trim();
  const power = await num("/sys/class/power_supply/BAT0/power_now");
  return {
    acOnline: ac === undefined ? undefined : ac === 1,
    batteryPct: pct,
    batteryStatus: status || undefined,
    watts: power !== undefined ? Math.round(power / 1e6) : undefined, // power_now is µW
  };
}

// ─── Disk ───────────────────────────────────────────────────────────────────

/**
 * Free space where the worktrees live.
 *
 * Slow lane of its own: there is no statfs binding here so this shells out, and
 * free space does not move fast enough to justify a subprocess every two
 * seconds. Worth measuring at all because agentbox cuts a fresh worktree per
 * session and keeps transcripts that run to megabytes — filling the disk is a
 * real failure mode rather than a hypothetical one.
 */
let diskCache: { path: string; free: number; total: number; at: number } | undefined;
const DISK_TTL = 60_000;

async function readDisk(path: string): Promise<{ free?: number; total?: number }> {
  // Keyed on the path as well as the clock: AGENTBOX_HOME is resolved per call
  // (see paths.ts), so a cache that ignored it would answer for the wrong
  // filesystem the moment a test pointed the home somewhere else.
  if (diskCache && diskCache.path === path && Date.now() - diskCache.at < DISK_TTL) {
    return { free: diskCache.free, total: diskCache.total };
  }
  try {
    const proc = Bun.spawn(["df", "-kP", path], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const cols = text.trim().split("\n")[1]?.split(/\s+/);
    if (cols && cols.length >= 4) {
      const total = Number(cols[1]) * 1024;
      const free = Number(cols[3]) * 1024;
      if (Number.isFinite(total) && Number.isFinite(free)) {
        diskCache = { path, free, total, at: Date.now() };
        return { free, total };
      }
    }
  } catch {
    /* df missing, or the path does not exist yet */
  }
  return {};
}

// ─── The sampler ────────────────────────────────────────────────────────────

export class SystemMeter {
  private prev?: { all: CpuTicks; cores: CpuTicks[] };
  private prevThrottle?: { count?: number; totalMs?: number };
  private prevAt?: number;

  async sample(diskPath = worktreeRoot()): Promise<SystemState> {
    const ticks = await readCpuTicks();
    const cores = ticks.cores.length;

    const [mem, temps, throttle, freq, psiCpu, psiIo, psiMem, power, disk, loadText] =
      await Promise.all([
        readFile("/proc/meminfo", "utf8").catch(() => "").then(parseMeminfo),
        readTemps(),
        readThrottle(),
        readFreq(cores),
        readPsi("cpu"),
        readPsi("io"),
        readPsi("memory"),
        readPower(),
        readDisk(diskPath),
        readFile("/proc/loadavg", "utf8").catch(() => ""),
      ]);

    const perCore = ticks.cores.map((c, i) => busy(this.prev?.cores[i], c));
    const cpu = busy(this.prev?.all, ticks.all);
    this.prev = ticks;

    // Cumulative-since-boot says nothing about the last two seconds, so this is
    // a difference against the previous sample.
    const now = Date.now();
    const { throttleDuty, throttling } = throttleDelta(
      this.prevThrottle,
      throttle,
      this.prevAt ? now - this.prevAt : 0,
    );
    this.prevThrottle = throttle;
    this.prevAt = now;

    const [l1, l5, l15, procs] = loadText.trim().split(/\s+/);

    return {
      at: now,
      cores,
      perCore,
      cpu,
      mhz: freq.mhz,
      mhzMax: freq.mhzMax,

      memTotal: mem.MemTotal ?? 0,
      memAvailable: mem.MemAvailable ?? 0,
      memCache: (mem.Cached ?? 0) + (mem.Buffers ?? 0),
      swapTotal: mem.SwapTotal ?? 0,
      swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0),

      load1: Number(l1) || 0,
      load5: Number(l5) || 0,
      load15: Number(l15) || 0,
      runnable: procs ? Number(procs.split("/")[0]) : undefined,

      psiCpu,
      psiIo,
      psiMem,

      temps,
      throttleCount: throttle.count,
      throttleDuty,
      throttling,

      diskFree: disk.free,
      diskTotal: disk.total,
      ...power,
    };
  }
}
