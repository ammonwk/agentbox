/** The fleet: every session on the machine, joined from what each piece knows.
 *
 * Nothing here is a source of truth on its own. The provider's transcript
 * says what a session said and did; the process table says whether it is
 * alive; tmux says whether it is one of ours; the database says which account
 * it is pinned to and what it claims. Each tick joins them into `Session`
 * views and says what changed.
 *
 * Two clocks. Every tick (2s): processes, tmux panes, and the transcripts
 * already known. Every discovery (10s): list transcript directories for new
 * sessions. Reading a transcript is always incremental (the adapters' readers
 * keep their offsets), so a tick costs a stat per transcript plus whatever was
 * appended.
 *
 * Actions (spawn, resume, adopt, send, stop) live here too, because each one
 * is a question about the joined state — "is this session in our tmux right
 * now", "which account is it on", "where can it be resumed from" — that no
 * single piece can answer.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { owners } from "./accounts/homes";
import { place, type AccountState } from "./balancer";
import { claimFor } from "./claim";
import { Attributor, claimsByAccount, consumedBy, type ClaimInput } from "./claims";
import {
  failUnfinishedBtw,
  findSessionRecord,
  finishBtw,
  getAccount,
  getRepoById,
  getSessionRecord,
  getSettings,
  insertAssignment,
  insertBtw,
  insertRateLimitHit,
  insertSessionRecord,
  insertTokenSample,
  listAccounts,
  listBtw,
  listClosedRecords,
  listSessionRecords,
  updateSessionRecord,
  usageSamplesSince,
  type SessionRecord,
} from "./db";
import { createWorktree, run, worktreeForBranch } from "./git";
import { attachArgv, tmuxName, type NewSession, type PaneInfo } from "./tmux";
import {
  transcriptFile,
  type LiveProcess,
  type ProviderAdapter,
  type TranscriptFacts,
  type TranscriptReader,
  type TranscriptRef,
} from "./providers/types";
import { argvOf, environOf, isAlive, runsCli, startedAtOf, withProcessScan } from "./providers/procs";
import { clockHz, describe, isToolShell, readProcTable, subtree, subtreeCpuTicks, type ProcTable } from "./proc";
import {
  classifyShell,
  minutes,
  subagentWorking,
  PARK_CHECK_MS,
  PARK_STARTUP_MS,
  shellCommand,
  normalCommand,
  shellHold,
  STALE_TURN_MS,
  SUBAGENT_QUIET_MS,
  subagentsLastWrite,
  WakeScan,
} from "./park";
import { read as readLive } from "../subagents/live";
import { poolKey, poolState, type PoolAgent } from "../subagents/record";
import { carryEnv, type Launch } from "./launch";
import { weeklyWindow } from "./balancer";
import { awaitAnswer, BtwHistory, clearPanel, closePanel, copyAnswer, type HistoryBtw } from "./btw";
import type {
  Account,
  AccountUsage,
  AskAnswer,
  AskQuestion,
  BalancerSettings,
  Btw,
  ClaimView,
  Placement,
  ProviderId,
  Session,
  SessionHost,
  SessionStatus,
  TimelineEvent,
  TimelinePage,
  UsageWindow,
} from "./types";

const DAY = 86_400_000;
const DISCOVERY_MS = 10_000;
const TICK_MS = 2_000;
/** Dialogs are only auto-answered this soon after we start a process: a key
 *  pressed into a session you are using is worse than a dialog left open. */
const AUTO_ANSWER_MS = 120_000;
/** A dead pane is kept this long so its last screen can be read, then killed. */
const DEAD_PANE_MS = 10 * 60_000;
/** A new token sample at most this often per session (plus at turn end). */
const TOKEN_SAMPLE_MS = 60_000;
/** How long a spawn may take to write its first transcript line before we
 *  stop trying to match it. */
const MATCH_WINDOW_MS = 10 * 60_000;

export interface Runtime {
  newSession(s: NewSession): number;
  listPanes(): PaneInfo[];
  sendText(name: string, text: string): Promise<void>;
  sendKeys(name: string, keys: string[]): void;
  capture(name: string, opts?: { ansi?: boolean; scrollback?: number }): string | null;
  killSession(name: string): void;
  setZoom?(name: string, on: boolean): boolean;
  /** A window left at a gone client's small size back to a readable one; whether it changed. */
  unsquash?(name: string): boolean;
  bufferNames?(): string[];
  takeBuffer?(buffer: string): string | null;
}

export interface UsageSource {
  usageOf(accountId: string): AccountUsage | null;
  /** The account's login state, if known. */
  authOf?(accountId: string): "ok" | "expired" | "missing" | "unknown" | null;
  /** Codex reports its limits inside the rollout; hand fresher readings over. */
  ingestRollout?(accountId: string, reading: { at: number; windows: UsageWindow[] }): void;
}

export interface FleetDeps {
  adapters: ProviderAdapter[];
  runtime: Runtime;
  usage: UsageSource;
  /** The subagent MCP's agents by `poolKey`. Their transcripts land in their
   *  CLI's store like any other; this is what makes each a child of the
   *  session that asked for it rather than a session of its own. */
  poolAgents?: () => ReadonlyMap<string, PoolAgent>;
  /** The Project session's id. It launches top-level work, so it is never
   *  recorded as anyone's parent. */
  projectSession?: () => string | null;
  now?: () => number;
}

export class FleetError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly placement?: Placement,
  ) {
    super(message);
  }
}

interface Tracked {
  ref: TranscriptRef;
  reader: TranscriptReader;
  facts: TranscriptFacts | null;
  /** Rate-limit hits already recorded, so each is written once. */
  hitsSeen: number;
  lastUsageAt: number;
}

export interface SpawnRequest {
  provider: ProviderId;
  cwd?: string;
  repoId?: string;
  worktree?: boolean;
  /** Run on this existing branch (a PR's head): in the worktree that has it
   *  checked out, or a new one. Wins over `worktree`. */
  branch?: string;
  /** The PR `branch` belongs to, for fetching it when origin has no such branch. */
  pr?: number;
  prompt?: string;
  model?: string;
  /** One of the adapter's `efforts`. */
  effort?: string;
  big?: boolean;
  accountId?: string | null;
  /** The process asking (the CLI, the fleet MCP). A session it runs under
   *  becomes the new session's parent. */
  callerPid?: number;
  /** Start under this id: a scheduled session keeps the one it was shown under. */
  id?: string;
}

export class Fleet extends EventEmitter {
  private readonly adapters: Map<ProviderId, ProviderAdapter>;
  private readonly now: () => number;

  /** By transcript path. */
  private tracked = new Map<string, Tracked>();
  /** Transcripts that turned out to be in-process subagents; never sessions. */
  private ignored = new Set<string>();
  private pool: ReadonlyMap<string, PoolAgent> = new Map();
  /** What each pool agent's MCP server says of it, while that server runs it. */
  private poolStates = new Map<string, NonNullable<ReturnType<typeof poolState>>>();
  /** Session ids on the list (not closed), as of this pass. */
  private openIds = new Set<string>();
  /** `${provider}:${agentSessionId}` → session id. */
  private byAgentId = new Map<string, string>();
  private views = new Map<string, Session>();
  private fingerprints = new Map<string, string>();
  private live = new Map<string, LiveProcess>();
  private livePids = new Map<number, LiveProcess & { provider: ProviderId }>();
  private panes = new Map<string, PaneInfo>();
  private deadSince = new Map<string, number>();
  private startedAt = new Map<string, number>();
  private answered = new Map<string, { sig: string; at: number; tries: number }>();
  /** Permission prompts `approvePrompt` has pressed Yes on, by session. */
  private approved = new Map<string, { sig: string; at: number; tries: number }>();
  private blocked = new Map<string, string>();
  /** A question read off the screen, for a session whose transcript does not have it (yet). */
  private screenAsks = new Map<string, { id: string; questions: AskQuestion[] }>();
  private tokenSampled = new Map<string, { at: number; costEquiv: number; turnOpen: boolean }>();
  /** `${session}:${pid}` whose process ancestry has been looked at. */
  private ancestryChecked = new Set<string>();
  private lastDiscovery = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private attributor = new Attributor();
  private lastWeekly = new Map<string, string>();
  /** Providers whose sessions can wake on another account: the adapter can
   *  move a session, and there is another account to move it to. */
  private movable = new Set<ProviderId>();
  /** Limit hits already acted on (`continueStalled`): session → the hit's time. */
  private stallsMoved = new Map<string, number>();
  /** Sessions waiting out a 5-hour reset: tell them to go on at `at`, if still
   *  stopped at the hit `hitAt`. */
  private resumeAfterReset = new Map<string, { hitAt: number; at: number }>();
  /** Home → the account it belongs to (see `owners`), as of the last pass. */
  private owner = new Map<string, string>();
  private coldAfterMs = 60 * 60_000;
  /** Each session's own status, before archive masks it. */
  private liveStatus = new Map<string, SessionStatus>();
  /** Idle sessions kept running, and why (see src/core/park.ts). */
  private parkHolds = new Map<string, string>();
  /** By transcript path. */
  private wakeScans = new Map<string, WakeScan>();
  /** Sessions found parkable at the last check (see `parkIdle`). */
  private parkClean = new Map<string, ParkCheck>();
  /** Parked processes that may outlive their tmux session (see reapParked). */
  private dying = new Map<number, { since: number; start: number | null; termed: boolean }>();
  /** Per session: the action under way (see `serial`), and when you last
   *  did anything to it. */
  private busy = new Map<string, Promise<void>>();
  private touched = new Map<string, number>();
  /** Side questions asked in the terminal whose answer is being waited for, by session. */
  private btwWatching = new Map<string, Promise<void>>();
  private btwHistory = new BtwHistory();
  private nextParkCheck: number;
  readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor(private readonly deps: FleetDeps) {
    super();
    this.adapters = new Map(deps.adapters.map((a) => [a.id, a]));
    this.now = deps.now ?? Date.now;
    this.nextParkCheck = this.now() + PARK_STARTUP_MS;
    this.ready = new Promise((r) => (this.markReady = r));
  }

  start(): void {
    if (this.timer) return;
    for (const id of failUnfinishedBtw("agentbox restarted before it answered", this.now())) this.emit("btw", id);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  adapter(id: ProviderId): ProviderAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new FleetError(400, `unknown provider: ${id}`);
    return a;
  }

