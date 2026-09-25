/** The omp (oh-my-pi) adapter.
 *
 * omp balances its own credential pool across every provider account it is
 * logged into, so agentbox treats it as ONE implicit account whose home is
 * `~/.omp`. Everything here is read from omp's own files:
 *
 *   <home>/agent/sessions/<slug(cwd)>/<ISO>_<uuidv7>.jsonl   one session
 *   <home>/agent/sessions/<slug>/<ISO>_<uuidv7>/…            its subagents
 *       (`<Name>.jsonl`, `<Name>.md`, and `<Parent>/<Parent>.<Child>.jsonl`
 *       for nested ones, plus numbered tool-output logs we ignore)
 *
 * Liveness: omp opens a session's JSONL once and keeps the fd for the life of
 * the session (`FileSessionStorageWriter`), so a live omp's /proc/<pid>/fd is
 * the proof of which session it is running. omp writes no pid or lock file.
 * A brand-new session is lazy — no file until the first assistant output — and
 * those processes are reported with no session until the file appears.
 */

import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { userHome } from "../paths";
import { cliVersion } from "./cli-version";
import type { Account, TimelineEvent, TimelinePage } from "../types";
import { JsonlTail } from "./jsonl";
import {
  foldOmpRecord,
  newOmpState,
  ompEvents,
  ompSlug,
  sessionIdFromFileName,
  startFromFileName,
  titleFromSlot,
  toolOutcomeOf,
  type OmpState,
  type ToolOutcome,
} from "./omp-transcript";
import { ompRedirectVars } from "./omp-usage";
import { argvOf, cwdOf, environOf, findProcesses, openFilesOf, runsCli, startedAtOf } from "./procs";
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

export { ompUsage, parseOmpUsage } from "./omp-usage";

const TITLE_SLOT_BYTES = 256;
const DEFAULT_PAGE = 50;

/** omp's agent dir for an account. `PI_CODING_AGENT_DIR` in the server's own
 *  environment relocates the default one, exactly as it would for omp. */
export function agentDirOf(account: Pick<Account, "home" | "isDefault">): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (account.isDefault && override) return override;
  return join(account.home, "agent");
}

export function sessionsRootOf(account: Pick<Account, "home" | "isDefault">): string {
  return join(agentDirOf(account), "sessions");
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The slug directory omp would use for `cwd`. */
export function slugDirFor(root: string, cwd: string): string {
  return join(root, ompSlug(canonical(cwd), canonical(homedir()), canonical(tmpdir())));
}

// ------------------------------------------------------------ discovery

interface DirListing {
  mtimeMs: number;
  files: string[];
}

/** readdir results per slug dir, reused until the dir's mtime moves. Files
 *  are only ever added or removed there, which is what bumps a dir mtime;
 *  appends to a session do not, so every poll still stats the files. */
const listings = new Map<string, DirListing>();

function sessionFilesIn(dir: string): string[] {
  let st;
  try {
    st = statSync(dir);
  } catch {
    listings.delete(dir);
    return [];
  }
  if (!st.isDirectory()) return [];
  const cached = listings.get(dir);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.files;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((n) => n.endsWith(".jsonl") && sessionIdFromFileName(n) !== null);
  } catch {
    /* raced a delete */
  }
  listings.set(dir, { mtimeMs: st.mtimeMs, files });
  return files;
}

function slugDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
}

