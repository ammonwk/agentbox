import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { LoadSample, ProcDetail, ProcRole } from "./types";

/**
 * What each session is actually costing the machine.
 *
 * A session is never one process. A provider CLI with a couple of MCP servers
 * and a type-check running is several, and the several are what make the laptop
 * hot — the agent process itself is mostly idle waiting on the network. So
 * everything here works on the *subtree* rooted at the session's pid, which is
 * exactly what `Session.pid` holds: the provider's own CLI process (`claude`,
 * `codex`, `devin`, `omp`), whether it runs in agentbox's tmux or in some
 * terminal of yours.
 *
 * ── On cost ────────────────────────────────────────────────────────────────
 * Reading /proc/<pid>/stat for every process on the machine is 16-37ms for the
 * ~670 processes on a working laptop, which is affordable on a 2s poll.
 *
 * Reading /proc/<pid>/smaps_rollup is not: 11ms for a small process and 147ms
 * for one holding a 4.6 GiB heap, because the kernel walks every VMA. That is
 * why memory has its own slow lane — see metrics.ts.
 *
 * ── On which memory number ─────────────────────────────────────────────────
 * Summing RSS across a subtree is wrong, and the error is large rather than
 * academic: a measured agent read 776 MiB by RSS and 537 MiB by PSS. Node and
 * bun processes share their binary and libraries, a fork shares its parent's
 * heap until it writes, and RSS charges every shared page in full to every
 * process holding it.
 *
 * PSS divides each shared page by the number of processes sharing it, so a
 * subtree sum is meaningful. It is the number to show. RSS is kept only as the
 * fallback for the first poll and for processes whose smaps we cannot read —
 * and `LoadSample.memKind` says which one you are looking at, so the fallback
 * is labelled rather than silently wrong.
 */

export interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
  /** utime+stime+cutime+cstime in clock ticks — see `subtreeCpuTicks`. */
  cpuTicks: number;
  /** utime+stime only: this process, excluding everything it has reaped. */
  ownTicks: number;
  rssKb: number;
  /** Clock ticks since boot when this process started; used for age and identity. */
  startTicks: number;
  cmd?: string;
}

/** USER_HZ. Effectively always 100 on Linux; read once rather than assumed. */
let hz: number | null = null;

export function clockHz(): number {
  if (hz !== null) return hz;
  hz = 100;
  try {
    const n = Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim());
    if (n > 0) hz = n;
  } catch {
    /* keep the default */
  }
  return hz;
}

/** Boot time in ms since epoch, so a start tick becomes a wall clock. Lazy: an
 *  import must not do I/O, and this file is imported by the server at boot.
 *  0 when /proc/stat cannot be read (not Linux). */
let bootMs: number | null = null;

export function bootTimeMs(): number {
  if (bootMs !== null) return bootMs;
  bootMs = 0;
  try {
    const m = /^btime (\d+)/m.exec(readFileSync("/proc/stat", "utf8"));
    if (m) bootMs = Number(m[1]) * 1000;
  } catch {
    /* not Linux */
  }
  return bootMs;
}

/** argv of a process, or null if it is gone, mid-exec, or not ours to read. */
export function argvOf(pid: number): string[] | null {
  try {
    return splitArgv(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
  } catch {
    return null;
  }
}

/** A /proc/<pid>/cmdline as argv; null when empty (a kernel thread, a zombie). */
export function splitArgv(raw: string): string[] | null {
  if (!raw) return null;
  return raw.split("\0").filter((s, i, a) => s.length > 0 || i < a.length - 1);
}

export function parseStat(pid: number, s: string): ProcRow | null {
  // comm is in parens and may itself contain spaces and parens, so split from
  // the *last* close paren rather than tokenising the whole line.
  const close = s.lastIndexOf(")");
  const open = s.indexOf("(");
  if (close < 0 || open < 0 || close < open) return null;
  const comm = s.slice(open + 1, close);
  const f = s.slice(close + 2).split(" ");
  if (f.length < 22) return null;
  return {
    pid,
    ppid: Number(f[1]),
    comm,
    // Fields 14-17 (1-based utime, stime, cutime, cstime), here 0-based 11-14.
    cpuTicks: Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]),
    ownTicks: Number(f[11]) + Number(f[12]),
    rssKb: Number(f[21]) * 4,
    startTicks: Number(f[19]),
  };
}

export interface ProcTable {
  at: number;
  byPid: Map<number, ProcRow>;
  children: Map<number, number[]>;
}

