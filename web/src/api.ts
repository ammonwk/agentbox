/** The web client: one HTTP method per endpoint, one WebSocket for everyone.
 *
 * Domain types are imported type-only from the server's source of truth. There
 * is deliberately no second copy of the model here — the old one had already
 * drifted (it was missing `flagged`, `toolCalls` and the whole attention model).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  AgentSettings,
  AppState,
  Attention,
  ClientMessage,
  ColdState,
  HotState,
  MetricsState,
  ModelCatalog,
  ProcDetail,
  ReclaimResult,
  Repo,
  ServerMessage,
  Session,
  SessionDiff,
  SkillResult,
  TranscriptEvent,
  WorktreeScan,
} from "../../src/core/types";
// The health tri-state, imported rather than redeclared: a second copy of
// `"ok" | "unusable" | "missing"` is a copy that can drift from the probe.
import type { DepState } from "../../src/deps";
import type { FanoutView } from "../../src/server/fanout";
import type { HubAgentDetail } from "../../src/core/ompsession";
import type { CompactReport, TranscriptScan } from "../../src/server/transcripts";

export type { FanoutView } from "../../src/server/fanout";
export type { HubAgentDetail, HubStep } from "../../src/core/ompsession";
export type { CompactReport, TranscriptInfo, TranscriptScan } from "../../src/server/transcripts";

export type { DepState } from "../../src/deps";

export type {
  AdvisorSettings,
  AgentSettings,
  AppState,
  Attention,
  AttentionKind,
  ColdState,
  DiffFile,
  HotState,
  LoadSample,
  MetricsState,
  ModelCatalog,
  ModelOption,
  PermissionRequest,
  ProcDetail,
  ProcRole,
  PrInfo,
  Repo,
  Session,
  SessionDiff,
  SessionStatus,
  SkillInfo,
  SkillResult,
  SupervisorSettings,
  SupervisorVerdict,
  SystemState,
  TempReading,
  ToolCall,
  ToolKind,
  ToolStatus,
  TranscriptEvent,
} from "../../src/core/types";

/** A session as it arrives in `HotState` — attention is always present. */
export type SessionRow = Session & { attention: Attention };

/**
 * `GET /api/health`. Not part of the domain model.
 *
 * Each dependency is **run**, not merely looked up on PATH, so the booleans
 * mean *usable*: a `gh` that is installed but logged out reports `false` here,
 * with `ghState: "unusable"` and the reason in `ghDetail`. Prefer `*State` and
 * `*Detail` over the boolean — "missing" and "installed but unusable" need
 * different words and different advice, and collapsing them is what made an
 * unauthenticated `gh` look like "you have no pull requests".
 *
 * The probe costs subprocesses and is cached ~60s server-side. Pass
 * `refresh: true` for an explicit Re-check; never poll it.
 */
export interface Health {
  ok: boolean;
  omp: boolean;
  gh: boolean;
  git: boolean;
  ompState: DepState;
  ghState: DepState;
  gitState: DepState;
  /** The reason it is not `ok`, or the version/account when it is. */
  ompDetail: string | null;
  ghDetail: string | null;
  gitDetail: string | null;
  /** When the snapshot was taken, ms epoch — so the UI can show its age. */
  checkedAt: number;
  version: string;
}

import type { SubagentDetail, SubagentRow } from "../../src/server/subagents";

