/** The devin adapter (devin CLI 3000.11, a Rust binary).
 *
 * Where things are, under `$XDG_DATA_HOME/devin` (default ~/.local/share/devin):
 *
 *   credentials.toml          windsurf_api_key and server URLs — the identity
 *   cli/sessions.db           sessions, prompt history, the message forest
 *   cli/transcripts/<id>.json ATIF export, rewritten at the end of each turn
 *   cli/session_locks/<id>.lock   the pid of the process holding the session
 *   cli/logs/devin_<stamp>_<pid>.log   one log per process
 *
 * Accounts. devin records nothing about which login a session ran under, and
 * `WINDSURF_API_KEY` in a process's environment overrides the stored login
 * for that process only. So every account runs with the DEFAULT XDG dirs —
 * all transcripts land in one place — and a non-default account differs only
 * by the key read from `<home>/devin/credentials.toml` (where its login was
 * run with `XDG_DATA_HOME=<home>`). Consequences:
 *   - live processes are attributed by comparing their WINDSURF_API_KEY with
 *     each account's key (unset = the default account);
 *   - transcripts cannot be attributed from devin's data, so they are all
 *     listed under the default account; the fleet overrides that from its own
 *     database for sessions it spawned on another account.
 *
 * Liveness. The interactive TUI spawns a `devin acp` child that does the work
 * and holds the session lock, writing its own pid into
 * `session_locks/<id>.lock`. Lock files are never deleted, so a lock proves a
 * session live only when that pid is a running devin that started before the
 * lock was written. The TUI (the lock holder's parent) is reported as the
 * session's process, since it is what runs in the terminal.
 */

import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account, TimelineEvent, TimelinePage } from "../types";
import * as db from "./devin-db";
import {
  devinFacts,
  parseAtif,
  parseDevinRateLimits,
  pendingPromptEvents,
  type AtifParse,
} from "./devin-transcript";
import { cwdOf, environOf, findProcesses, runsCli, startedAtOf } from "./procs";
import type {
  Command,
  LiveProcess,
  ProviderAdapter,
  ResumeOptions,
  SpawnOptions,
  TranscriptFacts,
  TranscriptReader,
  TranscriptRef,
} from "./types";

const DEFAULT_PAGE = 50;

interface DevinPaths {
  cli: string;
  db: string;
  transcripts: string;
  locks: string;
  logs: string;
}

function pathsUnder(dataHome: string): DevinPaths {
  const cli = join(dataHome, "devin", "cli");
  return {
    cli,
    db: join(cli, "sessions.db"),
    transcripts: join(cli, "transcripts"),
    locks: join(cli, "session_locks"),
    logs: join(cli, "logs"),
  };
}

/** The XDG data dir devin's default login lives under — the default account's
 *  "home", since a home is what `XDG_DATA_HOME` gets set to. */
function defaultDataHome(): string {
  return process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local", "share");
}

// ----------------------------------------------------------- credentials

const keyCache = new Map<string, { mtimeMs: number; key: string | null }>();

/**
 * The windsurf API key an account logged in with. Read at runtime only, to
 * put in a child's environment or compare in memory; it is never logged or
 * returned anywhere else.
 */
export function windsurfKeyOf(home: string): string | null {
  const path = join(home, "devin", "credentials.toml");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    keyCache.delete(path);
    return null;
  }
  const hit = keyCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.key;
  let key: string | null = null;
  try {
    const text = readFileSync(path, "utf8");
    try {
      const v = (Bun.TOML.parse(text) as Record<string, unknown>).windsurf_api_key;
      key = typeof v === "string" && v ? v : null;
    } catch {
      key = /^\s*windsurf_api_key\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ?? null;
    }
  } catch {
    key = null;
  }
  keyCache.set(path, { mtimeMs, key });
  return key;
}

// ----------------------------------------------------------- processes

