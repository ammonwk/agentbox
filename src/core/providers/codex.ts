/** OpenAI Codex CLI.
 *
 * Transcripts ("rollouts"): `<home>/sessions/YYYY/MM/DD/rollout-<local time>-<uuid>.jsonl`,
 * home being `CODEX_HOME` (default `~/.codex`). The uuid is a v7 thread id;
 * the filename time is *local* time, so the start time is taken from record
 * 0's UTC timestamp where it matters. Subagent threads get rollouts of their
 * own in the same directories, told apart only by record 0.
 *
 * Processes: `codex` on PATH is a node wrapper (`bin/codex.js`) that spawns
 * the native binary (`…/vendor/<triple>/bin/codex`) with the same argv and
 * forwards signals to it. Both match `runsCli`; they are one session, reported
 * once, under the wrapper's pid (the top of the tree — what tmux started and
 * what a SIGTERM should reach). The ChatGPT desktop app runs its own
 * `codex app-server`, which hosts many threads and is not a CLI session.
 *
 * Which session a process is — codex keeps no rollout open and writes no
 * per-pid file, so this is proven in order of strength:
 *   1. argv: `codex resume <uuid>`;
 *   2. an open `<home>/thread-writer-locks/<uuid>.lock` (the writer lock
 *      codex 0.156 takes for the thread it records) or open rollout;
 *   3. `<home>/logs_2.sqlite`, whose rows carry `process_uuid = "pid:<pid>:…"`
 *      and the `thread_id` they were logged for (the TUI logs its thread id
 *      within a second or two of creating it);
 *   4. a rollout in the process's cwd, of the same kind (TUI vs exec), that
 *      started after the process and that no other unexplained process in
 *      that cwd could have written. Two codex started in one directory with
 *      nothing else to go on stay unknown rather than guessed.
 */

import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, readlinkSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { userHome } from "../paths";
import { cliVersion } from "./cli-version";
import type { Account } from "../types";
import { codexFormat, codexLineage, type CodexLineage } from "./codex-transcript";
import { JsonlTranscriptReader } from "./jsonl-reader";
import { cwdOf, environOf, findProcesses, runsCli, startedAtOf, type ProcMatch } from "./procs";
import { pickOption, plainScreen } from "./tui-screen";
import type {
  Command,
  LiveProcess,
  ProviderAdapter,
  ResumeOptions,
  SpawnOptions,
  TranscriptReader,
  TranscriptRef,
} from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;


export function codexHome(account: Pick<Account, "isDefault" | "home">): string {
  return account.isDefault ? join(userHome(), ".codex") : account.home;
}

const norm = (p: string) => resolve(p).replace(/\/+$/, "");

/** Start of a rollout from its filename, which is written in local time. */
export function rolloutStartFromName(name: string): number | null {
  const m = ROLLOUT.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
}

// ------------------------------------------------------------- listing

/** How far back day directories are walked by default: a rollout started
 *  days ago is still appended to while its session runs. */
const LOOKBACK_DAYS = 14;
const DAY = 86_400_000;

interface Rollout {
  path: string;
  id: string;
  mtimeMs: number;
  size: number;
}

class SessionsIndex {
  /** Day directory → rollout names, cached by the directory's mtime. */
  private days = new Map<string, { mtimeMs: number; names: string[] }>();

  constructor(readonly root: string) {}

