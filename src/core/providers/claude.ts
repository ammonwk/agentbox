/** Claude Code.
 *
 * Transcripts: `<home>/projects/<slug(cwd)>/<sessionId>.jsonl`, where home is
 * `CLAUDE_CONFIG_DIR` (default `~/.claude`). Subagents write
 * `<slug>/<sessionId>/subagents/[workflows/<wf>/]agent-*.jsonl`; Claude before
 * 2.1 wrote `<slug>/agent-<hash>.jsonl`. Only uuid-named files are sessions.
 *
 * Live processes: every interactive claude writes `<home>/sessions/<pid>.json`
 * for its life:
 *
 *   { pid, sessionId, cwd, startedAt (ms), procStart ("<start ticks>"),
 *     version, kind: "interactive", entrypoint: "cli", status, updatedAt,
 *     statusUpdatedAt, name, nameSource, waitingFor?, tmux?, … }
 *
 * `status` is "busy" (a turn is running), "idle", "shell" (idle, but a
 * background shell it started is still alive — not work in flight; a PR
 * watcher left running kept sessions "shell" for twenty hours), or "waiting"
 * with `waitingFor` ("dialog open") when a permission prompt is up.
 * `sessionId` follows `/clear`, so it beats the `--session-id` in argv.
 * `procStart` is the kernel's start time of the pid, which is what makes a
 * stale file for a recycled pid detectable.
 */

import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { moveInto } from "./move";
import { randomUUID } from "node:crypto";
import { userHome } from "../paths";
import { cliVersion } from "./cli-version";
import type { Account, TokenTotals } from "../types";
import { emptyTotals } from "../pricing";
import { JsonlTail } from "./jsonl";
import { JsonlTranscriptReader } from "./jsonl-reader";
import { claudeFormat, ClaudeTokenFold } from "./claude-transcript";
import { argvOf, cwdOf, environOf, findProcesses, isAlive, runsCli, startedAtOf } from "./procs";
import { pickOption, plainScreen } from "./tui-screen";
import { askFromScreen, askStep } from "./claude-ask";
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
const UUID_JSONL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;


export function claudeHome(account: Pick<Account, "isDefault" | "home">): string {
  return account.isDefault ? join(userHome(), ".claude") : account.home;
}

/** Paths compared as written in env and on disk: absolute, no trailing slash. */
const norm = (p: string) => resolve(p).replace(/\/+$/, "");

// ------------------------------------------------------------- listing

/**
 * Cheap discovery over thousands of transcripts. A full stat of this machine's
 * ~11K project files takes ~85 ms — too slow for a 2 s poll — and appending
 * to a file does not touch its directory's mtime, so a directory cache alone
 * cannot see a resumed session either. So: directory listings are cached by
 * directory mtime; files known to be recent are stat'd every call; the cold
 * rest a rotating slice at a time, so a week-old session that is resumed
 * shows up within ~COLD_SLICES polls (and at once through its live process,
 * which the fleet looks up with `findTranscript`).
 */
const COLD_SLICES = 16;
const HOT_MS = 60 * 60_000;

interface DirEntry {
  mtimeMs: number;
  files: string[];
}

class ProjectsIndex {
  private rootMtime = -1;
  private dirs = new Map<string, DirEntry>();
  private stats = new Map<string, { mtimeMs: number; size: number }>();
  private coldTurn = 0;

  constructor(readonly root: string) {}

  private listDir(dir: string, prev: DirEntry | undefined, mtimeMs: number): DirEntry {
    if (prev && prev.mtimeMs === mtimeMs) return prev;
    let names: string[] = [];
    try {
      names = readdirSync(join(this.root, dir));
    } catch {
      /* vanished */
    }
    const files = names.filter((n) => UUID_JSONL.test(n));
    if (prev) {
      const keep = new Set(files);
      for (const f of prev.files) if (!keep.has(f)) this.stats.delete(join(this.root, dir, f));
    }
    return { mtimeMs, files };
  }

