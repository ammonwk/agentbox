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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { place, type AccountState } from "./balancer";
import { Attributor, claimsByAccount, consumedBy, type ClaimInput } from "./claims";
import {
  findSessionRecord,
  getAccount,
  getRepoById,
  getSessionRecord,
  getSettings,
  insertAssignment,
  insertRateLimitHit,
  insertSessionRecord,
  insertTokenSample,
  listAccounts,
  listSessionRecords,
  updateSessionRecord,
  type SessionRecord,
} from "./db";
import { createWorktree, run } from "./git";
import { attachArgv, tmuxName, type NewSession, type PaneInfo } from "./tmux";
import type {
  LiveProcess,
  ProviderAdapter,
  TranscriptFacts,
  TranscriptReader,
  TranscriptRef,
} from "./providers/types";
import { isAlive, withProcessScan } from "./providers/procs";
import { weeklyWindow } from "./balancer";
import type {
  Account,
  AccountUsage,
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
}

export interface UsageSource {
  usageOf(accountId: string): AccountUsage | null;
  /** Codex reports its limits inside the rollout; hand fresher readings over. */
  ingestRollout?(accountId: string, reading: { at: number; windows: UsageWindow[] }): void;
}

export interface FleetDeps {
  adapters: ProviderAdapter[];
  runtime: Runtime;
  usage: UsageSource;
  /** omp session ids that belong to the subagent MCP's pool. Their
   *  transcripts land in omp's store like any other, but they are calls, not
   *  sessions, and a fan-out would bury the board. */
  poolSessions?: () => ReadonlySet<string>;
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
  prompt?: string;
  model?: string;
  big?: boolean;
  accountId?: string | null;
}

export class Fleet extends EventEmitter {
  private readonly adapters: Map<ProviderId, ProviderAdapter>;
  private readonly now: () => number;

  /** By transcript path. */
  private tracked = new Map<string, Tracked>();
  /** Transcripts that turned out to be subagents or pool agents; never sessions. */
  private ignored = new Set<string>();
  private pool: ReadonlySet<string> = new Set();
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
  private blocked = new Map<string, string>();
  private tokenSampled = new Map<string, { at: number; costEquiv: number; turnOpen: boolean }>();
  private lastDiscovery = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private attributor = new Attributor();
  private lastWeekly = new Map<string, string>();
  readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor(private readonly deps: FleetDeps) {
    super();
    this.adapters = new Map(deps.adapters.map((a) => [a.id, a]));
    this.now = deps.now ?? Date.now;
    this.ready = new Promise((r) => (this.markReady = r));
  }

