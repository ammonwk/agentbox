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
import { basename, dirname, join, resolve } from "node:path";
import { owners } from "./accounts/homes";
import { place, type AccountState } from "./balancer";
import { claimFor } from "./claim";
import { Attributor, claimsByAccount, consumedBy, type ClaimInput } from "./claims";
import {
  dismissBtw,
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
import { createWorktree, worktreeForBranch } from "./git";
import { setUpWorktree } from "./setup";
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
import { claimRecord, poolKey, poolState, type PoolAgent } from "../subagents/record";
import { carryEnv, type Launch } from "./launch";
import {
  bootTime,
  crashCause,
  decide,
  lastReport,
  managerIncarnation,
  MAX_AUTO_RESUME_MS,
  parkedWhy,
  readSnapshot,
  resumePrompt,
  saveReport,
  summarize,
  tookWith,
  writeSnapshot,
  type Incarnation,
  type LiveEntry,
  type LiveSnapshot,
  type RecoveryReport,
  type Step,
} from "./recovery";
import { agentboxBin } from "./paths";
import { loadReaderState, pruneReaderStates, saveReaderState } from "./readercache";
import { weeklyWindow } from "./balancer";
import { statedWaitMs } from "./retrywait";
import { readBtwPanel } from "./providers/claude-btw";
import { devinQueuedCount } from "./providers/devin";
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
/** How often readers' positions are saved; a crash re-reads at most this much. */
const READER_SAVE_MS = 60_000;
/** Longest stretch of a pass without letting the event loop in. */
const BREATHE_MS = 25;
/** Dialogs are only auto-answered this soon after we start a process: a key
 *  pressed into a session you are using is worse than a dialog left open. */
const AUTO_ANSWER_MS = 120_000;
/**
 * Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN), whatever room the
 * whole command line has: a prompt past it in the agent's argv fails the exec
 * with "Argument list too long" and the pane dies before the agent starts.
 * Past this many bytes the agent starts bare and the prompt is pasted in
 * (`typeFirstPrompt`).
 */
const MAX_ARGV_PROMPT = 100_000;
const tooLongForArgv = (prompt: string | undefined): prompt is string => !!prompt && Buffer.byteLength(prompt) > MAX_ARGV_PROMPT;
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
  /** A window too small to read a dialog off grown for a while, or handed back; whether it grew. */
  setRoomy?(name: string, on: boolean): boolean;
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
  /** The reader took up where the last server left off (`readercache.ts`)
   *  and has not been refreshed since. */
  restored: boolean;
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
  /** The parent, named outright: for a detached orchestrator whose process
   *  tree no longer reaches the session it works for. Wins over `callerPid`. */
  parent?: string;
  /** Start under this id: a scheduled session keeps the one it was shown under. */
  id?: string;
}

export class Fleet extends EventEmitter {
  private readonly adapters: Map<ProviderId, ProviderAdapter>;
  private readonly now: () => number;

  /** By transcript path. */
  private tracked = new Map<string, Tracked>();
  /** Transcripts read since their reader's state was last saved. */
  private unsaved = new Set<string>();
  private readersSavedAt = 0;
  private breathedAt = 0;
  /** The first pass's progress, until it is done. */
  private starting: { read: number; of: number } | null = { read: 0, of: 0 };
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
  /** The last screen `settledScreen` captured of each pane, and when. */
  private screens = new Map<string, { key: string; at: number; screen: string }>();
  private deadSince = new Map<string, number>();
  private startedAt = new Map<string, number>();
  /** When each session was last woken, onto a new account or its own: its
   *  claim is new there from then, however long ago it started. Lost on a
   *  restart, which counts a claim made just before it as already measured. */
  private wokeAt = new Map<string, number>();
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
  private stallsSeen = new Map<string, number>();
  /** Sessions nudged past an error screen (`nudgeErrored`): the spell's start
   *  and how many nudges it has had. */
  private nudges = new Map<string, { firstAt: number; tries: number }>();
  private nextNudgeAt = 0;
  /** Error screens that name their own wait ("will reset in 55 minutes"):
   *  the error, as first seen, and when that wait is up. */
  private screenWaits = new Map<string, { key: string; until: number }>();
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
  /** Side questions taken back while asking: their watcher's answer is not recorded. */
  private btwDismissed = new Set<number>();
  private nextParkCheck: number;
  /** With its turn over: what a live session is still waiting on (`refreshWork`). */
  private work = new Map<string, string>();
  private nextWorkCheck = 0;
  /** The snapshot recovery would start from: the previous run's until this
   *  run has checked it, then this run's own (`recordLive`). */
  private snapshot: LiveSnapshot | null = null;
  private snapshotSig = "";
  /** Every session as last seen running, for recovering one by hand. */
  private lastSeen = new Map<string, LiveEntry & { at: number }>();
  /** Your user's systemd, as of start (see recovery.ts `crashCause`). */
  private manager: Incarnation | null = null;
  /** How each process in another terminal was launched, by pid; undefined
   *  for a scripted one-shot, which nothing should ever resume. */
  private launches = new Map<number, Launch | null | undefined>();
  /** tmux sessions this fleet stopped, and when: gone by our hand, not a crash. */
  private killedAt = new Map<string, number>();
  private recovering: Promise<RecoveryReport> | null = null;
  private lastRecovery: RecoveryReport | null = null;
  /** Sessions started a moment ago, watched for coming back unable to act. */
  private watches = new Map<string, Watch>();
  private nextWatchCheck = 0;
  /** What the watch found, by session, while it stands. */
  private trouble = new Map<string, string>();
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
    // Before the first pass writes this run's: the previous run's snapshot is
    // what a crash left, and the first pass checks it.
    this.snapshot = readSnapshot();
    this.manager = managerIncarnation();
    for (const id of failUnfinishedBtw("agentbox restarted before it answered", this.now())) this.emit("btw", id);
    pruneReaderStates();
    // The first save a while after the first pass, not in it: it is on the
    // path to the board, and what it would save was just read anyway.
    this.readersSavedAt = this.now();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.saveReaders();
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
          this.starting = null;
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
    for (const name of this.screens.keys()) if (!this.panes.has(name)) this.screens.delete(name);
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
          for (const ref of refs) {
            this.track(adapter, ref);
            await this.breathe();
          }
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
    if (this.starting) this.starting.of = this.tracked.size;
    for (const [path, t] of this.tracked) {
      if (this.starting) this.starting.read++;
      await this.breathe();
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
        if (r.changed) this.unsaved.add(path);
        // A restored reader's first facts are new to this process, though
        // not to the file: record them as a first full read would.
        const fresh = r.changed || t.restored;
        t.restored = false;
        if (r.facts.isSubagent) {
          this.ignored.add(path);
          continue;
        }
        if (fresh) changed.add(path);
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
    this.nudgeErrored(now);
    await this.refreshWork(now);
    await this.watchStarts(now);
    this.checkCrash(now);
    this.recordLive(now);
    for (const b of this.btwHistory.read(accountsOf("claude").map((a) => a.home))) this.watchTerminalBtw(b);
    if (now - this.readersSavedAt >= READER_SAVE_MS) this.saveReaders();
  }

  /** Save the position of every reader that read something since the last
   *  save, for the next server to carry on from (`readercache.ts`). */

  private saveReaders(): void {
    this.readersSavedAt = this.now();
    for (const path of this.unsaved) {
      const t = this.tracked.get(path);
      const state = t?.reader.saveState?.();
      if (t && state) saveReaderState(t.ref.provider, path, state);
    }
    this.unsaved.clear();
  }