  providers(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  // ------------------------------------------------------------- the tick

  /** One pass. Overlapping calls share the pass in flight. */
  tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.pass()
        .catch((e) => console.error("agentbox: fleet tick failed:", e))
        .finally(() => {
          this.ticking = null;
          this.markReady();
        });
    }
    return this.ticking;
  }

  private async pass(): Promise<void> {
    const now = this.now();
    const settings = getSettings();
    const since = now - settings.boardDays * DAY;
    const accounts = listAccounts();
    const accountsOf = (p: ProviderId) => accounts.filter((a) => a.provider === p);

    this.panes = new Map(this.deps.runtime.listPanes().map((p) => [p.name, p]));
    this.coldAfterMs = settings.balancer.claimIdleMin * 60_000;
    this.owner = owners(accounts);
    // Movable means there is another *account* to move to; a second home on
    // the same login is not one.
    this.movable = new Set(
      [...this.adapters.values()]
        .filter((a) => a.moveSession && new Set(accountsOf(a.id).map((x) => this.ownerOf(x.id))).size > 1)
        .map((a) => a.id),
    );

    // Processes.
    this.live.clear();
    this.livePids.clear();
    await withProcessScan(async () => {
      for (const adapter of this.adapters.values()) {
        const accts = accountsOf(adapter.id);
        let procs: LiveProcess[] = [];
        try {
          procs = await adapter.liveProcesses(accts);
        } catch (e) {
          console.error(`agentbox: ${adapter.id} process scan failed:`, e);
        }
        for (const p of procs) {
          this.livePids.set(p.pid, { ...p, provider: adapter.id });
          if (p.agentSessionId) this.live.set(`${adapter.id}:${p.agentSessionId}`, p);
        }
      }
    });

    // New transcripts.
    if (now - this.lastDiscovery >= DISCOVERY_MS) {
      this.lastDiscovery = now;
      for (const adapter of this.adapters.values()) {
        for (const account of accountsOf(adapter.id)) {
          let refs: TranscriptRef[] = [];
          try {
            refs = await adapter.listTranscripts(account, since);
          } catch (e) {
            console.error(`agentbox: ${adapter.id} transcript scan failed for ${account.label}:`, e);
          }
          for (const ref of refs) this.track(adapter, ref);
        }
      }
      this.pool = this.deps.poolAgents?.() ?? this.pool;
    }
    this.poolStates.clear();
    for (const [key, a] of this.pool) {
      const state = this.live.has(key) && isAlive(a.serverPid) ? poolState(a) : null;
      if (state) this.poolStates.set(key, state);
    }

    // A live session whose transcript is older than the window (resumed
    // today, started last week) is found by id.
    for (const [key, p] of this.live) {
      const [provider] = key.split(":") as [ProviderId];
      if (!p.agentSessionId || this.hasTranscriptFor(provider, p.agentSessionId)) continue;
      const account = p.accountId ? accounts.find((a) => a.id === p.accountId) : null;
      if (!account) continue;
      const ref = await this.adapter(provider).findTranscript(account, p.agentSessionId).catch(() => null);
      if (ref) this.track(this.adapter(provider), ref);
    }
    // And so is every open agentbox session, so its board row has facts.
    for (const rec of listSessionRecords(since)) {
      if (!rec.transcriptPath || this.tracked.has(rec.transcriptPath) || !rec.accountId) continue;
      if (!existsSync(transcriptFile(rec.transcriptPath))) continue;
      const account = accounts.find((a) => a.id === rec.accountId);
      if (!account || !rec.agentSessionId) continue;
      const ref = await this.adapter(rec.provider).findTranscript(account, rec.agentSessionId).catch(() => null);
      if (ref) this.track(this.adapter(rec.provider), ref);
    }

    // Read what was appended.
    const changed = new Set<string>();
    for (const [path, t] of this.tracked) {
      if (this.ignored.has(path)) continue;
      try {
        const st = statSync(transcriptFile(path));
        // A live session is re-read every tick even when its own file has not
        // moved: its subagents write elsewhere, and their tokens are its tokens.
        const live = this.live.has(`${t.ref.provider}:${t.ref.agentSessionId}`);
        if (t.facts && !live && st.mtimeMs === t.ref.mtimeMs && st.size === t.ref.size) continue;
        t.ref = { ...t.ref, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        continue;
      }
      try {
        const r = await t.reader.refresh();
        t.facts = r.facts;
        if (r.facts.isSubagent) {
          this.ignored.add(path);
          continue;
        }
        if (r.changed) changed.add(path);
      } catch (e) {
        console.error(`agentbox: reading ${path} failed:`, e);
      }
    }

    this.matchPendingSpawns(now);
    this.followPaneSwitches(accounts);

    // Every transcript gets a record; changed ones get their record refreshed.
    for (const [path, t] of this.tracked) {
      if (!t.facts || this.ignored.has(path)) continue;
      const id = this.recordFor(t, settings.balancer, now);
      if (!changed.has(path)) continue;
      this.persistFacts(id, t, now);
      this.collectMetrics(id, t, now);
      this.emit("transcript", id);
    }

    this.linkParents(since);
    this.observeUsage(now);
    this.reapDeadPanes(now);
    this.reapParked(now);
    this.rebuildViews(since, now);
    await this.parkIdle(now, settings.parkIdleMin);
    this.continueStalled(now);
    for (const b of this.btwHistory.read(accountsOf("claude").map((a) => a.home))) this.watchTerminalBtw(b);
  }

  /**
   * A session that stopped at its account's limit carries on.
   *
   * A 5-hour window that resets within `RESET_WAIT_MS` is waited out: moving
   * costs a cold start and a fresh claim elsewhere, and the window is nearly
   * back. The session is told to go on a minute after the reset, where it is.
   *
   * Otherwise — a weekly limit, or a 5-hour one with more than that to go — it
   * continues on another account with room: what the "limits reset" button
   * does, done for you. Only when the balancer's pick is another account, and
   * never for one that has led an agent team: its teammates run inside it and
   * would not come back. The move proves the resume before it stops anything
   * (`wake`).
   *
   * Either way only for a fresh hit — a restart does not act on what stalled
   * hours ago — and once per hit.
   */
  private continueStalled(now: number): void {
    for (const [id, w] of this.resumeAfterReset) {
      if (now < w.at) continue;
      this.resumeAfterReset.delete(id);
      const v = this.views.get(id);
      // Still stopped at that same hit, and nobody has written to it since.
      if (!v || v.limitHit?.at !== w.hitAt || v.status !== "waiting" || v.host !== "tmux") continue;
      console.log(`agentbox: ${id} (${v.title}): its 5-hour window has reset; telling it to carry on`);
      void this.send(id, "[agentbox: the 5-hour usage limit has reset. Carry on where you left off.]").catch((e) =>
        console.error(`agentbox: continuing ${id} after its reset failed:`, e),
      );
    }
    for (const v of this.views.values()) {
      const hit = v.limitHit;
      if (!hit || now - hit.at > STALL_FRESH_MS || this.stallsMoved.get(v.id) === hit.at) continue;
      if (v.status !== "waiting" || v.host !== "tmux" || this.busy.has(v.id)) continue;
      const rec = getSessionRecord(v.id);
      if (!rec) continue;
      this.stallsMoved.set(v.id, hit.at);
      const windows = rec.accountId ? this.deps.usage.usageOf(this.ownerOf(rec.accountId))?.windows ?? [] : [];
      const weekly = weeklyWindow(windows);
      const short = windows.find((w) => w.kind === "short" && !w.scope);
      const weeklyOut = !!weekly && weekly.usedPct >= 100 && (weekly.resetsAt === null || weekly.resetsAt > now);
      if (!weeklyOut && short?.resetsAt && short.resetsAt > now && short.resetsAt - now <= RESET_WAIT_MS) {
        this.resumeAfterReset.set(v.id, { hitAt: hit.at, at: short.resetsAt + 60_000 });
        console.log(`agentbox: ${v.id} (${v.title}) stopped at its 5-hour limit, which resets in ${Math.round((short.resetsAt - now) / 60_000)}m; waiting it out`);
        continue;
      }
      if (!this.movable.has(v.provider)) continue;
      const t = v.transcriptPath ? this.tracked.get(v.transcriptPath) : undefined;
      if (t?.facts?.teamsLed?.length) continue;
      const target = this.wakeTarget(rec, v);
      if (!target) continue;
      const from = rec.accountId ? getAccount(rec.accountId)?.label ?? rec.accountId : "its account";
      const prompt = `[agentbox: ${from} hit its usage limit, so this session moved to ${target.account.label}. Carry on where you left off.]`;
      console.log(`agentbox: ${v.id} (${v.title}) stopped at its limit on ${from}; continuing it on ${target.account.label}`);
      void this.serial(v.id, () => this.moveAndContinue(v.id, { accountId: target.account.id, prompt })).catch((e) =>
        console.error(`agentbox: moving ${v.id} after its limit failed:`, e),
      );
    }
  }

  private track(adapter: ProviderAdapter, ref: TranscriptRef): void {
    if (this.ignored.has(ref.path)) return;
    const existing = this.tracked.get(ref.path);
    if (existing) return;
    this.tracked.set(ref.path, { ref: { ...ref, mtimeMs: -1 }, reader: adapter.reader(ref), facts: null, hitsSeen: -1, lastUsageAt: 0 });
  }

  private poolAgentOf(rec: Pick<SessionRecord, "provider" | "agentSessionId">): PoolAgent | undefined {
    return rec.agentSessionId ? this.pool.get(poolKey(rec.provider, rec.agentSessionId)) : undefined;
  }

  /** The session a pool agent's `owner` names: a client's `--session-id`, or
   *  the pid of a client that had none. */
  private sessionOfOwner(owner: string): string | null {
    const pid = /^pid:(\d+)$/.exec(owner)?.[1];
    if (pid) {
      const p = this.livePids.get(Number(pid));
      return p?.agentSessionId ? (this.byAgentId.get(`${p.provider}:${p.agentSessionId}`) ?? null) : null;
    }
    for (const provider of this.adapters.keys()) {
      const id = this.byAgentId.get(`${provider}:${owner}`) ?? findSessionRecord(provider, owner)?.id;
      if (id) return id;
    }
    return null;
  }

  private hasTranscriptFor(provider: ProviderId, agentSessionId: string): boolean {
    for (const t of this.tracked.values()) {
      if (t.ref.provider === provider && t.ref.agentSessionId === agentSessionId) return true;
    }
    return false;
  }

  /**
   * A provider that cannot be told its session id up front (codex, devin,
   * omp) writes a transcript some seconds after we start it. The session we
   * spawned is waiting with a null id; the first new transcript on the same
   * account, in the same directory, started after we did, is it.
   */
  private matchPendingSpawns(now: number): void {
    const defaults = new Set(listAccounts().filter((a) => a.isDefault).map((a) => a.id));
    const pending = listSessionRecords(now - MATCH_WINDOW_MS).filter(
      (r) => r.agentSessionId === null && r.origin === "agentbox" && now - r.createdAt < MATCH_WINDOW_MS,
    );
    for (const rec of pending) {
      // Strongest evidence first: the process in our pane says which session it is.
      const pane = rec.tmux ? this.panes.get(rec.tmux) : undefined;
      const proc = pane ? this.processUnder(pane.pid, rec.provider) : undefined;
      let agentId = proc?.agentSessionId ?? null;

      if (!agentId) {
        let best: Tracked | null = null;
        for (const t of this.tracked.values()) {
          const f = t.facts;
          if (!f || f.isSubagent || t.ref.provider !== rec.provider || this.pool.has(poolKey(rec.provider, f.agentSessionId))) continue;
          // Devin records no account per session, so its adapter lists every
          // transcript under the default account; a session we started on
          // another account still matches there.
          if (t.ref.accountId !== rec.accountId && !defaults.has(t.ref.accountId)) continue;
          if (this.byAgentId.has(`${rec.provider}:${f.agentSessionId}`)) continue;
          if (findSessionRecord(rec.provider, f.agentSessionId)) continue;
          if ((f.startedAt ?? 0) < rec.createdAt - 10_000) continue;
          if (!samePath(f.cwd, rec.cwd)) continue;
          if (!best || (f.startedAt ?? 0) < (best.facts!.startedAt ?? 0)) best = t;
        }
        agentId = best?.facts?.agentSessionId ?? null;
      }
      if (!agentId || findSessionRecord(rec.provider, agentId)) continue;
      updateSessionRecord(rec.id, { agentSessionId: agentId });
      this.byAgentId.set(`${rec.provider}:${agentId}`, rec.id);
    }
  }

  /**
   * Claude's `/resume` inside a running TUI swaps the conversation under the
   * same process. When the process in one of our panes reports a different
   * session than the row that owns the pane, the pane follows the process: the
   * row for the new conversation takes the tmux session and the account, and
   * the old row is left stopped.
   */
  private followPaneSwitches(accounts: Account[]): void {
    for (const rec of listSessionRecords(0)) {
      if (!rec.tmux || !rec.agentSessionId) continue;
      const pane = this.panes.get(rec.tmux);
      if (!pane || pane.dead) continue;
      const proc = this.processUnder(pane.pid, rec.provider);
      if (!proc?.agentSessionId || proc.agentSessionId === rec.agentSessionId) continue;
      let target = findSessionRecord(rec.provider, proc.agentSessionId);
      if (!target) {
        const account = accounts.find((a) => a.id === rec.accountId);
        if (!account) continue;
        const id = newSessionId();
        insertSessionRecord({
          ...rec,
          id,
          agentSessionId: proc.agentSessionId,
          label: null,
          transcriptPath: null,
          facts: null,
          archivedAt: null,
          createdAt: this.now(),
        });
        target = getSessionRecord(id);
      }
      if (!target) continue;
      updateSessionRecord(target.id, { tmux: rec.tmux, accountId: rec.accountId, archivedAt: null });
      updateSessionRecord(rec.id, { tmux: null });
      this.byAgentId.set(`${rec.provider}:${proc.agentSessionId}`, target.id);
      this.emit("paneMoved", rec.id, target.id);
    }
  }

  /** The provider process at `pid` or somewhere under it (a shell wrapper,
   *  `env`, a node shim in front of a native binary). */
  private processUnder(pid: number, provider: ProviderId): LiveProcess | undefined {
    const direct = this.livePids.get(pid);
    if (direct?.provider === provider) return direct;
    for (const p of this.livePids.values()) {
      if (p.provider === provider && isDescendant(p.pid, pid)) return p;
    }
    return undefined;
  }

  private recordFor(t: Tracked, settings: BalancerSettings, now: number): string {
    const f = t.facts!;
    const key = `${t.ref.provider}:${f.agentSessionId}`;
    const cached = this.byAgentId.get(key);
    if (cached) return cached;
    const existing = findSessionRecord(t.ref.provider, f.agentSessionId);
    if (existing) {
      this.byAgentId.set(key, existing.id);
      return existing.id;
    }
    const id = newSessionId();
    const started = f.startedAt ?? t.ref.mtimeMs;
    insertSessionRecord({
      id,
      provider: t.ref.provider,
      agentSessionId: f.agentSessionId,
      accountId: t.ref.accountId,
      cwd: f.cwd ?? "",
      worktree: null,
      label: null,
      big: false,
      // A session started outside agentbox still uses its account, so it
      // claims like any other; it just was not placed. Its model is known
      // from its transcript, so the claim is the model's.
      claim: claimFor({ model: f.model, big: false }, settings),
      origin: "external",
      tmux: null,
      transcriptPath: t.ref.path,
      startedAt: started,
      lastActivityAt: f.lastActivityAt ?? t.ref.mtimeMs,
      archivedAt: null,
      facts: compactFacts(f),
      createdAt: now,
    });
    this.byAgentId.set(key, id);
    return id;
  }

  /**
   * Who started each session, recorded once and kept. Only from proof:
   *
   * - A Claude teammate names its team on every record, and its lead's
   *   transcript records spawning members into that team.
   * - A process started inside another session — a Bash tool running `codex
   *   exec` or `claude -p`, an omp — has that session's process above it. Only
   *   while it runs, and only when its conversation began under that process:
   *   a session merely resumed from inside another one is not claimed by it.
   *
   * - A subagent-MCP pool agent names the session that asked for it in its
   *   record, whatever process it runs under — even the Project's.
   *
   * Sessions started through the API are given theirs at spawn. The Project
   * session launches top-level work, so it is otherwise never a parent.
   */
  private linkParents(since: number): void {
    const leads = new Map<string, string>();
    for (const t of this.tracked.values()) {
      if (!t.facts?.teamsLed?.length) continue;
      const lead = this.byAgentId.get(`${t.ref.provider}:${t.facts.agentSessionId}`);
      if (lead) for (const team of t.facts.teamsLed) leads.set(team, lead);
    }
    const project = this.deps.projectSession?.() ?? null;
    for (const rec of listSessionRecords(since)) {
      if (rec.parent) continue;
      const agent = this.poolAgentOf(rec);
      if (agent) {
        const owner = this.sessionOfOwner(agent.owner);
        if (owner && owner !== rec.id) updateSessionRecord(rec.id, { parent: owner });
        continue;
      }
      const team = rec.transcriptPath ? this.tracked.get(rec.transcriptPath)?.facts?.team : null;
      let parent = team ? leads.get(team) ?? null : null;
      const proc = rec.agentSessionId ? this.live.get(`${rec.provider}:${rec.agentSessionId}`) : undefined;
      if (!parent && proc && !this.ancestryChecked.has(`${rec.id}:${proc.pid}`)) {
        this.ancestryChecked.add(`${rec.id}:${proc.pid}`);
        if (rec.startedAt >= proc.startedAt - 5_000) parent = this.sessionAbove(proc.pid);
      }
      if (parent && parent !== rec.id && parent !== project) updateSessionRecord(rec.id, { parent });
    }
  }

  /** The session whose process `pid` runs under: the nearest ancestor that is
   *  a live session's own process. */
  private sessionAbove(pid: number): string | null {
    let cur = ppidOf(pid);
    for (let i = 0; i < 32 && cur !== null && cur > 1; i++) {
      const p = this.livePids.get(cur);
      if (p?.agentSessionId) {
        const id = this.byAgentId.get(`${p.provider}:${p.agentSessionId}`) ?? findSessionRecord(p.provider, p.agentSessionId)?.id;
        if (id) return id;
      }
      cur = ppidOf(cur);
    }
    return null;
  }

  private persistFacts(id: string, t: Tracked, now: number): void {
    const f = t.facts!;
    const rec = getSessionRecord(id);
    if (!rec) return;
    const patch: Partial<SessionRecord> = { facts: compactFacts(f), transcriptPath: t.ref.path };
    const last = f.lastActivityAt ?? t.ref.mtimeMs;
    // The transcript's newest turn is the record, so it also corrects a value
    // that was set too late; an mtime is only a guess and may only move it on.
    if (f.lastActivityAt !== null ? last !== rec.lastActivityAt : last > rec.lastActivityAt) patch.lastActivityAt = Math.min(last, now);
    if (f.cwd && !rec.cwd) patch.cwd = f.cwd;
    // A model switch (/model) changes what the session costs: its claim
    // follows. A wake's claim already counts what was consumed before it, so
    // only a real change rewrites it, never the same model re-read.
    if (f.model && f.model !== (rec.facts as Partial<TranscriptFacts> | null)?.model) {
      patch.claim = claimFor({ model: f.model, effort: rec.effort ?? null, big: rec.big }, getSettings().balancer);
    }
    // A message from you to a closed session means you went back to it.
    // Its own activity does not: an agent still finishing, or one another
    // agent wrote to, stays where you put it.
    if (rec.archivedAt && f.lastPromptAt !== null && f.lastPromptAt > rec.archivedAt) patch.archivedAt = null;
    updateSessionRecord(id, patch);
  }

  private collectMetrics(id: string, t: Tracked, now: number): void {
    const f = t.facts!;
    const rec = getSessionRecord(id);
    if (!rec) return;

    // A sample at most every minute while a session works, plus one when a
    // turn ends, so the interval between two usage readings can always be
    // bracketed by samples on both sides.
    const last = this.tokenSampled.get(id);
    const moved = f.tokens.costEquiv !== last?.costEquiv;
    const turnEnded = !f.turnOpen && (last?.turnOpen ?? true);
    if (f.tokens.costEquiv > 0 && moved && (!last || now - last.at >= TOKEN_SAMPLE_MS || turnEnded)) {
      insertTokenSample(id, now, f.tokens);
      this.tokenSampled.set(id, { at: now, costEquiv: f.tokens.costEquiv, turnOpen: f.turnOpen });
    } else if (last) {
      last.turnOpen = f.turnOpen;
    }

    if (t.hitsSeen < 0) t.hitsSeen = 0;
    for (const hit of f.rateLimitHits.slice(t.hitsSeen)) insertRateLimitHit(id, rec.accountId && this.ownerOf(rec.accountId), hit.at, hit.detail);
    t.hitsSeen = f.rateLimitHits.length;

    if (f.usage && f.usage.at > t.lastUsageAt && rec.accountId) {
      t.lastUsageAt = f.usage.at;
      this.deps.usage.ingestRollout?.(this.ownerOf(rec.accountId), f.usage);
    }
  }

  /** Feed each account's newest weekly reading to the attributor once. */
  private observeUsage(now: number): void {
    const records = listSessionRecords(now - 8 * DAY);
    const accounts = listAccounts();
    const owner = owners(accounts);
    for (const account of accounts) {
      // A twin's rises are its owner's rises; attributing both would count
      // every point twice. The owner takes the twin's sessions instead.
      if (owner.get(account.id) !== account.id) continue;
      const pool = new Set(accounts.filter((o) => owner.get(o.id) === account.id).map((o) => o.id));
      const usage = this.deps.usage.usageOf(account.id);
      const weekly = usage ? weeklyWindow(usage.windows) : null;
      if (!usage?.at || !weekly) continue;
      const key = `${usage.at}:${weekly.usedPct}`;
      if (this.lastWeekly.get(account.id) === key) continue;
      this.lastWeekly.set(account.id, key);
      const ids = records.filter((r) => r.accountId && pool.has(r.accountId)).map((r) => r.id);
      this.attributor.observe(
        account.id,
        { windowId: weekly.id, at: usage.at, usedPct: weekly.usedPct, resetsAt: weekly.resetsAt },
        ids,
      );
    }
  }

  private reapDeadPanes(now: number): void {
    for (const pane of this.panes.values()) {
      if (!pane.dead) {
        this.deadSince.delete(pane.name);
        continue;
      }
      const since = this.deadSince.get(pane.name) ?? now;
      this.deadSince.set(pane.name, since);
      if (now - since > DEAD_PANE_MS && pane.clients === 0) this.deps.runtime.killSession(pane.name);
    }
  }

  // -------------------------------------------------------------- parking

  /**
   * Stop the process of every Claude session in our tmux that has sat idle
   * for `idleMin` with nothing holding it up (src/core/park.ts says what
   * holds). The session stays on the board as waiting, and a message or a
   * resume brings it back — with the prompt cache cold after this long, a
   * resume costs no more than keeping it would have.
   *
   * The unit is the tmux session: a lead's teammates run as panes in it and
   * go with it, so every pane must be idle too. Nothing is stopped before
   * its resume is proven (directory and transcript), as with adopt.
   *
   * "Running" counts too once the turn has been silent for `STALE_TURN_MS`:
   * Claude's status file stays "busy" for days on a lead with teammates. A
   * session showing a permission prompt ("blocked") is never parked — it is
   * waiting on you for something a resume would lose.
   */
  private async parkIdle(now: number, idleMin: number): Promise<void> {
    if (!idleMin) {
      this.parkHolds.clear();
      this.parkClean.clear();
      return;
    }
    if (now < this.nextParkCheck) return;
    this.nextParkCheck = now + PARK_CHECK_MS;
    const idleMs = idleMin * 60_000;
    const project = this.deps.projectSession?.() ?? null;
    const candidates = [...this.views.values()].filter(
      (v) =>
        v.provider === "claude" &&
        v.host === "tmux" &&
        v.tmux &&
        v.id !== project &&
        (this.liveStatus.get(v.id) === "waiting"
          ? now - v.lastActivityAt >= idleMs
          : this.liveStatus.get(v.id) === "running" && now - v.lastActivityAt >= Math.max(idleMs, STALE_TURN_MS)),
    );
    const holds = new Map<string, string>();
    const clean = new Map<string, ParkCheck>();
    if (candidates.length > 0) {
      const table = await readProcTable().catch(() => null);
      const panes = new Map<string, PaneInfo[]>();
      for (const p of this.deps.runtime.listPanes()) panes.set(p.name, [...(panes.get(p.name) ?? []), p]);
      const live = readLive().filter((e) => subagentWorking(e.text));
      let parked = false;
      for (const v of candidates) {
        // Let the server answer between candidates.
        await Bun.sleep(0);
        try {
          if (!table) {
            holds.set(v.id, "the process table could not be read");
            continue;
          }
          const check = await this.parkHold(v, table, panes.get(v.tmux!) ?? [], live, now, idleMs);
          if (typeof check === "string") {
            holds.set(v.id, check);
            continue;
          }
          // Clean twice in a row, a check apart, with nothing moved in
          // between: one look can land in the gap between two rounds of
          // anything.
          const prev = this.parkClean.get(v.id);
          clean.set(v.id, check);
          if (!prev || prev.activity !== check.activity) {
            holds.set(v.id, "idle; parked at the next check if it still is");
            continue;
          }
          const cores = (check.cpuTicks - prev.cpuTicks) / clockHz() / Math.max(1, (check.at - prev.at) / 1000);
          if (cores > BUSY_CORES_PER_AGENT * check.agents) {
            clean.delete(v.id);
            holds.set(v.id, `it is using ${Math.round(cores * 100)}% of a core`);
            continue;
          }
          // Checked last and fresh: you may have sent it something, stopped
          // it or resumed it while the checks above ran.
          const touched = this.touched.get(v.id) ?? 0;
          if (this.busy.has(v.id) || this.now() - touched < idleMs) {
            holds.set(v.id, `you acted on it ${minutes(this.now() - touched)} ago`);
            continue;
          }
          const rec = getSessionRecord(v.id);
          if (!rec?.agentSessionId || !rec.transcriptPath || !existsSync(transcriptFile(rec.transcriptPath))) {
            holds.set(v.id, "its transcript is missing, so it could not be resumed");
            continue;
          }
          try {
            if (!existsSync(this.resumeCwd(rec))) throw new Error("gone");
          } catch {
            holds.set(v.id, "it could not be proven to resume, so it is left running");
            continue;
          }
          // The last look, just before the kill: a transcript that grew or a
          // shell that appeared since the first check means something woke.
          if (stirred(prev, check)) {
            clean.delete(v.id);
            holds.set(v.id, "something stirred since the last check");
            continue;
          }
          if (this.deps.runtime.listPanes().some((p) => p.name === v.tmux && p.clients > 0)) {
            holds.set(v.id, "a terminal or browser is attached to it");
            continue;
          }
          const starts = check.agentPids.map((pid) => [pid, startedAtOf(pid)] as const);
          this.deps.runtime.killSession(v.tmux!);
          clean.delete(v.id);
          if (this.paneAlive(v.tmux)) {
            holds.set(v.id, "tmux did not stop it");
            continue;
          }
          for (const [pid, start] of starts) this.dying.set(pid, { since: this.now(), start, termed: false });
          updateSessionRecord(v.id, { parkedAt: now, parkedMates: check.mates.length ? check.mates : null });
          // The board says so now, not a tick from now: a message sent in
          // between must resume it, not type into a pane that is gone.
          this.views.set(v.id, { ...v, status: v.status === "closed" ? "closed" : "waiting", host: "none", pid: null, tmux: null, parkedAt: now, parkHold: null });
          parked = true;
          const team = check.mates.length ? `, with teammates ${check.mates.join(", ")}` : "";
          console.log(`agentbox: parked ${v.id} (${v.title}) after ${minutes(now - v.lastActivityAt)} idle${team}`);
        } catch (e) {
          console.error(`agentbox: parking ${v.id} failed:`, e);
        }
      }
      if (parked) this.emit("sessions");
    }
    this.parkClean = clean;
    for (const path of this.wakeScans.keys()) if (!this.tracked.has(path)) this.wakeScans.delete(path);
    this.parkHolds = holds;
  }

  /**
   * A parked Claude that outlives its tmux session — it ignored the hangup,
   * or is slow to shut its MCP servers down — gets SIGTERM after 10s and
   * SIGKILL after two minutes: a process left behind is what parking is for.
   * The start time guards against a recycled pid.
   */
  private reapParked(now: number): void {
    for (const [pid, d] of this.dying) {
      if (!isAlive(pid) || startedAtOf(pid) !== d.start) {
        this.dying.delete(pid);
        continue;
      }
      try {
        if (now - d.since > 120_000) {
          // Its tool shells run in process groups of their own, which the
          // hangup never reached and nothing will clean up after a SIGKILL.
          for (const kid of childrenOf(pid)) {
            if (!isToolShell(argvOf(kid)?.join(" "))) continue;
            try {
              process.kill(-kid, "SIGTERM");
            } catch {
              /* not a group leader, or gone */
            }
          }
          process.kill(pid, "SIGKILL");
          this.dying.delete(pid);
        } else if (now - d.since > 10_000 && !d.termed) {
          process.kill(pid, "SIGTERM");
          d.termed = true;
        }
      } catch {
        this.dying.delete(pid);
      }
    }
  }

  /**
   * Why an idle session must keep running — or, when nothing holds it, what
   * it looked like, for the next check to compare against.
   */
  private async parkHold(
    v: Session,
    table: ProcTable,
    panes: PaneInfo[],
    live: { owner: string }[],
    now: number,
    idleMs: number,
  ): Promise<string | ParkCheck> {
    const quiet = now - v.lastActivityAt;
    if (panes.some((p) => p.clients > 0)) return "a terminal or browser is attached to it";
    const own = v.transcriptPath ? this.tracked.get(v.transcriptPath) : undefined;
    if (!own?.facts) return "its transcript has not been read yet";

    // Every pane is an agent: the lead, and teammates, which name their team
    // and themselves on the command line.
    const agents: { pid: number; team: string | null; name: string | null; sessionId: string | null; started: number }[] = [];
    for (const pane of panes) {
      if (pane.dead) continue;
      const argv = argvOf(pane.pid);
      if (!argv) continue; // exited since the listing
      if (!runsCli(argv, "claude")) return `a pane runs ${basename(argv[0] ?? "?")}, not claude`;
      const started = startedAtOf(pane.pid);
      if (started !== null && now - started < idleMs) return `started ${minutes(now - started)} ago`;
      const flag = (f: string) => {
        const i = argv.indexOf(f);
        return i === -1 ? null : (argv[i + 1] ?? null);
      };
      agents.push({ pid: pane.pid, team: flag("--team-name"), name: flag("--agent-name"), sessionId: flag("--session-id"), started: started ?? 0 });
    }

    // The conversations: its own, and every member's of a team with a pane
    // here — found by team, not by the lead's record of what it led, which a
    // `/clear` or a fork loses.
    const teams = new Set(agents.map((a) => a.team).filter((t): t is string => !!t));
    const family: { name: string; t: Tracked }[] = [{ name: "it", t: own }];
    for (const [path, t] of this.tracked) {
      if (t !== own && !this.ignored.has(path) && t.facts?.team && teams.has(t.facts.team)) {
        family.push({ name: `teammate ${t.facts.title ?? t.facts.agentSessionId.slice(0, 8)}`, t });
      }
    }
    // A team whose transcripts are not tracked has been quiet longer than
    // the board's window: nothing to check there beyond its processes below.
    const monitors = new Set<string>();
    for (const { name, t } of family) {
      const f = t.facts!;
      const at = f.lastActivityAt ?? 0;
      if (t !== own) {
        if (f.turnOpen && now - at < STALE_TURN_MS) return `${name} is mid-turn`;
        if (now - at < idleMs) return `${name} was active ${minutes(now - at)} ago`;
      }
      let scan = this.wakeScans.get(t.ref.path);
      if (!scan) this.wakeScans.set(t.ref.path, (scan = new WakeScan(t.ref.path)));
      // Timers set before these processes started died with the one before.
      const since = Math.min(...agents.map((a) => a.started), now);
      const wake = await scan.hold(now, since);
      if (wake) return name === "it" ? wake : `${name}: ${wake}`;
      for (const m of scan.monitors) monitors.add(m);
      const sub = subagentsLastWrite(t.ref.path, f.agentSessionId);
      if (sub !== null && now - sub < SUBAGENT_QUIET_MS) return `${name === "it" ? "its" : `${name}'s`} subagents are working`;
    }

    // What runs under each agent.
    const shells: number[] = [];
    let cpuTicks = 0;
    for (const a of agents) {
      // The subagent MCP names its owner by the `--session-id` its client was
      // started with, which a `/clear` does not change.
      const owners = [`pid:${a.pid}`, ...(a.sessionId ? [a.sessionId] : []), ...family.map((m) => m.t.facts!.agentSessionId)];
      if (live.some((e) => owners.includes(e.owner))) return "MCP subagents are running";
      cpuTicks += subtreeCpuTicks(subtree(table, a.pid));
      for (const kid of table.children.get(a.pid) ?? []) {
        const cmd = argvOf(kid)?.join(" ");
        if (!cmd || !isToolShell(cmd)) continue; // an MCP server
        shells.push(kid);
        const command = shellCommand(cmd);
        const label = describe({ ...table.byPid.get(kid)!, cmd });
        // A monitor's every line of output is a message to the session.
        if (monitors.has(normalCommand(command))) return `a monitor is running (${label})`;
        const running = subtree(table, kid)
          .filter((r) => r.pid !== kid)
          .map((r) => argvOf(r.pid)?.join(" ") ?? r.comm)
          .filter((c) => !bareShell(c));
        const hold = shellHold(classifyShell(command, running), label, quiet);
        if (hold) return hold;
      }
    }
    return {
      at: now,
      activity: v.lastActivityAt,
      cpuTicks,
      agents: Math.max(1, agents.length),
      agentPids: agents.map((a) => a.pid),
      shells,
      sizes: new Map(family.map((m) => [m.t.ref.path, sizeOf(m.t.ref.path)])),
      mates: agents.filter((a) => a.team && a.name).map((a) => a.name!),
    };
  }

  // ---------------------------------------------------------------- views

  private rebuildViews(since: number, now: number): void {
    const records = listSessionRecords(since);
    this.openIds = new Set(records.filter((r) => !r.archivedAt).map((r) => r.id));
    const seen = new Set<string>();
    let dirty = false;
    for (const rec of records) {
      const view = this.viewOf(rec, now);
      if (!view) continue;
      seen.add(rec.id);
      // Running again, however it got there (a resume here, or `claude
      // --resume` in some terminal): no longer parked.
      if (rec.parkedAt && view.host !== "none") {
        updateSessionRecord(rec.id, { parkedAt: null });
        view.parkedAt = null;
      }
      const fp = JSON.stringify(view);
      if (this.fingerprints.get(rec.id) !== fp) {
        this.fingerprints.set(rec.id, fp);
        dirty = true;
      }
      this.views.set(rec.id, view);
    }
    for (const id of [...this.views.keys()]) {
      if (!seen.has(id)) {
        this.views.delete(id);
        this.liveStatus.delete(id);
        this.fingerprints.delete(id);
        dirty = true;
      }
    }
    if (dirty) this.emit("sessions");
  }

  private viewOf(rec: SessionRecord, now: number): Session | null {
    const tracked = rec.transcriptPath ? this.tracked.get(rec.transcriptPath) : undefined;
    if (rec.transcriptPath && this.ignored.has(rec.transcriptPath)) return null;
    const f = (tracked?.facts ?? (rec.facts as Partial<TranscriptFacts> | null)) ?? null;
    const adapter = this.adapters.get(rec.provider);

    const pane = rec.tmux ? this.panes.get(rec.tmux) : undefined;
    const proc = rec.agentSessionId ? this.live.get(`${rec.provider}:${rec.agentSessionId}`) : undefined;
    const agent = this.poolAgentOf(rec);
    const pooled = agent ? this.poolStates.get(poolKey(rec.provider, rec.agentSessionId!)) : undefined;
    let host: SessionHost = "none";
    let pid: number | null = null;
    if (pane && !pane.dead) {
      host = "tmux";
      pid = pane.pid;
    } else if (proc && isAlive(proc.pid) && !(rec.parkedAt && proc.startedAt <= rec.parkedAt)) {
      // (A process older than the parking is the parked one, still exiting.)
      // One its MCP server outlived is nobody's, so it can be adopted.
      host = agent && isAlive(agent.serverPid) ? "subagent" : "external";
      pid = proc.pid;
    }

    let status: SessionStatus;
    // Parked is still your move: the fleet stopped the process, not you, and
    // the next message resumes it.
    if (host === "none") status = rec.parkedAt ? "waiting" : "stopped";
    else {
      // A pool agent's server knows whether its turn is open; its transcript can lag.
      const busy = host === "subagent" ? pooled?.running : proc?.busy;
      status = (busy ?? f?.turnOpen) ? "running" : "waiting";
      // Claude says so itself while a permission dialog is up, which is the
      // only way to know it for a session in some other terminal.
      if (proc?.waitingOn) {
        status = "blocked";
        this.blocked.set(rec.id, proc.waitingOn);
      }
      if (host === "tmux" && adapter?.blockedOn && pane) {
        const quietFor = now - (f?.lastActivityAt ?? 0);
        // A prompt waiting on you stalls the transcript, so only look at the
        // screen when it has been quiet for a moment.
        if (quietFor > 2_500 || status === "waiting") {
          const screen = this.deps.runtime.capture(pane.name);
          const shown = screen ? adapter.blockedOn(screen) : null;
          if (!shown) this.approved.delete(rec.id);
          // A session told to skip permissions is not waiting on you for one.
          const allowed = !!shown && !!screen && !!f?.skipsPermissions && this.approvePrompt(rec.id, pane.name, adapter, screen, shown, now);
          const why = allowed ? null : shown;
          if (why) {
            status = "blocked";
            this.blocked.set(rec.id, why);
          } else {
            this.blocked.delete(rec.id);
            if (allowed) status = "running";
          }
          // A question the transcript does not have: read it off the screen,
          // at a size it can be read at (the next look sees the redraw).
          const ask = why === "asking a question" && !f?.pendingAsk && screen && adapter.askOnScreen ? adapter.askOnScreen(screen) : null;
          if (ask) this.screenAsks.set(rec.id, ask);
          else {
            this.screenAsks.delete(rec.id);
            if (why === "asking a question" && !f?.pendingAsk) this.deps.runtime.unsquash?.(pane.name);
          }
        }
      }
      this.autoAnswer(rec, pane, adapter, now);
    }
    // Closed is your word, not the process's: a session you closed stays
    // closed even if a process outlived the stop (an external one that
    // ignored SIGTERM, a pane restarted by hand), until you send it
    // something (persistFacts).
    const live = status;
    this.liveStatus.set(rec.id, live);
    if (rec.archivedAt) status = "closed";
    // A stopped pool agent was a call in its caller's run: listed while that
    // run goes on, then history (See closed, resumable), never stranded at
    // the root of the board or piled under a caller that has stopped.
    else if (agent && host === "none" && !(rec.parent && this.openIds.has(rec.parent) && this.views.get(rec.parent)?.host !== "none")) {
      status = "closed";
    }

    const cwd = f?.cwd || rec.cwd;
    const lastActivityAt = f?.lastActivityAt ?? rec.lastActivityAt;
    // The limit message is the session's last word: nothing after it, bar the
    // odd bookkeeping line written in the same breath.
    const hit = f?.rateLimitHits?.at(-1) ?? null;
    const limitHit = hit && live !== "running" && hit.at >= lastActivityAt - 60_000 ? hit : null;
    const cold =
      this.movable.has(rec.provider) &&
      (live === "waiting" || live === "stopped") &&
      (host === "tmux" || host === "none") &&
      now - lastActivityAt > this.coldAfterMs;
    return {
      id: rec.id,
      provider: rec.provider,
      agentSessionId: rec.agentSessionId,
      accountId: rec.accountId ? this.ownerOf(rec.accountId) : null,
      status,
      host,
      title: rec.label || agent?.name || f?.title || headline(f?.firstPrompt) || basename(cwd) || rec.provider,
      label: rec.label,
      cwd,
      repoRoot: repoRootOf(cwd),
      branch: f?.gitBranch ?? null,
      worktree: rec.worktree,
      model: f?.model ?? null,
      firstPrompt: f?.firstPrompt ?? null,
      lastPrompt: f?.lastPrompt ?? null,
      lastPromptAt: f?.lastPromptAt ?? rec.startedAt,
      lastMessage: f?.lastMessage ?? null,
      contextUsed: f?.contextUsed ?? null,
      contextLimit: f?.contextLimit ?? null,
      tokens: f?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 },
      big: rec.big,
      claim: rec.claim,
      effort: rec.effort ?? null,
      cold,
      limitHit,
      // Only while the dialog is up: a call recorded but not yet answered is
      // also what a session interrupted mid-question leaves behind.
      question: live === "blocked" && host === "tmux" ? (f?.pendingAsk ?? this.screenAsks.get(rec.id) ?? null) : null,
      origin: rec.origin,
      parent: rec.parent ?? null,
      subagent: agent
        ? { name: agent.name, answerWaiting: host === "subagent" && !!pooled?.answerWaiting }
        : null,
      pid,
      tmux: host === "tmux" || (pane && pane.dead) ? rec.tmux : null,
      transcriptPath: rec.transcriptPath,
      startedAt: rec.startedAt,
      // When the conversation last moved. Starting or resuming a process is not
      // activity: a session resumed and left alone is as idle as before.
      lastActivityAt,
      closedAt: rec.archivedAt,
      parkedAt: host === "none" ? (rec.parkedAt ?? null) : null,
      parkHold: host === "tmux" ? (this.parkHolds.get(rec.id) ?? null) : null,
    };
  }

  private autoAnswer(rec: SessionRecord, pane: PaneInfo | undefined, adapter: ProviderAdapter | undefined, now: number): void {
    if (!pane || !adapter?.autoAnswer) return;
    const started = this.startedAt.get(rec.id);
    if (!started || now - started > AUTO_ANSWER_MS) return;
    // With scrollback: a short pane (tmux sizes a window to its latest client)
    // scrolls a dialog's top — and any "pre-approves permissions" line — out
    // of view. Only the first minutes after a start get here, so the history
    // is this start-up's and nothing older.
    const screen = this.deps.runtime.capture(pane.name, { scrollback: 200 });
    if (!screen) return;
    const keys = adapter.autoAnswer(screen, { bypassPermissions: getSettings().autoApprove });
    if (!keys) return;
    // Claude's trust dialog ignores keys for a moment after it opens, so the
    // same screen again is worth another try — a few, spaced out, then stop:
    // pressing keys forever into a dialog we misread is worse than leaving it.
    const sig = screen.trim().slice(-400);
    const prev = this.answered.get(rec.id);
    if (prev && prev.sig === sig && (prev.tries >= 4 || now - prev.at < 1_500)) return;
    this.answered.set(rec.id, { sig, at: now, tries: prev && prev.sig === sig ? prev.tries + 1 : 1 });
    try {
      this.deps.runtime.sendKeys(pane.name, keys);
    } catch {
      /* the pane went away between capture and keys */
    }
  }

  /**
   * Allow the permission prompt a skip-permissions session is showing anyway.
   * True while it is being handled: keys went in, or went in a moment ago and
   * the screen has not caught up. A dialog that ignores them gets a few
   * tries and is then left to you, like `autoAnswer`'s.
   */
  private approvePrompt(id: string, pane: string, adapter: ProviderAdapter, screen: string, what: string, now: number): boolean {
    const keys = adapter.approvePrompt?.(screen);
    if (!keys) return false;
    const sig = screen.trim().slice(-400);
    const prev = this.approved.get(id);
    if (prev && prev.sig === sig) {
      if (prev.tries >= 3) return false;
      if (now - prev.at < 1_500) return true;
    }
    this.approved.set(id, { sig, at: now, tries: prev && prev.sig === sig ? prev.tries + 1 : 1 });
    try {
      this.deps.runtime.sendKeys(pane, keys);
    } catch {
      return false; // the pane went away between capture and keys
    }
    console.log(`agentbox: ${id} skips permissions; allowed its prompt (${what})`);
    return true;
  }

  // --------------------------------------------------------------- reading

  sessions(): Session[] {
    return [...this.views.values()];
  }

  get(id: string): Session {
    const s = this.views.get(id);
    if (s) return s;
    const rec = getSessionRecord(id);
    const view = rec ? this.viewOf(rec, this.now()) : null;
    if (!view) throw new FleetError(404, `no session ${id}`);
    return view;
  }

  /**
   * Closed sessions for the See closed list, most recently closed first: all
   * of them, not only the board's window, so an old one can be found and
   * reopened. `q` matches as the board's search does; `offset` pages.
   */
  closed(q: string, offset: number, limit: number): { sessions: Session[]; total: number } {
    const needle = q.trim().toLowerCase();
    const all: Session[] = [];
    for (const rec of listClosedRecords()) {
      const s = this.views.get(rec.id) ?? this.viewOf(rec, this.now());
      if (!s) continue;
      if (needle && ![s.label, s.title, s.cwd, s.branch, s.lastMessage, s.firstPrompt, s.id, s.model, s.provider].some((x) => x?.toLowerCase().includes(needle))) continue;
      all.push(s);
    }
    return { sessions: all.slice(offset, offset + limit), total: all.length };
  }

  blockedReason(id: string): string | null {
    return this.blocked.get(id) ?? null;
  }

  private readerOf(id: string): TranscriptReader {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    const t = rec.transcriptPath ? this.tracked.get(rec.transcriptPath) : undefined;
    if (!t) throw new FleetError(404, `session ${id} has no transcript yet`);
    return t.reader;
  }

  timeline(id: string, before: string | null, limit: number): Promise<TimelinePage> {
    return this.readerOf(id).timeline({ before, limit });
  }

  since(id: string, cursor: string): Promise<{ events: TimelineEvent[]; cursor: string; reset: boolean }> {
    return this.readerOf(id).since(cursor);
  }

  hasTranscript(id: string): boolean {
    try {
      this.readerOf(id);
      return true;
    } catch {
      return false;
    }
  }

  /** Claims per account, as the balancer and the Accounts page see them. */
  claims(): Map<string, ClaimView[]> {
    const now = this.now();
    const settings = getSettings().balancer;
    const inputs: ClaimInput[] = [];
    for (const s of this.views.values()) {
      // A closed session with a process still alive can still spend.
      if (!s.accountId || (s.status === "closed" && s.host === "none")) continue;
      // A teammate, a pool agent, or a run another session started: the balancer never
      // placed it and its parent's claim already counts it. What it really
      // spends shows in the account's measured pace.
      if ((s.parent && s.origin !== "agentbox") || s.subagent) continue;
      inputs.push({
        sessionId: s.id,
        accountId: s.accountId,
        title: s.title,
        big: s.big,
        claim: s.claim,
        lastActivityAt: s.lastActivityAt,
        running: s.status === "running" || s.status === "blocked",
      });
    }
    return claimsByAccount(inputs, consumedBy(inputs.map((i) => i.sessionId)), settings, now);
  }

  /** The account a home belongs to (itself unless it is a twin). */
  ownerOf(homeId: string): string {
    return this.owner.get(homeId) ?? homeId;
  }

  /**
   * The balancer's input: one entry per account, not per home. A twin home is
   * not a candidate, and its sessions' claims are already the owner's (a
   * session's `accountId` is its home's owner).
   */
  accountStates(provider: ProviderId): AccountState[] {
    const claims = this.claims();
    const all = listAccounts(provider);
    const owner = owners(all);
    const since = this.now() - 90 * 60_000;
    return all
      .filter((a) => owner.get(a.id) === a.id)
      .map((a) => {
        const windows = this.deps.usage.usageOf(a.id)?.windows ?? [];
        const short = windows.find((w) => w.kind === "short" && !w.scope);
        return {
          account: a,
          windows,
          // For its pace: how fast the 5-hour window is really filling.
          shortSamples: short
            ? usageSamplesSince(since, a.id)
                .filter((r) => r.windowId === short.id)
                .map((r) => ({ at: r.at, usedPct: r.usedPct, resetsAt: r.resetsAt }))
            : [],
          outstanding: (claims.get(a.id) ?? []).map((c) => c.outstanding),
          loggedOut: this.deps.usage.authOf?.(a.id) === "missing",
        };
      });
  }

  placement(provider: ProviderId, big: boolean, model?: string | null, accountId?: string | null, effort?: string | null): Placement {
    this.adapter(provider);
    return place({
      provider,
      big,
      model: model || getSettings().models[provider] || null,
      effort: effort ?? null,
      accountId: accountId && accountId !== "auto" ? accountId : null,
      accounts: this.accountStates(provider),
      settings: getSettings().balancer,
      now: this.now(),
    });
  }

  // --------------------------------------------------------------- actions

  async spawn(req: SpawnRequest): Promise<{ session: Session; placement: Placement }> {
    const adapter = this.adapter(req.provider);
    const settings = getSettings();
    if (req.effort && !adapter.efforts.includes(req.effort)) {
      throw new FleetError(400, `${adapter.label} takes no effort "${req.effort}"${adapter.efforts.length ? ` (${adapter.efforts.join(", ")})` : ""}`);
    }
    const effort = req.effort || undefined;
    const placement = this.placement(req.provider, !!req.big, req.model, req.accountId, effort);
    if (!placement.accountId) throw new FleetError(409, placement.why, placement);
    const account = getAccount(placement.accountId);
    if (!account) throw new FleetError(404, `no account ${placement.accountId}`);

    if (req.id && getSessionRecord(req.id)) throw new FleetError(409, `there is already a session ${req.id}`);
    const id = req.id ?? newSessionId();
    let cwd = req.cwd ? expandHome(req.cwd) : "";
    let worktree: string | null = null;
    if (req.repoId) {
      const repo = getRepoById(req.repoId);
      if (!repo) throw new FleetError(404, `no repo ${req.repoId}`);
      if (req.branch) {
        const wt = worktreeForBranch(repo, id, req.branch, req.pr);
        cwd = wt.path;
        worktree = wt.created ? wt.path : null;
      } else if (req.worktree) {
        const wt = createWorktree(repo, id, `ab/${id}`);
        cwd = wt.path;
        worktree = wt.path;
      } else if (repo.kind === "local") {
        cwd = repo.ref;
      } else {
        throw new FleetError(400, "a GitHub repo needs a worktree (it has no checkout of its own to work in)");
      }
    }
    if (!cwd) throw new FleetError(400, "say where the session should run: a repo or a directory");
    if (!existsSync(cwd)) throw new FleetError(400, `no such directory: ${cwd}`);

    const model = req.model || settings.models[req.provider] || undefined;
    const cmd = adapter.spawnCommand({ account, cwd, prompt: req.prompt || undefined, model, effort, autoApprove: settings.autoApprove });
    const now = this.now();
    const name = tmuxName(id);
    const parent = req.callerPid ? this.sessionAbove(req.callerPid) : null;

    insertSessionRecord({
      id,
      provider: req.provider,
      agentSessionId: cmd.agentSessionId,
      accountId: account.id,
      cwd,
      worktree,
      label: null,
      big: !!req.big,
      claim: placement.claim,
      origin: "agentbox",
      tmux: name,
      transcriptPath: null,
      startedAt: now,
      lastActivityAt: now,
      archivedAt: null,
      facts: req.prompt ? { firstPrompt: req.prompt, lastPrompt: req.prompt, lastPromptAt: now, cwd } : { cwd },
      createdAt: now,
      effort: effort ?? null,
      model: model ?? null,
      parent: parent && parent !== this.deps.projectSession?.() ? parent : null,
    });
    if (cmd.agentSessionId) this.byAgentId.set(`${req.provider}:${cmd.agentSessionId}`, id);
    insertAssignment({
      id: randomUUID(),
      sessionId: id,
      at: now,
      provider: req.provider,
      accountId: account.id,
      mode: placement.mode,
      big: !!req.big,
      claim: placement.claim,
      candidates: placement.candidates,
      settings: settings.balancer,
      why: placement.why,
    });

    try {
      this.deps.runtime.newSession({ name, cwd, argv: cmd.argv, env: cmd.env, unset: cmd.unset });
    } catch (e) {
      updateSessionRecord(id, { tmux: null });
      throw new FleetError(500, (e as Error).message);
    }
    this.startedAt.set(id, now);
    await this.tick();
    return { session: this.get(id), placement };
  }

  /** Where a session can be resumed from, proven — or why not. */
  private resumeCwd(rec: SessionRecord): string {
    const t = rec.transcriptPath ? this.tracked.get(rec.transcriptPath) : undefined;
    const f = t?.facts ?? (rec.facts as Partial<TranscriptFacts> | null);
    const proven = f?.resumeCwd ?? null;
    if (proven) return proven;
    // Claude finds a transcript by the slug of the cwd it is started in, so
    // guessing wrong starts an empty session and — for adopt — would kill the
    // real one first. The others look sessions up by id.
    if (rec.provider === "claude") {
      throw new FleetError(409, "cannot prove which directory this session resumes from, so it will not be restarted automatically");
    }
    return f?.cwd || rec.cwd;
  }

  /**
   * Run `fn` once any action already under way on the session is done. Two
   * messages to a parked session must not each resume it: the second start
   * kills the first's process, and its message with it.
   */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    this.touched.set(id, this.now());
    const run = (this.busy.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.busy.set(id, tail);
    void tail.then(() => {
      if (this.busy.get(id) === tail) this.busy.delete(id);
    });
    return run;
  }

  /** Is the tmux session up right now? Asked of tmux, not the last pass. */
  private paneAlive(name: string | null | undefined): boolean {
    return !!name && this.deps.runtime.listPanes().some((p) => p.name === name && !p.dead);
  }

  resume(id: string, prompt?: string): Promise<Session> {
    return this.serial(id, () => this.resumeNow(id, prompt));
  }

  private async resumeNow(id: string, prompt?: string): Promise<Session> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    const view = this.get(id);
    if (view.host === "subagent") throw this.callersAgent(view);
    if (view.host !== "none" || this.paneAlive(rec.tmux)) throw new FleetError(409, `session is already running (${view.host === "none" ? "tmux" : view.host})`);
    // Its teammates were stopped with it and do not come back; say so, or it
    // will message them and wait for answers that never come.
    if (prompt && rec.parkedAt && rec.parkedMates?.length) {
      prompt = `[agentbox: this session was parked while idle, and its teammates (${rec.parkedMates.join(", ")}) were stopped with it — they are no longer running.]\n\n${prompt}`;
    }
    if (!rec.agentSessionId) throw new FleetError(409, "this session never started a conversation, so there is nothing to resume");
    const account = rec.accountId ? getAccount(rec.accountId) : null;
    if (!account) throw new FleetError(409, "this session's account is no longer set up; add it back to resume on the same account");
    const cwd = this.resumeCwd(rec);
    if (!existsSync(cwd)) throw new FleetError(409, `the session's directory is gone: ${cwd}`);
    if (view.cold) {
      await this.wake(rec, view, account, cwd, this.wakeTarget(rec, view), prompt);
    } else {
      this.startTmux(rec, account, cwd, prompt);
    }
    await this.tick();
    return this.get(id);
  }

  /**
   * Where a cold session should wake: the balancer's pick for a session like
   * it, when that is another account. Null means stay — the pick is where it
   * already is, or nothing can take it and a pinned session beats none.
   */
  private wakeTarget(rec: SessionRecord, view: Session, accountId?: string | null): { account: Account; placement: Placement } | null {
    if (!this.adapter(rec.provider).moveSession) return null;
    const placement = this.placement(rec.provider, rec.big, view.model, accountId, rec.effort ?? null);
    // Another home on the same login is the same account: moving there would
    // cost a cold start and change nothing about the limits.
    if (!placement.accountId || placement.mode === "none" || placement.accountId === this.ownerOf(rec.accountId ?? "")) return null;
    const account = getAccount(placement.accountId);
    return account ? { account, placement } : null;
  }

  /**
   * Continue a session whose prompt cache is cold (or that stopped at its
   * account's limit), on `target` when given, else where it is. Proves the
   * resume first — directory, transcript — and only then stops what is
   * running, moves the transcript over, and resumes with `prompt`. A move
   * that fails resumes on the old account rather than not at all.
   *
   * The session claims afresh either way: what it used before it went cold
   * was used, and the balancer should count what it is about to use.
   */
  private async wake(
    rec: SessionRecord,
    view: Session,
    from: Account,
    cwd: string,
    target: { account: Account; placement: Placement } | null,
    prompt?: string,
  ): Promise<void> {
    const adapter = this.adapter(rec.provider);
    if (target && (!rec.transcriptPath || !existsSync(transcriptFile(rec.transcriptPath)))) {
      throw new FleetError(409, "its transcript is missing, so it cannot be moved to another account");
    }
    if (view.host === "external") throw new FleetError(409, "running in another terminal — adopt it first");
    if (view.host === "tmux") await this.stopAndWait(rec, view);

    let account = from;
    let transcriptPath = rec.transcriptPath;
    if (target) {
      try {
        transcriptPath = adapter.moveSession!({ from, to: target.account, agentSessionId: rec.agentSessionId!, transcriptPath: rec.transcriptPath! });
        account = target.account;
      } catch (e) {
        console.error(`agentbox: moving ${rec.id} to ${target.account.label} failed; resuming on ${from.label}:`, e);
      }
    }
    const settings = getSettings();
    const consumed = consumedBy([rec.id]).get(rec.id) ?? 0;
    // It claims afresh, and the claim is its model's: what it used before it
    // went cold was used, and the balancer should count what it is about to.
    const fresh = claimFor({ model: view.model, effort: rec.effort ?? null, big: rec.big }, settings.balancer);
    const claim = Math.round((consumed + fresh) * 100) / 100;
    const patch: Partial<SessionRecord> = { claim };
    if (account.id !== from.id) {
      patch.accountId = account.id;
      patch.transcriptPath = transcriptPath;
      if (rec.transcriptPath && rec.transcriptPath !== transcriptPath) this.tracked.delete(rec.transcriptPath);
      const p = target!.placement;
      insertAssignment({
        id: randomUUID(),
        sessionId: rec.id,
        at: this.now(),
        provider: rec.provider,
        accountId: account.id,
        mode: p.mode,
        big: rec.big,
        claim,
        candidates: p.candidates,
        settings: settings.balancer,
        why: `moved from ${from.label}: ${p.why}`,
      });
    }
    updateSessionRecord(rec.id, patch);
    if (account.id !== from.id) {
      const ref = await adapter.findTranscript(account, rec.agentSessionId!).catch(() => null);
      if (ref) this.track(adapter, ref);
    }
    this.startTmux({ ...rec, ...patch }, account, cwd, prompt);
  }

  /** End the session's process in our tmux and wait until it is gone, so
   *  nothing is still writing the transcript when it moves. */
  private async stopAndWait(rec: SessionRecord, view: Session): Promise<void> {
    const pane = rec.tmux ? this.panes.get(rec.tmux) : undefined;
    const pid = (pane ? this.processUnder(pane.pid, rec.provider)?.pid : undefined) ?? view.pid;
    if (rec.tmux) this.deps.runtime.killSession(rec.tmux);
    if (!pid) return;
    const start = this.now();
    let termed = false;
    while (isAlive(pid)) {
      if (!termed && this.now() - start > 5_000) {
        termed = true;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
      if (this.now() - start > 20_000) throw new FleetError(409, `the process (${pid}) did not exit within 20s; nothing was moved or resumed`);
      await Bun.sleep(200);
    }
    await Bun.sleep(500);
  }

  /**
   * Continue a session on another account: the "limits reset" button for a
   * session that stopped at its account's limit. `accountId` absent or
   * "auto" is the balancer's pick; the pick being where it already is just
   * continues it there.
   */
  async moveAndContinue(id: string, opts: { accountId?: string | null; prompt?: string }): Promise<Session> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    const view = this.get(id);
    if (view.host === "subagent") throw this.callersAgent(view);
    if (view.host === "external") throw new FleetError(409, "running in another terminal — adopt it first");
    if (view.status === "running") throw new FleetError(409, "it is mid-turn; interrupt it first");
    if (!rec.agentSessionId) throw new FleetError(409, "this session never started a conversation");
    const from = rec.accountId ? getAccount(rec.accountId) : null;
    if (!from) throw new FleetError(409, "this session's account is no longer set up");
    const accountId = opts.accountId && opts.accountId !== "auto" ? opts.accountId : null;
    const target = this.wakeTarget(rec, view, accountId);
    if (accountId && accountId !== this.ownerOf(from.id) && !target) {
      throw new FleetError(409, this.adapter(rec.provider).moveSession ? `no ${rec.provider} account ${accountId}` : `${this.adapter(rec.provider).label} sessions cannot change account`);
    }
    if (!target && view.host === "tmux" && view.tmux) {
      if (opts.prompt) await this.deps.runtime.sendText(view.tmux, opts.prompt);
      return view;
    }
    const cwd = this.resumeCwd(rec);
    if (!existsSync(cwd)) throw new FleetError(409, `the session's directory is gone: ${cwd}`);
    await this.wake(rec, view, from, cwd, target, opts.prompt);
    await this.tick();
    return this.get(id);
  }

  private startTmux(rec: SessionRecord, account: Account, cwd: string, prompt?: string): void {
    const settings = getSettings();
    const cmd = this.adapter(rec.provider).resumeCommand({
      account,
      agentSessionId: rec.agentSessionId!,
      cwd,
      prompt: prompt || undefined,
      ...(rec.effort ? { effort: rec.effort } : {}),
      ...(resumeModel(rec) ? { model: resumeModel(rec)! } : {}),
      autoApprove: settings.autoApprove,
      ...(rec.launch ? { carry: rec.launch.args } : {}),
    });
    const name = tmuxName(rec.id);
    // A dead pane from the last run holds the name.
    this.deps.runtime.killSession(name);
    // The account's variables win over the launching shell's.
    const env = { ...rec.launch?.env, ...cmd.env };
    this.deps.runtime.newSession({ name, cwd, argv: cmd.argv, env, unset: cmd.unset });
    updateSessionRecord(rec.id, { tmux: name, archivedAt: null, parkedAt: null, parkedMates: null });
    this.startedAt.set(rec.id, this.now());
    this.answered.delete(rec.id);
  }

  /**
   * Move a session running in some other terminal into our tmux: prove the
   * resume will land, stop the process, wait for it to be gone, resume. In
   * that order, always — killing first and then finding the resume cannot
   * work is how a session gets destroyed.
   */
  async adopt(id: string): Promise<Session> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    const view = this.get(id);
    if (view.host === "subagent") throw this.callersAgent(view);
    if (view.host !== "external" || !view.pid) throw new FleetError(409, "only a session running in another terminal can be adopted");
    if (!rec.agentSessionId) throw new FleetError(409, "cannot tell which conversation that process is");
    const account = rec.accountId ? getAccount(rec.accountId) : null;
    if (!account) throw new FleetError(409, "this session's account is not set up in agentbox");
    const cwd = this.resumeCwd(rec);
    if (!existsSync(cwd)) throw new FleetError(409, `the session's directory is gone: ${cwd}`);
    if (!rec.transcriptPath || !existsSync(transcriptFile(rec.transcriptPath))) throw new FleetError(409, "its transcript is missing, so a resume would start empty");

    const pid = view.pid;
    // Read how it was launched before it is gone: the resume keeps its flags
    // and its shell's environment (src/core/launch.ts).
    const adapter = this.adapter(rec.provider);
    const argv = argvOf(pid) ?? [];
    if (adapter.headless?.(argv)) throw new FleetError(409, "a scripted one-shot run: something is waiting on its output, so it is left alone");
    const env = environOf(pid);
    const launch: Launch = { args: adapter.carryOver?.(argv) ?? [], env: env ? carryEnv(env, process.env) : {} };
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = this.now() + 20_000;
    while (isAlive(pid)) {
      if (this.now() > deadline) {
        throw new FleetError(409, `the process (${pid}) did not exit within 20s; nothing was resumed, so there is still exactly one copy running`);
      }
      await Bun.sleep(300);
    }
    // Let the CLI's own exit bookkeeping (session files, locks) settle.
    await Bun.sleep(500);
    updateSessionRecord(id, { launch });
    this.startTmux({ ...rec, launch }, account, cwd);
    await this.tick();
    return this.get(id);
  }

  /** Type into the session. A cold one wakes where there is room, which may
   *  mean restarting it on another account with `text` as its prompt; a
   *  parked one resumes with `text` as its prompt. */
  send(id: string, text: string): Promise<void> {
    return this.serial(id, () => this.sendNow(id, text));
  }

  private async sendNow(id: string, text: string): Promise<void> {
    const s = this.get(id);
    if (s.host === "none") {
      const rec = getSessionRecord(id);
      // Back already — an earlier message resumed it, and the board lags
      // a pass behind.
      if (rec?.tmux && this.paneAlive(rec.tmux)) {
        await this.untilReady(id);
        if (s.provider === "claude") await this.clearBtw(id, rec.tmux);
        return this.deps.runtime.sendText(rec.tmux, text);
      }
      // Parked by the fleet, not stopped by you: this is what wakes it.
      if (rec?.parkedAt) {
        await this.resumeNow(id, text);
        return;
      }
      throw new FleetError(409, "not running — resume it first");
    }
    if (s.host === "subagent") throw this.callersAgent(s);
    if (s.host !== "tmux" || !s.tmux) {
      throw new FleetError(409, "running in another terminal — adopt it to type here");
    }
    const rec = s.cold ? getSessionRecord(id) : null;
    const target = rec ? this.wakeTarget(rec, s) : null;
    const from = rec?.accountId ? getAccount(rec.accountId) : null;
    if (rec && target && from && rec.agentSessionId) {
      let cwd: string | null = null;
      try {
        cwd = this.resumeCwd(rec);
      } catch {
        /* cannot prove a resume: type into it where it is */
      }
      if (cwd && existsSync(cwd)) {
        await this.wake(rec, s, from, cwd, target, text);
        await this.tick();
        return;
      }
    }
    await this.untilReady(id);
    if (s.provider === "claude") await this.clearBtw(id, s.tmux);
    await this.deps.runtime.sendText(s.tmux, text);
  }

  /**
   * A TUI started moments ago drops what is typed before it is up. Wait —
   * at most 30s from its start — until its process is seen (Claude writes
   * its session file once running), and a moment more.
   */
  private async untilReady(id: string): Promise<void> {
    const started = this.startedAt.get(id);
    if (!started) return;
    const rec = getSessionRecord(id);
    if (!rec?.agentSessionId) return; // nothing to watch for (a fresh codex or devin)
    const key = `${rec.provider}:${rec.agentSessionId}`;
    while (this.now() - started < 30_000) {
      const p = this.live.get(key);
      if (p && p.startedAt >= started - 5_000) {
        if (this.now() - started < 8_000) await Bun.sleep(1_500);
        return;
      }
      await Bun.sleep(500);
      await this.tick();
    }
  }

  /** What the session's terminal shows now, as plain text. */
  screen(id: string): string {
    const s = this.get(id);
    if (s.host === "subagent") throw this.callersAgent(s);
    if (s.host !== "tmux" || !s.tmux) throw new FleetError(409, s.host === "external" ? "running in another terminal; its screen is not ours to read" : "not running");
    return this.deps.runtime.capture(s.tmux) ?? "";
  }

  keys(id: string, keys: string[]): void {
    this.touched.set(id, this.now());
    const s = this.get(id);
    if (s.host !== "tmux" || !s.tmux) throw new FleetError(409, "not running in agentbox");
    this.deps.runtime.sendKeys(s.tmux, keys);
  }

  interrupt(id: string): void {
    this.keys(id, ["Escape"]);
  }

  /**
   * Answer the AskUserQuestion dialog the session is showing (`question`,
   * the call's id, says which). Driven off the screen one step at a time
   * (claude-ask.ts), so a dialog the terminal is answering too, or one that
   * is no longer up, stops it with an error instead of a wrong answer.
   */
  answer(id: string, question: string, answers: AskAnswer[]): Promise<void> {
    return this.serial(id, async () => {
      const s = this.get(id);
      if (s.host !== "tmux" || !s.tmux) throw new FleetError(409, "not running in agentbox");
      const open = s.question;
      if (!open || open.id !== question) throw new FleetError(409, "that question is no longer waiting for an answer");
      const step = this.adapter(s.provider).answerStep;
      if (!step) throw new FleetError(409, `${s.provider} questions cannot be answered from here`);
      checkAnswers(open.questions, answers);

      const pane = s.tmux;
      const rt = this.deps.runtime;
      let screen = rt.capture(pane) ?? "";
      // A lead squeezed beside its teammates' panes is read zoomed, once it
      // has redrawn at the new size.
      const zoomed = rt.setZoom?.(pane, true) ?? false;
      if (zoomed) screen = await this.settled(pane, screen);
      try {
        const visited = new Set<number>();
        for (let n = 0; n < 60; n++) {
          const next = step(screen, open.questions, answers, visited);
          if ("done" in next) {
            if (n === 0) throw new FleetError(409, "the terminal is not showing the question");
            this.touched.set(id, this.now());
            return;
          }
          if ("error" in next) throw new FleetError(409, next.error);
          if ("type" in next) rt.sendKeys(pane, ["-l", "--", next.type]);
          else {
            rt.sendKeys(pane, next.keys);
            if (next.commits !== undefined) visited.add(next.commits);
          }
          screen = await this.settled(pane, screen);
        }
        throw new FleetError(409, "the dialog did not end up answered; the Terminal tab shows where it stopped");
      } finally {
        if (zoomed) rt.setZoom?.(pane, false);
      }
    });
  }

  // ------------------------------------------------------ side questions

  /**
   * Ask Claude a side question (/btw) in its pane (src/core/btw.ts). Returns
   * at once with the question recorded as asking; the answer, or why there is
   * none, follows as a `btw` event.
   */
  askBtw(id: string, question: string): Btw {
    const s = this.get(id);
    if (s.provider !== "claude") throw new FleetError(409, `/btw is Claude's; this is a ${s.provider} session`);
    if (s.host === "subagent") throw this.callersAgent(s);
    if (s.host !== "tmux" || !s.tmux) throw new FleetError(409, s.host === "external" ? "running in another terminal — adopt it to ask here" : "not running — resume it first");
    if (s.status === "blocked") throw new FleetError(409, "it is showing a prompt; answer that first");
    const q = question.trim();
    const row = insertBtw({ sessionId: id, question: q, source: "timeline", askedAt: this.now() });
    this.emit("btw", id);
    const asked = this.serial(id, async () => {
      const pane = this.get(id).tmux;
      if (!pane) throw new Error("it stopped before the question was asked");
      const rt = this.deps.runtime;
      await this.clearBtw(id, pane);
      await rt.sendText(pane, `/btw ${q}`);
      try {
        await awaitAnswer(rt, pane, q, 10_000);
        return await copyAnswer(rt, pane);
      } finally {
        await closePanel(rt, pane);
      }
    });
    this.settleBtw(id, row.id, asked);
    return row;
  }

  /**
   * A /btw typed in the terminal: take its answer when the panel shows it,
   * and leave the panel to whoever is reading it. Not queued behind the
   * session's other actions (it types nothing); they wait for it instead
   * (`clearBtw`).
   */
  private watchTerminalBtw(b: HistoryBtw): void {
    const id = this.byAgentId.get(`claude:${b.agentSessionId}`);
    const pane = id ? this.views.get(id)?.tmux : null;
    if (!id || !pane) return;
    // One asked from the Timeline lands in the history too.
    if (listBtw(id).some((x) => x.source === "timeline" && x.question === b.question && Math.abs(x.askedAt - b.at) < 5 * 60_000)) return;
    const row = insertBtw({ sessionId: id, question: b.question, source: "terminal", askedAt: b.at });
    this.emit("btw", id);
    const rt = this.deps.runtime;
    const answer = (this.btwWatching.get(id) ?? Promise.resolve())
      .then(() => awaitAnswer(rt, pane, b.question, 10_000))
      .then(() => copyAnswer(rt, pane));
    const done = answer.then(
      () => {},
      () => {},
    );
    this.btwWatching.set(id, done);
    void done.then(() => {
      if (this.btwWatching.get(id) === done) this.btwWatching.delete(id);
    });
    this.settleBtw(id, row.id, answer);
  }

  private settleBtw(id: string, rowId: number, answer: Promise<string>): void {
    void answer
      .then(
        (text) => finishBtw(rowId, { answer: text }, this.now()),
        (e) => finishBtw(rowId, { error: e instanceof Error ? e.message : String(e) }, this.now()),
      )
      .finally(() => this.emit("btw", id));
  }

  /** Before typing into a Claude pane: its /btw panel out of the way, once any answer in it is kept. */
  private async clearBtw(id: string, pane: string): Promise<void> {
    await this.btwWatching.get(id);
    await clearPanel(this.deps.runtime, pane);
  }

  /** The screen once it has changed from `before` and held still a moment. */
  private async settled(pane: string, before: string): Promise<string> {
    let last = before;
    for (let t = 0; t < 2_000; t += 50) {
      await Bun.sleep(50);
      const now = this.deps.runtime.capture(pane) ?? "";
      if (now !== before && now === last) return now;
      last = now;
    }
    return last;
  }

  async stopSession(id: string): Promise<void> {
    const s = this.get(id);
    // Killing it under its MCP server would look to its caller like a crash.
    if (s.host === "subagent") throw this.callersAgent(s);
    this.touched.set(id, this.now());
    // Stopped by you, so shown as stopped rather than as waiting on you.
    updateSessionRecord(id, { parkedAt: null, parkedMates: null });
    if (s.host === "tmux" && s.tmux) this.deps.runtime.killSession(s.tmux);
    else if (s.host === "external" && s.pid) {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    } else if (s.tmux) this.deps.runtime.killSession(s.tmux);
    await this.tick();
  }

  /** Why a running pool agent is not ours to drive: its caller's MCP server
   *  holds its conversation open and would take a stop for a crash. */
  private callersAgent(s: Session): FleetError {
    const caller = s.parent ? `“${this.views.get(s.parent)?.title ?? s.parent}”` : "another session";
    return new FleetError(
      409,
      `a subagent run by ${caller}: steer or stop it through that session's subagent tools; it can be resumed here once it has stopped`,
    );
  }

  /**
   * Close: stop its process, then take it off the list. The transcript and
   * worktree stay, and a resume or a message brings it back. Reopening only
   * puts it back on the list; it stays stopped until you resume it.
   */
  async close(id: string, closed: boolean): Promise<void> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    if (closed && this.get(id).host !== "none") await this.stopSession(id);
    // A parked one is stopped already; closing makes that yours, so it
    // reopens stopped rather than waiting on you.
    updateSessionRecord(id, closed ? { archivedAt: this.now(), parkedAt: null, parkedMates: null } : { archivedAt: null });
    await this.tick();
  }

  async patch(id: string, p: { label?: string | null; big?: boolean }): Promise<Session> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    const settings = getSettings().balancer;
    const patch: Partial<SessionRecord> = {};
    if (p.label !== undefined) patch.label = p.label?.trim() || null;
    if (p.big !== undefined && p.big !== rec.big) {
      patch.big = p.big;
      patch.claim = claimFor(
        { model: this.views.get(id)?.model ?? rec.model ?? null, effort: rec.effort ?? null, big: p.big },
        settings,
      );
    }
    updateSessionRecord(id, patch);
    await this.tick();
    return this.get(id);
  }

  attachCommand(id: string): string[] {
    const s = this.get(id);
    if (!s.tmux) throw new FleetError(409, "not running in agentbox's tmux");
    return attachArgv(s.tmux);
  }

  tmuxOf(id: string): string {
    const s = this.get(id);
    if (!s.tmux || s.host !== "tmux") throw new FleetError(409, "not running in agentbox's tmux");
    return s.tmux;
  }
}