  private ls(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  private dayFiles(dir: string): string[] {
    let m: number;
    try {
      m = statSync(dir).mtimeMs;
    } catch {
      this.days.delete(dir);
      return [];
    }
    const hit = this.days.get(dir);
    if (hit && hit.mtimeMs === m) return hit.names;
    const names = this.ls(dir).filter((n) => ROLLOUT.test(n));
    this.days.set(dir, { mtimeMs: m, names });
    return names;
  }

  /** Day directories newest first, back to `floorDay` (YYYY/MM/DD strings compare as dates). */
  private dayDirs(floorDay: string | null): string[] {
    const out: string[] = [];
    for (const y of this.ls(this.root).filter((n) => /^\d{4}$/.test(n)).sort().reverse()) {
      for (const mo of this.ls(join(this.root, y)).filter((n) => /^\d{2}$/.test(n)).sort().reverse()) {
        for (const d of this.ls(join(this.root, y, mo)).filter((n) => /^\d{2}$/.test(n)).sort().reverse()) {
          if (floorDay && `${y}/${mo}/${d}` < floorDay) return out;
          out.push(join(this.root, y, mo, d));
        }
      }
    }
    return out;
  }

  scan(sinceMs: number): Rollout[] {
    const floor = new Date(sinceMs - LOOKBACK_DAYS * DAY);
    const floorDay = `${floor.getFullYear()}/${String(floor.getMonth() + 1).padStart(2, "0")}/${String(floor.getDate()).padStart(2, "0")}`;
    const out: Rollout[] = [];
    for (const dir of this.dayDirs(floorDay)) {
      for (const name of this.dayFiles(dir)) {
        const path = join(dir, name);
        try {
          const st = statSync(path);
          if (st.mtimeMs >= sinceMs) out.push({ path, id: ROLLOUT.exec(name)![7]!, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* vanished */
        }
      }
    }
    return out;
  }

  find(id: string): string | null {
    const lower = id.toLowerCase();
    for (const dir of this.dayDirs(null)) {
      for (const name of this.dayFiles(dir)) if (name.toLowerCase().endsWith(`-${lower}.jsonl`)) return join(dir, name);
    }
    return null;
  }
}

const indexes = new Map<string, SessionsIndex>();
function indexFor(home: string): SessionsIndex {
  const root = join(home, "sessions");
  let ix = indexes.get(root);
  if (!ix) indexes.set(root, (ix = new SessionsIndex(root)));
  return ix;
}

// ------------------------------------------------------------- record 0

/** First line of a file, read in small steps: record 0 carries the base
 *  instructions and can run to tens of KB, and the rest can run to 200 MB. */
export function readFirstLine(path: string, max = 4 * 1024 * 1024): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let pos = 0;
    while (pos < max) {
      const buf = Buffer.allocUnsafe(64 * 1024);
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return null;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(buf.subarray(0, n));
      pos += n;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Record 0 never changes once written, so what a rollout is is cached for
 *  good (bounded by eviction of the oldest). */
const lineageCache = new Map<string, CodexLineage>();
function lineageOf(path: string): CodexLineage | null {
  const hit = lineageCache.get(path);
  if (hit) return hit;
  const line = readFirstLine(path);
  if (!line) return null;
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  const l = codexLineage(rec);
  if (lineageCache.size > 5000) lineageCache.delete(lineageCache.keys().next().value!);
  lineageCache.set(path, l);
  return l;
}

// ------------------------------------------------------------- thread names

/**
 * `<home>/session_index.jsonl` holds `{id, thread_name, updated_at}` lines,
 * the newest per id winning: the name the TUI or you gave the thread. Small,
 * shared by every reader on a home, and re-read only when it changes.
 */
const nameCache = new Map<string, { mtimeMs: number; size: number; names: Map<string, string> }>();
function threadName(home: string, id: string): string | null {
  const path = join(home, "session_index.jsonl");
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let c = nameCache.get(path);
  if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
    const names = new Map<string, string>();
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const r = JSON.parse(line);
          if (typeof r.id === "string" && typeof r.thread_name === "string" && r.thread_name) names.set(r.id, r.thread_name);
        } catch {
          /* torn line */
        }
      }
    } catch {
      /* unreadable */
    }
    nameCache.set(path, (c = { mtimeMs: st.mtimeMs, size: st.size, names }));
  }
  return c.names.get(id) ?? null;
}

// ------------------------------------------------------------- processes

/** Subcommands that are not an agent session at all. */
const NOT_A_SESSION = new Set([
  "app-server", "exec-server", "mcp-server", "mcp", "login", "logout", "plugin", "completion",
  "update", "doctor", "sandbox", "debug", "apply", "a", "cloud", "features", "help", "agents",
  "queue", "archive", "delete", "unarchive", "migrate-rollouts", "remote-control",
]);
/** Options that take a value, so the value is not mistaken for a subcommand. */
const VALUE_OPTS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image",
  "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval",
  "-C", "--cd", "--add-dir", "-o", "--output-last-message", "--output-schema", "--color",
]);

