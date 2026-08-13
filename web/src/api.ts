import { useEffect, useRef, useState } from "react";

// ---- client-side mirror of the server domain types ----

export type SessionStatus =
  | "spawning"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "dead";

export interface Session {
  id: string;
  title: string;
  prompt: string;
  status: SessionStatus;
  repo: string;
  branch: string;
  worktree: string | null;
  model: string;
  followUps: number;
  lastMessage: string | null;
  exitCode: number | null;
  prNumber: number | null;
  repoFullName: string | null;
  costUsd: number | null;
  tokens: number | null;
  waitingForInput: boolean;
  blocked: boolean;
  ompSessionId: string | null;
  permission?: {
    id: string;
    title: string;
    tool: string;
    options: { id: string; name: string }[];
  } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Repo {
  id: string;
  ref: string;
  kind: "local" | "github";
  displayName: string;
  addedAt: number;
}

export interface ConductorItem {
  kind: "failed" | "review" | "pr";
  sessionId: string | null;
  title: string;
  detail: string;
  urgency: number;
  updatedAt: number;
}

export interface PrInfo {
  number: number;
  repo: string;
  title: string;
  headRef: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  url: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "global" | "agents" | "project";
  path: string;
  body: string;
}

export interface AgentSettings {
  theme: "light" | "dark" | "system";
  model: string;
  autoApprove: boolean;
  maxMinutes: number;
}

export interface AppState {
  sessions: Session[];
  repos: Repo[];
  prs: PrInfo[];
  skills: SkillInfo[];
  conductor: ConductorItem[];
  settings: AgentSettings;
  serverTime: number;
}

export interface TranscriptLine {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: number;
  tool?: string;
}

// ---- api helpers ----

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error ?? "request failed");
  return body.data as T;
}

export const api = {
  state: () => request<AppState>("/api/state"),
  spawnSession: (repo_id: string, prompt: string, model?: string) =>
    request<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ repo_id, prompt, model }),
    }),
  sendMessage: (id: string, text: string) =>
    request<Session>(`/api/sessions/${id}/message`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  interruptSession: (id: string) =>
    request<Session>(`/api/sessions/${id}/interrupt`, { method: "POST" }),
  replyPermission: (id: string, approved: boolean) =>
    request<Session>(`/api/sessions/${id}/permission`, {
      method: "POST",
      body: JSON.stringify({ approved }),
    }),
  killSession: (id: string) => request<Session>(`/api/sessions/${id}/kill`, { method: "POST" }),
  archiveSession: (id: string) =>
    request<Session>(`/api/sessions/${id}/archive`, { method: "POST" }),
  deleteSession: (id: string) => request<{ ok: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  transcript: (id: string) => request<TranscriptLine[]>(`/api/sessions/${id}/transcript`),
  addRepo: (ref: string) =>
    request<Repo>("/api/repos", { method: "POST", body: JSON.stringify({ ref }) }),
  deleteRepo: (id: string) => request<{ ok: boolean }>(`/api/repos/${id}`, { method: "DELETE" }),
  saveSettings: (s: Partial<AgentSettings>) =>
    request<AgentSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
};

// ---- live state hook ----

export function useAppState(): { state: AppState | null; connected: boolean } {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const ref = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;

    function connect() {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ref.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        setTimeout(connect, 1500);
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "state") setState(msg.state);
        } catch {}
      };
    }

    connect();
    api.state().then(setState).catch(() => {});
    return () => {
      closed = true;
      ws?.close();
    };
  }, []);

  return { state, connected };
}

// ---- small ui helpers ----

export function ago(ts: number | string): string {
  const n = typeof ts === "string" ? new Date(ts).getTime() : ts;
  const s = Math.max(0, (Date.now() - n) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtCost(cost: number | null): string {
  if (cost == null) return "—";
  if (cost < 0.01) return `$${(cost * 1000).toFixed(2)}m`;
  return `$${cost.toFixed(3)}`;
}

export function fmtTokens(t: number | null): string {
  if (t == null) return "—";
  if (t >= 1000) return `${(t / 1000).toFixed(1)}k`;
  return `${t}`;
}

export function repoShort(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1];
}