  private refreshDirs(): void {
    let st;
    try {
      st = statSync(this.root);
    } catch {
      this.dirs.clear();
      this.stats.clear();
      return;
    }
    if (st.mtimeMs !== this.rootMtime) {
      this.rootMtime = st.mtimeMs;
      let names: string[] = [];
      try {
        names = readdirSync(this.root);
      } catch {
        /* unreadable */
      }
      const keep = new Set(names);
      for (const d of [...this.dirs.keys()]) if (!keep.has(d)) this.dirs.delete(d);
      for (const n of names) if (!this.dirs.has(n)) this.dirs.set(n, { mtimeMs: -1, files: [] });
    }
    for (const [d, prev] of this.dirs) {
      let m: number;
      try {
        const s = statSync(join(this.root, d));
        if (!s.isDirectory()) {
          this.dirs.delete(d);
          continue;
        }
        m = s.mtimeMs;
      } catch {
        this.dirs.delete(d);
        continue;
      }
      this.dirs.set(d, this.listDir(d, prev.mtimeMs === -1 ? undefined : prev, m));
    }
  }

  scan(sinceMs: number, now: number): { path: string; id: string; mtimeMs: number; size: number }[] {
    this.refreshDirs();
    const hotSince = Math.min(sinceMs, now - HOT_MS);
    const turn = this.coldTurn++ % COLD_SLICES;
    const out: { path: string; id: string; mtimeMs: number; size: number }[] = [];
    let k = 0;
    for (const [d, e] of this.dirs) {
      for (const f of e.files) {
        const path = join(this.root, d, f);
        const known = this.stats.get(path);
        const due = !known || known.mtimeMs >= hotSince || k++ % COLD_SLICES === turn;
        let cur = known;
        if (due) {
          try {
            const s = statSync(path);
            cur = { mtimeMs: s.mtimeMs, size: s.size };
            this.stats.set(path, cur);
          } catch {
            this.stats.delete(path);
            continue;
          }
        }
        if (cur && cur.mtimeMs >= sinceMs) out.push({ path, id: f.slice(0, -6), ...cur });
      }
    }
    return out;
  }

  /** A known file for a session id, from the cached listing only. */
  lookup(id: string): string | null {
    const name = `${id}.jsonl`;
    for (const [d, e] of this.dirs) if (e.files.includes(name)) return join(this.root, d, name);
    return null;
  }
}

const indexes = new Map<string, ProjectsIndex>();
function indexFor(home: string): ProjectsIndex {
  const root = join(home, "projects");
  let ix = indexes.get(root);
  if (!ix) indexes.set(root, (ix = new ProjectsIndex(root)));
  return ix;
}

// ------------------------------------------------------------- subagent tokens

/**
 * Tokens spent by a session's subagents, which Claude writes to their own
 * files under `<sessionId>/subagents/`. They are the session's spend — a turn
 * that fans out to five agents costs six agents' tokens — so the reader folds
 * them in. Finished subagent files never change again, so only recently
 * written ones are re-stat'd on each refresh, with a full re-check now and
 * then for one that was resumed.
 */
const SUB_HOT_MS = 10 * 60_000;
const SUB_FULL_MS = 60_000;

export class SubagentTokens {
  private files = new Map<string, { tail: JsonlTail; fold: ClaudeTokenFold; mtimeMs: number; size: number }>();
  private dirMtimes = new Map<string, number>();
  private lastFull = 0;
  private cached: TokenTotals | null = null;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  totals(): TokenTotals | null {
    return this.cached;
  }

  /** Paths of subagent transcripts: `subagents/agent-*.jsonl` and
   *  `subagents/workflows/<wf>/agent-*.jsonl`. */
  private list(): string[] | null {
    const out: string[] = [];
    let changed = false;
    const walk = (d: string, depth: number) => {
      let st;
      try {
        st = statSync(d);
      } catch {
        return;
      }
      if (this.dirMtimes.get(d) !== st.mtimeMs) changed = true;
      this.dirMtimes.set(d, st.mtimeMs);
      let ents;
      try {
        ents = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl")) out.push(join(d, e.name));
        else if (e.isDirectory() && depth < 2 && (depth === 1 || e.name === "workflows")) walk(join(d, e.name), depth + 1);
      }
    };
    walk(this.dir, 0);
    return changed || this.files.size === 0 ? out : null;
  }