export interface CodexInvocation {
  /** undefined = interactive TUI. */
  sub: string | undefined;
  /** The uuid `codex resume <uuid>` names. */
  resumeId: string | null;
  /** `-C/--cd <dir>`, the directory the session works in. */
  cd: string | null;
}

/** What a codex argv is doing. `args` excludes the program (and node). */
export function parseCodexArgs(args: string[]): CodexInvocation {
  let sub: string | undefined;
  let resumeId: string | null = null;
  let cd: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      const flag = eq > 0 ? a.slice(0, eq) : a;
      const val = eq > 0 ? a.slice(eq + 1) : args[i + 1];
      if (flag === "-C" || flag === "--cd") cd = val ?? null;
      if (eq < 0 && VALUE_OPTS.has(flag)) i++;
      continue;
    }
    positionals.push(a);
    if (positionals.length === 1) {
      // The first positional is a subcommand only if codex knows it as one;
      // otherwise it is the prompt of an interactive session.
      if (NOT_A_SESSION.has(a) || ["exec", "e", "review", "resume", "fork"].includes(a)) sub = a;
      else break;
    } else if (sub === "resume" && positionals.length === 2 && UUID.test(a)) {
      resumeId = a;
    }
  }
  return { sub, resumeId, cd };
}

function codexArgs(argv: string[]): string[] {
  const a0 = basename(argv[0] ?? "");
  return a0 === "node" || a0.startsWith("node") || a0 === "bun" ? argv.slice(2) : argv.slice(1);
}

/** The thread ids a process holds a writer lock or rollout open for. */
function openThreads(pid: number, home: string): string[] {
  const locks = join(home, "thread-writer-locks") + "/";
  const sessions = join(home, "sessions") + "/";
  const out: string[] = [];
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return out;
  }
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    if (target.startsWith(locks) && target.endsWith(".lock")) {
      const id = basename(target, ".lock");
      if (UUID.test(id)) out.push(id);
    } else if (target.startsWith(sessions)) {
      const m = ROLLOUT.exec(basename(target));
      if (m) out.push(m[7]!);
    }
  }
  return out;
}

/** pid → threads from codex's own log database, newest first. Rows before the
 *  process started belong to an earlier process that had the same pid. */
function loggedThreads(home: string, pid: number, startedAt: number): string[] {
  const path = join(home, "logs_2.sqlite");
  if (!existsSync(path)) return [];
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db
      .query(
        "SELECT thread_id, MAX(ts) AS last FROM logs WHERE ts >= ?1 AND process_uuid LIKE ?2 AND thread_id IS NOT NULL GROUP BY thread_id ORDER BY last DESC LIMIT 20",
      )
      .all(Math.floor(startedAt / 1000) - 5, `pid:${pid}:%`) as { thread_id: string }[];
    return rows.map((r) => r.thread_id).filter((t) => UUID.test(t));
  } catch {
    // Locked, migrated, or not the schema we know: this is only one witness.
    return [];
  } finally {
    db?.close();
  }
}

interface Candidate extends CwdCandidate {
  pid: number;
  pids: number[];
  account: Account | null;
}

/** A rollout of this kind: the TUI writes source "cli" (the VS Code
 *  extension "vscode"), `codex exec` writes "exec". */
function kindMatches(l: CodexLineage, kind: "tui" | "exec"): boolean {
  if (l.isSubagent) return false;
  return kind === "exec" ? l.source === "exec" : l.source !== "exec";
}

/** Resolved ids by (pid, start), so the log database and fds are not
 *  re-read every poll for a process that has already been identified. */
const proven = new Map<string, { id: string; at: number }>();
const PROVEN_TTL = 30_000;