export async function readProcTable(): Promise<ProcTable> {
  const dirs = await readdir("/proc").catch(() => [] as string[]);
  const rows = await Promise.all(
    dirs.map(async (d) => {
      if (!/^\d+$/.test(d)) return null;
      const pid = Number(d);
      try {
        return parseStat(pid, await readFile(`/proc/${d}/stat`, "utf8"));
      } catch {
        // Exited between readdir and read. Normal, and frequent at ~670 processes.
        return null;
      }
    }),
  );

  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (!r) continue;
    byPid.set(r.pid, r);
    const sib = children.get(r.ppid);
    if (sib) sib.push(r.pid);
    else children.set(r.ppid, [r.pid]);
  }
  return { at: Date.now(), byPid, children };
}

/**
 * The process table, shared. The fleet's pass, the metrics bar and the park
 * checks each read all of /proc every couple of seconds, on a machine with
 * near a thousand processes; one read now serves every caller within
 * `maxAgeMs` of it, and a caller that asks mid-read waits for that read.
 */
let sharedTable: { at: number; table: Promise<ProcTable> } | null = null;

export function sharedProcTable(maxAgeMs = 1_500): Promise<ProcTable> {
  const now = Date.now();
  if (sharedTable && now - sharedTable.at < maxAgeMs) return sharedTable.table;
  const table = readProcTable();
  const entry = { at: now, table };
  sharedTable = entry;
  table.catch(() => {
    if (sharedTable === entry) sharedTable = null;
  });
  return table;
}

/** Every process in the subtree rooted at `pid`, the root included. */
export function subtree(table: ProcTable, pid: number): ProcRow[] {
  const out: ProcRow[] = [];
  const seen = new Set<number>();
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    if (seen.has(p)) continue; // a pid cannot be its own ancestor, but never loop
    seen.add(p);
    const row = table.byPid.get(p);
    if (row) out.push(row);
    for (const k of table.children.get(p) ?? []) stack.push(k);
  }
  return out;
}

/**
 * Total CPU consumed by a subtree, in clock ticks.
 *
 * The subtlety is short-lived processes. A poll every two seconds misses every
 * `grep`, `git status` and `tsc` that starts and finishes in between, and those
 * are most of what an agent runs. Summing only live processes would undercount
 * a session's real cost by a wide margin.
 *
 * The kernel already solves this: when a process is reaped, its CPU time — and
 * that of everything it had already reaped — moves into its parent's `cutime`
 * and `cstime`. So summing utime+stime+cutime+cstime over the *live* members of
 * the subtree counts every descendant exactly once. A dead process is charged
 * to the nearest still-living ancestor that reaped it, and never to two.
 *
 * The one thing this misses is a subtree orphaned onto init, whose time is
 * charged to init instead. That also means the total can go *down* between
 * samples, which is why callers clamp the delta at zero.
 */
export function subtreeCpuTicks(rows: ProcRow[]): number {
  let t = 0;
  for (const r of rows) t += r.cpuTicks;
  return t;
}

/** How many samples of per-session CPU history to keep, for the sparkline. */
const HISTORY = 60;

interface Prior {
  ticks: number;
  at: number;
  history: number[];
}

/**
 * Turns successive process tables into rates.
 *
 * Held per pid rather than per session because a session that is stopped and
 * resumed is a genuinely new process whose counters restart at zero; keying on
 * pid means the old reading is simply never consulted again.
 */
export class LoadMeter {
  private prior = new Map<number, Prior>();
  private pss = new Map<number, { bytes: number; at: number }>();

  sample(table: ProcTable, pid: number): LoadSample | undefined {
    const rows = subtree(table, pid);
    if (rows.length === 0) {
      this.prior.delete(pid);
      return undefined;
    }

    const ticks = subtreeCpuTicks(rows);
    const prev = this.prior.get(pid);
    let cpuPct = 0;
    let history = prev?.history ?? [];

    if (prev && table.at > prev.at) {
      const elapsedTicks = ((table.at - prev.at) / 1000) * clockHz();
      // Clamped: a reaped subtree can make the total fall, which is not a
      // negative CPU usage, it is missing information.
      cpuPct = Math.max(0, ((ticks - prev.ticks) / elapsedTicks) * 100);
      history = [...history, cpuPct].slice(-HISTORY);
    }
    this.prior.set(pid, { ticks, at: table.at, history });

    let rssBytes = 0;
    for (const r of rows) rssBytes += r.rssKb * 1024;

    const measured = this.pss.get(pid);
    return {
      cpuPct,
      memBytes: measured ? measured.bytes : rssBytes,
      memKind: measured ? "pss" : "rss",
      procs: rows.length,
      history,
    };
  }