// ---------------------------------------------------------------- helpers

/** An idle Claude uses 1–2.5% of a core; more than this per agent over a
 *  minute is work nothing else caught. */
/** A limit hit older than this is not moved on its own: it stalled before we
 *  were watching, and its account may well have reset since. */
const STALL_FRESH_MS = 15 * 60_000;
/** A 5-hour window resetting within this is waited out, not moved away from. */
const RESET_WAIT_MS = 60 * 60_000;

const BUSY_CORES_PER_AGENT = 0.1;

/** What a parkable session looked like at one check. */
interface ParkCheck {
  at: number;
  activity: number;
  cpuTicks: number;
  agents: number;
  agentPids: number[];
  /** Tool shells under the agents. */
  shells: number[];
  /** Each family transcript's size. */
  sizes: Map<string, number>;
  /** Teammates stopped with it. */
  mates: string[];
}

/** Did anything move since `prev`: a transcript written, a shell started? */
function stirred(prev: ParkCheck, cur: ParkCheck): boolean {
  for (const [path, size] of cur.sizes) if (sizeOf(path) !== (prev.sizes.get(path) ?? size)) return true;
  for (const pid of cur.agentPids) {
    for (const kid of childrenOf(pid)) {
      if (!prev.shells.includes(kid) && !cur.shells.includes(kid) && isToolShell(argvOf(kid)?.join(" "))) return true;
    }
  }
  return false;
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function childrenOf(pid: number): number[] {
  const out: number[] = [];
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const kids = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
      if (kids) out.push(...kids.split(/\s+/).map(Number));
    }
  } catch {
    /* gone */
  }
  return out;
}