async function liveProcesses(accounts: Account[]): Promise<LiveProcess[]> {
  const mine = accounts.filter((a) => a.provider === "codex");
  const byHome = new Map(mine.map((a) => [norm(codexHome(a)), a]));
  const def = mine.find((a) => a.isDefault) ?? null;

  const procs = findProcesses((argv) => runsCli(argv, "codex"));
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  // Group a wrapper with the native child it spawned (and anything codex
  // re-execs of itself): one session, reported at the top of the chain.
  const rootOf = (p: ProcMatch): ProcMatch => {
    let cur = p;
    for (let guard = 0; guard < 8; guard++) {
      const parent = byPid.get(cur.ppid);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  };
  const groups = new Map<number, ProcMatch[]>();
  for (const p of procs) {
    const r = rootOf(p);
    const g = groups.get(r.pid);
    if (g) g.push(p);
    else groups.set(r.pid, [p]);
  }

  const now = Date.now();
  const cands: Candidate[] = [];
  for (const [rootPid, members] of groups) {
    const root = byPid.get(rootPid)!;
    const inv = parseCodexArgs(codexArgs(root.argv));
    if (inv.sub && NOT_A_SESSION.has(inv.sub)) continue;
    const kind = inv.sub === "exec" || inv.sub === "e" || inv.sub === "review" ? "exec" : "tui";
    const env = environOf(rootPid);
    let account: Account | null = null;
    if (env) {
      const h = env.get("CODEX_HOME");
      account = h ? (byHome.get(norm(h)) ?? null) : def;
      if (!account) continue; // a home agentbox does not manage
    }
    const home = account ? codexHome(account) : env?.get("CODEX_HOME") || join(userHome(), ".codex");
    const pcwd = cwdOf(rootPid) ?? "";
    const cwd = inv.cd ? resolve(pcwd || "/", inv.cd) : pcwd;
    const startedAt = startedAtOf(rootPid) ?? 0;
    const pids = members.map((m) => m.pid);
    let id: string | null = inv.resumeId;

    // Re-proven every PROVEN_TTL, so a `/new` inside the TUI is followed.
    const key = `${rootPid}:${startedAt}`;
    const cached = proven.get(key);
    if (!id && cached && now - cached.at < PROVEN_TTL) id = cached.id;
    if (!id) {
      const held = [...new Set(pids.flatMap((p) => openThreads(p, home)))];
      id = pickThread(held, home) ?? pickThread(pids.flatMap((p) => loggedThreads(home, p, startedAt)), home);
      if (id) proven.set(key, { id, at: now });
    }
    cands.push({ pid: rootPid, pids, account, home, cwd, startedAt, kind, id });
  }
  if (proven.size > 500) for (const [k, v] of proven) if (now - v.at > PROVEN_TTL) proven.delete(k);

  matchByCwd(cands);
  return cands
    .filter((c) => c.kind === "tui" || c.id)
    .map((c) => ({ pid: c.pid, accountId: c.account?.id ?? null, agentSessionId: c.id, cwd: c.cwd, startedAt: c.startedAt }));
}

/** Of the threads a process is proven to hold, its own session: not a
 *  subagent it spawned, and the newest (after `/new`, the old thread may
 *  still be listed). Thread ids are v7 uuids, so they sort by creation. */
function pickThread(ids: string[], home: string): string | null {
  if (!ids.length) return null;
  const ix = indexFor(home);
  const own = ids.filter((id) => {
    const path = ix.find(id);
    const l = path ? lineageOf(path) : null;
    return !l?.isSubagent;
  });
  if (!own.length) return null;
  return own.sort().reverse()[0]!;
}

export interface CwdCandidate {
  home: string;
  cwd: string;
  kind: "tui" | "exec";
  startedAt: number;
  id: string | null;
}

export interface RolloutInfo {
  id: string;
  /** Epoch ms the thread was created. */
  start: number;
  lineage: CodexLineage;
}

/** Threads the log database attributes to some process. */
function loggedOwners(home: string, ids: string[]): Set<string> {
  const out = new Set<string>();
  const path = join(home, "logs_2.sqlite");
  if (!ids.length || !existsSync(path)) return out;
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const q = db.query("SELECT 1 FROM logs WHERE thread_id = ?1 LIMIT 1");
    for (const id of ids) if (q.get(id)) out.add(id);
  } catch {
    /* only one witness */
  } finally {
    db?.close();
  }
  return out;
}

