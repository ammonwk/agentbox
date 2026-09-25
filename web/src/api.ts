/** The web client: one method per endpoint, one WebSocket for the page.
 *
 * Domain types are imported type-only from the server's source of truth
 * (src/core/types.ts); there is deliberately no second copy here.
 *
 * `?mock=1` in the URL swaps the server for web/src/mock.ts — realistic state,
 * no-op mutations — so the UI can be built and screenshotted without one. The
 * mock is a dynamic import, so it costs a production bundle nothing.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  Account,
  AccountUsage,
  AgentSettings,
  AppState,
  BalancerSettings,
  CalibrationReport,
  ClientMessage,
  ColdState,
  DepState,
  DepStatus,
  Health,
  HotState,
  LoginFlow,
  MetricsState,
  ModelOption,
  Placement,
  ProcDetail,
  ProviderId,
  ReclaimResult,
  Repo,
  ServerMessage,
  Session,
  SessionDiff,
  SkillResult,
  TimelineEvent,
  TimelinePage,
  WorktreeScan,
} from "../../src/core/types";
import { mergeTimeline } from "./lib/timeline";

export type { SessionRow } from "./lib/board";
export type { DepState, DepStatus, Health, LoadSample, ProcDetail, ProcRole, SystemState } from "../../src/core/types";
export * from "./lib/format";

// ------------------------------------------------------------------- mock

/** True when the page was opened with `?mock=1`. Read once: it never changes. */
export const MOCK: boolean =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("mock");

type MockModule = typeof import("./mock");
let mockModule: Promise<MockModule> | null = null;
const loadMock = (): Promise<MockModule> => (mockModule ??= import("./mock"));