  /** Let the event loop run now and then during a long pass — the first one
   *  reads every transcript — so the server answers meanwhile. */
  private async breathe(): Promise<void> {
    if (performance.now() - this.breathedAt < BREATHE_MS) return;
    await new Promise((r) => setImmediate(r));
    this.breathedAt = performance.now();
  }

  /** How far the first pass is, while it runs; null once the board is ready. */
  startup(): { read: number; of: number } | null {
    return this.starting ? { ...this.starting } : null;
  }

  /**
   * A session that stopped at its account's 5-hour limit carries on where it
   * is: a minute after the window resets it is told to go on. It never moves
   * to another account by itself — a move throws away the prompt cache, so
   * that is yours to choose (the limit banner). A weekly limit is left to you.
   *
   * Once per hit, and only for a hit inside the window still running, so a
   * restart in the middle of a wait picks it back up (the deadline lives only
   * in memory).
   */
  private continueStalled(now: number): void {
    for (const [id, w] of this.resumeAfterReset) {
      if (now < w.at) continue;
      this.resumeAfterReset.delete(id);
      const v = this.views.get(id);
      // Still stopped at that same hit, and nobody has written to it since.
      if (!v || v.limitHit?.at !== w.hitAt || v.status !== "waiting" || v.host !== "tmux") continue;
      console.log(`agentbox: ${id} (${v.title}): its 5-hour window has reset; telling it to carry on`);
      void this.sendInPlace(id, "[agentbox: the 5-hour usage limit has reset. Carry on where you left off.]").catch((e) =>
        console.error(`agentbox: continuing ${id} after its reset failed:`, e),
      );
    }
    for (const v of this.views.values()) {
      const hit = v.limitHit;
      if (!hit || this.stallsSeen.get(v.id) === hit.at) continue;
      if (v.status !== "waiting" || v.host !== "tmux" || this.busy.has(v.id)) continue;
      const accountId = getSessionRecord(v.id)?.accountId;
      if (!accountId) continue;
      this.stallsSeen.set(v.id, hit.at);
      const windows = this.deps.usage.usageOf(this.ownerOf(accountId))?.windows ?? [];
      const weekly = weeklyWindow(windows);
      const short = windows.find((w) => w.kind === "short" && !w.scope);
      if (weekly && weekly.usedPct >= 100 && (weekly.resetsAt === null || weekly.resetsAt > now)) continue;
      if (!short?.resetsAt || short.resetsAt <= now || hit.at < short.resetsAt - short.windowMs) continue;
      this.resumeAfterReset.set(v.id, { hitAt: hit.at, at: short.resetsAt + 60_000 });
      console.log(`agentbox: ${v.id} (${v.title}) stopped at its 5-hour limit, which resets in ${Math.round((short.resetsAt - now) / 60_000)}m; waiting it out`);
    }
  }

  /**
   * A session whose turn died on an error is told to go on once the error's
   * reset window has passed: either the CLI left the error on screen ("Send
   * a message to retry" — a rate limit or a failure it is waiting on), or
   * the transcript ends on a retryable provider error (the reply cut off by
   * the output cap, a transient API failure; never a fatal one — a retry
   * cannot fix that, and typing at it only burns tokens). One nudge across
   * the fleet at a time — several sessions retaking one rate-limited account
   * in lockstep is what stuck them — a few per spell, then it is yours. An
   * error that names its own wait (`retryAfterMs`: a model at capacity, 10
   * minutes) is left that long instead, and retried at that pace for as long
   * as it keeps coming back: capacity returns by itself, the refused request
   * cost nothing, and nothing you could do would bring it back sooner. A
   * nudge types where the session is, however cold: only you move it.
   */
  private nudgeErrored(now: number): void {
    if (now < this.nextNudgeAt) return;
    for (const v of this.views.values()) {
      if (v.host !== "tmux" || this.busy.has(v.id)) continue;
      // A transcript error persists, so only act while it is fresh — a
      // restart does not retry what died hours before it was watching.
      const wait = v.status === "waiting" ? v.turnError?.retryAfterMs : undefined;
      const err = v.status === "waiting" && v.turnError && now - v.turnError.at <= STALL_FRESH_MS + (wait ?? 0) ? v.turnError : null;
      const screen = v.status === "blocked" ? this.blocked.get(v.id) : undefined;
      const onScreen = screen === "rate limit" || screen === "error";
      // An error screen that names its reset is left until then, however
      // long: every earlier retry is refused the same way. Quiet a while
      // either way, so the screen a nudge has not yet redrawn is not nudged.
      const until = onScreen ? this.screenWaitUntil(v) : null;
      if (now < Math.max(until ?? 0, v.lastActivityAt + (wait ?? NUDGE_QUIET_MS))) continue;
      const retryable = onScreen ? screen : err && err.kind !== "fatal" ? err.kind : null;
      if (!retryable) continue;
      const prev = this.nudges.get(v.id);
      const spell = prev && now - prev.firstAt < NUDGE_SPELL_MS ? prev : { firstAt: now, tries: 0 };
      const paced = !!err?.retryAfterMs || until !== null;
      if (spell.tries >= NUDGE_MAX_TRIES && !paced) continue;
      this.nudges.set(v.id, { firstAt: spell.firstAt, tries: spell.tries + 1 });
      this.nextNudgeAt = now + NUDGE_STAGGER_MS;
      const message =
        err?.kind === "output-cap"
          ? "[agentbox: your last reply was cut off by the output token limit. Continue where you left off.]"
          : "[agentbox: your turn stopped on an error; this message retries it. Carry on where you left off.]";
      console.log(
        `agentbox: ${v.id} (${v.title}) ${screen ? (screen === "rate limit" ? "hit a rate limit" : "stopped on an error") : `its turn ended on ${err!.kind}${err!.retryAfterMs ? ` (${oneLine(err!.detail, 80)})` : ""}`}; nudging it on (${spell.tries + 1}${paced ? "" : `/${NUDGE_MAX_TRIES}`})`,
      );
      void this.sendInPlace(v.id, message).catch((e) => console.error(`agentbox: nudging ${v.id} failed:`, e));
      return;
    }
  }

  /**
   * When the wait an error screen names is up, or null when it names none.
   * Devin logs a rate limit with the moment it struck (`limitHit`), so its
   * "reset in 55 minutes" counts from then; the screen alone counts from when
   * the fleet first read that error, which after a restart is late, never
   * early. A minute over, for the reset the message rounded down.
   */
  private screenWaitUntil(v: Session): number | null {
    const hitWait = v.limitHit ? statedWaitMs(v.limitHit.detail) : null;
    if (v.limitHit && hitWait !== null) return v.limitHit.at + hitWait + 60_000;
    return this.screenWaits.get(v.id)?.until ?? null;
  }

  /** Remember the wait an error screen names, from when it first showed: the
   *  text stays put, so reading it again later must not push the wait back. */
  private noteScreenWait(id: string, screen: string, now: number): void {
    const foot = screen.split("\n").slice(-12).join("\n");
    const ms = statedWaitMs(foot);
    if (ms === null) {
      this.screenWaits.delete(id);
      return;
    }
    const key = `${/trace ID:?\s*([0-9a-f]{8,})/i.exec(foot)?.[1] ?? ""}|${ms}`;
    if (this.screenWaits.get(id)?.key === key) return;
    this.screenWaits.set(id, { key, until: now + ms + 60_000 });
  }