  refresh(): boolean {
    let rootMtime: number;
    try {
      rootMtime = statSync(this.dir).mtimeMs;
    } catch {
      return false;
    }
    const now = this.now();
    // A new subagent file changes the directory; a new workflow agent only
    // its own directory, which the periodic full pass catches.
    const full = now - this.lastFull >= SUB_FULL_MS || rootMtime !== this.dirMtimes.get(this.dir);
    const listed = full ? this.list() : null;
    if (full) this.lastFull = now;
    const paths = listed ?? [...this.files.keys()];
    let changed = false;
    for (const p of paths) {
      let f = this.files.get(p);
      if (f && !full && now - f.mtimeMs > SUB_HOT_MS) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (f && st.mtimeMs === f.mtimeMs && st.size === f.size) continue;
      if (!f) this.files.set(p, (f = { tail: new JsonlTail(p), fold: new ClaudeTokenFold(), mtimeMs: 0, size: 0 }));
      f.mtimeMs = st.mtimeMs;
      f.size = st.size;
      const fold = f.fold;
      let last = -1;
      f.tail.read((rec) => {
        if (rec.index <= last) fold.reset();
        last = rec.index;
        try {
          fold.add(rec.value);
        } catch {
          /* one odd record */
        }
      });
      changed = true;
    }
    if (changed || (this.cached === null && this.files.size)) {
      const t = emptyTotals();
      for (const f of this.files.values()) {
        t.input += f.fold.totals.input;
        t.output += f.fold.totals.output;
        t.cacheRead += f.fold.totals.cacheRead;
        t.cacheWrite += f.fold.totals.cacheWrite;
        t.costEquiv += f.fold.totals.costEquiv;
      }
      this.cached = t;
    }
    return changed;
  }
}

// ------------------------------------------------------------- processes

function startTicks(pid: number): string | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** True for Claude Code itself. `runsCli` also matches any process that set
 *  its title to "claude" (an SDK host's worker shows as `claude` with an
 *  empty argv), so the executable or script has to say so too. */
function isClaudeCode(pid: number, argv: string[]): boolean {
  let exe = "";
  try {
    exe = readlinkSync(`/proc/${pid}/exe`);
  } catch {
    /* not readable */
  }
  const b = basename(exe);
  if (b === "claude" || b === "claude.exe") return true;
  return argv.some((a) => a.includes("claude-code") || a.includes("@anthropic-ai"));
}

/** The session a claude argv names, when it can be told from argv alone. */
export function sessionIdFromArgv(argv: string[]): string | null {
  const fork = argv.includes("--fork-session");
  let sid: string | null = null;
  let resumed: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const val = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
    if (flag === "--session-id" && val && UUID.test(val)) sid = val;
    else if ((flag === "--resume" || flag === "-r") && val && UUID.test(val)) resumed = val;
  }
  // --fork-session resumes into a new id that argv does not state.
  return sid ?? (fork ? null : resumed);
}

const isHeadless = (argv: string[]) => argv.includes("-p") || argv.includes("--print");

function readSessionFile(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Written in place by a live process; a torn read is retried next poll.
    return null;
  }
}

