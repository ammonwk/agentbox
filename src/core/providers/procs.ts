/** Finding provider processes and reading what they were started with.
 *
 * Every adapter's `liveProcesses` is the same three questions about a pid:
 * what is it running, which account's environment did it start with, and where
 * is it. All three come from /proc and all three race with the process
 * exiting, so every reader here returns null instead of throwing.
 */

import { readFileSync, readlinkSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { clockHz } from "../proc";

let bootMs: number | null = null;

/** Wall-clock ms at boot, for turning /proc start ticks into timestamps. */
function bootTimeMs(): number {
  if (bootMs !== null) return bootMs;
  bootMs = 0;
  try {
    const m = readFileSync("/proc/stat", "utf8").match(/^btime (\d+)$/m);
    if (m) bootMs = Number(m[1]) * 1000;
  } catch {
    /* not Linux */
  }
  return bootMs;
}

/** argv of a process, or null if it is gone or not ours to read. */
export function argvOf(pid: number): string[] | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!raw) return null;
    return raw.split("\0").filter((s, i, a) => s.length > 0 || i < a.length - 1);
  } catch {
    return null;
  }
}

/** The whole environment a process was started with. */
export function environOf(pid: number): Map<string, string> | null {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
    const env = new Map<string, string>();
    for (const kv of raw.split("\0")) {
      const eq = kv.indexOf("=");
      if (eq > 0) env.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    return env;
  } catch {
    return null;
  }
}

export function cwdOf(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/** When the process started, epoch ms. Stable for the life of the pid, so
 *  (pid, startedAt) identifies a process even after pid reuse. */
export function startedAtOf(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(f[19]);
    if (!Number.isFinite(ticks)) return null;
    return bootTimeMs() + (ticks / clockHz()) * 1000;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but is someone else's — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Paths a process currently has open, resolved. */
export function openFilesOf(pid: number): string[] {
  try {
    return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
      try {
        return [readlinkSync(`/proc/${pid}/fd/${fd}`)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export interface ProcMatch {
  pid: number;
  ppid: number;
  argv: string[];
}

/**
 * Processes of the current user whose argv matches `test`. Matching on argv
 * rather than `comm` because node- and bun-launched CLIs show up as `node` or
 * `bun` with the script in argv[1], and comm is truncated to 15 bytes.
 */
export function findProcesses(test: (argv: string[]) => boolean): ProcMatch[] {
  return scanOwnProcesses().filter((p) => test(p.argv));
}

/**
 * Every process of ours with its argv. Each adapter's `liveProcesses` scans
 * the whole table (~25ms at 900 processes), so the fleet opens a shared scan
 * for the length of one pass (`withProcessScan`) and every adapter reads the
 * same one. Outside a pass every call scans fresh — a cache on a timer would
 * hand a caller that just started a process a table without it.
 */
let shared: ProcMatch[] | null = null;

function scanOwnProcesses(): ProcMatch[] {
  return shared ?? scanUncached();
}

export async function withProcessScan<T>(fn: () => Promise<T>): Promise<T> {
  shared = scanUncached();
  try {
    return await fn();
  } finally {
    shared = null;
  }
}

function scanUncached(): ProcMatch[] {
  const uid = process.getuid?.();
  const out: ProcMatch[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    if (pid === process.pid) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      if (uid !== undefined) {
        const m = status.match(/^Uid:\s+(\d+)/m);
        if (m && Number(m[1]) !== uid) continue;
      }
      const argv = argvOf(pid);
      if (!argv || argv.length === 0) continue;
      const pp = status.match(/^PPid:\s+(\d+)/m);
      out.push({ pid, ppid: pp ? Number(pp[1]) : 0, argv });
    } catch {
      /* exited mid-scan */
    }
  }
  return out;
}

/**
 * True when argv runs the named CLI: `claude …`, `/path/to/claude …`,
 * `node /…/bin/codex …`, `bun /…/omp …`. Child processes a CLI spawns (MCP
 * servers, shells) do not match, because their argv[0]/argv[1] is something
 * else.
 */
export function runsCli(argv: string[], name: string): boolean {
  const a0 = basename(argv[0] ?? "");
  if (a0 === name || a0 === `${name}.exe`) return true;
  if ((a0 === "node" || a0 === "bun" || a0.startsWith("node")) && argv[1]) {
    const a1 = argv[1];
    const b1 = basename(a1);
    return b1 === name || b1 === `${name}.js` || b1 === `${name}.exe` || a1.includes(`/${name}/`);
  }
  return false;
}