/** Rollouts started since `sinceMs` that no log row ties to a process: a
 *  thread with a logged owner belongs to that owner, and had the owner been
 *  one of the unexplained processes it would already have been matched. */
function unownedRollouts(home: string, sinceMs: number): RolloutInfo[] {
  const found = indexFor(home)
    .scan(sinceMs)
    .map((r) => ({ r, l: lineageOf(r.path) }))
    .filter((x): x is { r: Rollout; l: CodexLineage } => !!x.l);
  const owned = loggedOwners(home, found.map((x) => x.r.id));
  return found
    .filter((x) => !owned.has(x.r.id))
    .map((x) => ({ id: x.r.id, start: x.l.startedAt ?? rolloutStartFromName(basename(x.r.path)) ?? 0, lineage: x.l }));
}

/**
 * The weakest proof, used only where it is unambiguous: a rollout of the
 * right kind in the process's cwd, created after the process started, that
 * exactly one unexplained process could have written. Rollouts are taken in
 * creation order, so once one has two possible writers every later one does
 * too, and the rest stay unknown.
 */
export function matchByCwd<C extends CwdCandidate>(
  cands: C[],
  rolloutsFor: (home: string, sinceMs: number) => RolloutInfo[] = unownedRollouts,
): void {
  const open = cands.filter((c) => !c.id && c.cwd);
  if (!open.length) return;
  const claimed = new Set(cands.filter((c) => c.id).map((c) => c.id!));
  const byKey = new Map<string, C[]>();
  for (const c of open) {
    const k = JSON.stringify([c.home, c.cwd, c.kind]);
    const g = byKey.get(k);
    if (g) g.push(c);
    else byKey.set(k, [c]);
  }
  const earliest = new Map<string, number>();
  for (const c of open) earliest.set(c.home, Math.min(earliest.get(c.home) ?? Infinity, c.startedAt));
  const cache = new Map<string, RolloutInfo[]>();
  for (const group of byKey.values()) {
    const { home, cwd, kind } = group[0]!;
    let all = cache.get(home);
    if (!all) cache.set(home, (all = rolloutsFor(home, earliest.get(home)! - 60_000)));
    const rollouts = all
      .filter((r) => r.lineage.cwd === cwd && kindMatches(r.lineage, kind) && !claimed.has(r.id))
      .sort((a, b) => a.start - b.start);
    const pending = new Set(group);
    for (const ro of rollouts) {
      // Its possible writers: unexplained processes that had started by then,
      // with slack for /proc start ticks against a wall-clock timestamp.
      const owners = [...pending].filter((c) => c.startedAt - 5_000 <= ro.start);
      if (owners.length === 1) {
        owners[0]!.id = ro.id;
        claimed.add(ro.id);
        pending.delete(owners[0]!);
      } else if (owners.length > 1) {
        break;
      }
    }
  }
}

// ------------------------------------------------------------- screens

/**
 * Start-up dialogs safe to answer for a session agentbox launched: folder
 * trust ("Trust this folder?" → "Trust and continue"; before 0.15x "Do you
 * trust the contents of this directory?" → "Yes, continue"), the update
 * prompt ("Skip" — never "Update now", which runs npm under the session), and
 * resuming from another directory ("Use session directory" — where the
 * session was). Hook trust, model migration and login are left to you.
 */
export function codexAutoAnswer(raw: string): string[] | null {
  const s = plainScreen(raw);
  if (/Trust this folder\?/.test(s) && /Trust and continue/.test(s)) return pickOption(s, /^Trust and continue/);
  if (/Do you trust the contents of this directory/.test(s) && /Yes, continue/.test(s)) return pickOption(s, /^Yes, continue/);
  if (/Update available/.test(s) && /Skip until next version/.test(s)) return pickOption(s, /^Skip\s*$/);
  if (/Use session directory/.test(s) && /Use current directory/.test(s)) return pickOption(s, /^Use session directory/);
  return null;
}