async function liveProcesses(accounts: Account[]): Promise<LiveProcess[]> {
  const out: LiveProcess[] = [];
  const seen = new Set<number>();
  const mine = accounts.filter((a) => a.provider === "claude");

  for (const account of mine) {
    const dir = join(claudeHome(account), "sessions");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      const rec = readSessionFile(join(dir, n));
      if (!rec) continue;
      const pid = Number(rec.pid ?? n.slice(0, -5));
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      // A file outlives a crashed process, and its pid gets reused.
      if (rec.procStart !== undefined) {
        if (startTicks(pid) !== String(rec.procStart)) continue;
      } else {
        const argv = argvOf(pid);
        if (!isAlive(pid) || !argv || !runsCli(argv, "claude")) continue;
      }
      seen.add(pid);
      const p: LiveProcess = {
        pid,
        accountId: account.id,
        agentSessionId: typeof rec.sessionId === "string" ? rec.sessionId : null,
        cwd: cwdOf(pid) ?? (typeof rec.cwd === "string" ? rec.cwd : ""),
        startedAt: typeof rec.startedAt === "number" ? rec.startedAt : (startedAtOf(pid) ?? 0),
      };
      if (typeof rec.status === "string") p.busy = rec.status === "busy";
      if (rec.status === "waiting") p.waitingOn = typeof rec.waitingFor === "string" ? rec.waitingFor : "waiting for input";
      out.push(p);
    }
  }

  // Claude processes with no session file: an older CLI, or one still
  // starting. Attributed by their own CLAUDE_CONFIG_DIR.
  const byHome = new Map(mine.map((a) => [norm(claudeHome(a)), a]));
  const def = mine.find((a) => a.isDefault) ?? null;
  const procs = findProcesses((argv) => runsCli(argv, "claude"));
  const pids = new Set(procs.map((p) => p.pid));
  for (const p of procs) {
    if (seen.has(p.pid) || pids.has(p.ppid)) continue;
    if (!isClaudeCode(p.pid, p.argv)) continue;
    const sid = sessionIdFromArgv(p.argv);
    // A `claude -p` one-shot is only worth a row when it names its session.
    if (isHeadless(p.argv) && !sid) continue;
    const env = environOf(p.pid);
    let accountId: string | null = null;
    if (env) {
      const dir = env.get("CLAUDE_CONFIG_DIR");
      const account = dir ? byHome.get(norm(dir)) : def;
      if (!account) continue; // a home agentbox does not manage
      accountId = account.id;
    }
    out.push({ pid: p.pid, accountId, agentSessionId: sid, cwd: cwdOf(p.pid) ?? "", startedAt: startedAtOf(p.pid) ?? 0 });
  }
  return out;
}

// ------------------------------------------------------------- screens

/**
 * Start-up dialogs agentbox answers for a session it launched. Each needs
 * several distinctive phrases, so a transcript that merely quotes one cannot
 * trigger it, and each restates a choice already made: the folder is the one
 * you asked for; bypass mode is the autoApprove setting that added the flag.
 * The option is found by the pointer, never assumed (Claude 2.1 focuses
 * "No, exit" in both).
 *
 * The trust dialog when the folder also pre-approves tool permissions is
 * answered only in bypass mode, where pre-approving a tool grants nothing the
 * session does not already have. Every git worktree of a repo raises it, since
 * Claude reads the main checkout's `.claude/settings.local.json` for all of
 * them and each new worktree is a folder it has not been told to trust.
 *
 * Not answered: a folder that adds directories or mints HTTP headers (runs a
 * helper before the session starts) — a new decision even in bypass mode, not
 * the one you made — and the resume-from-summary choice.
 */
export function claudeAutoAnswer(raw: string, ctx: { bypassPermissions: boolean } = { bypassPermissions: false }): string[] | null {
  const s = plainScreen(raw);
  if (/Quick safety check|Accessing workspace/.test(s) && /Yes, I trust this folder/.test(s)) {
    if (/adds \d+ director|mint HTTP headers/.test(s)) return null;
    if (/pre-approves/.test(s) && !ctx.bypassPermissions) return null;
    return pickOption(s, /^Yes, I trust this folder/);
  }
  if (/Bypass Permissions mode/.test(s) && /Yes, I accept/.test(s) && /No, exit/.test(s)) {
    return pickOption(s, /^Yes, I accept/);
  }
  if (/Choose the text style that looks best with your terminal/.test(s)) return ["Enter"];
  return null;
}