function refFor(account: Account, path: string): TranscriptRef | null {
  const id = sessionIdFromFileName(basename(path));
  if (!id) return null;
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { provider: "omp", accountId: account.id, agentSessionId: id, path, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** A session file (not a subagent log) by id, searching `cwd`'s slug first. */
function findSessionFile(root: string, id: string, cwd?: string): string | null {
  const suffix = `_${id}.jsonl`;
  const look = (dir: string) => {
    const hit = sessionFilesIn(dir).find((n) => n.endsWith(suffix));
    return hit ? join(dir, hit) : null;
  };
  if (cwd) {
    const direct = look(slugDirFor(root, cwd));
    if (direct) return direct;
  }
  for (const d of slugDirs(root)) {
    const hit = look(d);
    if (hit) return hit;
  }
  return null;
}

// ------------------------------------------------------------ processes

/** Subcommands that are not an agent session. `acp` and `join` are. */
const NON_SESSION_COMMANDS = new Set([
  "agents", "auth-broker", "auth-gateway", "bench", "browser-relay", "cleanse", "commit", "completions",
  "config", "dry-balance", "gallery", "gc", "grep", "grievances", "install", "models", "plugin", "read",
  "say", "search", "setup", "share", "shell", "ssh", "stats", "tiny-models", "token", "ttsr", "update",
  "usage", "worktree", "help",
]);

/** Where omp's own arguments start in argv, or -1 if this is not omp. The
 *  global install is a bun script, so it shows up as `bun …/bin/omp` — or as
 *  `bun …/pi-coding-agent/dist/cli.js` when launched by path. */
export function ompArgStart(argv: string[]): number {
  if (argv.length === 0) return -1;
  const a0 = basename(argv[0]!);
  if (a0 === "omp") return 1;
  if ((a0 === "bun" || a0.startsWith("node")) && argv[1]) {
    if (runsCli(argv, "omp") || /pi-coding-agent[/\\]dist[/\\]cli\.js$/.test(argv[1])) return 2;
  }
  return -1;
}

/** True when argv is an omp that hosts an agent session. */
export function isOmpSessionArgv(argv: string[]): boolean {
  const k = ompArgStart(argv);
  if (k < 0) return false;
  const first = argv[k];
  if (first === undefined) return true;
  // Internal workers (`__tiny-worker`) and the one-shot subcommands.
  if (first.startsWith("_") || NON_SESSION_COMMANDS.has(first)) return false;
  if (argv.slice(k).some((a) => a === "--profile" || a.startsWith("--profile="))) return false;
  return true;
}

/** `-r <id>` / `--resume <id>` / `--resume=<id>` from omp's argv. */
export function resumeArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if ((a === "-r" || a === "--resume") && argv[i + 1] && !argv[i + 1]!.startsWith("-")) return argv[i + 1]!;
    if (a.startsWith("--resume=")) return a.slice("--resume=".length);
  }
  return null;
}

interface OmpProc {
  pid: number;
  ppid: number;
  argv: string[];
  cwd: string;
  startedAt: number;
}

/**
 * Attribute live omp processes to sessions, most certain first, and never
 * give one session to two processes:
 *  1. an open fd on a top-level session file (omp keeps its writer open);
 *  2. `-r <id|path>` in argv;
 *  3. the newest session file in the cwd's slug dir created after the
 *     process started and not already claimed.
 */
export function attributeOmp(
  procs: OmpProc[],
  root: string,
  openFiles: (pid: number) => string[],
): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const claimed = new Set<string>();
  const rootPrefix = root.endsWith(sep) ? root : root + sep;

  // 1. Open files. Only `<root>/<slug>/<file>.jsonl`; subagent logs are one
  //    level deeper and belong to the same process's parent session.
  for (const p of procs) {
    let best: { id: string; mtime: number } | null = null;
    for (const f of openFiles(p.pid)) {
      if (!f.startsWith(rootPrefix) || !f.endsWith(".jsonl")) continue;
      const rest = f.slice(rootPrefix.length).split(sep);
      if (rest.length !== 2) continue;
      const id = sessionIdFromFileName(rest[1]!);
      if (!id || claimed.has(id)) continue;
      let mtime = 0;
      try {
        mtime = statSync(f).mtimeMs;
      } catch {
        /* closing */
      }
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    if (best) {
      out.set(p.pid, best.id);
      claimed.add(best.id);
    }
  }

  // 2. The session named on the command line.
  for (const p of procs) {
    if (out.has(p.pid)) continue;
    const arg = resumeArg(p.argv);
    if (!arg) continue;
    let id: string | null = null;
    if (arg.includes("/") || arg.endsWith(".jsonl")) {
      id = sessionIdFromFileName(basename(arg));
    } else {
      // omp accepts an id prefix; resolve it against what exists.
      const dir = slugDirFor(root, p.cwd);
      const hits = sessionFilesIn(dir).filter((n) => n.includes(`_${arg}`));
      if (hits.length === 1) id = sessionIdFromFileName(hits[0]!);
    }
    if (id && !claimed.has(id)) {
      out.set(p.pid, id);
      claimed.add(id);
    }
  }

  // 3. A file born after the process started, in its cwd.
  for (const p of procs) {
    if (out.has(p.pid)) continue;
    const dir = slugDirFor(root, p.cwd);
    let best: { id: string; mtime: number } | null = null;
    for (const n of sessionFilesIn(dir)) {
      const id = sessionIdFromFileName(n);
      const born = startFromFileName(n);
      if (!id || born === null || claimed.has(id) || born < p.startedAt - 2000) continue;
      let mtime = 0;
      try {
        mtime = statSync(join(dir, n)).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtime > best.mtime) best = { id, mtime };
    }
    out.set(p.pid, best?.id ?? null);
    if (best) claimed.add(best.id);
  }
  return out;
}

// ------------------------------------------------------------ reader