  start(): void {
    if (this.timer) return;
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
      // A pool agent's id reaches its record a moment after its transcript
      // appears, so one already tracked is dropped here once it is known.
      this.pool = this.deps.poolSessions?.() ?? this.pool;
      for (const [path, t] of this.tracked) {
        if (t.facts && this.isPoolAgent(t.ref.provider, t.facts.agentSessionId)) this.ignored.add(path);
      }
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
    // And so is every unarchived agentbox session, so its board row has facts.
    for (const rec of listSessionRecords(since)) {
      if (!rec.transcriptPath || this.tracked.has(rec.transcriptPath) || !rec.accountId) continue;
      if (!existsSync(rec.transcriptPath)) continue;
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
        const st = statSync(path);
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
        if (r.facts.isSubagent || this.isPoolAgent(t.ref.provider, r.facts.agentSessionId)) {
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
      const id = this.recordFor(t, settings.balancer.claimNormal, now);
      if (!changed.has(path)) continue;
      this.persistFacts(id, t, now);
      this.collectMetrics(id, t, now);
      this.emit("transcript", id);
    }

    this.observeUsage(now);
    this.reapDeadPanes(now);
    this.rebuildViews(since, now);
  }

  private track(adapter: ProviderAdapter, ref: TranscriptRef): void {
    if (this.ignored.has(ref.path)) return;
    const existing = this.tracked.get(ref.path);
    if (existing) return;
    this.tracked.set(ref.path, { ref: { ...ref, mtimeMs: -1 }, reader: adapter.reader(ref), facts: null, hitsSeen: -1, lastUsageAt: 0 });
  }

  private isPoolAgent(provider: ProviderId, agentSessionId: string): boolean {
    return provider === "omp" && this.pool.has(agentSessionId);
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
          if (!f || f.isSubagent || t.ref.provider !== rec.provider) continue;
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

  private recordFor(t: Tracked, claimNormal: number, now: number): string {
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
      // claims like any other; it just was not placed.
      claim: claimNormal,
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

  private persistFacts(id: string, t: Tracked, now: number): void {
    const f = t.facts!;
    const rec = getSessionRecord(id);
    if (!rec) return;
    const patch: Partial<SessionRecord> = { facts: compactFacts(f), transcriptPath: t.ref.path };
    const last = f.lastActivityAt ?? t.ref.mtimeMs;
    if (last > rec.lastActivityAt) patch.lastActivityAt = Math.min(last, now);
    if (f.cwd && !rec.cwd) patch.cwd = f.cwd;
    // New activity on an archived session means you went back to it.
    if (rec.archivedAt && last > rec.archivedAt) patch.archivedAt = null;
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
    for (const hit of f.rateLimitHits.slice(t.hitsSeen)) insertRateLimitHit(id, rec.accountId, hit.at, hit.detail);
    t.hitsSeen = f.rateLimitHits.length;

    if (f.usage && f.usage.at > t.lastUsageAt && rec.accountId) {
      t.lastUsageAt = f.usage.at;
      this.deps.usage.ingestRollout?.(rec.accountId, f.usage);
    }
  }

  /** Feed each account's newest weekly reading to the attributor once. */
  private observeUsage(now: number): void {
    const records = listSessionRecords(now - 8 * DAY);
    for (const account of listAccounts()) {
      const usage = this.deps.usage.usageOf(account.id);
      const weekly = usage ? weeklyWindow(usage.windows) : null;
      if (!usage?.at || !weekly) continue;
      const key = `${usage.at}:${weekly.usedPct}`;
      if (this.lastWeekly.get(account.id) === key) continue;
      this.lastWeekly.set(account.id, key);
      const ids = records.filter((r) => r.accountId === account.id).map((r) => r.id);
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

  // ---------------------------------------------------------------- views

  private rebuildViews(since: number, now: number): void {
    const records = listSessionRecords(since);
    const seen = new Set<string>();
    let dirty = false;
    for (const rec of records) {
      const view = this.viewOf(rec, now);
      if (!view) continue;
      seen.add(rec.id);
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
    let host: SessionHost = "none";
    let pid: number | null = null;
    if (pane && !pane.dead) {
      host = "tmux";
      pid = pane.pid;
    } else if (proc && isAlive(proc.pid)) {
      host = "external";
      pid = proc.pid;
    }

    let status: SessionStatus;
    if (rec.archivedAt && host === "none") status = "archived";
    else if (host === "none") status = "stopped";
    else {
      const busy = proc?.busy;
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
          const why = screen ? adapter.blockedOn(screen) : null;
          if (why) {
            status = "blocked";
            this.blocked.set(rec.id, why);
          } else this.blocked.delete(rec.id);
        }
      }
      this.autoAnswer(rec, pane, adapter, now);
    }

    const cwd = f?.cwd || rec.cwd;
    return {
      id: rec.id,
      provider: rec.provider,
      agentSessionId: rec.agentSessionId,
      accountId: rec.accountId,
      status,
      host,
      title: rec.label || f?.title || headline(f?.firstPrompt) || basename(cwd) || rec.provider,
      label: rec.label,
      cwd,
      repoRoot: repoRootOf(cwd),
      branch: f?.gitBranch ?? null,
      worktree: rec.worktree,
      model: f?.model ?? null,
      firstPrompt: f?.firstPrompt ?? null,
      lastPrompt: f?.lastPrompt ?? null,
      lastMessage: f?.lastMessage ?? null,
      contextUsed: f?.contextUsed ?? null,
      contextLimit: f?.contextLimit ?? null,
      tokens: f?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEquiv: 0 },
      big: rec.big,
      claim: rec.claim,
      origin: rec.origin,
      pid,
      tmux: host === "tmux" || (pane && pane.dead) ? rec.tmux : null,
      transcriptPath: rec.transcriptPath,
      startedAt: rec.startedAt,
      lastActivityAt: Math.max(rec.lastActivityAt, f?.lastActivityAt ?? 0),
      archivedAt: rec.archivedAt,
    };
  }

  private autoAnswer(rec: SessionRecord, pane: PaneInfo | undefined, adapter: ProviderAdapter | undefined, now: number): void {
    if (!pane || !adapter?.autoAnswer) return;
    const started = this.startedAt.get(rec.id);
    if (!started || now - started > AUTO_ANSWER_MS) return;
    const screen = this.deps.runtime.capture(pane.name);
    if (!screen) return;
    const keys = adapter.autoAnswer(screen);
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
      if (!s.accountId || s.status === "archived") continue;
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

  accountStates(provider: ProviderId): AccountState[] {
    const claims = this.claims();
    return listAccounts(provider).map((a) => ({
      account: a,
      windows: this.deps.usage.usageOf(a.id)?.windows ?? [],
      outstanding: (claims.get(a.id) ?? []).map((c) => c.outstanding),
    }));
  }

  placement(provider: ProviderId, big: boolean, model?: string | null, accountId?: string | null): Placement {
    this.adapter(provider);
    return place({
      provider,
      big,
      model: model || getSettings().models[provider] || null,
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
    const placement = this.placement(req.provider, !!req.big, req.model, req.accountId);
    if (!placement.accountId) throw new FleetError(409, placement.why, placement);
    const account = getAccount(placement.accountId);
    if (!account) throw new FleetError(404, `no account ${placement.accountId}`);

    const id = newSessionId();
    let cwd = req.cwd ? expandHome(req.cwd) : "";
    let worktree: string | null = null;
    if (req.repoId) {
      const repo = getRepoById(req.repoId);
      if (!repo) throw new FleetError(404, `no repo ${req.repoId}`);
      if (req.worktree) {
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
    const cmd = adapter.spawnCommand({ account, cwd, prompt: req.prompt || undefined, model, autoApprove: settings.autoApprove });
    const now = this.now();
    const name = tmuxName(id);

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
      facts: req.prompt ? { firstPrompt: req.prompt, lastPrompt: req.prompt, cwd } : { cwd },
      createdAt: now,
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

  async resume(id: string, prompt?: string): Promise<Session> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    const view = this.get(id);
    if (view.host !== "none") throw new FleetError(409, `session is already running (${view.host})`);
    if (!rec.agentSessionId) throw new FleetError(409, "this session never started a conversation, so there is nothing to resume");
    const account = rec.accountId ? getAccount(rec.accountId) : null;
    if (!account) throw new FleetError(409, "this session's account is no longer set up; add it back to resume on the same account");
    const cwd = this.resumeCwd(rec);
    if (!existsSync(cwd)) throw new FleetError(409, `the session's directory is gone: ${cwd}`);
    this.startTmux(rec, account, cwd, prompt);
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
      autoApprove: settings.autoApprove,
    });
    const name = tmuxName(rec.id);
    // A dead pane from the last run holds the name.
    this.deps.runtime.killSession(name);
    this.deps.runtime.newSession({ name, cwd, argv: cmd.argv, env: cmd.env, unset: cmd.unset });
    updateSessionRecord(rec.id, { tmux: name, archivedAt: null, lastActivityAt: this.now() });
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
    if (view.host !== "external" || !view.pid) throw new FleetError(409, "only a session running in another terminal can be adopted");
    if (!rec.agentSessionId) throw new FleetError(409, "cannot tell which conversation that process is");
    const account = rec.accountId ? getAccount(rec.accountId) : null;
    if (!account) throw new FleetError(409, "this session's account is not set up in agentbox");
    const cwd = this.resumeCwd(rec);
    if (!existsSync(cwd)) throw new FleetError(409, `the session's directory is gone: ${cwd}`);
    if (!rec.transcriptPath || !existsSync(rec.transcriptPath)) throw new FleetError(409, "its transcript is missing, so a resume would start empty");

    const pid = view.pid;
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
    this.startTmux(rec, account, cwd);
    await this.tick();
    return this.get(id);
  }

  async send(id: string, text: string): Promise<void> {
    const s = this.get(id);
    if (s.host !== "tmux" || !s.tmux) {
      throw new FleetError(409, s.host === "external" ? "running in another terminal — adopt it to type here" : "not running — resume it first");
    }
    await this.deps.runtime.sendText(s.tmux, text);
  }

  keys(id: string, keys: string[]): void {
    const s = this.get(id);
    if (s.host !== "tmux" || !s.tmux) throw new FleetError(409, "not running in agentbox");
    this.deps.runtime.sendKeys(s.tmux, keys);
  }

  interrupt(id: string): void {
    this.keys(id, ["Escape"]);
  }

  async stopSession(id: string): Promise<void> {
    const s = this.get(id);
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

  async archive(id: string, archived: boolean): Promise<void> {
    const rec = getSessionRecord(id);
    if (!rec) throw new FleetError(404, `no session ${id}`);
    updateSessionRecord(id, { archivedAt: archived ? this.now() : null });
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
      patch.claim = p.big ? settings.claimBig : settings.claimNormal;
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

/** Short, URL-safe, unambiguous: no 0/o/1/l. */
export function newSessionId(): string {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = "";
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
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
    lastMessage: f.lastMessage?.slice(0, 300) ?? null,
    model: f.model,
    gitBranch: f.gitBranch,
    lastActivityAt: f.lastActivityAt,
    turnOpen: f.turnOpen,
    contextUsed: f.contextUsed,
    contextLimit: f.contextLimit,
    tokens: f.tokens,
  };
}

/**
 * A board title from a first prompt: its first line, trimmed at a word
 * boundary. Prompts that are pasted logs or slash commands make poor titles,
 * so those fall through to the directory name.
 */
export function headline(prompt: string | null | undefined): string | null {
  if (!prompt) return null;
  const line = prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line || line.startsWith("/") || line.startsWith("<")) return null;
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${space > 40 ? cut.slice(0, space) : cut}…`;
}

const roots = new Map<string, string | null>();
function repoRootOf(cwd: string): string | null {
  if (!cwd) return null;
  if (roots.has(cwd)) return roots.get(cwd)!;
  let root: string | null = null;
  if (existsSync(cwd)) {
    const r = run(["git", "rev-parse", "--show-toplevel"], cwd);
    root = r.code === 0 ? r.stdout.trim() || null : null;
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
  let cur = pid;
  for (let i = 0; i < 16 && cur > 1; i++) {
    if (cur === ancestor) return true;
    try {
      const s = readFileSync(`/proc/${cur}/stat`, "utf8");
      cur = Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return false;
    }
  }
  return false;
}