/** The question a permission dialog ends on. */
const PERMISSION_QUESTION =
  /Do you want to (?:proceed|make this edit to \S+|create \S+)\?|Do you want to allow (?:Claude to fetch this content|this connection)\?/;

/**
 * The keys that allow the permission prompt on screen, for a session in
 * bypass mode. The dialog must be the live thing at the foot of the screen,
 * not one quoted higher up in the conversation: its question among the last
 * lines, its "Esc to cancel" footer below that, and no input box (whose
 * footer is the mode line) under it. "Yes" is allowing this once; the "don't
 * ask again" options would write rules to the project's settings.
 */
export function claudeApprovePrompt(raw: string): string[] | null {
  if (!claudeBlockedOn(raw)?.startsWith("permission")) return null;
  const lines = plainScreen(raw).trimEnd().split("\n");
  let q = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    if (PERMISSION_QUESTION.test(lines[i]!)) {
      q = i;
      break;
    }
  }
  if (q < 0) return null;
  const tail = lines.slice(q).join("\n");
  if (!/Esc to cancel/.test(tail) || /shift\+tab to cycle|\? for shortcuts/.test(tail)) return null;
  return pickOption(tail, /^Yes$/);
}

/** What a Claude screen is waiting on you for, in a few words. */
export function claudeBlockedOn(raw: string): string | null {
  const s = plainScreen(raw);
  if (/Select login method|Please run \/login|Not logged in/.test(s)) return "login required";
  // The options alone: in a short pane the dialog's heading has scrolled away.
  if (/Yes, I trust this folder/.test(s) && /No, exit/.test(s)) return "folder trust";
  if (/Bypass Permissions mode/.test(s) && /Yes, I accept/.test(s)) return "confirm bypass-permissions mode";
  if (/Resume from summary/.test(s) && /Resume full session/.test(s)) return "resume: summary or full session";
  if (/Yes, I trust these settings/.test(s)) return "trust project settings";
  let m = /Do you want to make this edit to ([^\s?]+)\?/.exec(s);
  if (m) return `permission: edit ${basename(m[1]!)}`;
  m = /Do you want to create ([^\s?]+)\?/.exec(s);
  if (m) return `permission: create ${basename(m[1]!)}`;
  if (/Do you want to allow Claude to fetch this content\?/.test(s)) return "permission: web fetch";
  if (/Do you want to allow this connection\?/.test(s)) return "permission: network connection";
  if (/Would you like to proceed\?/.test(s) && /plan/i.test(s)) return "plan approval";
  if (/Do you want to proceed\?/.test(s)) {
    const title = /(Bash command|Edit file|Create file|Read file|Write file|Tool use|Fetch|MCP tool|Web search)/.exec(s)?.[1];
    return title ? `permission: ${title.toLowerCase()}` : "permission prompt";
  }
  // Its footer says "↑/↓ to navigate" for one question and "Tab/Arrow keys to
  // navigate" for several, and wraps in a narrow pane.
  const flat = s.replace(/\s+/g, " ");
  if (/Enter to select/.test(flat) && /Esc to cancel/.test(flat) && /to navigate/.test(flat)) return "asking a question";
  // Its last tab, which has no footer.
  if (/Review your answers/.test(flat) && /Submit answers/.test(flat)) return "asking a question";
  return null;
}

// ------------------------------------------------------------- commands

function accountCommand(account: Pick<Account, "home" | "isDefault">): Pick<Command, "env" | "unset"> {
  return account.isDefault ? { env: {}, unset: ["CLAUDE_CONFIG_DIR"] } : { env: { CLAUDE_CONFIG_DIR: account.home } };
}

/** Without it newer models record thinking as a bare signature, and the
 *  timeline has nothing to show. */
const THINKING = ["--thinking-display", "summarized"];

/** A prompt that starts with `-` would be parsed as a flag. */
const promptArg = (p: string) => (p.startsWith("-") ? ` ${p}` : p);

