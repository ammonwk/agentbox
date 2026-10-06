/** The opencode adapter (opencode 2.0, the TUI and its servers).
 *
 * opencode 2.0 is a client and a server. A plain `opencode` TUI talks to the
 * shared background service (`opencode serve --service`, see
 * ~/.local/state/opencode/service.json), which runs every such session's
 * model calls and tools; `opencode --standalone` starts a private server as
 * its own child (`opencode serve --stdio --port 0`) instead. Both write one
 * database, `$XDG_DATA_HOME/opencode/opencode.db` (`opencode-db.ts`), which is
 * where transcripts are read from — `<db>#<session id>`, as devin's are.
 *
 * Accounts. opencode keeps one login per provider (`auth.json`), and the one
 * that matters here — OpenCode Go — is the subscription omp also runs on. So
 * opencode has no account of its own: it shares omp's implicit one, and with
 * it omp's usage windows and its place in the balancer. The account handed in
 * is never used to find anything.
 *
 * Launching. agentbox starts sessions `--standalone`, so the server that runs
 * the tools is a child of the TUI in the pane and inherits its environment
 * (AGENTBOX_SESSION, the briefing below); a tool under the shared service
 * would see the service's environment instead. Before the TUI starts, the
 * session is made with an id agentbox chose (`opencode api POST
 * /api/session`, which also sets its model and variant), so the session id
 * is known from the first moment; `-s <id> --prompt=…` then opens it and sends
 * the prompt. `--prompt` without `-s` only fills the box, and an unknown `-s`
 * is silently a new session.
 *
 * Liveness. Neither server writes anything per session that names the process
 * showing it, so a TUI is matched to a session by `-s <id>` in its argv, and
 * otherwise by the newest session in its directory made, viewed or finished
 * since it started.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { agentboxHome, userHome } from "../paths";
import { cliVersion } from "./cli-version";
import { carryFlags, type Arity } from "../launch";
import { cwdOf, findProcesses, runsCli, startedAtOf } from "./procs";
import { BRIEFING } from "./briefing";
import { ensureBridge } from "../../bridge/service";
import { bridgeUrl } from "../../bridge/models";
import type { Account, TimelineEvent, TimelinePage } from "../types";
import * as db from "./opencode-db";
import { modelName, opencodeEvents, opencodeFacts, parseData, summarize, type RowSummary } from "./opencode-transcript";
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
/** How often a session's subagents are summed again when nothing else moved. */
const CHILDREN_EVERY_MS = 30_000;

/** opencode's data dir, which holds the database. */
function defaultDataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(userHome(), ".local", "share"), "opencode");
}

// ----------------------------------------------------------- ids

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastIdMs = 0;
let idCounter = 0;

/**
 * A session id as opencode makes them (`Identifier.descending`): `ses_`, the
 * creation time times 4096 plus a counter, bit-inverted to 48 bits so newer
 * sorts first, in hex, then 14 random base62 characters.
 */
export function newSessionId(now = Date.now()): string {
  if (now === lastIdMs) idCounter++;
  else {
    lastIdMs = now;
    idCounter = 0;
  }
  const v = BigInt(now) * 4096n + BigInt(idCounter);
  const hex = (~v & 0xffffffffffffn).toString(16).padStart(12, "0");
  let rand = "";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  for (const b of bytes) rand += BASE62[b % 62];
  return `ses_${hex}${rand}`;
}

// ----------------------------------------------------------- processes

/** opencode's subcommands; `mini` is an interactive session too. A first
 *  positional that is none of these is the directory to open. */
const SUBCOMMANDS = new Set([
  "upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin", "models", "stats",
  "mini", "run", "session", "service", "reload", "pair", "serve", "export", "import", "github", "pr",
  "web", "agent", "help", "completion",
]);
/** Options whose value is the next argument. */
const VALUE_FLAGS = new Set(["-s", "--session", "--prompt", "--server", "--log-level", "--completions", "-m", "--model", "--agent", "-f", "--file", "--title", "--format"]);