/** A shell that is only plumbing: the tool-call wrapper, a `-c` subshell or
 *  a bare shell. `bash migrate.sh` is not — it is the work. */
function bareShell(c: string): boolean {
  return isToolShell(c) || /^(\S*\/)?(ba|z|da)?sh((\s+-\S*)*\s*$|(\s+-\S+)*\s+-[a-z]*c\b)/.test(c);
}

/**
 * The model to resume on. A resume without `--model` runs on the CLI's
 * default, so a session started on Haiku or on 1M-context Fable would come
 * back as something else. The model it was started with, unless the
 * transcript shows it has since been switched (`/model`) to another.
 */
function resumeModel(rec: SessionRecord): string | null {
  if (!rec.model) return null;
  const latest = (rec.facts as Partial<TranscriptFacts> | null)?.model ?? null;
  const base = rec.model.replace(/\[[^\]]*\]$/, "");
  if (!latest || latest.startsWith(base) || base.startsWith(latest)) return rec.model;
  // An alias (`opus`) resolves to a full id; that is not a switch.
  if (!base.includes("-") && latest.includes(base)) return rec.model;
  return latest;
}

/** Short, URL-safe, unambiguous: no 0/o/1/l. */
export function newSessionId(): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}

/** Answers that fit the questions: one each, naming options that exist, one
 *  option at most unless multi-select, and not empty. */