function spawnCommand(opts: SpawnOptions): Command & { agentSessionId: string | null } {
  const id = randomUUID();
  const argv = ["claude", "--session-id", id];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.autoApprove) argv.push("--dangerously-skip-permissions");
  argv.push(...THINKING);
  if (opts.prompt) argv.push(promptArg(opts.prompt));
  return { argv, ...accountCommand(opts.account), agentSessionId: id };
}

function resumeCommand(opts: ResumeOptions): Command {
  const argv = ["claude", "--resume", opts.agentSessionId];
  if (opts.carry) {
    // An adopted session keeps how it was launched, permissions included.
    argv.push(...opts.carry);
    if (opts.model && !opts.carry.some((a) => a === "--model" || a.startsWith("--model="))) argv.push("--model", opts.model);
    if (opts.effort && !opts.carry.some((a) => a === "--effort" || a.startsWith("--effort="))) argv.push("--effort", opts.effort);
    if (!opts.carry.some((a) => a === "--thinking-display" || a.startsWith("--thinking-display="))) argv.push(...THINKING);
  } else {
    if (opts.model) argv.push("--model", opts.model);
    if (opts.effort) argv.push("--effort", opts.effort);
    if (opts.autoApprove) argv.push("--dangerously-skip-permissions");
    argv.push(...THINKING);
  }
  if (opts.prompt) argv.push(promptArg(opts.prompt));
  return { argv, ...accountCommand(opts.account) };
}

/**
 * Flags adopt carries over, by how many values each takes (`many` runs to the
 * next flag, as commander parses it). An allowlist, not a denylist: a flag we
 * do not know the arity of could swallow the prompt, and one we do not know
 * the meaning of could be the session id.
 */
const CARRIED: Record<string, "none" | "one" | "many"> = {
  "--dangerously-skip-permissions": "none",
  "--allow-dangerously-skip-permissions": "none",
  "--permission-mode": "one",
  "--allowedTools": "many",
  "--allowed-tools": "many",
  "--disallowedTools": "many",
  "--disallowed-tools": "many",
  "--tools": "many",
  "--add-dir": "many",
  "--mcp-config": "many",
  "--strict-mcp-config": "none",
  "--settings": "one",
  "--setting-sources": "one",
  "--plugin-dir": "one",
  "--agent": "one",
  "--agents": "one",
  "--model": "one",
  "--fallback-model": "one",
  "--effort": "one",
  "--thinking-display": "one",
  "--autocompact": "one",
  "--betas": "many",
  "--append-system-prompt": "one",
  "--append-system-prompt-file": "one",
  "--system-prompt": "one",
  "--system-prompt-file": "one",
  "--disable-slash-commands": "none",
  "--exclude-dynamic-system-prompt-sections": "none",
  "--bare": "none",
  "--restricted": "none",
  "--safe-mode": "none",
  "--ide": "none",
  "--chrome": "none",
  "--no-chrome": "none",
  "--brief": "none",
  "--verbose": "none",
};

export function claudeCarryOver(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const eq = a.indexOf("=");
    const flag = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const arity = CARRIED[flag];
    if (!arity) continue;
    out.push(a);
    if (arity === "none" || eq > 0) continue;
    if (arity === "one") {
      if (argv[i + 1] !== undefined) out.push(argv[++i]!);
      continue;
    }
    while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("-")) out.push(argv[++i]!);
  }
  return out;
}

/**
 * Move a stopped session to another account's home: the transcript and its
 * sibling directory (subagents, tool results) into the same project slug,
 * then what Claude keys by session id elsewhere in the home — rewind
 * snapshots, the shell environment, tasks and todos. Moved, never copied:
 * two homes holding one session is how `--resume` crosses accounts by
 * accident. The transcript goes first and is the only part that may fail the
 * move; the rest is best effort, as Claude does without any of it.
 */