/** The subcommand and the directory argument of an opencode argv. */
export function parseOpencodeArgv(argv: string[]): { sub: string | null; dir: string | null; session: string | null } {
  let sub: string | null = null;
  let dir: string | null = null;
  let session: string | null = null;
  const start = runsCli(argv, "opencode") && !/opencode/.test(argv[0] ?? "") ? 2 : 1;
  for (let i = start; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") break;
    if (a === "-s" || a === "--session") {
      session = argv[i + 1] ?? null;
      i++;
      continue;
    }
    if (a.startsWith("--session=")) {
      session = a.slice("--session=".length) || null;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    if (sub === null && dir === null && SUBCOMMANDS.has(a)) sub = a;
    else if (sub === null && dir === null) dir = a;
  }
  return { sub, dir, session };
}

/** An interactive opencode: the TUI (or `mini`), not a server, a one-shot
 *  `run`, or any other subcommand. */
export function isOpencodeTui(argv: string[]): boolean {
  if (!runsCli(argv, "opencode")) return false;
  if (argv.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-v")) return false;
  const { sub } = parseOpencodeArgv(argv);
  return sub === null || sub === "mini";
}

export interface OpencodeProc {
  pid: number;
  /** The directory the TUI opened: its argument, else its cwd. */
  cwd: string;
  startedAt: number;
  /** `-s <id>` from its argv. */
  session: string | null;
}

/**
 * Match TUIs to sessions, most certain first, and never give one session to
 * two processes:
 *  1. `-s <id>` naming a session that exists;
 *  2. the session in its directory most recently made, viewed or finished
 *     since it started, not already claimed — a new session, or `-c`, or one
 *     opened from the TUI's own list.
 */
export function attributeOpencode(
  procs: OpencodeProc[],
  look: { exists(id: string): boolean; touchedSince(ms: number): db.OpencodeSessionRow[] },
): Map<number, string | null> {
  const out = new Map<number, string | null>();
  const claimed = new Set<string>();
  for (const p of procs) {
    if (p.session && !claimed.has(p.session) && look.exists(p.session)) {
      out.set(p.pid, p.session);
      claimed.add(p.session);
    }
  }
  const rest = procs.filter((p) => !out.has(p.pid)).sort((a, b) => b.startedAt - a.startedAt);
  if (rest.length === 0) return out;
  const earliest = Math.min(...rest.map((p) => p.startedAt)) - 2000;
  const rows = look.touchedSince(earliest);
  for (const p of rest) {
    let best: { id: string; t: number } | null = null;
    for (const r of rows) {
      if (r.directory !== p.cwd || claimed.has(r.id)) continue;
      const t = Math.max(r.time_created, r.time_viewed ?? 0, r.time_idle ?? 0);
      if (t < p.startedAt - 2000) continue;
      if (!best || t > best.t) best = { id: r.id, t };
    }
    out.set(p.pid, best?.id ?? null);
    if (best) claimed.add(best.id);
  }
  return out;
}

// ----------------------------------------------------------- reader

class OpencodeReader implements TranscriptReader {
  private rows: RowSummary[] = [];
  private bySeq = new Map<number, RowSummary>();
  private maxSeq = 0;
  private evSeq: number | null = -1;
  private ver = 0;
  /** Changes when rows go away (a revert), so old cursors are recognisably stale. */
  private gen = Math.floor(Math.random() * 1e9);
  private row: db.OpencodeSessionRow | null = null;
  private rowSig = "";
  private children: db.OpencodeChildRow[] = [];
  private childSig = "";
  private childrenAt = 0;
  private dirty = true;

  constructor(
    readonly ref: TranscriptRef,
    private readonly dbPath: string,
  ) {}

  private get id(): string {
    return this.ref.agentSessionId;
  }

  private pull(): boolean {
    let changed = false;
    const row = db.sessionById(this.dbPath, this.id);
    if (row) {
      const sig = JSON.stringify(row);
      if (sig !== this.rowSig) {
        this.row = row;
        this.rowSig = sig;
        changed = true;
      }
    }

    const es = db.eventSeq(this.dbPath, this.id);
    if (es === null || es !== this.evSeq) {
      let from = this.maxSeq + 1;
      for (const r of this.rows) if (r.open && r.seq < from) from = r.seq;
      const msgs = db.messagesFrom(this.dbPath, this.id, from);
      if (msgs) {
        const ver = this.ver + 1;
        let moved = false;
        const seen = new Set<number>();
        for (const m of msgs) {
          seen.add(m.seq);
          const had = this.bySeq.get(m.seq);
          if (had && had.updated === m.time_updated) continue;
          const s = summarize(m, ver);
          this.bySeq.set(m.seq, s);
          if (m.seq > this.maxSeq) this.maxSeq = m.seq;
          moved = true;
        }
        // Rows of ours from `from` on that are gone: opencode reverted them.
        for (const r of this.rows) {
          if (r.seq >= from && !seen.has(r.seq)) {
            this.bySeq.delete(r.seq);
            this.gen++;
            moved = true;
          }
        }
        if (moved) {
          this.ver = ver;
          this.rows = [...this.bySeq.values()].sort((a, b) => a.seq - b.seq);
          changed = true;
        }
        this.evSeq = es;
      }
    }

    // Subagents run as sessions of their own; their tokens are this one's.
    const now = Date.now();
    if (this.row?.parent_id === null && (changed || now - this.childrenAt > CHILDREN_EVERY_MS)) {
      this.childrenAt = now;
      const all: db.OpencodeChildRow[] = [];
      let level = [this.id];
      for (let depth = 0; depth < 4 && level.length > 0; depth++) {
        const kids = db.childrenOf(this.dbPath, level);
        if (!kids) break;
        all.push(...kids);
        level = kids.map((k) => k.id);
      }
      const sig = JSON.stringify(all);
      if (sig !== this.childSig) {
        this.children = all;
        this.childSig = sig;
        changed = true;
      }
    }
    if (changed) this.dirty = true;
    return changed;
  }

  private facts(): TranscriptFacts {
    return opencodeFacts({ id: this.id, row: this.row, rows: this.rows, children: this.children });
  }

  saveState(): unknown {
    return { rows: this.rows, maxSeq: this.maxSeq, evSeq: this.evSeq, gen: this.gen, ver: this.ver };
  }

  loadState(saved: unknown): boolean {
    const s = saved as { rows: RowSummary[]; maxSeq: number; evSeq: number | null; gen: number; ver: number } | null;
    if (!s || this.rows.length > 0 || !Array.isArray(s.rows)) return false;
    const es = db.eventSeq(this.dbPath, this.id);
    // Fewer events than when saved: not the database that was read.
    if (es === null || (s.evSeq ?? 0) > es) return false;
    this.rows = s.rows;
    this.bySeq = new Map(s.rows.map((r) => [r.seq, r]));
    this.maxSeq = s.maxSeq;
    this.evSeq = s.evSeq;
    this.gen = s.gen;
    this.ver = s.ver;
    return true;
  }

  async refresh(): Promise<{ changed: boolean; facts: TranscriptFacts }> {
    this.pull();
    const changed = this.dirty;
    this.dirty = false;
    return { changed, facts: this.facts() };
  }

  private materialize(seqs: number[]): TimelineEvent[] {
    if (seqs.length === 0) return [];
    const got = db.messagesBySeq(this.dbPath, this.id, seqs);
    if (!got) return [];
    return seqs.flatMap((s) => {
      const r = got.get(s);
      return r ? opencodeEvents(r) : [];
    });
  }

  private cursor(): string {
    return `${this.gen}:${this.ver}`;
  }

  private page(before: string | null, limit: number): TimelinePage {
    const anchors = this.rows.filter((r) => r.shown).map((r) => r.seq);
    let p = anchors.length;
    let collected: TimelineEvent[] = [];
    if (before) {
      const seq = Number(before.split(".")[0]);
      const pos = anchors.indexOf(seq);
      if (pos >= 0) {
        const evs = this.materialize([seq]);
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

  async timeline(opts: { before?: string | null; limit: number }): Promise<TimelinePage> {
    this.pull();
    return this.page(opts.before ?? null, opts.limit);
  }

  /** Rows rewritten since the cursor (a step that went on running) are sent
   *  again whole, under the same event ids. */
  async since(cursor: string): Promise<{ events: TimelineEvent[]; cursor: string; reset: boolean }> {
    this.pull();
    const m = /^(\d+):(\d+)$/.exec(cursor);
    const v = m ? Number(m[2]) : NaN;
    if (!m || Number(m[1]) !== this.gen || v > this.ver) {
      const page = this.page(null, DEFAULT_PAGE);
      return { events: page.events, cursor: page.cursor, reset: true };
    }
    const seqs = this.rows.filter((r) => r.shown && r.ver > v).map((r) => r.seq);
    return { events: this.materialize(seqs), cursor: this.cursor(), reset: false };
  }
}

// ----------------------------------------------------------- launching

/** `provider/model`, optionally `#variant`, as opencode's model ref. */
export function modelRef(model: string | null | undefined, variant?: string | null): { id: string; providerID: string; variant?: string } | null {
  if (!model) return null;
  const hash = model.indexOf("#");
  const base = hash >= 0 ? model.slice(0, hash) : model;
  const v = variant || (hash >= 0 ? model.slice(hash + 1) : "") || null;
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) return null;
  const ref: { id: string; providerID: string; variant?: string } = { providerID: base.slice(0, slash), id: base.slice(slash + 1) };
  if (v) ref.variant = v;
  return ref;
}

/** The briefing goes in as an instructions file, through the config opencode
 *  reads from its environment; written when it differs. */
function briefingFile(): string {
  const path = join(agentboxHome(), "opencode-briefing.md");
  try {
    if (!existsSync(path) || readFileSync(path, "utf8") !== BRIEFING) writeFileSync(path, BRIEFING);
  } catch {
    /* the session starts unbriefed */
  }
  return path;
}

/** OPENCODE_CONFIG_CONTENT with the briefing added to whatever the server's
 *  own environment already sets there. */
const objectOr = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The config a launch adds to the user's own: the briefing, and the bridge
 *  as OpenCode Go's endpoint, which puts the session's account's Go key on
 *  each request. Without it opencode sends no Go key at all when it is signed
 *  into an OpenCode workspace — it bills the workspace, whatever key it holds
 *  or its config names — and on another account it would still use its one
 *  stored login (accounts/gokey.ts). */
function configEnv(account: Pick<Account, "id" | "isDefault">): Record<string, string> {
  let cfg: Record<string, unknown> = {};
  const own = process.env.OPENCODE_CONFIG_CONTENT;
  if (own) {
    const parsed = parseData(own);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) cfg = parsed;
  }
  const brief = briefingFile();
  const instructions = Array.isArray(cfg.instructions) ? cfg.instructions.filter((x) => x !== brief) : [];
  cfg = { ...cfg, instructions: [...instructions, brief] };
  ensureBridge();
  const providers = objectOr(cfg.provider);
  const go = objectOr(providers["opencode-go"]);
  const options = { ...objectOr(go.options), baseURL: `${bridgeUrl()}/go/${account.isDefault ? "default" : account.id}/v1` };
  cfg = { ...cfg, provider: { ...providers, "opencode-go": { ...go, options } } };
  // The user's own shell runs opencode with fewer GC marker threads.
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg), JSC_numberOfGCMarkers: process.env.JSC_numberOfGCMarkers || "2" };
}

/**
 * Make the session (with its model) on a private server, then open it. If
 * the session cannot be made the TUI still starts, on a new session of its
 * own, with the prompt waiting in its box.
 */
const SPAWN_SCRIPT = [
  'b=$1; id=$2; shift 2',
  'if opencode api --standalone POST /api/session -d "$b" >/dev/null; then exec opencode -s "$id" "$@"; fi',
  'echo "agentbox: could not make the opencode session; starting a new one" >&2',
  'exec opencode "$@"',
].join("\n");

/** Switch a session's model before opening it. */
const RESUME_SCRIPT = [
  'id=$1; b=$2; shift 2',
  'opencode api --standalone POST "/api/session/$id/model" -d "$b" >/dev/null || echo "agentbox: could not switch the session\'s model" >&2',
  'exec opencode -s "$id" "$@"',
].join("\n");

/** Flags adopt carries over. */
const CARRIED: Record<string, Arity> = { "--auto": "none" };

function tuiFlags(opts: { prompt?: string; autoApprove: boolean; carry?: string[] }): string[] {
  const c = opts.carry;
  const a = ["--standalone", ...(c ?? [])];
  if (!c && opts.autoApprove) a.push("--auto");
  // `=` so a prompt starting with `-` is not read as a flag.
  if (opts.prompt) a.push(`--prompt=${opts.prompt}`);
  return a;
}

export interface OpencodeAdapterOptions {
  /** opencode's data dir; read on every call so tests can point it at a fixture. */
  dataDir?: () => string;
}

export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): ProviderAdapter {
  const dataDir = options.dataDir ?? defaultDataDir;
  const dbPath = () => join(dataDir(), "opencode.db");

  /** The last good listing, served while the database is busy. */
  let lastRows: db.OpencodeListedRow[] = [];

  function refOf(account: Account, id: string, mtimeMs: number): TranscriptRef {
    return { provider: "opencode", accountId: account.id, agentSessionId: id, path: `${dbPath()}#${id}`, mtimeMs, size: 0 };
  }

  const noEnv = (): Pick<Command, "env" | "unset"> => ({ env: {} });

  return {
    id: "opencode",
    label: "opencode",
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],

    detect: () => cliVersion(["opencode", "--version"]),

    defaultHome: () => dataDir(),

    // One login per provider, opencode's own; nothing to point it at.
    accountCommand: noEnv,
    authEnv: noEnv,

    async listTranscripts(account, sinceMs) {
      const rows = db.sessionsSince(dbPath(), sinceMs);
      if (rows) lastRows = rows;
      return (rows ?? lastRows).map((r) =>
        refOf(account, r.id, Math.max(r.time_created, r.time_updated, r.time_idle ?? 0, r.last_msg ?? 0)),
      ).filter((ref) => ref.mtimeMs >= sinceMs);
    },

    async liveProcesses(accounts) {
      const account = accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
      const matches = findProcesses(isOpencodeTui);
      if (matches.length === 0) return [];
      const pids = new Set(matches.map((m) => m.pid));
      const procs: OpencodeProc[] = [];
      for (const m of matches) {
        // An opencode started by another (a worker, or `mini` under a TUI) is
        // part of its parent's session.
        if (pids.has(m.ppid)) continue;
        const cwd = cwdOf(m.pid);
        const startedAt = startedAtOf(m.pid);
        if (cwd === null || startedAt === null) continue;
        const { dir, session } = parseOpencodeArgv(m.argv);
        procs.push({ pid: m.pid, cwd: dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : cwd, startedAt, session });
      }
      if (procs.length === 0) return [];
      const path = dbPath();
      const ids = attributeOpencode(procs, {
        exists: (id) => db.sessionById(path, id) !== null,
        touchedSince: (ms) => db.sessionsTouchedIn(path, ms) ?? [],
      });
      return procs.map(
        (p): LiveProcess => ({ pid: p.pid, accountId: account?.id ?? null, agentSessionId: ids.get(p.pid) ?? null, cwd: p.cwd, startedAt: p.startedAt }),
      );
    },

    async findTranscript(account, agentSessionId) {
      const r = db.sessionById(dbPath(), agentSessionId);
      return r ? refOf(account, r.id, Math.max(r.time_updated, r.time_idle ?? 0)) : null;
    },

    reader(ref) {
      return new OpencodeReader(ref, dbPath());
    },

    // Every OpenCode Go account runs on the one database (only the key
    // differs), so a session is already wherever it is resumed.
    moveSession: ({ transcriptPath }) => transcriptPath,

    spawnCommand(opts: SpawnOptions) {
      const id = newSessionId();
      const body: Record<string, unknown> = { id, location: { directory: opts.cwd } };
      const model = modelRef(opts.model, opts.effort);
      if (model) body.model = model;
      return {
        argv: ["sh", "-c", SPAWN_SCRIPT, "opencode", JSON.stringify(body), id, ...tuiFlags(opts)],
        env: configEnv(opts.account),
        agentSessionId: id,
      };
    },

    resumeCommand(opts: ResumeOptions): Command {
      const flags = tuiFlags(opts);
      // A model or effort that differs from the session's own is switched to
      // before the TUI opens it; the TUI itself takes neither as a flag.
      if (opts.model || opts.effort) {
        const current = parseData(db.sessionById(dbPath(), opts.agentSessionId)?.model ?? "null") as { id?: string; providerID?: string; variant?: string } | null;
        const want = modelRef(opts.model ?? modelName(current), opts.effort ?? current?.variant ?? null);
        if (want && (want.id !== current?.id || want.providerID !== current?.providerID || (want.variant ?? null) !== (current?.variant ?? null))) {
          return {
            argv: ["sh", "-c", RESUME_SCRIPT, "opencode", opts.agentSessionId, JSON.stringify({ model: want }), ...flags],
            env: configEnv(opts.account),
          };
        }
      }
      return { argv: ["opencode", "-s", opts.agentSessionId, ...flags], env: configEnv(opts.account) };
    },

    carryOver: (argv) => carryFlags(argv, CARRIED),
    headless: (argv) => parseOpencodeArgv(argv).sub === "run",

    blockedOn(screen) {
      if (/Permission required/.test(screen) && /Allow once|Always allow|Reject/.test(screen)) return "permission";
      // The question form's footer.
      if (/select\s+enter choose\s+tab next\s+esc dismiss|enter submit\s+esc dismiss/.test(screen)) return "asking a question";
      if (/Connect a provider|No provider selected/.test(screen)) return "login";
      if (/Session location unavailable/.test(screen)) return "move session";
      return null;
    },
  };
}

export const opencodeAdapter: ProviderAdapter = createOpencodeAdapter();