  private track(adapter: ProviderAdapter, ref: TranscriptRef): void {
    if (this.ignored.has(ref.path)) return;
    const existing = this.tracked.get(ref.path);
    if (existing) return;
    const reader = adapter.reader(ref);
    const saved = reader.loadState ? loadReaderState(ref.provider, ref.path) : null;
    const restored = saved !== null && reader.loadState!(saved);
    this.tracked.set(ref.path, { ref: { ...ref, mtimeMs: -1 }, reader, facts: null, hitsSeen: -1, lastUsageAt: 0, restored });
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
   *   record, whatever process it runs under.
   *
   * Sessions started through the API are given theirs at spawn.
   */
  private linkParents(since: number): void {
    const leads = new Map<string, string>();
    for (const t of this.tracked.values()) {
      if (!t.facts?.teamsLed?.length) continue;
      const lead = this.byAgentId.get(`${t.ref.provider}:${t.facts.agentSessionId}`);
      if (lead) for (const team of t.facts.teamsLed) leads.set(team, lead);
    }
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
      if (parent && parent !== rec.id) updateSessionRecord(rec.id, { parent });
    }
  }

  /** The session whose process `pid` runs under: the nearest ancestor that is
   *  a live session's own process. */
  /**
   * The session a process runs under, found by walking up from it: who is
   * calling, when the caller cannot say. `agentbox send` asks this when
   * `AGENTBOX_SESSION` did not reach it — Codex runs commands with only the
   * core environment (`shell_environment_policy.inherit = "core"`).
   */
  callerOf(pid: number): string | null {
    const found = this.sessionAbove(pid);
    if (found) return found;
    // A process not tied to its transcript yet: the agent above still carries
    // the id agentbox started it with, even when the shell below was stripped.
    let cur = ppidOf(pid);
    for (let i = 0; i < 32 && cur !== null && cur > 1; i++) {
      const id = environOf(cur)?.get("AGENTBOX_SESSION");
      if (id && getSessionRecord(id)) return id;
      cur = ppidOf(cur);
    }
    return null;
  }

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
      if (now - since > DEAD_PANE_MS && pane.clients === 0) this.killTmux(pane.name);
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
    const candidates = [...this.views.values()].filter(
      (v) =>
        v.provider === "claude" &&
        v.host === "tmux" &&
        v.tmux &&
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
          this.killTmux(v.tmux!);
          clean.delete(v.id);
          if (this.paneAlive(v.tmux)) {
            holds.set(v.id, "tmux did not stop it");
            continue;
          }
          for (const [pid, start] of starts) this.dying.set(pid, { since: this.now(), start, termed: false });
          updateSessionRecord(v.id, { parkedAt: now, parkedMates: check.mates.length ? check.mates : null, parkedWhy: null });
          // The board says so now, not a tick from now: a message sent in
          // between must resume it, not type into a pane that is gone.
          this.views.set(v.id, { ...v, status: v.status === "closed" ? "closed" : "waiting", host: "none", pid: null, tmux: null, parkedAt: now, parkHold: null, background: false });
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
      const found = shellWork(table, a.pid, monitors, quiet, true);
      shells.push(...found.shells);
      if (found.hold) return found.hold;
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

  // ------------------------------------------------------------- recovery

  /**
   * For every live session whose turn is over: the work it is still waiting
   * on, which a crash would kill — a background command, a monitor, a
   * wakeup, subagents. What decides, after a crash, between resuming it and
   * leaving it for you (src/core/recovery.ts). Every `WORK_CHECK_MS`.
   */
  private async refreshWork(now: number): Promise<void> {
    if (now < this.nextWorkCheck) return;
    this.nextWorkCheck = now + WORK_CHECK_MS;
    const idle = [...this.views.values()].filter((v) => (v.host === "tmux" || v.host === "external") && this.liveStatus.get(v.id) === "waiting");
    if (idle.length === 0) {
      this.work.clear();
      return;
    }
    const table = await readProcTable().catch(() => null);
    if (!table) return;
    const live = readLive().filter((e) => subagentWorking(e.text));
    const work = new Map<string, string>();
    for (const v of idle) {
      // Let the server answer between sessions.
      await Bun.sleep(0);
      const why = await this.workOf(v, table, live, now).catch(() => null);
      if (why) work.set(v.id, why);
    }
    this.work = work;
  }

  private async workOf(v: Session, table: ProcTable, live: { owner: string }[], now: number): Promise<string | null> {
    const kids = [...this.views.values()].filter((c) => c.parent === v.id && c.host === "subagent" && c.status === "running");
    if (kids.length) return `its subagents were working (${kids.map((k) => k.subagent?.name ?? k.id).join(", ")})`;
    const pane = v.tmux ? this.panes.get(v.tmux) : undefined;
    const pid = (pane ? this.processUnder(pane.pid, v.provider)?.pid : undefined) ?? v.pid;
    if (!pid) return null;
    // The subagent MCP names its owner by the client's --session-id, else its pid.
    const argv = argvOf(pid) ?? [];
    const flag = argv.indexOf("--session-id");
    const owners = [`pid:${pid}`, ...(flag !== -1 && argv[flag + 1] ? [argv[flag + 1]!] : []), ...(v.agentSessionId ? [v.agentSessionId] : [])];
    if (live.some((e) => owners.includes(e.owner))) return "its subagents were working";
    const monitors = new Set<string>();
    const t = v.transcriptPath ? this.tracked.get(v.transcriptPath) : undefined;
    if (v.provider === "claude" && t?.facts) {
      let scan = this.wakeScans.get(t.ref.path);
      if (!scan) this.wakeScans.set(t.ref.path, (scan = new WakeScan(t.ref.path)));
      const wake = await scan.hold(now, startedAtOf(pid) ?? now);
      if (wake) return wake;
      for (const m of scan.monitors) monitors.add(m);
      const sub = subagentsLastWrite(t.ref.path, t.facts.agentSessionId);
      if (sub !== null && now - sub < SUBAGENT_QUIET_MS) return "its in-process subagents were working";
    }
    return shellWork(table, pid, monitors, now - v.lastActivityAt, false).hold;
  }

  /**
   * Write down what every running session is doing, for recovery to start
   * from. Rewritten whenever that changes — a crash straight after a session
   * starts must still find it — and once a minute regardless, so the time it
   * was last seen stays close to the time it died.
   */
  private recordLive(now: number): void {
    const entries: LiveEntry[] = [];
    const external = new Set<number>();
    for (const v of this.views.values()) {
      if (v.host === "none" || v.status === "closed") continue;
      // A run another session started — a teammate, a `claude -p`, a `codex
      // exec` — comes back with that session or not at all.
      if (v.host === "external" && v.parent) continue;
      if (v.host === "external" && v.pid) external.add(v.pid);
      const launch = v.host === "external" && v.pid ? this.launchOf(v, v.pid) : null;
      if (launch === undefined) continue;
      const status = this.liveStatus.get(v.id) ?? v.status;
      const t = v.transcriptPath ? this.tracked.get(v.transcriptPath) : undefined;
      const entry: LiveEntry = {
        id: v.id,
        provider: v.provider,
        title: v.title,
        host: v.host,
        status,
        blockedOn: status === "blocked" ? (this.blocked.get(v.id) ?? null) : null,
        work: status === "waiting" ? (this.work.get(v.id) ?? null) : null,
        parent: v.parent,
        subagent: v.subagent ? { name: v.subagent.name, answerWaiting: v.subagent.answerWaiting } : null,
        lastActivityAt: v.lastActivityAt,
        lastTurnAt: t?.facts?.lastTurnAt ?? null,
        launch,
      };
      entries.push(entry);
      this.lastSeen.set(v.id, { ...entry, at: now });
    }
    for (const pid of this.launches.keys()) if (!external.has(pid)) this.launches.delete(pid);
    for (const [id, e] of this.lastSeen) if (now - e.at > DAY) this.lastSeen.delete(id);
    for (const [name, at] of this.killedAt) if (now - at > DAY) this.killedAt.delete(name);

    const tmux = this.tmuxServer();
    const sig = JSON.stringify([tmux, entries.map((e) => [e.id, e.host, e.status, e.work, e.blockedOn, e.subagent?.answerWaiting])]);
    if (sig === this.snapshotSig && this.snapshot && now - this.snapshot.at < SNAPSHOT_HEARTBEAT_MS) return;
    this.snapshotSig = sig;
    this.snapshot = { at: now, tmux, manager: this.manager, entries };
    writeSnapshot(this.snapshot);
  }

  /** The tmux server our sessions are on, as of this pass; null with none running. */
  private tmuxServer(): Incarnation | null {
    for (const p of this.panes.values()) if (p.server?.pid) return p.server;
    return null;
  }

  /** How a process in another terminal was launched — its flags and its
   *  shell's variables — read once per process; undefined for a scripted
   *  one-shot (`claude -p`), which something is waiting on and nothing should resume. */
  private launchOf(v: Session, pid: number): Launch | null | undefined {
    if (this.launches.has(pid)) return this.launches.get(pid);
    const adapter = this.adapters.get(v.provider);
    const argv = argvOf(pid);
    let launch: Launch | null | undefined = null;
    if (argv && adapter?.headless?.(argv)) launch = undefined;
    else if (argv && adapter) {
      const env = environOf(pid);
      launch = { args: adapter.carryOver?.(argv) ?? [], env: env ? carryEnv(env, process.env) : {} };
    }
    this.launches.set(pid, launch);
    return launch;
  }

  /**
   * Has something bigger than one session gone away since the snapshot —
   * the machine, your user's systemd, our tmux server? Then recover what went
   * with it. Checked at start against the previous run's snapshot, and on
   * every pass after, since the tmux server can die while we run.
   */
  private checkCrash(now: number): void {
    const prev = this.snapshot;
    if (this.recovering || !prev || prev.entries.length === 0) return;
    // Your user's systemd as of start: one that has changed since took us with it.
    const crash = crashCause(prev, { boot: bootTime(now), tmux: this.tmuxServer(), manager: this.manager });
    if (!crash) return;
    const { cause } = crash;
    const dead = prev.entries.filter((e) => tookWith(e, prev.entries, crash.tookAll) && this.diedWith(e, prev.at));
    // Whatever happens next, this snapshot has been answered.
    this.snapshot = null;
    this.snapshotSig = "";
    if (dead.length === 0) return;
    console.log(`agentbox: ${cause}; ${dead.length} session${dead.length === 1 ? "" : "s"} stopped with it`);
    void this.recover(dead, cause, prev.at).catch((e) => console.error("agentbox: recovery failed:", e));
  }

  /** Did this session stop with everything else, rather than being stopped —
   *  by you or by us — or picked up again since? */
  private diedWith(e: LiveEntry, lastSeen: number): boolean {
    const rec = getSessionRecord(e.id);
    if (!rec || rec.archivedAt || rec.parkedAt) return false;
    const v = this.views.get(e.id);
    if (v && v.host !== "none") return false;
    if ((this.touched.get(e.id) ?? 0) > lastSeen - 5_000) return false;
    if (rec.tmux && (this.killedAt.get(rec.tmux) ?? 0) > lastSeen - 5_000) return false;
    return true;
  }

  /** Decide what to do with each of `dead`, and do it unless `dryRun`. */
  recover(dead: LiveEntry[], cause: string, lastSeen: number, dryRun = false): Promise<RecoveryReport> {
    const run = this.recoverNow(dead, cause, lastSeen, dryRun);
    if (dryRun) return run;
    this.recovering = run;
    void run.finally(() => {
      if (this.recovering === run) this.recovering = null;
    });
    return run;
  }

  private async recoverNow(dead: LiveEntry[], cause: string, lastSeen: number, dryRun: boolean): Promise<RecoveryReport> {
    const now = this.now();
    const byId = new Map(dead.map((e) => [e.id, e]));
    const late = now - lastSeen > MAX_AUTO_RESUME_MS;
    const steps: Step[] = dead.map((e) => {
      const d = decide(e, byId, lastSeen);
      if (late && d.action === "resume") {
        return { id: e.id, title: e.title, provider: e.provider, action: "park", why: `${d.why}, but that was ${minutes(now - lastSeen)} ago, so it waits for you` };
      }
      return { id: e.id, title: e.title, provider: e.provider, ...d };
    });
    // Resumes last, warmest cache first: a minute's wait can be the difference.
    const rank = { leave: 0, park: 1, revive: 2, resume: 3 } as const;
    const warmth = (s: Step) => byId.get(s.id)!.lastTurnAt ?? byId.get(s.id)!.lastActivityAt;
    steps.sort((a, b) => rank[a.action] - rank[b.action] || warmth(b) - warmth(a));
    const report: RecoveryReport = { at: now, cause, lastSeen, dryRun, steps, trouble: [] };
    if (dryRun) return report;

    for (const s of steps) {
      const e = byId.get(s.id)!;
      // Resumed here, now or at your next message, a session from another
      // terminal keeps its flags and its shell's variables.
      const rec = getSessionRecord(s.id);
      if (e.host === "external" && rec && !rec.launch && e.launch) updateSessionRecord(s.id, { launch: e.launch });
      if (s.action === "leave") s.outcome = "nothing to bring back";
      else if (s.action === "revive") {
        this.claimForCaller(e);
        s.outcome = "comes back with its caller";
      } else if (s.action === "park") {
        updateSessionRecord(s.id, { parkedAt: lastSeen, parkedMates: null, parkedWhy: parkedWhy(e, cause, lastSeen) });
        s.outcome = "parked";
      }
    }
    this.emit("sessions");
    for (const s of steps) {
      if (s.action !== "resume") continue;
      const e = byId.get(s.id)!;
      const revived = dead.filter((c) => c.parent === e.id && steps.find((x) => x.id === c.id)?.action === "revive");
      try {
        await this.resume(s.id, resumePrompt(e, s.why, cause, lastSeen, revived));
        s.outcome = "resumed";
        const w = this.watches.get(s.id);
        if (w) w.recovery = report.at;
      } catch (err) {
        s.outcome = `could not resume: ${err instanceof Error ? err.message : String(err)}`;
        updateSessionRecord(s.id, { parkedAt: lastSeen, parkedMates: null, parkedWhy: null });
      }
      await Bun.sleep(RESUME_GAP_MS);
    }
    saveReport(report);
    this.lastRecovery = report;
    const summary = summarize(report);
    console.log(`agentbox: ${summary}`);
    notify(summary);
    this.emit("sessions");
    return report;
  }

  /** A subagent's record names the session whose MCP may bring it back —
   *  records written before that was recorded name it here, from the fleet's own link. */
  private claimForCaller(e: LiveEntry): void {
    const rec = getSessionRecord(e.id);
    const agent = rec ? this.poolAgentOf(rec) : undefined;
    if (agent && e.parent) claimRecord(agent.dir, e.parent);
  }

  /** What recovery would do if every running session died now. */
  recoveryPreview(): Promise<RecoveryReport> {
    const entries = [...this.lastSeen.values()].filter((e) => this.views.get(e.id)?.host !== "none" && this.now() - e.at < 60_000);
    return this.recover(entries, "a crash (a preview: nothing was done)", this.now(), true);
  }

  /** The newest recovery carried out: this run's, else the newest on disk. */
  lastRecoveryReport(): RecoveryReport | null {
    return this.lastRecovery ?? lastReport();
  }

  /** Recover sessions by hand, from how they were last seen running. Each
   *  must be stopped now; `dryRun` only says what would happen. */
  async recoverByHand(ids: string[], dryRun = false): Promise<RecoveryReport> {
    const entries: LiveEntry[] = [];
    let at = 0;
    for (const id of ids) {
      const e = this.lastSeen.get(id);
      if (!e) throw new FleetError(404, `${id} has not been seen running since agentbox started`);
      if (this.views.get(id)?.host !== "none") throw new FleetError(409, `${id} is running`);
      const { at: seen, ...entry } = e;
      entries.push(entry);
      at = Math.max(at, seen);
    }
    return this.recover(entries, "you asked for it", at, dryRun);
  }

  /**
   * Sessions started in the last `WATCH_MS`: one whose tool calls are being
   * refused came back unable to act, which nothing else would notice — it
   * reads the refusals, concludes it cannot do its job, and stops. A devin
   * session is repaired (its saved permission mode; see `prepareResume`)
   * and resumed once; anything else is shown as blocked on you, and a
   * recovery's report says so.
   */
  private async watchStarts(now: number): Promise<void> {
    if (now < this.nextWatchCheck || this.watches.size === 0) return;
    this.nextWatchCheck = now + WATCH_CHECK_MS;
    for (const [id, w] of this.watches) {
      if (now - w.since > WATCH_MS) {
        this.watches.delete(id);
        continue;
      }
      if (w.flagged) continue;
      const rec = getSessionRecord(id);
      const t = rec?.transcriptPath ? this.tracked.get(rec.transcriptPath) : undefined;
      if (!rec || !t) continue;
      let events: TimelineEvent[];
      try {
        events = (await t.reader.timeline({ limit: 80 })).events;
      } catch {
        continue;
      }
      const refused = events.filter((e) => e.kind === "tool" && e.status === "error" && e.at >= w.since - 5_000 && REFUSED.test(e.output ?? ""));
      if (refused.length < REFUSALS) continue;
      w.flagged = true;
      const last = refused.at(-1) as Extract<TimelineEvent, { kind: "tool" }>;
      const what = `its tool calls are being refused (${refused.length} since it started): ${oneLine(last.output ?? "", 90)}`;
      const title = this.views.get(id)?.title ?? id;
      console.log(`agentbox: ${id} (${title}) came back unable to act: ${what}`);
      if (rec.provider === "devin" && !w.repaired) {
        this.repairPermissions(id);
        continue;
      }
      this.trouble.set(id, what);
      if (w.recovery !== null) this.noteTrouble(w.recovery, id, title, what);
    }
  }

  /** Stop a devin session whose commands are all refused and resume it,
   *  its saved permission mode set on the way (the devin adapter's `prepareResume`). */
  private repairPermissions(id: string): void {
    void this.serial(id, async () => {
      const rec = getSessionRecord(id);
      const account = rec?.accountId ? getAccount(rec.accountId) : null;
      const view = this.get(id);
      if (!rec || !account || view.host !== "tmux") return;
      const recovery = this.watches.get(id)?.recovery ?? null;
      await this.stopAndWait(rec, view);
      this.startTmux(rec, account, this.resumeCwd(rec), REFUSED_NOTE);
      this.watches.set(id, { since: this.now(), flagged: false, repaired: true, recovery });
      console.log(`agentbox: ${id}: stopped it, set its permission mode, and resumed it`);
    }).catch((e) => console.error(`agentbox: repairing ${id} failed:`, e));
  }

  private noteTrouble(reportAt: number, id: string, title: string, what: string): void {
    const report = this.lastRecovery?.at === reportAt ? this.lastRecovery : null;
    if (!report) return;
    report.trouble.push({ id, title, what });
    saveReport(report);
    notify(`After agentbox's recovery, ${title} (${id}) came back unable to act: ${what}. It is marked blocked on the board.`);
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
        updateSessionRecord(rec.id, { parkedAt: null, parkedWhy: null });
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
    let background = false;
    // Parked is still your move: the fleet stopped the process, not you, and
    // the next message resumes it.
    if (host === "none") status = rec.parkedAt ? "waiting" : "stopped";
    else {
      // A pool agent's server knows whether its turn is open; its transcript can lag.
      const busy = host === "subagent" ? pooled?.running : proc?.busy;
      status = (busy ?? f?.turnOpen) ? "running" : "waiting";
      // A turn open but silent for STALE_TURN_MS is over, whatever the
      // transcript still says: the CLI died mid-turn without closing it.
      // Only where no provider flag says otherwise — Claude's status file
      // stays "busy" for days on a lead with teammates (see parkIdle).
      if (status === "running" && !busy && host !== "subagent" && now - (f?.lastActivityAt ?? now) >= STALE_TURN_MS) status = "waiting";
      // Busy with its own turn over: the CLI is waiting on what it left going
      // (teammates, background agents, shells), not thinking.
      background = status === "running" && !!busy && host !== "subagent" && !!f && !f.turnOpen;
      // Claude says so itself while a permission dialog is up, which is the
      // only way to know it for a session in some other terminal. Its /btw
      // panel is a dialog to Claude too, but a prompt to no one: while it
      // answers the side question the session is working, and with the
      // answer shown it is the idle prompt it was at, under the panel.
      if (proc?.waitingOn) {
        const panel = pane && rec.provider === "claude" ? readBtwPanel(this.settledScreen(pane) ?? "") : null;
        if (!panel) {
          status = "blocked";
          this.blocked.set(rec.id, proc.waitingOn);
        } else {
          status = panel.state === "asking" ? "running" : "waiting";
          this.blocked.delete(rec.id);
        }
      }
      if (host === "tmux" && adapter?.blockedOn && pane) {
        const quietFor = now - (f?.lastActivityAt ?? 0);
        // A prompt waiting on you stalls the transcript, so only look at the
        // screen when it has been quiet for a moment.
        if (quietFor > 2_500 || status === "waiting") {
          const screen = this.settledScreen(pane);
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
          if ((why === "rate limit" || why === "error") && screen) this.noteScreenWait(rec.id, screen, now);
          else this.screenWaits.delete(rec.id);
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
      // Came back unable to act (`watchStarts`) and stopped trying: it needs you.
      const trouble = host === "tmux" ? this.trouble.get(rec.id) : undefined;
      if (trouble && status === "waiting") {
        status = "blocked";
        this.blocked.set(rec.id, trouble);
      }
    }
    // Closed is your word, not the process's: a session you closed stays
    // closed even if a process outlived the stop (an external one that
    // ignored SIGTERM, a pane restarted by hand), until you send it
    // something (persistFacts).
    const live = status;
    this.liveStatus.set(rec.id, live);
    if (rec.archivedAt) status = "closed";
    // A stopped child was a call in its parent's run — a pool agent, a
    // teammate, a `codex exec` from a Bash tool: listed while that run goes
    // on, then history (resumable by id), never stranded at the root of the
    // board or piled under a caller that has stopped.
    else if (rec.parent && host === "none" && !(this.openIds.has(rec.parent) && this.views.get(rec.parent)?.host !== "none")) {
      status = "closed";
    }

    const cwd = f?.cwd || rec.cwd;
    const lastActivityAt = f?.lastActivityAt ?? rec.lastActivityAt;
    // The limit message is the session's last word: nothing after it, bar the
    // odd bookkeeping line written in the same breath.
    const hit = f?.rateLimitHits?.at(-1) ?? null;
    const limitHit = hit && live !== "running" && hit.at >= lastActivityAt - 60_000 ? hit : null;
    // The cache goes cold from the last model call, not the last line: a
    // session watching background work writes notification lines for hours
    // without calling the model once.
    const cold =
      this.movable.has(rec.provider) &&
      (live === "waiting" || live === "stopped") &&
      (host === "tmux" || host === "none") &&
      now - (f?.lastTurnAt ?? lastActivityAt) > this.coldAfterMs;
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
      prRepo: f?.prRepo ?? null,
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
      // The transcript's turn ended on the provider and nothing has followed
      // it: it stopped without meaning to. Meaningless mid-turn (the next
      // step rewrites the end of the chain) and after a prompt (the turn is
      // someone's again); stale like a limit hit, a restart does not act on
      // what died hours ago.
      turnError:
        f?.turnError && (live === "waiting" || live === "stopped") && f.turnError.at >= lastActivityAt - 60_000 ? f.turnError : null,
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
      background: background && status === "running",
    };
  }

  /**
   * A pane's screen for a pass's look at it, captured again only when tmux has
   * seen output in the window, or it was resized, since the last capture.
   * Every waiting pane was captured every pass: sixty of them held the server
   * up for a quarter of a second in every two.
   */
  private settledScreen(pane: PaneInfo): string | null {
    const key = `${pane.activity}:${pane.width}x${pane.height}`;
    const had = this.screens.get(pane.name);
    // Activity is in whole seconds: a capture in the second of the last output
    // may have been taken before some of it.
    if (had && had.key === key && Math.floor(had.at / 1000) > pane.activity) return had.screen;
    const at = Date.now();
    const screen = this.deps.runtime.capture(pane.name);
    if (screen === null) this.screens.delete(pane.name);
    else this.screens.set(pane.name, { key, at, screen });
    return screen;
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
    const why = this.blocked.get(id) ?? null;
    const v = this.views.get(id);
    // An error screen with a stated reset is the fleet's to retry: say when.
    const until = v && (why === "rate limit" || why === "error") ? this.screenWaitUntil(v) : null;
    if (until !== null && until > Date.now()) {
      return `${why} — agentbox retries it at ${new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    }
    return why;
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
        since: Math.max(s.startedAt, this.wokeAt.get(s.id) ?? 0),
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
          claims: (claims.get(a.id) ?? []).map((c) => ({ outstanding: c.outstanding, since: c.since })),
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
    if (req.parent && !getSessionRecord(req.parent)) throw new FleetError(404, `no session ${req.parent} to be the parent`);
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
      // Only a checkout cut just now: an existing one was set up by whoever made it.
      if (worktree) setUpWorktree(repo, worktree, id);
    }
    if (!cwd) throw new FleetError(400, "say where the session should run: a repo or a directory");
    if (!existsSync(cwd)) throw new FleetError(400, `no such directory: ${cwd}`);

    const model = req.model || settings.models[req.provider] || undefined;
    const typed = tooLongForArgv(req.prompt) ? req.prompt : undefined;
    const cmd = adapter.spawnCommand({ account, cwd, prompt: typed ? undefined : req.prompt || undefined, model, effort, autoApprove: settings.autoApprove });
    const now = this.now();
    const name = tmuxName(id);
    const parent = req.parent ?? (req.callerPid ? this.sessionAbove(req.callerPid) : null);

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
      parent: parent ?? null,
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
      this.deps.runtime.newSession({ name, cwd, argv: cmd.argv, env: { ...cmd.env, ...sessionEnv(id) }, unset: cmd.unset });
    } catch (e) {
      updateSessionRecord(id, { tmux: null });
      throw new FleetError(500, (e as Error).message);
    }
    this.startedAt.set(id, now);
    this.watches.set(id, { since: now, flagged: false, repaired: false, recovery: null });
    if (typed) this.typeFirstPrompt(id, name, typed);
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

  /** Stop a tmux session, noting that we did: its session did not die in a crash. */
  private killTmux(name: string): void {
    this.killedAt.set(name, this.now());
    this.deps.runtime.killSession(name);
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
    // Parked by a crash rather than for idling: what it lost, before what you say.
    if (prompt && rec.parkedAt && rec.parkedWhy) prompt = `[agentbox: ${rec.parkedWhy}]\n\n${prompt}`;
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
    this.wokeAt.set(rec.id, this.now());
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
    if (rec.tmux) this.killTmux(rec.tmux);
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
    const adapter = this.adapter(rec.provider);
    const typed = tooLongForArgv(prompt) ? prompt : undefined;
    const opts = {
      account,
      agentSessionId: rec.agentSessionId!,
      cwd,
      prompt: typed ? undefined : prompt || undefined,
      ...(rec.effort ? { effort: rec.effort } : {}),
      ...(resumeModel(rec) ? { model: resumeModel(rec)! } : {}),
      autoApprove: settings.autoApprove,
      ...(rec.launch ? { carry: rec.launch.args } : {}),
    };
    try {
      adapter.prepareResume?.(opts);
    } catch (e) {
      // Resume anyway: the health watch catches a session that comes back unable to act.
      console.error(`agentbox: preparing ${rec.id}'s resume failed:`, e);
    }
    const cmd = adapter.resumeCommand(opts);
    const name = tmuxName(rec.id);
    // A dead pane from the last run holds the name.
    this.killTmux(name);
    // The account's variables win over the launching shell's.
    const env = { ...rec.launch?.env, ...cmd.env, ...sessionEnv(rec.id) };
    this.deps.runtime.newSession({ name, cwd, argv: cmd.argv, env, unset: cmd.unset });
    updateSessionRecord(rec.id, { tmux: name, archivedAt: null, parkedAt: null, parkedMates: null, parkedWhy: null });
    this.startedAt.set(rec.id, this.now());
    this.answered.delete(rec.id);
    this.trouble.delete(rec.id);
    const prev = this.watches.get(rec.id);
    this.watches.set(rec.id, { since: this.now(), flagged: false, repaired: prev?.repaired ?? false, recovery: prev?.recovery ?? null });
    if (typed) this.typeFirstPrompt(rec.id, name, typed);
  }

  /**
   * Paste the prompt of a session started without one because it was too long
   * for its argv (`tooLongForArgv`), once the TUI is up and past its start-up
   * dialogs. Queued like a message, so one sent meanwhile lands after it.
   */
  private typeFirstPrompt(id: string, pane: string, prompt: string): void {
    void this.serial(id, async () => {
      await this.untilReady(id);
      await this.untilSettled(id, pane);
      await this.deps.runtime.sendText(pane, prompt);
    }).catch((e) => console.error(`agentbox: typing ${id}'s prompt into it failed:`, e));
  }

  /**
   * Wait — at most 60s from its start — until the pane shows no dialog the
   * start-up answers (`autoAnswer`) and has held still for a second: a paste
   * into Claude's trust dialog is lost, and one into a TUI still drawing its
   * first screen can be too.
   */
  private async untilSettled(id: string, pane: string): Promise<void> {
    const rec = getSessionRecord(id);
    const adapter = rec ? this.adapter(rec.provider) : undefined;
    const deadline = (this.startedAt.get(id) ?? this.now()) + 60_000;
    let last = "";
    let still = 0;
    while (this.now() < deadline) {
      if (!this.paneAlive(pane)) throw new Error("its pane exited before the prompt could be typed");
      const screen = this.deps.runtime.capture(pane, { scrollback: 200 }) ?? "";
      const dialog = adapter?.autoAnswer?.(screen, { bypassPermissions: getSettings().autoApprove });
      still = !dialog && screen.trim() && screen === last ? still + 1 : 0;
      if (still >= 2) return;
      last = screen;
      await Bun.sleep(500);
    }
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
    return this.serial(id, async () => {
      if (!(await this.wakeElsewhere(id, text))) await this.sendNow(id, text);
    });
  }

  /** Type into the session on the account it is on, however cold: the
   *  fleet's own nudges, which must never move a session. */
  private sendInPlace(id: string, text: string): Promise<void> {
    return this.serial(id, () => this.sendNow(id, text));
  }

  /** Wake a cold tmux session on the balancer's pick with `text` as its
   *  prompt, when that is another account; false when it stays put. */
  private async wakeElsewhere(id: string, text: string): Promise<boolean> {
    const s = this.get(id);
    if (!s.cold || s.host !== "tmux") return false;
    const rec = getSessionRecord(id);
    const target = rec ? this.wakeTarget(rec, s) : null;
    const from = rec?.accountId ? getAccount(rec.accountId) : null;
    if (!rec || !target || !from || !rec.agentSessionId) return false;
    let cwd: string;
    try {
      cwd = this.resumeCwd(rec);
    } catch {
      return false; // cannot prove a resume: type into it where it is
    }
    if (!existsSync(cwd)) return false;
    await this.wake(rec, s, from, cwd, target, text);
    await this.tick();
    return true;
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
    await this.untilReady(id);
    if (s.provider === "claude") await this.clearBtw(id, s.tmux);
    await this.deps.runtime.sendText(s.tmux, text);
    if (s.provider === "devin") await this.deliverDevinQueue(s.tmux);
  }

  /**
   * Devin holds a message typed mid-turn until the turn ends, and a turn can
   * run for hours, so a course correction would arrive after the work it was
   * meant to steer. Enter on its empty prompt delivers the queue now — and
   * the footer going away is the proof it went. If the footer survives two
   * Enters (a modal dialog eats them), say so: the message is typed and
   * queued, and a blind resend would queue it twice.
   */
  private async deliverDevinQueue(pane: string): Promise<void> {
    const queued = (): number => devinQueuedCount(this.deps.runtime.capture(pane) ?? "");
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(500);
      if (queued() > 0) break;
      if (i === 5) return; // no footer: idle, the message went straight through
    }
    for (let i = 0; i < 2; i++) {
      this.deps.runtime.sendKeys(pane, ["Enter"]);
      for (let j = 0; j < 12; j++) {
        await Bun.sleep(250);
        if (queued() === 0) return;
      }
    }
    throw new FleetError(
      409,
      "typed and queued, but the pane never took the flush Enter (a dialog may be up) — do not send again; press Enter there or clear the pane",
    );
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
      // A window squeezed short by a small terminal is read grown, and a lead
      // squeezed beside its teammates' panes zoomed, once it has redrawn at
      // the new size.
      const grown = rt.setRoomy?.(pane, true) ?? false;
      const zoomed = rt.setZoom?.(pane, true) ?? false;
      if (grown || zoomed) screen = await this.settled(pane, screen);
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
        if (grown) rt.setRoomy?.(pane, false);
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
        (text) => {
          if (!this.btwDismissed.has(rowId)) finishBtw(rowId, { answer: text }, this.now());
        },
        (e) => {
          if (!this.btwDismissed.has(rowId)) finishBtw(rowId, { error: e instanceof Error ? e.message : String(e) }, this.now());
        },
      )
      .finally(() => {
        this.btwDismissed.delete(rowId);
        this.emit("btw", id);
      });
  }