// ------------------------------------------------------------------- http

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  if (MOCK) {
    const m = await loadMock();
    // The mock is typed loosely at its one boundary; everything past this line is the contract's type.
    return (await m.mockServer.request(method, path, body)) as T;
  }

  const headers: Record<string, string> = {};
  // The server rejects any mutation without this header (docs/v2.md, Security).
  if (method !== "GET") headers["x-agentbox"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (err) {
    // A dead server is the common case for a local tool; say which call died.
    throw new Error(`${path}: cannot reach agentbox (${(err as Error).message})`);
  }

  const text = await res.text();
  let env: { ok?: boolean; data?: unknown; error?: string };
  try {
    env = JSON.parse(text) as typeof env;
  } catch {
    // Non-JSON means a proxy or a crash page, not our server. Keep the body:
    // it is usually the only description of what actually went wrong.
    throw new Error(`${path}: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  if (!env.ok) throw new Error(env.error || `${path}: ${res.status} ${res.statusText}`);
  return env.data as T;
}

const get = <T,>(path: string) => request<T>("GET", path);
const post = <T,>(path: string, body?: unknown) => request<T>("POST", path, body);
const enc = encodeURIComponent;

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type SettingsPatch = DeepPartial<AgentSettings>;

/** Body of `POST /api/sessions`. `accountId` absent or "auto" = the balancer. */
export interface NewSessionInput {
  provider: ProviderId;
  cwd?: string;
  repoId?: string;
  worktree?: boolean;
  /** An existing branch to run on — its worktree, or a new one. */
  branch?: string;
  pr?: number;
  prompt?: string;
  model?: string;
  effort?: string;
  big?: boolean;
  accountId?: string;
}

/** An image saved for a prompt to name: agents read it from `path`. */
export interface Upload {
  name: string;
  path: string;
}

/** Raw bytes, not JSON, so it skips `request`; same header and envelope. */
async function upload(file: Blob): Promise<Upload> {
  if (MOCK) return { name: "mock.png", path: `/tmp/agentbox-mock/${Math.random().toString(36).slice(2)}.png` };
  let res: Response;
  try {
    res = await fetch("/api/uploads", { method: "POST", headers: { "x-agentbox": "1", "content-type": file.type }, body: file });
  } catch (err) {
    throw new Error(`/api/uploads: cannot reach agentbox (${(err as Error).message})`);
  }
  const env = (await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }))) as { ok?: boolean; data?: Upload; error?: string };
  if (!env.ok || !env.data) throw new Error(env.error || `upload failed: ${res.status}`);
  return env.data;
}

export const uploadUrl = (name: string): string => `/api/uploads/${encodeURIComponent(name)}`;

/**
 * `GET /api/health` as Diagnostics rows: the probed dependencies first, then
 * the provider CLIs. A provider is only ever found or not — its probe is
 * `detect()`, which has no "installed but unusable".
 */
export function healthRows(h: Health): { name: string; state: DepState; detail: string | null }[] {
  const deps: [string, DepStatus][] = [
    ["tmux", h.deps.tmux],
    ["git", h.deps.git],
    ["gh", h.deps.gh],
  ];
  return [
    ...deps.map(([name, d]) => ({ name, state: d.state, detail: d.detail })),
    ...h.providers.map((p) => ({
      name: p.id,
      state: p.installed ? ("ok" as const) : ("missing" as const),
      detail: p.installed ? p.version : `${p.id} is not on PATH`,
    })),
  ];
}

export const api = {
  state: () => get<AppState>("/api/state"),
  health: (refresh = false) => get<Health>(`/api/health${refresh ? "?refresh=1" : ""}`),

  // sessions
  placement: (input: { provider: ProviderId; big: boolean; model?: string }) =>
    post<Placement>("/api/placement", input),
  project: (provider?: ProviderId) => post<Session>("/api/project", provider ? { provider } : {}),
  clearProject: () => post<Session>("/api/project/clear"),
  compactProject: () => post<null>("/api/project/compact"),
  /** What `--model` can be on this account, newest release first. */
  models: (accountId: string) => get<ModelOption[]>(`/api/models?accountId=${enc(accountId)}`),
  createSession: (input: NewSessionInput) =>
    post<{ session: Session; placement: Placement }>("/api/sessions", input),
  patchSession: (id: string, patch: { label?: string | null; big?: boolean }) =>
    request<Session>("PATCH", `/api/sessions/${enc(id)}`, patch),
  send: (id: string, text: string) => post<unknown>(`/api/sessions/${enc(id)}/send`, { text }),
  keys: (id: string, keys: string[]) => post<unknown>(`/api/sessions/${enc(id)}/keys`, { keys }),
  interrupt: (id: string) => post<unknown>(`/api/sessions/${enc(id)}/interrupt`),
  resume: (id: string, prompt?: string) =>
    post<Session>(`/api/sessions/${enc(id)}/resume`, prompt ? { prompt } : {}),
  adopt: (id: string) => post<Session>(`/api/sessions/${enc(id)}/adopt`),
  /** Continue on another account (`auto` = the balancer's pick), sending `prompt`. */
  move: (id: string, opts: { accountId?: string; prompt?: string }) => post<Session>(`/api/sessions/${enc(id)}/move`, opts),
  upload,
  stop: (id: string) => post<unknown>(`/api/sessions/${enc(id)}/stop`),
  archive: (id: string, archived: boolean) => post<unknown>(`/api/sessions/${enc(id)}/archive`, { archived }),
  timeline: (id: string, opts: { before?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.before) q.set("before", opts.before);
    if (opts.limit) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return get<TimelinePage>(`/api/sessions/${enc(id)}/timeline${qs ? `?${qs}` : ""}`);
  },
  diff: (id: string) => get<SessionDiff>(`/api/sessions/${enc(id)}/diff`),
  /** The per-process drilldown. Expensive server-side — only behind an opened tab. */
  load: (id: string) => get<ProcDetail[]>(`/api/sessions/${enc(id)}/load`),

  // accounts
  addAccount: (provider: ProviderId, label?: string) =>
    post<{ account: Account; login: LoginFlow }>("/api/accounts", label ? { provider, label } : { provider }),
  importAccount: (provider: ProviderId, home: string) => post<Account>("/api/accounts/import", { provider, home }),
  patchAccount: (id: string, patch: { label?: string; enabled?: boolean }) =>
    request<Account>("PATCH", `/api/accounts/${enc(id)}`, patch),
  forgetAccount: (id: string) => request<unknown>("DELETE", `/api/accounts/${enc(id)}`),
  login: (id: string) => post<LoginFlow>(`/api/accounts/${enc(id)}/login`),
  refreshUsage: (id: string) => post<AccountUsage>(`/api/accounts/${enc(id)}/usage`),
  loginPaste: (id: string, text: string) => post<LoginFlow>(`/api/logins/${enc(id)}/paste`, { text }),
  loginCancel: (id: string) => post<unknown>(`/api/logins/${enc(id)}/cancel`),
  calibration: (days = 7) => get<CalibrationReport>(`/api/calibration?days=${days}`),

  // settings
  /** Deep-merges server-side, so a partial is a patch, not a replacement. */
  saveSettings: (patch: SettingsPatch) => request<AgentSettings>("PUT", "/api/settings", patch),
  applyBalancer: (b: BalancerSettings) => request<AgentSettings>("PUT", "/api/settings", { balancer: b }),

  // repos, worktrees
  addRepo: (ref: string) => post<Repo>("/api/repos", { ref }),
  deleteRepo: (id: string) => request<unknown>("DELETE", `/api/repos/${enc(id)}`),
  /** Slow by construction — many git and gh calls. Only ever on a button. */
  scanWorktrees: (scope: "all" | "agentbox") => post<WorktreeScan>("/api/worktrees/scan", { scope }),
  reclaimWorktrees: (paths: string[], force = false) =>
    post<ReclaimResult>("/api/worktrees/reclaim", { paths, force }),

  // skills
  skillBody: (path: string) => get<{ body: string }>(`/api/skill/body?path=${enc(path)}`),
  saveSkillBody: (path: string, body: string) => post<{ ok: boolean }>("/api/skill/body", { path, body }),
  promoteSkill: (name: string) => post<SkillResult>("/api/skill/promote", { name }),
  demoteSkill: (name: string) => post<SkillResult>("/api/skill/demote", { name }),
};

// --------------------------------------------------------------- the wire

export interface Connection {
  connected: boolean;
  /** When we lost it. Null while connected. */
  downSince: number | null;
  /** When the next attempt fires, so the UI can count down instead of guessing. */
  retryAt: number | null;
  attempts: number;
  lastError: string | null;
}

const BACKOFF_MIN = 500;
const BACKOFF_MAX = 15_000;
const HEARTBEAT_MS = 25_000;

/** Exponential with jitter: many tabs, one server. Exported for the terminal socket. */
export function backoffMs(attempts: number): number {
  const base = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** Math.min(attempts, 6));
  return base * (0.7 + Math.random() * 0.3);
}

/** One socket for the page. Every hook rides it; nothing else opens one. */
class Wire {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private mockStarted = false;
  private messageListeners = new Set<(m: ServerMessage) => void>();
  private statusListeners = new Set<() => void>();
  private status: Connection = { connected: false, downSince: null, retryAt: null, attempts: 0, lastError: null };
  /** The single session subscription, replayed verbatim after a reconnect. */
  private watching: string | null = null;

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

  /** Follow one session's timeline, or `null` to stop. Replaces any previous watch. */
  watch(sessionId: string | null): void {
    this.watching = sessionId;
    this.send({ type: "watch", sessionId });
  }

  watchingId(): string | null {
    return this.watching;
  }

  /** Skip the backoff — the "retry now" button. */
  retryNow(): void {
    if (this.status.connected) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.open();
  }

  private emit(msg: ServerMessage): void {
    for (const fn of this.messageListeners) fn(msg);
  }

  private send(msg: ClientMessage): void {
    if (MOCK) {
      void loadMock().then((m) => m.mockServer.client(msg));
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setStatus(patch: Partial<Connection>): void {
    this.status = { ...this.status, ...patch };
    for (const fn of this.statusListeners) fn();
  }

  private ensureOpen(): void {
    if (MOCK) {
      if (!this.mockStarted) {
        this.mockStarted = true;
        void loadMock().then((m) => {
          m.mockServer.connect((msg) => this.emit(msg));
          this.setStatus({ connected: true, downSince: null, retryAt: null, attempts: 0, lastError: null });
          if (this.watching) this.send({ type: "watch", sessionId: this.watching });
        });
      }
      return;
    }
    if (!this.ws && !this.timer) this.open();
  }

  private open(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus({ connected: true, downSince: null, retryAt: null, attempts: 0, lastError: null });
      // The server replays hot, cold and metrics on connect; we only restate
      // the watch, and the server answers it with a fresh `reset` frame.
      if (this.watching) this.send({ type: "watch", sessionId: this.watching });
      this.heartbeat = setInterval(() => this.send({ type: "ping" }), HEARTBEAT_MS);
    };

    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        this.setStatus({ lastError: "server sent a malformed message" });
        return;
      }
      if (msg.type === "error") this.setStatus({ lastError: msg.message });
      this.emit(msg);
    };

    ws.onerror = () => {
      // The browser withholds the reason; `onclose` follows and drives the retry.
      this.setStatus({ lastError: "connection error" });
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      const attempts = this.status.attempts + 1;
      const delay = backoffMs(attempts);
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

export function useConnection(): Connection & { retryNow: () => void } {
  const status = useSyncExternalStore(wire.onStatus, wire.getStatus, wire.getStatus);
  const retryNow = useCallback(() => wire.retryNow(), []);
  return { ...status, retryNow };
}

// -------------------------------------------------------------- app state

export function useAppState(): { state: AppState | null; connected: boolean } {
  const [hot, setHot] = useState<HotState | null>(null);
  const [cold, setCold] = useState<ColdState | null>(null);
  const { connected } = useConnection();

  useEffect(
    () =>
      wire.onMessage((msg) => {
        if (msg.type === "hot") setHot(msg.state);
        else if (msg.type === "cold") setCold(msg.state);
      }),
    [],
  );

  // Seed over HTTP so a first paint does not wait on the socket handshake.
  useEffect(() => {
    let cancelled = false;
    api.state().then(
      (s) => {
        if (cancelled) return;
        setHot((prev) => prev ?? { sessions: s.sessions, serverTime: s.serverTime });
        setCold(
          (prev) =>
            prev ?? {
              accounts: s.accounts,
              logins: s.logins,
              repos: s.repos,
              prs: s.prs,
              skills: s.skills,
              settings: s.settings,
              providers: s.providers,
              warnings: s.warnings,
              project: s.project,
            },
        );
      },
      () => {
        /* the socket's status is the UI's signal; no second alarm here. */
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const state = hot && cold ? { ...cold, ...hot } : null;
  return { state, connected };
}

// ----------------------------------------------------------------- metrics

/**
 * The machine and per-session load, straight off the socket. Deliberately not
 * folded into `useAppState`: every frame differs, and joining them would
 * re-render every board row twice a second to move one number.
 */
export function useMetrics(): { metrics: MetricsState | null; stale: boolean } {
  const [metrics, setMetrics] = useState<MetricsState | null>(null);
  const { connected } = useConnection();
  useEffect(
    () =>
      wire.onMessage((msg) => {
        // `at: 0` is the server's snapshot before its first sweep has landed.
        if (msg.type === "metrics" && msg.state.at > 0) setMetrics(msg.state);
      }),
    [],
  );
  return { metrics, stale: !connected };
}

// ---------------------------------------------------------------- timeline

/** Events per older-page fetch: one screenful of history, not the whole log. */
export const OLDER_PAGE = 100;

export interface TimelineState {
  events: readonly TimelineEvent[];
  /** The first `reset` frame has arrived. Before it, "empty" means "not yet". */
  ready: boolean;
  loadingOlder: boolean;
  /** Nothing older exists (the server said `before: null`). */
  exhausted: boolean;
  error: string | null;
}

/**
 * One session's timeline, over the `watch` subscription: a `reset` frame with
 * the newest page, then increments, merged by id (a tool event is re-sent with
 * the same id when its result lands). Scrolling up pages backwards over HTTP,
 * from the reset frame's `before` cursor and then each page's.
 *
 * A session with no transcript yet gets a reset frame with no `before`; its
 * first older page, if one ever exists, is asked for by the oldest held
 * event's id.
 */
export function useTimeline(sessionId: string): TimelineState & { loadOlder: () => void } {
  const [st, setSt] = useState<TimelineState>({
    events: [],
    ready: false,
    loadingOlder: false,
    exhausted: false,
    error: null,
  });
  const before = useRef<string | null | undefined>(undefined);
  const busy = useRef(false);
  const eventsRef = useRef<readonly TimelineEvent[]>([]);

  useEffect(() => {
    before.current = undefined;
    busy.current = false;
    eventsRef.current = [];
    setSt({ events: [], ready: false, loadingOlder: false, exhausted: false, error: null });

    const off = wire.onMessage((msg) => {
      if (msg.type !== "timeline" || msg.sessionId !== sessionId) return;
      if (msg.reset) {
        before.current = msg.before;
        eventsRef.current = mergeTimeline([], msg.events);
        setSt({ events: eventsRef.current, ready: true, loadingOlder: false, exhausted: msg.before === null, error: null });
      } else {
        const next = mergeTimeline(eventsRef.current, msg.events);
        if (next === eventsRef.current) return;
        eventsRef.current = next;
        setSt((s) => ({ ...s, events: next, ready: true }));
      }
    });
    wire.watch(sessionId);
    return () => {
      off();
      if (wire.watchingId() === sessionId) wire.watch(null);
    };
  }, [sessionId]);

  const loadOlder = useCallback(() => {
    if (busy.current) return;
    const held = eventsRef.current;
    if (before.current === null || held.length === 0) return;
    const cursor = before.current ?? held[0].id;
    busy.current = true;
    setSt((s) => ({ ...s, loadingOlder: true, error: null }));
    api
      .timeline(sessionId, { before: cursor, limit: OLDER_PAGE })
      .then((page) => {
        before.current = page.before;
        eventsRef.current = mergeTimeline(eventsRef.current, page.events, "prepend");
        setSt((s) => ({
          ...s,
          events: eventsRef.current,
          loadingOlder: false,
          exhausted: page.before === null || page.events.length === 0,
        }));
      })
      .catch((e: unknown) => {
        setSt((s) => ({ ...s, loadingOlder: false, error: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        busy.current = false;
      });
  }, [sessionId]);

  return { ...st, loadOlder };
}

// ---------------------------------------------------------------- terminal

/** A live terminal on a session's tmux: `/ws/term/:id` in the contract. */
export interface TermChannel {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface TermHandlers {
  onOutput(bytes: Uint8Array): void;
  onOpen(): void;
  /** `reason` is whatever the server said in a close frame, if anything. */
  onClose(reason: string | null): void;
}

export function openTerm(sessionId: string, h: TermHandlers): TermChannel {
  if (MOCK) {
    let inner: TermChannel | null = null;
    let closed = false;
    void loadMock().then((m) => {
      if (closed) return;
      inner = m.mockServer.term(sessionId, h);
    });
    return {
      send: (d) => inner?.send(d),
      resize: (c, r) => inner?.resize(c, r),
      close: () => {
        closed = true;
        inner?.close();
      },
    };
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws/term/${enc(sessionId)}`);
  ws.binaryType = "arraybuffer";
  const text = new TextEncoder();
  ws.onopen = () => h.onOpen();
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) h.onOutput(new Uint8Array(e.data));
    // A text frame is not in the contract's server→client direction; write it
    // rather than drop it, since it is most likely the server explaining itself.
    else if (typeof e.data === "string") h.onOutput(text.encode(e.data));
  };
  ws.onclose = (e) => h.onClose(e.reason || null);
  const sendJson = (m: object) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };
  return {
    send: (data) => sendJson({ type: "input", data }),
    resize: (cols, rows) => sendJson({ type: "resize", cols, rows }),
    close: () => ws.close(),
  };
}

// -------------------------------------------------------- shared 1s ticker

const tick = {
  now: Date.now(),
  listeners: new Set<() => void>(),
  timer: null as ReturnType<typeof setInterval> | null,
};

/** One interval for the whole page. The snapshot only moves once a second. */
export function subscribeToClock(fn: () => void): () => void {
  tick.listeners.add(fn);
  if (!tick.timer) {
    tick.now = Date.now();
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

/** `now`, re-rendering at most every `everyMs` (rounded to it, so the snapshot is stable). */
export function useNow(everyMs = 1000): number {
  return useSyncExternalStore(
    subscribeToClock,
    () => Math.floor(clockNow() / everyMs) * everyMs,
    () => 0,
  );
}