function checkAnswers(questions: AskQuestion[], answers: AskAnswer[]): void {
  if (answers.length !== questions.length) throw new FleetError(400, `${questions.length} answers needed, got ${answers.length}`);
  questions.forEach((q, i) => {
    const a = answers[i]!;
    for (const l of a.labels) {
      if (!q.options.some((o) => o.label === l)) throw new FleetError(400, `“${l}” is not an option of “${q.question}”`);
    }
    const picks = a.labels.length + (a.other ? 1 : 0);
    if (picks === 0) throw new FleetError(400, `no answer for “${q.question}”`);
    if (!q.multiSelect && picks > 1) throw new FleetError(400, `“${q.question}” takes one answer`);
  });
}

/** What the database keeps of the facts: enough to draw the board before the
 *  first scan, not the whole fold. */
function compactFacts(f: TranscriptFacts): Partial<TranscriptFacts> {
  return {
    cwd: f.cwd,
    resumeCwd: f.resumeCwd,
    title: f.title,
    firstPrompt: f.firstPrompt?.slice(0, 500) ?? null,
    lastPrompt: f.lastPrompt?.slice(0, 500) ?? null,
    lastPromptAt: f.lastPromptAt,
    lastMessage: f.lastMessage?.slice(0, 300) ?? null,
    model: f.model,
    gitBranch: f.gitBranch,
    lastActivityAt: f.lastActivityAt,
    turnOpen: f.turnOpen,
    contextUsed: f.contextUsed,
    contextLimit: f.contextLimit,
    tokens: f.tokens,
    rateLimitHits: f.rateLimitHits.slice(-1),
  };
}