  /** Drop meters for pids that are gone, so the maps do not grow forever. */
  retain(pids: Set<number>): void {
    for (const pid of this.prior.keys()) if (!pids.has(pid)) this.prior.delete(pid);
    for (const pid of this.pss.keys()) if (!pids.has(pid)) this.pss.delete(pid);
  }

  /** Record a freshly measured PSS total for a subtree. */
  putPss(pid: number, bytes: number): void {
    this.pss.set(pid, { bytes, at: Date.now() });
  }
}

/** Proportional set size for one process, in bytes. Undefined if unreadable. */
async function readPss(pid: number): Promise<number | undefined> {
  try {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const m = /^Pss:\s+(\d+) kB/m.exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  } catch {
    // Kernel threads and processes we do not own have no readable rollup, and
    // anything can exit mid-read.
    return undefined;
  }
}

/** PSS for a whole subtree. Sequential on purpose — see the cost note above. */
export async function subtreePss(rows: ProcRow[]): Promise<number | undefined> {
  let total = 0;
  let got = 0;
  for (const r of rows) {
    const b = await readPss(r.pid);
    if (b !== undefined) {
      total += b;
      got++;
    }
  }
  return got > 0 ? total : undefined;
}

// ─── Naming and classifying ─────────────────────────────────────────────────

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "fish"]);

/** `-c`, alone or in a short-option cluster: codex runs its commands as `bash -lc`. */
const DASH_C = /^-[a-z]*c[a-z]*$/;

/**
 * Is this command line an agent running a shell tool call?
 *
 * Structural rather than string-matched, because the four providers do not
 * share a shape. Claude Code runs every Bash call through `bash -c source
 * <shell snapshot>`, which nothing else does, so that marker is exact. Codex
 * runs `bash -lc <command>` (its rollouts record the argv). omp's and devin's
 * shapes have not been sampled mid-turn; an idle agent has no children at all,
 * so the subtree only exists while a turn is running.
 *
 * So the rule is the one that holds for any of them: a direct child that is a
 * shell running `-c` is work the agent asked for, and a direct child that is
 * anything else is a server it started at boot. To check a provider against
 * it, sample a subtree while a turn is in flight:
 *   ps -e -o pid,ppid,args --no-headers | awk '$2==<agent pid>'
 */
export function isToolShell(cmd: string | undefined): boolean {
  if (!cmd) return false;
  if (cmd.includes("shell-snapshots")) return true;
  const parts = cmd.trim().split(/\s+/);
  const base = basename(parts[0] ?? "");
  return SHELLS.has(base) && parts.some((p) => DASH_C.test(p));
}

/**
 * What a process in a session's subtree is doing there.
 *
 * The distinction that earns its place is mcp-versus-tool: an MCP server
 * holding a gigabyte is a configuration problem you fix once, and a tool call
 * holding a gigabyte is just today's type-check.
 */
export function classify(row: ProcRow, agentPid: number, parentRole?: ProcRole): ProcRole {
  if (row.pid === agentPid) return "agent";
  if (parentRole === "agent") return isToolShell(row.cmd) ? "tool" : "mcp";
  return parentRole === "tool" ? "tool" : parentRole ?? "child";
}

/**
 * A name worth putting in a table.
 *
 * `comm` is capped at 15 characters by the kernel and is frequently useless — a
 * Python MCP server shows as "MainThread" and a truncated npm invocation as
 * "npm exec slack-". The command line has the real answer, so prefer it.
 */