// ------------------------------------------------------------------- http

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      ...init,
    });
  } catch (err) {
    // A dead server is the common case for a local tool; say which call died.
    throw new Error(`${path}: cannot reach agentbox (${(err as Error).message})`);
  }

  const text = await res.text();
  let body: { ok?: boolean; data?: unknown; error?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // Non-JSON means a proxy or a crash page, not our server. Keep the body:
    // it is usually the only description of what actually went wrong.
    throw new Error(`${path}: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  if (!body.ok) throw new Error(body.error || `${path}: ${res.status} ${res.statusText}`);
  return body.data as T;
}

const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  state: () => request<AppState>("/api/state"),

  // Subagents are not on the board and have no session row, so they are not in
  // `state` and do not arrive over the socket. This view polls; a couple of
  // seconds is the same beat the records are written on.
  subagents: () => request<SubagentRow[]>("/api/subagents"),
  subagent: (id: string) => request<SubagentDetail>(`/api/subagents/${encodeURIComponent(id)}`),
  commandSubagent: (id: string, command: "interrupt" | "stop") =>
    post<{ requested: string }>(`/api/subagents/${encodeURIComponent(id)}/${command}`),
  /** `refresh` forces a re-probe past the server's ~60s cache — for a Re-check
   *  button, whose presser has usually just fixed the thing being probed. */
  health: (refresh = false) => request<Health>(`/api/health${refresh ? "?refresh=1" : ""}`),

  /** The Model dropdowns' options. Read it through `useModelCatalog`. */
  models: () => request<ModelCatalog>("/api/models"),

  spawnSession: (input: { repoId: string; prompt: string; model?: string; branch?: string }) =>
    post<Session>("/api/sessions", input),
  sendMessage: (id: string, text: string) => post<Session>(`/api/sessions/${id}/message`, { text }),
  interruptSession: (id: string) => post<Session>(`/api/sessions/${id}/interrupt`),
  resumeSession: (id: string) => post<Session>(`/api/sessions/${id}/resume`),
  replyPermission: (id: string, approved: boolean) =>
    post<Session>(`/api/sessions/${id}/permission`, { approved }),
  closeSession: (id: string) => post<Session>(`/api/sessions/${id}/close`),
  /** Backlog fetch, optionally windowed: only `seq < before`, capped to the
   *  newest `limit` of that window — how the transcript pages backwards. The
   *  live transcript comes over the socket — never poll this. */
  events: (id: string, since = 0, opts: { before?: number; limit?: number } = {}) => {
    const q = new URLSearchParams({ since: String(since) });
    if (opts.before !== undefined) q.set("before", String(opts.before));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    return request<TranscriptEvent[]>(`/api/sessions/${id}/events?${q}`);
  },
  diff: (id: string) => request<SessionDiff>(`/api/sessions/${id}/diff`),

  /**
   * One session's fan-out, reconciled against omp's own session directory.
   *
   * Fetched rather than folded out of the transcript the browser happens to
   * hold. A roster built from a window of events is wrong at the window's
   * edges — a dispatch that has scrolled out of the page takes its subagents'
   * assignments with it — and it cannot see anything that happened after the
   * turn ended, which for a fan-out is most of its life.
   */
  fanout: (id: string) => request<FanoutView>(`/api/sessions/${id}/subagents`),
  /** One subagent's history, read from omp's log rather than reconstructed
   *  from the progress snapshots the parent happened to stream. */
  fanoutAgent: (id: string, name: string) =>
    request<HubAgentDetail>(`/api/sessions/${id}/subagents/${encodeURIComponent(name)}`),
  /** The per-process drilldown. Expensive server-side (smaps walks the whole
   *  subtree) — only ever behind an opened panel, never on the board. */
  load: (id: string) => request<{ procs: ProcDetail[] }>(`/api/sessions/${id}/load`),

  repos: () => request<Repo[]>("/api/repos"),
  addRepo: (ref: string) => post<Repo>("/api/repos", { ref }),
  deleteRepo: (id: string) => request<{ ok: boolean }>(`/api/repos/${id}`, { method: "DELETE" }),

  /** Slow by construction — many git and gh calls. Only ever on a button. */
  scanWorktrees: (scope: "all" | "agentbox") =>
    post<WorktreeScan>("/api/worktrees/scan", { scope }),
  /** `force` skips the dirty/unmerged guards. The main checkout and any
   *  worktree a session is live in are refused regardless. */
  reclaimWorktrees: (paths: string[], force = false) =>
    post<ReclaimResult>("/api/worktrees/reclaim", { paths, force }),

  /** Transcripts big enough to be worth rewriting, and the rewrite. Reading
   *  is a stat per session; compacting reads and rewrites whole files, so it
   *  only ever happens on a button. */
  transcripts: () => request<TranscriptScan>("/api/transcripts"),
  compactTranscripts: (sessionIds: string[]) =>
    post<CompactReport>("/api/transcripts/compact", { sessionIds }),

  settings: () => request<AgentSettings>("/api/settings"),
  /** Deep-merges server-side, so a partial is a patch, not a replacement. */
  saveSettings: (patch: DeepPartial<AgentSettings>) =>
    request<AgentSettings>("/api/settings", { method: "PUT", body: JSON.stringify(patch) }),

  /** Skill body. `path` is the skill *directory* as listed in cold state. */
  skillBody: (path: string) => request<{ body: string }>(`/api/skill/body?path=${encodeURIComponent(path)}`),
  saveSkillBody: (path: string, body: string) => post<{ ok: boolean }>("/api/skill/body", { path, body }),
  promoteSkill: (name: string) => post<SkillResult>("/api/skill/promote", { name }),
  demoteSkill: (name: string) => post<SkillResult>("/api/skill/demote", { name }),
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// --------------------------------------------------------------- the wire

export interface Connection {
  connected: boolean;
  /** When we lost it. Null while connected. Lets the UI say how stale it is. */
  downSince: number | null;
  /** When the next attempt fires, so the UI can count down instead of guessing. */
  retryAt: number | null;
  attempts: number;
  /** Why the last attempt failed, when the browser told us anything useful. */
  lastError: string | null;
}

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 15_000;
const HEARTBEAT_MS = 25_000;

/** One socket for the page. Both hooks ride it; nothing else opens one. */
class Wire {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private messageListeners = new Set<(m: ServerMessage) => void>();
  private statusListeners = new Set<() => void>();
  private status: Connection = {
    connected: false,
    downSince: null,
    retryAt: null,
    attempts: 0,
    lastError: null,
  };

  /** The single session subscription, replayed verbatim after a reconnect. */
  private watching: { sessionId: string; since: number } | null = null;

  onMessage(fn: (m: ServerMessage) => void): () => void {
    this.messageListeners.add(fn);
    this.ensureOpen();
    return () => this.messageListeners.delete(fn);
  }

  onStatus = (fn: () => void): (() => void) => {
    this.statusListeners.add(fn);
    this.ensureOpen();
    return () => this.statusListeners.delete(fn);
  };

  getStatus = (): Connection => this.status;

  /** Follow one session, or `null` to stop. Replaces any previous watch. */
  watch(sessionId: string | null, since: number): void {
    this.watching = sessionId === null ? null : { sessionId, since };
    this.send({ type: "watch", sessionId, since });
  }

  /** Remember how far this client has read, so a reconnect resumes there. */
  noteSeq(sessionId: string, seq: number): void {
    if (this.watching?.sessionId === sessionId && seq > this.watching.since) {
      this.watching.since = seq;
    }
  }

  watchingId(): string | null {
    return this.watching?.sessionId ?? null;
  }

  /** Skip the backoff — the "retry now" button. */
  retryNow(): void {
    if (this.status.connected) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.open();
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setStatus(patch: Partial<Connection>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.statusListeners) fn();
  }

  private ensureOpen(): void {
    if (!this.ws && !this.timer) this.open();
  }

  private open(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus({ connected: true, downSince: null, retryAt: null, attempts: 0, lastError: null });
      // The server replays hot+cold on connect; we only have to restate the
      // session subscription, from the highest seq we already hold.
      if (this.watching) this.send({ type: "watch", ...this.watching });
      this.heartbeat = setInterval(() => this.send({ type: "ping" }), HEARTBEAT_MS);
    };

    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string) as ServerMessage;
      } catch {
        this.setStatus({ lastError: "server sent a malformed message" });
        return;
      }
      for (const fn of this.messageListeners) fn(msg);
    };

    ws.onerror = () => {
      // The browser deliberately withholds the reason for a WebSocket error.
      // Record that one happened; `onclose` follows and drives the retry.
      this.setStatus({ lastError: "connection error" });
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;

      const attempts = this.status.attempts + 1;
      const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** Math.min(attempts, 6));
      const delay = base * (0.7 + Math.random() * 0.3); // jitter: many tabs, one server
      this.setStatus({
        connected: false,
        downSince: this.status.downSince ?? Date.now(),
        retryAt: Date.now() + delay,
        attempts,
      });
      this.timer = setTimeout(() => {
        this.timer = null;
        this.open();
      }, delay);
    };
  }
}

const wire = new Wire();

/** Connection detail for the shell. `useAppState` exposes only the boolean. */
export function useConnection(): Connection & { retryNow: () => void } {
  const status = useSyncExternalStore(wire.onStatus, wire.getStatus, wire.getStatus);
  const retryNow = useCallback(() => wire.retryNow(), []);
  return { ...status, retryNow };
}

// -------------------------------------------------------------- app state

export function useAppState(): { state: AppState | null; connected: boolean; warnings: string[] } {
  const [hot, setHot] = useState<HotState | null>(null);
  const [cold, setCold] = useState<ColdState | null>(null);
  const { connected } = useConnection();

  useEffect(() => wire.onMessage((msg) => {
    if (msg.type === "hot") setHot(msg.state);
    else if (msg.type === "cold") setCold(msg.state);
  }), []);

  // Seed over HTTP so a first paint does not wait on the socket handshake, and
  // so a page loaded while the socket is failing still shows something real.
  useEffect(() => {
    let cancelled = false;
    api.state().then(
      (s) => {
        if (cancelled) return;
        setHot((prev) => prev ?? { sessions: s.sessions, serverTime: s.serverTime });
        setCold((prev) => prev ?? {
          repos: s.repos, prs: s.prs, skills: s.skills, settings: s.settings, warnings: s.warnings,
        });
      },
      () => { /* the socket's status is the UI's signal; no second alarm here. */ },
    );
    return () => { cancelled = true; };
  }, []);

  const state = hot && cold ? { ...cold, ...hot } : null;
  return { state, connected, warnings: cold?.warnings ?? [] };
}

// ----------------------------------------------------------------- metrics

/**
 * The machine and the per-session load, straight off the socket.
 *
 * Deliberately NOT folded into `useAppState`. Metrics arrive on their own
 * cadence and every frame differs, so joining them to `hot` would re-render
 * every session row on the board twice a second to move one number in a bar at
 * the bottom of the screen. Components that want the bar subscribe to this;
 * everything else is untouched.
 *
 * There is no HTTP seed here, unlike `useAppState`. The server replays its last
 * sweep on connect, and a metrics reading that cannot be refreshed is not worth
 * painting — `stale` says so rather than leaving a frozen number on screen.
 */
export function useMetrics(): { metrics: MetricsState | null; stale: boolean } {
  const [metrics, setMetrics] = useState<MetricsState | null>(null);
  const { connected } = useConnection();

  useEffect(
    () =>
      wire.onMessage((msg) => {
        // `at: 0` is the server's snapshot before its first sweep has landed —
        // a real message carrying nothing yet, which is not the same as a
        // reading and must not be painted as one.
        if (msg.type === "metrics" && msg.state.at > 0) setMetrics(msg.state);
      }),
    [],
  );

  return { metrics, stale: !connected };
}

// ------------------------------------------------------------------ models

/**
 * The Model dropdowns' options, asked for on every mount. The server caches what
 * it fetches from OpenCode Go, so this is a local round trip and holding a copy
 * here would only add a second staleness to reason about.
 */
export function useModelCatalog(): { catalog: ModelCatalog | null; error: string | null } {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.models().then(
      (c) => {
        if (!cancelled) setCatalog(c);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { catalog, error };
}

// -------------------------------------------------------------- transcript

/**
 * The live transcript for one session, over the `watch` subscription.
 *
 * Deliberately never re-reads the whole transcript on a timer — that was the
 * old build's 2-second `setInterval`. The server backfills from `since`, so a
 * reconnect resumes at the highest seq already held rather than starting over.
 */
/**
 * Fold a batch of events into what we already hold, keyed by `seq`.
 *
 * `seq` is monotonic per session, so it is both the identity and the order:
 * a batch replayed after a reconnect lands on itself instead of duplicating,
 * and an out-of-order batch still sorts correctly. Returns null when nothing
 * new arrived, so the caller can skip the re-render.
 */
export function mergeEventsBySeq(
  held: Map<number, TranscriptEvent>,
  incoming: readonly TranscriptEvent[],
): TranscriptEvent[] | null {
  let added = false;
  for (const ev of incoming) {
    if (!held.has(ev.seq)) added = true;
    held.set(ev.seq, ev);
  }
  if (!added) return null;
  return [...held.values()].sort((a, b) => a.seq - b.seq);
}

/** Events fetched per `loadOlder()` page. Matches the server's watch backfill
 *  cap: one page is one screenful of history, not the whole log. */
const OLDER_PAGE = 500;

/** State of the unread-for-history side of a transcript subscription. */
export interface OlderEvents {
  /** A page fetch is in flight — the UI shows it and holds further requests. */
  loading: boolean;
  /** Everything below the lowest held seq has been fetched (or there is
   *  nothing held); no point asking again. */
  exhausted: boolean;
}

export function useSessionEvents(sessionId: string | null): {
  events: TranscriptEvent[];
  live: boolean;
  older: OlderEvents;
  /** Fetch the next page of history below what is held. No-op while a fetch
   *  is in flight, when exhausted, or when the beginning is already held. */
  loadOlder: () => void;
} {
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [older, setOlder] = useState<OlderEvents>({ loading: false, exhausted: false });
  const bySeq = useRef(new Map<number, TranscriptEvent>());
  const loadingRef = useRef(false);
  const exhaustedRef = useRef(false);
  const { connected } = useConnection();

  useEffect(() => {
    bySeq.current = new Map();
    loadingRef.current = false;
    exhaustedRef.current = false;
    setEvents([]);
    setOlder({ loading: false, exhausted: false });
    if (!sessionId) {
      wire.watch(null, 0);
      return;
    }

    const off = wire.onMessage((msg) => {
      if (msg.type !== "events" || msg.sessionId !== sessionId) return;
      for (const ev of msg.events) wire.noteSeq(sessionId, ev.seq);
      const next = mergeEventsBySeq(bySeq.current, msg.events);
      if (next) setEvents(next);
    });

    wire.watch(sessionId, 0);
    return () => {
      off();
      if (wire.watchingId() === sessionId) wire.watch(null, 0);
    };
  }, [sessionId]);

  const loadOlder = useCallback(() => {
    if (!sessionId || loadingRef.current || exhaustedRef.current) return;
    let lowest = Infinity;
    for (const seq of bySeq.current.keys()) if (seq < lowest) lowest = seq;
    if (lowest === Infinity) {
      exhaustedRef.current = true;
      setOlder({ loading: false, exhausted: true });
      return;
    }
    if (lowest <= 1) {
      // Seq 1 is the start of the log — nothing older exists, but say so once.
      exhaustedRef.current = true;
      setOlder({ loading: false, exhausted: true });
      return;
    }

    loadingRef.current = true;
    setOlder({ loading: true, exhausted: false });
    api
      .events(sessionId, 0, { before: lowest, limit: OLDER_PAGE })
      .then((page) => {
        // A short page means the window below `lowest` is drained. An empty
        // one means the log lost its head (or the session was resumed onto a
        // fresh log) — either way there is nothing further to ask for.
        if (page.length < OLDER_PAGE) exhaustedRef.current = true;
        const next = mergeEventsBySeq(bySeq.current, page);
        if (next) setEvents(next);
      })
      .catch(() => {
        // Leave exhausted false: the next scroll-up retries.
      })
      .finally(() => {
        loadingRef.current = false;
        setOlder({ loading: false, exhausted: exhaustedRef.current });
      });
  }, [sessionId]);

  return { events, live: connected && wire.watchingId() === sessionId && sessionId !== null, older, loadOlder };
}

// -------------------------------------------------------- shared 1s ticker

/** One interval for the whole page; `RelativeTime` reads it. */
const tick = {
  now: Date.now(),
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setInterval> | null,
};

/** Callers get a value that only moves once a second, which is what makes it
 *  safe as a `useSyncExternalStore` snapshot. */
export function subscribeToClock(fn: () => void): () => void {
  tick.listeners.add(fn);
  if (!tick.timer) {
    tick.now = Date.now(); // it has been frozen since the last subscriber left
    tick.timer = setInterval(() => {
      tick.now = Date.now();
      for (const l of tick.listeners) l();
    }, 1000);
  }
  return () => {
    tick.listeners.delete(fn);
    if (tick.listeners.size === 0 && tick.timer) {
      clearInterval(tick.timer);
      tick.timer = null;
    }
  };
}

export const clockNow = (): number => tick.now;

// -------------------------------------------------------------- formatting

export function ago(ts: number | string, at: number = Date.now()): string {
  const n = typeof ts === "string" ? new Date(ts).getTime() : ts;
  if (!Number.isFinite(n)) return "—";
  const s = Math.max(0, (at - n) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Time of day, for transcript tooltips: when a message actually landed. */
export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Elapsed as a duration, for "running for 4m 12s". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtCost(cost: number | null): string {
  if (cost == null) return "—";
  if (cost === 0) return "$0";
  if (cost < 0.01) return `${(cost * 100).toFixed(2)}¢`;
  return `$${cost.toFixed(3)}`;
}

export function fmtTokens(t: number | null): string {
  if (t == null) return "—";
  if (t >= 1_000_000) return `${(t / 1_000_000).toFixed(1)}M`;
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
  return `${t}`;
}

/** Disk sizes. Binary units, because that is what `du` reports and what a file
 *  manager will agree with. */
export function fmtBytes(b: number): string {
  if (b <= 0) return "0 B";
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`;
  if (b >= 1 << 20) return `${Math.round(b / (1 << 20))} MB`;
  if (b >= 1 << 10) return `${Math.round(b / (1 << 10))} KB`;
  return `${b} B`;
}

export function repoShort(ref: string): string {
  const parts = ref.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || ref;
}

export type { SubagentDetail, SubagentRow };