function moveSession(opts: { from: Account; to: Account; agentSessionId: string; transcriptPath: string }): string {
  const id = opts.agentSessionId;
  if (!UUID.test(id)) throw new Error(`not a claude session id: ${id}`);
  const fromHome = claudeHome(opts.from);
  const toHome = claudeHome(opts.to);
  const rel = relative(join(fromHome, "projects"), opts.transcriptPath);
  if (rel.startsWith("..") || basename(rel) !== `${id}.jsonl` || dirname(rel).includes("/")) {
    throw new Error(`the transcript is not where ${opts.from.label} keeps it: ${opts.transcriptPath}`);
  }
  const dest = join(toHome, "projects", rel);
  moveInto(opts.transcriptPath, dest);
  const side = (home: string, ...p: string[]) => join(home, ...p);
  const extras: [string, string][] = [
    [opts.transcriptPath.slice(0, -".jsonl".length), dest.slice(0, -".jsonl".length)],
    [side(fromHome, "file-history", id), side(toHome, "file-history", id)],
    [side(fromHome, "session-env", id), side(toHome, "session-env", id)],
    [side(fromHome, "tasks", id), side(toHome, "tasks", id)],
  ];
  try {
    for (const n of readdirSync(side(fromHome, "todos"))) {
      if (n.startsWith(`${id}-`)) extras.push([side(fromHome, "todos", n), side(toHome, "todos", n)]);
    }
  } catch {
    /* no todos */
  }
  for (const [a, b] of extras) {
    if (!existsSync(a)) continue;
    try {
      moveInto(a, b);
    } catch (e) {
      console.error(`agentbox: moving ${a} for session ${id}:`, e);
    }
  }
  return dest;
}

// ------------------------------------------------------------- adapter

function refOf(account: Account, path: string, id: string, mtimeMs: number, size: number): TranscriptRef {
  return { provider: "claude", accountId: account.id, agentSessionId: id, path, mtimeMs, size };
}

export function claudeReader(ref: TranscriptRef): TranscriptReader {
  const isSub = ref.path.includes("/subagents/");
  const subs = isSub ? null : new SubagentTokens(ref.path.replace(/\.jsonl$/, "") + "/subagents");
  return new JsonlTranscriptReader(
    ref,
    claudeFormat(ref, subs ? { totals: () => subs.totals(), refresh: () => subs.refresh() } : undefined),
  );
}

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  label: "Claude Code",
  efforts: ["low", "medium", "high", "xhigh", "max"],

  detect: () => cliVersion(["claude", "--version"]),

  defaultHome: () => join(userHome(), ".claude"),

  accountCommand,
  authEnv: accountCommand,

  async listTranscripts(account, sinceMs) {
    const ix = indexFor(claudeHome(account));
    return ix.scan(sinceMs, Date.now()).map((f) => refOf(account, f.path, f.id, f.mtimeMs, f.size));
  },

  liveProcesses,

  async findTranscript(account, agentSessionId) {
    if (!UUID.test(agentSessionId)) return null;
    const home = claudeHome(account);
    const ix = indexFor(home);
    let path = ix.lookup(agentSessionId);
    if (!path) {
      const root = join(home, "projects");
      let dirs: string[] = [];
      try {
        dirs = readdirSync(root);
      } catch {
        return null;
      }
      for (const d of dirs) {
        const p = join(root, d, `${agentSessionId}.jsonl`);
        if (existsSync(p)) {
          path = p;
          break;
        }
      }
    }
    if (!path) return null;
    try {
      const st = statSync(path);
      return refOf(account, path, agentSessionId, st.mtimeMs, st.size);
    } catch {
      return null;
    }
  },

  reader: claudeReader,
  spawnCommand,
  resumeCommand,
  moveSession,
  carryOver: claudeCarryOver,
  headless: isHeadless,
  autoAnswer: claudeAutoAnswer,
  approvePrompt: claudeApprovePrompt,
  blockedOn: claudeBlockedOn,
  answerStep: askStep,
  askOnScreen: askFromScreen,
};
