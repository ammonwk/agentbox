/** Finding provider processes and reading what they were started with.
 *
 * Every adapter's `liveProcesses` is the same three questions about a pid:
 * what is it running, which account's environment did it start with, and where
 * is it. All three come from /proc and all three race with the process
 * exiting, so every reader here returns null instead of throwing.
 */

import { readFileSync, readlinkSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { argvOf, bootTimeMs, clockHz, parseStat, sharedProcTable, splitArgv, type ProcTable } from "../proc";
import type { ProviderId } from "../types";

export { argvOf };

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
 * the whole table, so the fleet opens a shared scan for the length of one
 * pass (`withProcessScan`) and every adapter reads the same one. Outside a
 * pass every call scans fresh — a cache on a timer would hand a caller that
 * just started a process a table without it.
 */
let shared: ProcMatch[] | null = null;

function scanOwnProcesses(): ProcMatch[] {
  return shared ?? scanUncached();
}

/** A pass's scan, over the shared process table (`sharedProcTable`), which
 *  `fn` is handed too. */
export async function withProcessScan<T>(fn: (table: ProcTable) => Promise<T>): Promise<T> {
  const table = await sharedProcTable();
  shared = await ownProcesses(table);
  try {
    return await fn(table);
  } finally {
    shared = null;
  }
}

/**
 * Each process's argv and owner, as read: reading every process's cmdline and
 * owner each pass was two files a process, near a thousand processes, every
 * two seconds, on the event loop. A process keeps its argv for life unless it
 * execs, which changes its comm (bash → claude) and so reads it again; the
 * rare exec that keeps its comm (node → node) is caught by re-reading each
 * one every `KNOWN_MS` or so, staggered.
 */
const known = new Map<number, { startTicks: number; comm: string; until: number; argv: string[] | null; uid: number | null }>();
const KNOWN_MS = 30_000;

async function ownProcesses(table: ProcTable): Promise<ProcMatch[]> {
  const uid = process.getuid?.();
  const now = Date.now();
  const out: ProcMatch[] = [];
  await Promise.all(
    [...table.byPid.values()].map(async (row) => {
      if (row.pid === process.pid) return;
      let k = known.get(row.pid);
      if (!k || k.startTicks !== row.startTicks || k.comm !== row.comm || now > k.until) {
        const [argv, owner] = await Promise.all([
          readFile(`/proc/${row.pid}/cmdline`, "utf8").then(splitArgv, () => null),
          stat(`/proc/${row.pid}`).then((s) => s.uid, () => null),
        ]);
        k = { startTicks: row.startTicks, comm: row.comm, until: now + KNOWN_MS * (0.5 + Math.random()), argv, uid: owner };
        known.set(row.pid, k);
      }
      if (!k.argv || k.argv.length === 0 || (uid !== undefined && k.uid !== uid)) return;
      out.push({ pid: row.pid, ppid: row.ppid, argv: k.argv });
    }),
  );
  for (const pid of known.keys()) if (!table.byPid.has(pid)) known.delete(pid);
  return out;
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

/** A process as pid and start time: the pid alone may since belong to another. */
export interface ProcessRef {
  pid: number;
  startedAt: number;
}

const AGENT_CLIS: readonly ProviderId[] = ["claude", "codex", "devin", "omp"];

/** The nearest ancestor of this process that runs an agent CLI. */
export function agentAncestor(): ProcessRef | null {
  for (let pid = process.ppid, hops = 0; pid > 1 && hops < 64; hops++) {
    const argv = argvOf(pid);
    if (argv && AGENT_CLIS.some((name) => runsCli(argv, name))) {
      const startedAt = startedAtOf(pid);
      return startedAt === null ? null : { pid, startedAt };
    }
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return null;
    }
    pid = parseStat(pid, stat)?.ppid ?? 0;
  }
  return null;
}

export function stillRunning(p: ProcessRef): boolean {
  return startedAtOf(p.pid) === p.startedAt;
}