function readHead(path: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : "";
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** omp's per-tool output captures (`12.bash.log`) and scratch dirs are not
 *  agent logs; subagent logs are named after the agent. */
function isAgentLog(name: string): boolean {
  return name.endsWith(".jsonl") && !/^\d/.test(name);
}

function agentLogsUnder(dir: string, depth = 0): string[] {
  if (depth > 4) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "local") out.push(...agentLogsUnder(p, depth + 1));
    } else if (isAgentLog(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** The parent session id when `path` lies inside a session's subagent dir. */
export function parentFromPath(path: string): string | null {
  const parts = path.split(sep);
  for (let i = parts.length - 2; i >= 0; i--) {
    const m = /^\d{4}-\d\d-\d\dT[\d-]+Z_([0-9a-f-]{8,})$/i.exec(parts[i]!);
    if (m) return m[1]!;
  }
  return null;
}

class OmpReader implements TranscriptReader {
  private tail: JsonlTail;
  private state: OmpState = newOmpState();
  /** Bumped when the file is replaced, so old cursors are recognisably stale. */
  private gen = 0;
  private dirty = true;
  private slotTitle: string | null = null;
  private slotMtime = -1;
  private readonly parentId: string | null;
  /** Subagent logs, folded for tokens and rate-limit hits only. */
  private subs = new Map<string, { tail: JsonlTail; state: OmpState }>();
  private subDirMtime = -1;

  constructor(readonly ref: TranscriptRef) {
    this.tail = new JsonlTail(ref.path);
    this.parentId = parentFromPath(ref.path);
  }

  /** Read whatever is new. Returns true if anything changed. */
  private pull(): boolean {
    let changed = false;
    const { records, reset } = this.tail.read();
    if (reset) {
      this.gen++;
      this.state = newOmpState();
      changed = true;
    }
    for (const r of records) foldOmpRecord(this.state, r.value, r.index);
    if (records.length > 0) changed = true;

    // Line 0 is rewritten in place when the title changes, which the tail
    // (append-only by design) never re-reads.
    try {
      const st = statSync(this.ref.path);
      if (st.mtimeMs !== this.slotMtime) {
        this.slotMtime = st.mtimeMs;
        const t = titleFromSlot(readHead(this.ref.path, TITLE_SLOT_BYTES));
        if (t !== this.slotTitle) {
          this.slotTitle = t;
          changed = true;
        }
      }
    } catch {
      /* gone */
    }

    if (this.parentId === null && this.pullSubagents()) changed = true;
    if (changed) this.dirty = true;
    return changed;
  }

  private pullSubagents(): boolean {
    const dir = this.ref.path.slice(0, -".jsonl".length);
    let st;
    try {
      st = statSync(dir);
    } catch {
      return false;
    }
    if (st.mtimeMs !== this.subDirMtime) {
      this.subDirMtime = st.mtimeMs;
      for (const p of agentLogsUnder(dir)) {
        if (!this.subs.has(p)) this.subs.set(p, { tail: new JsonlTail(p), state: newOmpState() });
      }
    }
    let changed = false;
    for (const sub of this.subs.values()) {
      const { records, reset } = sub.tail.read();
      if (reset) sub.state = newOmpState();
      for (const r of records) foldOmpRecord(sub.state, r.value, r.index, { events: false });
      if (records.length > 0 || reset) changed = true;
    }
    return changed;
  }

  private facts(): TranscriptFacts {
    const s = this.state;
    const tokens = { ...s.tokens };
    const hits = [...s.rateLimitHits];
    for (const sub of this.subs.values()) {
      tokens.input += sub.state.tokens.input;
      tokens.output += sub.state.tokens.output;
      tokens.cacheRead += sub.state.tokens.cacheRead;
      tokens.cacheWrite += sub.state.tokens.cacheWrite;
      tokens.costEquiv += sub.state.tokens.costEquiv;
      hits.push(...sub.state.rateLimitHits);
    }
    hits.sort((a, b) => a.at - b.at);
    const cwd = s.header?.cwd ?? null;
    return {
      agentSessionId: s.header?.id ?? this.ref.agentSessionId,
      cwd,
      // `omp -r <id>` finds a session from any cwd, but moves it (after asking)
      // when run from another project; the header's cwd is where it lives.
      resumeCwd: this.parentId === null ? cwd : null,
      title: this.slotTitle ?? s.titleChange ?? s.header?.title ?? null,
      firstPrompt: s.firstPrompt,
      lastPrompt: s.lastPrompt,
      lastPromptAt: s.lastPromptAt,
      lastMessage: s.lastMessage,
      model: s.model,
      gitBranch: null,
      startedAt: s.header?.startedAt ?? startFromFileName(basename(this.ref.path)),
      lastActivityAt: s.lastActivityAt,
      turnOpen: s.turnOpen,
      contextUsed: s.contextUsed,
      contextLimit: null,
      tokens,
      usage: null,
      rateLimitHits: hits,
      isSubagent: this.parentId !== null || s.sessionInit,
      parentId: this.parentId,
    };
  }

  async refresh(): Promise<{ changed: boolean; facts: TranscriptFacts }> {
    this.pull();
    const changed = this.dirty;
    this.dirty = false;
    return { changed, facts: this.facts() };
  }

  /** Events for a set of record indices, with tool results merged in. */
  private materialize(recs: number[]): TimelineEvent[] {
    if (recs.length === 0) return [];
    const want = new Set(recs);
    const lo = recs[0]!;
    const hi = recs[recs.length - 1]!;
    const records = this.tail.range(lo, hi + 1).filter((r) => want.has(r.index));

    const outcomes = new Map<string, ToolOutcome | null>();
    const need: number[] = [];
    for (const r of records) {
      const m = r.value?.message;
      if (r.value?.type !== "message" || m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type !== "toolCall" || typeof b.id !== "string") continue;
        const at = this.state.results.get(b.id);
        if (at !== undefined) need.push(at);
      }
    }
    for (const i of need) {
      const [res] = this.tail.range(i, i + 1);
      const o = toolOutcomeOf(res?.value);
      const id = res?.value?.message?.toolCallId;
      if (typeof id === "string") outcomes.set(id, o);
    }
    return records.flatMap((r) => ompEvents(r.value, r.index, (id) => outcomes.get(id)));
  }

  private cursor(): string {
    return `${this.gen}:${this.tail.recordCount}`;
  }

  async timeline(opts: { before?: string | null; limit: number }): Promise<TimelinePage> {
    this.pull();
    return this.page(opts.before ?? null, opts.limit);
  }

  private page(before: string | null, limit: number): TimelinePage {
    const anchors = this.state.anchors;
    let p = anchors.length;
    let collected: TimelineEvent[] = [];
    if (before) {
      const rec = Number(before.split(".")[0]);
      const pos = lowerBound(anchors, rec);
      if (Number.isFinite(rec) && anchors[pos] === rec) {
        const evs = this.materialize([rec]);
        const k = evs.findIndex((e) => e.id === before);
        collected = k >= 0 ? evs.slice(0, k) : [];
        p = pos;
      }
    }
    while (collected.length < limit && p > 0) {
      const from = Math.max(0, p - 64);
      collected = this.materialize(anchors.slice(from, p)).concat(collected);
      p = from;
    }
    const events = collected.slice(-limit);
    const more = collected.length > events.length || p > 0;
    return { events, before: more && events.length > 0 ? events[0]!.id : null, cursor: this.cursor() };
  }

  async since(cursor: string): Promise<{ events: TimelineEvent[]; cursor: string; reset: boolean }> {
    this.pull();
    const m = /^(\d+):(\d+)$/.exec(cursor);
    const n = m ? Number(m[2]) : NaN;
    if (!m || Number(m[1]) !== this.gen || n > this.tail.recordCount) {
      const page = this.page(null, DEFAULT_PAGE);
      return { events: page.events, cursor: page.cursor, reset: true };
    }
    const anchors = this.state.anchors;
    const fresh = this.materialize(anchors.slice(lowerBound(anchors, n)));

    // Results that arrived after the cursor for calls made before it: re-send
    // the call's event, now finished, under the same id.
    const log = this.state.resultLog;
    const late = new Map<number, Set<string>>();
    for (let i = lowerBound(log, n, (x) => x.rec); i < log.length; i++) {
      const call = this.state.calls.get(log[i]!.callId);
      if (call === undefined || call >= n) continue;
      if (!late.has(call)) late.set(call, new Set());
      late.get(call)!.add(log[i]!.callId);
    }
    const resent: TimelineEvent[] = [];
    for (const rec of [...late.keys()].sort((a, b) => a - b)) {
      const ids = late.get(rec)!;
      const [raw] = this.tail.range(rec, rec + 1);
      const blocks: any[] = raw?.value?.message?.content ?? [];
      const wanted = new Set(blocks.flatMap((b, j) => (b?.type === "toolCall" && ids.has(b.id) ? [`${rec}.${j}`] : [])));
      resent.push(...this.materialize([rec]).filter((e) => wanted.has(e.id)));
    }
    return { events: [...resent, ...fresh], cursor: this.cursor(), reset: false };
  }
}

function lowerBound<T = number>(a: T[], x: number, key: (v: T) => number = (v) => v as unknown as number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(a[mid]!) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ------------------------------------------------------------ adapter

function withPrompt(argv: string[], prompt?: string): string[] {
  // `--` so a prompt starting with `-` is not read as a flag. omp still
  // treats a leading `@` as a file to attach, which is its documented syntax.
  return prompt ? [...argv, "--", prompt] : argv;
}

function commonFlags(opts: { cwd: string; model?: string; effort?: string; autoApprove: boolean }): string[] {
  const a: string[] = [];
  if (opts.model) a.push("--model", opts.model);
  if (opts.effort) a.push(`--thinking=${opts.effort}`);
  if (opts.autoApprove) a.push("--auto-approve");
  // omp silently moves a session started in ~ to a temp dir unless told not to.
  if (canonical(opts.cwd) === canonical(homedir())) a.push("--allow-home");
  return a;
}

/** One implicit account. What must not leak in from the server's shell is
 *  anything that silently points omp at another data dir: an XDG_*_HOME with
 *  an `omp/` under it, a profile, or a session-dir override. */
function ompAccountCommand(): Pick<Command, "env" | "unset"> {
  return { env: {}, unset: ompRedirectVars() };
}

export const ompAdapter: ProviderAdapter = {
  id: "omp",
  label: "omp",
  efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],

  detect() {
    return cliVersion(["omp", "--version"]);
  },

  defaultHome() {
    return join(userHome(), ".omp");
  },

  accountCommand: ompAccountCommand,
  authEnv: ompAccountCommand,

  async listTranscripts(account, sinceMs) {
    const out: TranscriptRef[] = [];
    for (const dir of slugDirs(sessionsRootOf(account))) {
      for (const name of sessionFilesIn(dir)) {
        const ref = refFor(account, join(dir, name));
        if (ref && ref.mtimeMs >= sinceMs) out.push(ref);
      }
    }
    return out;
  },

  async liveProcesses(accounts) {
    const account = accounts.find((a) => a.provider === "omp" && a.isDefault) ?? accounts.find((a) => a.provider === "omp");
    const matches = findProcesses(isOmpSessionArgv);
    const pids = new Set(matches.map((m) => m.pid));
    const procs: OmpProc[] = [];
    for (const m of matches) {
      // A child omp (a worker it spawned) is part of its parent's session.
      if (pids.has(m.ppid)) continue;
      const env = environOf(m.pid);
      if (env && (env.get("OMP_PROFILE") || env.get("PI_PROFILE"))) continue;
      const cwd = cwdOf(m.pid);
      const startedAt = startedAtOf(m.pid);
      if (cwd === null || startedAt === null) continue;
      procs.push({ pid: m.pid, ppid: m.ppid, argv: argvOf(m.pid) ?? m.argv, cwd, startedAt });
    }
    if (procs.length === 0) return [];
    const root = account ? sessionsRootOf(account) : join(userHome(), ".omp", "agent", "sessions");
    const ids = attributeOmp(procs, root, openFilesOf);
    return procs.map(
      (p): LiveProcess => ({
        pid: p.pid,
        accountId: account?.id ?? null,
        agentSessionId: ids.get(p.pid) ?? null,
        cwd: p.cwd,
        startedAt: p.startedAt,
      }),
    );
  },

  async findTranscript(account, agentSessionId) {
    const path = findSessionFile(sessionsRootOf(account), agentSessionId);
    return path ? refFor(account, path) : null;
  },

  reader(ref) {
    return new OmpReader(ref);
  },

  spawnCommand(opts: SpawnOptions) {
    return {
      argv: withPrompt(["omp", ...commonFlags(opts)], opts.prompt),
      ...ompAccountCommand(),
      agentSessionId: null,
    };
  },

  resumeCommand(opts: ResumeOptions): Command {
    // Resume by path when we can find it: `-r <id>` searches and, from a
    // different project, stops to ask whether to move the session.
    const path = findSessionFile(sessionsRootOf(opts.account), opts.agentSessionId, opts.cwd);
    return {
      argv: withPrompt(["omp", "-r", path ?? opts.agentSessionId, ...commonFlags(opts)], opts.prompt),
      ...ompAccountCommand(),
    };
  },

  blockedOn(screen) {
    const tool = /Allow tool: ([\w:.-]+)/.exec(screen);
    if (tool) return `permission: ${tool[1]}`;
    if (/Approve and execute/.test(screen) && /Refine plan/.test(screen)) return "plan approval";
    if (/No models available/.test(screen)) return "login";
    if (/belongs to a directory that no longer exists|Move session/i.test(screen)) return "move session";
    return null;
  },
};