  /**
   * Take a side question back while it is asking, or put its card away once
   * it has answered or failed: the card leaves the Timeline, the record
   * stays. A panel still up in the pane is closed — Escape only on seeing
   * the panel, so a prompt or a running turn is never touched (Esc in the
   * web UI).
   */
  dismissBtw(id: string, row: number): void {
    const s = this.get(id);
    const b = listBtw(id).find((x) => x.id === row);
    if (!b) throw new FleetError(404, `no side question #${row} here`);
    if (b.status === "dismissed") throw new FleetError(409, "it is already dismissed");
    if (b.status === "asking") this.btwDismissed.add(row);
    dismissBtw(row, this.now());
    if (s.tmux) void closePanel(this.deps.runtime, s.tmux).catch(() => {});
    this.emit("btw", id);
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
    updateSessionRecord(id, { parkedAt: null, parkedMates: null, parkedWhy: null });
    if (s.host === "tmux" && s.tmux) this.killTmux(s.tmux);
    else if (s.host === "external" && s.pid) {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    } else if (s.tmux) this.killTmux(s.tmux);
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
   * Closing takes the sessions it started, at any depth, off the list with
   * it: they were calls in its run, and a parent gone from the board leaves
   * them stranded at the root. Running ones are stopped first, the parent
   * before its children — its death takes its MCP servers, and the pool
   * agents they run, with it.
   */
  async close(id: string, closed: boolean): Promise<void> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    if (!closed) {
      updateSessionRecord(id, { archivedAt: null });
      await this.tick();
      return;
    }
    const target = this.get(id);
    if (target.host === "subagent") throw this.callersAgent(target);
    const family = [id, ...this.openDescendants(id)];
    for (const sid of family) {
      let s: Session;
      try {
        s = sid === id ? target : this.get(sid);
      } catch {
        continue; // not viewable (its transcript is ignored): archive it below, stop nothing
      }
      if (s.host === "subagent") continue;
      this.touched.set(sid, this.now());
      if (s.host === "tmux" && s.tmux) this.killTmux(s.tmux);
      else if (s.host === "external" && s.pid) {
        try {
          process.kill(s.pid, "SIGTERM");
        } catch {
          /* gone */
        }
      } else if (s.tmux) this.killTmux(s.tmux);
    }
    // A parked one is stopped already; closing makes that yours, so it
    // reopens stopped rather than waiting on you.
    const at = this.now();
    for (const sid of family) updateSessionRecord(sid, { archivedAt: at, parkedAt: null, parkedMates: null, parkedWhy: null });
    await this.tick();
  }