/** devin subcommands; anything else before `--` is an option or a path. */
const SUBCOMMANDS = new Set([
  "auth", "mcp", "models", "doctor", "rules", "skills", "plugins", "cloud", "desktop", "list", "ls", "rm",
  "ssh", "forward", "update", "version", "migrate", "sandbox", "setup", "uninstall", "acp", "help",
]);
/** Options whose value is the next argument, so it is not mistaken for one. */
const VALUE_FLAGS = new Set(["--model", "--permission-mode", "--config", "--prompt-file"]);

export function devinSubcommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return null;
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return SUBCOMMANDS.has(a) ? a : null;
  }
  return null;
}

export interface DevinProc {
  pid: number;
  ppid: number;
  argv: string[];
}

/** session id → pid, for every lock whose pid is a live devin that started
 *  before the lock was written. */
export function heldLocks(
  locksDir: string,
  pids: Iterable<number>,
  startOf: (pid: number) => number | null,
): Map<string, number> {
  const out = new Map<string, number>();
  const live = new Set(pids);
  if (live.size === 0) return out;
  let names: string[];
  try {
    names = readdirSync(locksDir).filter((n) => n.endsWith(".lock"));
  } catch {
    return out;
  }
  const starts = new Map<number, number | null>();
  const start = (pid: number) => {
    if (!starts.has(pid)) starts.set(pid, startOf(pid));
    return starts.get(pid)!;
  };
  const earliest = Math.min(...[...live].map((p) => start(p) ?? Infinity));
  for (const n of names) {
    const path = join(locksDir, n);
    try {
      const st = statSync(path);
      // Written before any live devin started: a leftover from a dead one.
      // This keeps the poll to one stat for each of the (never deleted) locks.
      if (st.mtimeMs < earliest - 2000) continue;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (!live.has(pid)) continue;
      const started = start(pid);
      if (started === null || started > st.mtimeMs + 2000) continue;
      out.set(n.slice(0, -".lock".length), pid);
    } catch {
      /* raced */
    }
  }
  return out;
}

/**
 * Which processes to report, and for which sessions. The TUI (no subcommand,
 * or `-p`) is reported with the sessions its `acp` child holds; a standalone
 * `acp` server (another client's) only for the sessions it holds; every other
 * subcommand (`list`, `auth`, `mcp`, …) not at all.
 */
export function devinSessionProcs(procs: DevinProc[], held: Map<string, number>): { pid: number; ids: string[] }[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const sessionsOf = new Map<number, string[]>();
  for (const [id, pid] of held) sessionsOf.set(pid, [...(sessionsOf.get(pid) ?? []), id]);
  const out: { pid: number; ids: string[] }[] = [];
  for (const p of procs) {
    const sub = devinSubcommand(p.argv);
    if (sub === null) {
      const ids = [...(sessionsOf.get(p.pid) ?? [])];
      for (const c of procs) {
        if (c.ppid === p.pid && devinSubcommand(c.argv) === "acp") ids.push(...(sessionsOf.get(c.pid) ?? []));
      }
      out.push({ pid: p.pid, ids });
    } else if (sub === "acp") {
      const parent = byPid.get(p.ppid);
      if (parent && devinSubcommand(parent.argv) === null) continue; // its TUI reports it
      const ids = sessionsOf.get(p.pid) ?? [];
      if (ids.length > 0) out.push({ pid: p.pid, ids });
    }
  }
  return out;
}

function accountFor(pid: number, accounts: Account[]): string | null {
  const env = environOf(pid);
  if (!env) return null;
  const devinAccounts = accounts.filter((a) => a.provider === "devin");
  const key = env.get("WINDSURF_API_KEY");
  if (!key) return devinAccounts.find((a) => a.isDefault)?.id ?? null;
  // A key that matches no account we know is someone else's login; saying
  // "default" would pin its usage to the wrong account.
  return devinAccounts.find((a) => windsurfKeyOf(a.home) === key)?.id ?? null;
}

// ----------------------------------------------------------- reader