/**
 * A board title from a first prompt: its first line, trimmed at a word
 * boundary. A prompt that opens with markup (a pasted log, a message another
 * agent sent) makes a poor title, so it falls through to the directory name;
 * a slash command (`/release`) says what the session is for, so it stays.
 */
export function headline(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const line = prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line || line.startsWith("<")) return null;
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}

/** The repository a directory belongs to: for a linked worktree, the main
 *  checkout it was made from, so worktree sessions group, filter and name
 *  under their repo rather than under their worktree directory. */
const roots = new Map<string, string | null>();
function repoRootOf(cwd: string): string | null {
  if (!cwd) return null;
  if (roots.has(cwd)) return roots.get(cwd)!;
  let root: string | null = null;
  if (existsSync(cwd)) {
    const r = run(["git", "rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], cwd);
    const [top, common] = r.code === 0 ? r.stdout.trim().split("\n") : [];
    // A common dir not named .git (bare repo, --separate-git-dir) has no main
    // checkout to point at; the worktree itself is the best answer.
    root = common?.endsWith("/.git") ? dirname(common) : top || null;
  }
  roots.set(cwd, root);
  return root;
}

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  const home = process.env.HOME ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}${p.slice(1)}`;
  return p;
}

function isDescendant(pid: number, ancestor: number): boolean {
  let cur: number | null = pid;
  for (let i = 0; i < 16 && cur !== null && cur > 1; i++) {
    if (cur === ancestor) return true;
    cur = ppidOf(cur);
  }
  return false;
}

function ppidOf(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return null;
  }
}