export function describe(row: ProcRow): string {
  const cmd = row.cmd?.trim();
  // /proc/<pid>/cmdline reads empty while a process is mid-exec, so comm is a
  // real fallback rather than a theoretical one — and comm is capped at 15
  // characters, which "node (vitest 4)" happens to fit exactly.
  if (!cmd) return /^(?:node|bun|python3?|deno) \((.+?)\)?$/.exec(row.comm)?.[1] ?? row.comm;

  const parts = cmd.split(/\s+/);
  const head = parts[0] ?? "";
  const base = head.split("/").pop() ?? head;

  // A shell tool call: the interesting part is the command, not the several
  // hundred characters of environment preamble a wrapper may have prepended.
  if (SHELLS.has(base) && isToolShell(cmd)) {
    const evaled =
      /eval '([^']+)'/.exec(cmd)?.[1] ?? // Claude Code's snapshot wrapper
      /&& *([^&]+)$/.exec(cmd)?.[1] ??
      /\s-[a-z]*c[a-z]*\s+(.+)$/.exec(cmd)?.[1]?.replace(/^['"]|['"]$/g, "");
    return evaled ? squash(evaled) : base;
  }

  // Interpreters say nothing; the script they are running says everything.
  if (base === "node" || base === "bun" || base === "python" || base === "python3") {
    const rest = parts.slice(1).filter((p) => !p.startsWith("-"));
    const script = rest[0];
    // Some runners rewrite argv to a label instead of a path — vitest reports
    // `node (vitest 1)`. Splitting that on whitespace and taking the first
    // token produced "(vitest", so keep the whole label and drop its parens.
    if (script?.startsWith("(")) return squash(rest.join(" ").replace(/^\(|\)$/g, ""));
    if (script) {
      const file = script.split("/").pop() ?? script;
      // .../mcp-servers/coach/dist/index.js -> coach, not index.js
      if (/^(index|main|server|cli)\.(js|mjs|cjs|ts|py)$/.test(file)) {
        const dirs = script.split("/").filter(Boolean);
        // Skip build directories and generic containers alike: every process in
        // this panel is already known to belong to one session, so "mcp" and
        // "server" carry no information here.
        const meaningful = dirs
          .slice(0, -1)
          .reverse()
          .find(
            (d) =>
              !["dist", "build", "src", "bin", "lib", "out", "mcp", "server", "servers", "app"].includes(
                d,
              ),
          );
        if (meaningful) return squash(meaningful);
      }
      return squash(file);
    }
  }

  return squash(parts.length > 1 && base === "npm" ? cmd : base);
}

function squash(s: string, max = 44): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

// ─── The drilldown ──────────────────────────────────────────────────────────

/**
 * The per-process breakdown behind one session's row.
 *
 * Per-process CPU here is deliberately *not* the cumulative figure used for the
 * subtree total: `cutime` only lands on a parent when a child is reaped, so a
 * live `npm run typecheck` would read as zero while its children do the work.
 * For a table you are looking at, own utime+stime over the sample interval is
 * the honest per-row number, and the subtree total above it is the honest sum.
 * That is why the summary can legitimately exceed the rows beneath it.
 */
export async function breakdown(
  prev: ProcTable | undefined,
  cur: ProcTable,
  agentPid: number,
  opts: { pss?: boolean } = {},
): Promise<ProcDetail[]> {
  const rows = withCmdlines(subtree(cur, agentPid));
  const byPid = new Map(rows.map((r) => [r.pid, r]));

  const out: ProcDetail[] = [];
  const walk = async (pid: number, depth: number, parentRole?: ProcRole) => {
    const row = byPid.get(pid);
    if (!row) return;
    const role = classify(row, agentPid, parentRole);

    let cpuPct = 0;
    const before = prev?.byPid.get(pid);
    // Same pid *and* same start time: pids are recycled, and charging a new
    // process with an old one's counters would show a wild spike.
    if (before && before.startTicks === row.startTicks && prev && cur.at > prev.at) {
      const elapsed = ((cur.at - prev.at) / 1000) * clockHz();
      cpuPct = Math.max(0, ((row.ownTicks - before.ownTicks) / elapsed) * 100);
    }

    const boot = bootTimeMs();
    out.push({
      pid,
      ppid: row.ppid,
      name: describe(row),
      cmd: row.cmd ?? row.comm,
      role,
      cpuPct,
      rssBytes: row.rssKb * 1024,
      pssBytes: opts.pss ? await readPss(pid) : undefined,
      depth,
      ageMs: boot ? Date.now() - (boot + (row.startTicks / clockHz()) * 1000) : 0,
    });

    for (const kid of (cur.children.get(pid) ?? []).slice().sort((a, b) => a - b)) {
      await walk(kid, depth + 1, role);
    }
  };
  await walk(agentPid, 0);
  return out;
}

/**
 * Shell tool calls still alive directly under a session.
 *
 * When the agent's turn has ended, these are background commands that outlived
 * it — dev servers and watchers, mostly. They are worth counting because they
 * are the reason such a session looks busy from the outside, and because a
 * `while true` loop nobody remembers starting will poll until the laptop is
 * rebooted.
 *
 * Direct children only, and only their command lines: a handful of small reads
 * per session rather than the full-subtree walk the drilldown does.
 */
export async function backgroundShells(table: ProcTable, pid: number): Promise<number> {
  const kids = table.children.get(pid) ?? [];
  if (kids.length === 0) return 0;
  return kids.filter((k) => isToolShell(argvOf(k)?.join(" "))).length;
}

/** Read command lines for a set of processes. Only for the drilldown. */
function withCmdlines(rows: ProcRow[]): ProcRow[] {
  return rows.map((r) => {
    const argv = argvOf(r.pid);
    return argv ? { ...r, cmd: argv.join(" ").trim() } : r;
  });
}