function stat(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

/** Newest log of a pid: `devin_<YYYYMMDD-HHMMSS>_<pid>.log` (rotated ones
 *  are gzipped and skipped). */
function logOfPid(logsDir: string, pid: number): string | null {
  try {
    const hits = readdirSync(logsDir)
      .filter((n) => n.endsWith(`_${pid}.log`))
      .sort();
    return hits.length > 0 ? join(logsDir, hits[hits.length - 1]!) : null;
  } catch {
    return null;
  }
}

class DevinReader implements TranscriptReader {
  private atif: AtifParse | null = null;
  private jsonSig = "";
  private row: db.DevinSessionRow | null = null;
  private prompts: db.DevinPrompt[] = [];
  private promptSig = "";
  private events: TimelineEvent[] = [];
  private hits: { at: number; detail: string }[] = [];
  private hitKeys = new Set<string>();
  private log: { pid: number; path: string | null; offset: number; lookedAt: number } | null = null;
  private dirty = true;

  constructor(
    readonly ref: TranscriptRef,
    private readonly paths: DevinPaths,
  ) {}

  private get id(): string {
    return this.ref.agentSessionId;
  }

  private pull(): boolean {
    let changed = false;

    const jsonPath = join(this.paths.transcripts, `${this.id}.json`);
    const st = stat(jsonPath);
    const sig = st ? `${st.mtimeMs}:${st.size}` : "";
    if (sig !== this.jsonSig) {
      if (!st) {
        this.atif = null;
        this.jsonSig = "";
        changed = true;
      } else {
        try {
          this.atif = parseAtif(JSON.parse(readFileSync(jsonPath, "utf8")));
          this.jsonSig = sig;
          changed = true;
        } catch {
          // Caught mid-rewrite; the next poll sees the finished file.
        }
      }
    }

    const row = db.sessionById(this.paths.db, this.id);
    if (row && JSON.stringify(row) !== JSON.stringify(this.row)) {
      this.row = row;
      changed = true;
    }

    const head = db.promptHead(this.paths.db, this.id);
    const psig = head ? `${head.maxId}:${head.count}` : this.promptSig;
    if (psig !== this.promptSig) {
      const prompts = db.promptsOf(this.paths.db, this.id);
      if (prompts) {
        this.prompts = prompts;
        this.promptSig = psig;
        changed = true;
      }
    }

    if (this.pullRateLimits()) changed = true;

    if (changed) {
      this.events = [
        ...(this.atif?.events ?? []),
        ...pendingPromptEvents(this.prompts, this.atif ? this.atif.lastStepAt : null),
      ];
      this.dirty = true;
    }
    return changed;
  }

  /** Follow the log of whichever process last held this session's lock. */
  private pullRateLimits(): boolean {
    let pid: number;
    try {
      pid = Number(readFileSync(join(this.paths.locks, `${this.id}.lock`), "utf8").trim());
    } catch {
      return false;
    }
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const now = Date.now();
    if (!this.log || this.log.pid !== pid) {
      this.log = { pid, path: logOfPid(this.paths.logs, pid), offset: 0, lookedAt: now };
    } else if (this.log.path === null && now - this.log.lookedAt > 30_000) {
      // Not written yet, or already rotated to .gz; look again now and then
      // rather than listing the logs directory on every poll.
      this.log = { pid, path: logOfPid(this.paths.logs, pid), offset: 0, lookedAt: now };
    }
    const path = this.log.path;
    if (!path) return false;
    const st = stat(path);
    if (!st || st.size <= this.log.offset) {
      if (st && st.size < this.log.offset) this.log.offset = 0;
      return false;
    }
    let text = "";
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(st.size - this.log.offset);
      const n = readSync(fd, buf, 0, buf.length, this.log.offset);
      const nl = buf.subarray(0, n).lastIndexOf(0x0a);
      if (nl < 0) return false;
      text = buf.subarray(0, nl + 1).toString("utf8");
      this.log.offset += nl + 1;
    } catch {
      return false;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    let added = false;
    for (const h of parseDevinRateLimits(text)) {
      const key = `${Math.floor(h.at / 1000)}|${h.detail}`;
      if (this.hitKeys.has(key)) continue;
      this.hitKeys.add(key);
      this.hits.push(h);
      added = true;
    }
    return added;
  }

  private facts(): TranscriptFacts {
    return devinFacts({ id: this.id, row: this.row, prompts: this.prompts, atif: this.atif, rateLimitHits: [...this.hits] });
  }

  async refresh(): Promise<{ changed: boolean; facts: TranscriptFacts }> {
    this.pull();
    const changed = this.dirty;
    this.dirty = false;
    return { changed, facts: this.facts() };
  }

  private cursor(): string {
    return this.events.length > 0 ? this.events[this.events.length - 1]!.id : "";
  }

  private page(before: string | null, limit: number): TimelinePage {
    let end = this.events.length;
    if (before) {
      const k = this.events.findIndex((e) => e.id === before);
      if (k >= 0) end = k;
    }
    const start = Math.max(0, end - limit);
    const events = this.events.slice(start, end);
    return { events, before: start > 0 && events.length > 0 ? events[0]!.id : null, cursor: this.cursor() };
  }

  async timeline(opts: { before?: string | null; limit: number }): Promise<TimelinePage> {
    this.pull();
    return this.page(opts.before ?? null, opts.limit);
  }

  /** The export is rewritten whole each turn, so the cursor is an event id
   *  rather than an offset; one that no longer exists (a pending prompt the
   *  export has since replaced) is a reset. */
  async since(cursor: string): Promise<{ events: TimelineEvent[]; cursor: string; reset: boolean }> {
    this.pull();
    if (cursor === "") return { events: [...this.events], cursor: this.cursor(), reset: false };
    const k = this.events.findIndex((e) => e.id === cursor);
    if (k < 0) {
      const page = this.page(null, DEFAULT_PAGE);
      return { events: page.events, cursor: page.cursor, reset: true };
    }
    return { events: this.events.slice(k + 1), cursor: this.cursor(), reset: false };
  }
}

// ----------------------------------------------------------- adapter

async function versionOf(argv: string[]): Promise<{ installed: boolean; version: string | null }> {
  try {
    const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { installed: true, version: code === 0 ? (/(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null) : null };
  } catch {
    return { installed: false, version: null };
  }
}

function flags(opts: { model?: string; autoApprove: boolean }): string[] {
  const a: string[] = [];
  if (opts.model) a.push("--model", opts.model);
  // devin's own name for "approve every tool"; its sessions record it as
  // agent_mode "bypass".
  if (opts.autoApprove) a.push("--permission-mode", "dangerous");
  return a;
}

/** devin takes the initial prompt after `--`. */
const withPrompt = (argv: string[], prompt?: string) => (prompt ? [...argv, "--", prompt] : argv);

export interface DevinAdapterOptions {
  /** The default XDG data dir; read on every call so tests can point it at a
   *  fixture. Defaults to `$XDG_DATA_HOME` or ~/.local/share. */
  dataHome?: () => string;
}

export function createDevinAdapter(options: DevinAdapterOptions = {}): ProviderAdapter {
  const dataHome = options.dataHome ?? defaultDataHome;
  const paths = () => pathsUnder(dataHome());

  /** The last good listing, served while the database is busy. */
  let lastRows: db.DevinSessionRow[] = [];

  function refOf(account: Account, row: db.DevinSessionRow | null, id: string, promptSec?: number): TranscriptRef | null {
    const p = paths();
    const json = join(p.transcripts, `${id}.json`);
    const js = stat(json);
    if (!row && !js) return null;
    const mtimeMs = Math.max(js?.mtimeMs ?? 0, (row?.last_activity_at ?? 0) * 1000, (promptSec ?? 0) * 1000);
    return {
      provider: "devin",
      accountId: account.id,
      agentSessionId: id,
      path: js ? json : p.db,
      mtimeMs,
      size: js?.size ?? 0,
    };
  }

  function accountCommand(account: Account): Pick<Command, "env" | "unset"> {
    if (account.isDefault) return { env: {}, unset: ["WINDSURF_API_KEY"] };
    const key = windsurfKeyOf(account.home);
    // Launching without the key would silently run on the default login.
    if (!key) throw new Error(`devin account "${account.label}" has no credentials under ${account.home}; log in again`);
    return { env: { WINDSURF_API_KEY: key } };
  }

  /** Logins and `auth status` see the home itself: its data dir, and its own
   *  config dir (resyncShared links the user's config.json into it). */
  function authEnv(account: Pick<Account, "home" | "isDefault">): Pick<Command, "env" | "unset"> {
    return account.isDefault
      ? { env: {}, unset: ["XDG_DATA_HOME", "XDG_CONFIG_HOME"] }
      : { env: { XDG_DATA_HOME: account.home, XDG_CONFIG_HOME: join(account.home, "config") }, unset: [] };
  }

  return {
    id: "devin",
    label: "Devin",

    detect: () => versionOf(["devin", "--version"]),

    defaultHome: () => dataHome(),

    accountCommand,

    authEnv,

    async listTranscripts(account, sinceMs) {
      // devin cannot say which account ran a session; see the file header.
      if (!account.isDefault) return [];
      const p = paths();
      const sinceSec = Math.floor(sinceMs / 1000);
      const rows = db.sessionsSince(p.db, sinceSec);
      if (rows) lastRows = rows;
      const byId = new Map((rows ?? lastRows.filter((r) => r.last_activity_at >= sinceSec)).map((r) => [r.id, r]));
      const prompts = db.promptTimesSince(p.db, sinceSec) ?? new Map<string, number>();
      for (const id of prompts.keys()) {
        if (!byId.has(id)) {
          const row = db.sessionById(p.db, id);
          if (row) byId.set(id, row);
        }
      }
      const out: TranscriptRef[] = [];
      for (const [id, row] of byId) {
        const ref = refOf(account, row, id, prompts.get(id));
        if (ref && ref.mtimeMs >= sinceMs) out.push(ref);
      }
      return out;
    },

    async liveProcesses(accounts) {
      const procs = findProcesses((argv) => runsCli(argv, "devin"));
      if (procs.length === 0) return [];
      const held = heldLocks(
        paths().locks,
        procs.map((p) => p.pid),
        startedAtOf,
      );
      const out: LiveProcess[] = [];
      for (const { pid, ids } of devinSessionProcs(procs, held)) {
        const cwd = cwdOf(pid);
        const startedAt = startedAtOf(pid);
        if (cwd === null || startedAt === null) continue;
        const accountId = accountFor(pid, accounts);
        for (const agentSessionId of ids.length > 0 ? ids : [null]) {
          out.push({ pid, accountId, agentSessionId, cwd, startedAt });
        }
      }
      return out;
    },

    async findTranscript(account, agentSessionId) {
      return refOf(account, db.sessionById(paths().db, agentSessionId), agentSessionId);
    },

    reader(ref) {
      return new DevinReader(ref, paths());
    },

    spawnCommand(opts: SpawnOptions) {
      return { argv: withPrompt(["devin", ...flags(opts)], opts.prompt), ...accountCommand(opts.account), agentSessionId: null };
    },

    resumeCommand(opts: ResumeOptions): Command {
      return {
        argv: withPrompt(["devin", "-r", opts.agentSessionId, ...flags(opts)], opts.prompt),
        ...accountCommand(opts.account),
      };
    },

    autoAnswer(screen) {
      // The folder-trust dialog lists "Yes, trust …" first and "No, exit"
      // second; Enter takes the highlighted first choice.
      if (/Do you trust the authors of/.test(screen) && /Yes, trust/.test(screen)) return ["Enter"];
      return null;
    },

    blockedOn(screen) {
      if (/Do you trust the authors of/.test(screen)) return "folder trust";
      if (/Allow network access to/.test(screen)) return "network access";
      if (/Yes, allow once|Yes, always allow|No, deny/.test(screen)) return "permission";
      if (/Yes, implement plan/.test(screen)) return "plan approval";
      if (/Not logged in/.test(screen)) return "login";
      if (/Quota exhausted|Usage limit reached/.test(screen)) return "usage limit";
      return null;
    },
  };
}

export const devinAdapter: ProviderAdapter = createDevinAdapter();