export function codexBlockedOn(raw: string): string | null {
  const s = plainScreen(raw);
  if (/Sign in with ChatGPT/.test(s) && /Sign in with Device Code|Provide your own API key|Welcome to Codex/.test(s)) return "login required";
  if (/Would you like to run the following command\?/.test(s)) return "approval: run command";
  if (/Would you like to make the following edits\?/.test(s)) return "approval: apply edits";
  if (/Would you like to grant these permissions\?/.test(s)) return "approval: permissions";
  if (/Would you like to send input to the/.test(s)) return "approval: send input";
  if (/Approve app tool call\?/.test(s)) return "approval: tool call";
  if (/Allow this request and continue/.test(s)) return "approval: network request";
  if (/Yes, provide the requested info/.test(s)) return "question";
  if (/Trust this folder\?|Do you trust the contents of this directory/.test(s)) return "folder trust";
  if (/Hooks need review/.test(s)) return "hooks need review";
  if (/Try new model/.test(s) && /Use existing model/.test(s)) return "model upgrade prompt";
  if (/Keep current model/.test(s)) return "rate-limit model switch prompt";
  if (/Enable full access\?/.test(s)) return "confirm full access";
  return null;
}

// ------------------------------------------------------------- commands

function accountCommand(account: Pick<Account, "home" | "isDefault">): Pick<Command, "env" | "unset"> {
  // The server's own CODEX_HOME must not leak into the default account.
  return account.isDefault ? { env: {}, unset: ["CODEX_HOME"] } : { env: { CODEX_HOME: account.home } };
}

/** clap reads a leading `-` as a flag. */
const promptArg = (p: string) => (p.startsWith("-") ? ` ${p}` : p);

function spawnCommand(opts: SpawnOptions): Command & { agentSessionId: string | null } {
  const argv = ["codex"];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.autoApprove) argv.push("--dangerously-bypass-approvals-and-sandbox");
  if (opts.prompt) argv.push(promptArg(opts.prompt));
  return { argv, ...accountCommand(opts.account), agentSessionId: null };
}

function resumeCommand(opts: ResumeOptions): Command {
  const argv = ["codex", "resume"];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.autoApprove) argv.push("--dangerously-bypass-approvals-and-sandbox");
  argv.push(opts.agentSessionId);
  if (opts.prompt) argv.push(promptArg(opts.prompt));
  return { argv, ...accountCommand(opts.account) };
}

// ------------------------------------------------------------- adapter

function refOf(account: Account, r: Rollout): TranscriptRef {
  return { provider: "codex", accountId: account.id, agentSessionId: r.id, path: r.path, mtimeMs: r.mtimeMs, size: r.size };
}

/** The home a rollout path lives in: everything before `/sessions/YYYY/`. */
function homeOfRollout(path: string): string | null {
  const m = /^(.*)\/sessions\/\d{4}\/\d{2}\/\d{2}\/[^/]+$/.exec(path);
  return m ? m[1]! : null;
}

export function codexReader(ref: TranscriptRef): TranscriptReader {
  const home = homeOfRollout(ref.path);
  return new JsonlTranscriptReader(ref, codexFormat(ref, () => (home ? threadName(home, ref.agentSessionId) : null)));
}

export const codexAdapter: ProviderAdapter = {
  id: "codex",
  label: "Codex",

  detect: () => cliVersion(["codex", "--version"]),

  defaultHome: () => join(userHome(), ".codex"),

  accountCommand,
  authEnv: accountCommand,

  async listTranscripts(account, sinceMs) {
    return indexFor(codexHome(account))
      .scan(sinceMs)
      .map((r) => refOf(account, r));
  },

  liveProcesses,

  async findTranscript(account, agentSessionId) {
    if (!UUID.test(agentSessionId)) return null;
    const path = indexFor(codexHome(account)).find(agentSessionId);
    if (!path) return null;
    try {
      const st = statSync(path);
      return refOf(account, { path, id: agentSessionId, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      return null;
    }
  },

  reader: codexReader,
  spawnCommand,
  resumeCommand,
  autoAnswer: codexAutoAnswer,
  blockedOn: codexBlockedOn,
};