  /** The sessions `id` started, at any depth, still open: what closing it takes with it. */
  private openDescendants(id: string): string[] {
    const kids = new Map<string, string[]>();
    for (const r of listSessionRecords(0)) {
      if (r.archivedAt || !r.parent || r.parent === r.id) continue;
      kids.set(r.parent, [...(kids.get(r.parent) ?? []), r.id]);
    }
    const out: string[] = [];
    const walk = (p: string) => {
      for (const c of kids.get(p) ?? []) if (!out.includes(c)) { out.push(c); walk(c); }
    };
    walk(id);
    return out;
  }

  async patch(id: string, p: { label?: string | null; big?: boolean; parent?: string | null }): Promise<Session> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    const settings = getSettings().balancer;
    const patch: Partial<SessionRecord> = {};
    if (p.label !== undefined) patch.label = p.label?.trim() || null;
    if (p.parent !== undefined) {
      // Close walks a parent's sessions at any depth, so a cycle would never end.
      for (let up = p.parent; up; up = getSessionRecord(up)?.parent ?? null) {
        if (up === id) throw new FleetError(400, `${p.parent} is ${id} or runs under it`);
        if (!getSessionRecord(up)) throw new FleetError(404, `no session ${up} to be the parent`);
      }
      patch.parent = p.parent;
    }
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
/** A turn error older than this is not retried on its own: it stalled before
 *  we were watching. */
const STALL_FRESH_MS = 15 * 60_000;
/** A session stuck on an error screen is nudged once the error's reset window
 *  ("will reset in N seconds") has passed: this long after it last moved. */
const NUDGE_QUIET_MS = 5 * 60_000;
/** One nudge across the fleet this often: several sessions retaking one
 *  rate-limited account in lockstep is what stuck them. */
const NUDGE_STAGGER_MS = 90_000;
/** Nudges per spell before a stuck session is left for you. */
const NUDGE_MAX_TRIES = 3;
/** How long a spell lasts: after this quiet, the count starts over. */
const NUDGE_SPELL_MS = 60 * 60_000;

const BUSY_CORES_PER_AGENT = 0.1;

/** How often live sessions are checked for work a crash would kill. */
const WORK_CHECK_MS = 30_000;
/** The live-sessions snapshot is rewritten at least this often. */
const SNAPSHOT_HEARTBEAT_MS = 60_000;
/** Between one recovered session's resume and the next. */
const RESUME_GAP_MS = 3_000;
/** How long a started session is watched for coming back unable to act, and how often. */
const WATCH_MS = 10 * 60_000;
const WATCH_CHECK_MS = 10_000;
/** Refused tool calls, since it started, that say it cannot act. One is a
 *  prompt it was right to be refused; two is a setting. */
const REFUSALS = 2;
/** A tool call refused by a permission rule, in the words each CLI uses. */
const REFUSED = /User skipped this tool call|Tool execution was rejected|The user doesn't want to proceed with this tool use|permission (was )?denied by the user/i;
const REFUSED_NOTE =
  '[agentbox: your tool calls were being refused ("User skipped this tool call"). That was a permission setting, not a person, and it is fixed now. Anything you concluded from those refusals — that you cannot run commands, check CI, push or edit — was wrong: redo what failed and carry on.]';

/** A session started a moment ago, watched by `watchStarts`. */
interface Watch {
  since: number;
  /** Found unable to act; not looked at again. */
  flagged: boolean;
  /** Already stopped and resumed once for it. */
  repaired: boolean;
  /** The recovery that started it, to tell if it came back broken. */
  recovery: number | null;
}

/** Tell you, on your phone, through the repo's Telegram skill — when it is
 *  set up, and not turned off (`AGENTBOX_NOTIFY=0`, for a test instance). */
function notify(text: string): void {
  if (process.env.AGENTBOX_NOTIFY === "0") return;
  const script = join(dirname(dirname(agentboxBin())), ".claude", "skills", "telegram", "send.ts");
  if (!existsSync(script)) return;
  try {
    Bun.spawn(["bun", script, text], { cwd: dirname(script), stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch (e) {
    console.error("agentbox: sending the recovery message failed:", e);
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

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

/**
 * The tool shells running under an agent's process, and the first that
 * holds it up (park.ts `shellHold`), if any. `services` says whether a dev
 * server counts: it holds a session up, but a crash that killed one is not a
 * reason to resume the session that started it.
 */
function shellWork(table: ProcTable, pid: number, monitors: ReadonlySet<string>, quietMs: number, services: boolean): { shells: number[]; hold: string | null } {
  const shells: number[] = [];
  for (const kid of table.children.get(pid) ?? []) {
    const cmd = argvOf(kid)?.join(" ");
    if (!cmd || !isToolShell(cmd)) continue; // an MCP server
    shells.push(kid);
    const command = shellCommand(cmd);
    const label = describe({ ...table.byPid.get(kid)!, cmd });
    // A monitor's every line of output is a message to the session.
    if (monitors.has(normalCommand(command))) return { shells, hold: `a monitor is running (${label})` };
    const running = subtree(table, kid)
      .filter((r) => r.pid !== kid)
      .map((r) => argvOf(r.pid)?.join(" ") ?? r.comm)
      .filter((c) => !bareShell(c));
    const kind = classifyShell(command, running);
    if (kind === "service" && !services) continue;
    const hold = shellHold(kind, label, quietMs);
    if (hold) return { shells, hold };
  }
  return { shells, hold: null };
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

/**
 * What every process agentbox starts is told about itself. The subagent MCP
 * a session runs inherits it, which is how a resumed session's MCP finds the
 * agents its last run left behind (src/subagents/pool.ts `revive`).
 */
function sessionEnv(id: string): Record<string, string> {
  return { AGENTBOX_SESSION: id };
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
    prRepo: f.prRepo ?? null,
    lastActivityAt: f.lastActivityAt,
    lastTurnAt: f.lastTurnAt ?? null,
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
export function repoRootOf(cwd: string): string | null {
  if (!cwd) return null;
  if (roots.has(cwd)) return roots.get(cwd)!;
  const root = existsSync(cwd) ? gitRootOf(cwd) : null;
  roots.set(cwd, root);
  return root;
}

/**
 * `git rev-parse --show-toplevel --git-common-dir`, read off the disk rather
 * than run: the first pass asked it of every session's cwd, a process each,
 * seconds of a restart. The nearest `.git` up from `dir` is the checkout's
 * top; a directory there is a main checkout, and a file (`gitdir: …`) a
 * linked worktree or submodule, whose git dir's `commondir` names the common
 * one. A common dir not named .git (bare repo, --separate-git-dir, a
 * submodule's) has no main checkout to point at; the top itself is the answer.
 */
function gitRootOf(dir: string): string | null {
  for (let top = resolve(dir); ; top = dirname(top)) {
    const dotGit = join(top, ".git");
    let st;
    try {
      st = statSync(dotGit);
    } catch {
      if (dirname(top) === top) return null;
      continue;
    }
    // A directory without a HEAD is not a repository, and git looks on up.
    if (st.isDirectory()) {
      if (existsSync(join(dotGit, "HEAD"))) return top;
      if (dirname(top) === top) return null;
      continue;
    }
    try {
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
      if (!gitdir) return null;
      const gd = resolve(top, gitdir);
      // A worktree whose git dir was deleted: git calls it no repository.
      if (!existsSync(join(gd, "HEAD"))) return null;
      let common = gd;
      try {
        common = resolve(gd, readFileSync(join(gd, "commondir"), "utf8").trim());
      } catch {
        /* no commondir: the git dir is its own */
      }
      return basename(common) === ".git" ? dirname(common) : top;
    } catch {
      return top;
    }
  }
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
