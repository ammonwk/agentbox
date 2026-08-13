/** agentbox domain model.
 *
 * A "session" is one omp task run by agentbox: it owns a git worktree, a
 * dedicated omp session directory (so `-c` continues the same conversation),
 * and a headless `omp -p` process. We watch the process and its NDJSON log.
 */

export type SessionStatus =
  | "spawning"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "dead";

/** Ordered worst-first for the board, matching how much you should care. */
export const STATUS_RANK: Record<SessionStatus, number> = {
  failed: 0,
  dead: 1,
  waiting: 2,
  running: 3,
  spawning: 4,
  done: 5,
};

export interface Session {
  id: string;
  title: string;
  prompt: string;
  status: SessionStatus;
  /** Repo this session works on: a local path or an owner/repo slug. */
  repo: string;
  /** Worktree branch, e.g. vk/ab-<id>. */
  branch: string;
  /** Absolute path to the worktree. */
  worktree: string | null;
  /** Dedicated omp session directory (feeds `--session-dir` and `-c`). */
  sessionDir: string;
  model: string;
  followUps: number;
  /** Latest assistant text (tail of the run). */
  lastMessage: string | null;
  exitCode: number | null;
  pid: number | null;
  prNumber: number | null;
  repoFullName: string | null;
  costUsd: number | null;
  tokens: number | null;
  /** Idle turn ended; awaiting your next message. */
  waitingForInput: boolean;
  /** The agent asked for permission and is blocked on your answer. */
  blocked: boolean;
  /** omp ACP session id, so we can resume the conversation after a restart. */
  ompSessionId: string | null;
  /** Live (in-memory) pending permission detail; only set when blocked. */
  permission?: {
    id: string;
    title: string;
    tool: string;
    options: { id: string; name: string }[];
  } | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface Repo {
  id: string;
  /** Local absolute path or a `owner/name` GitHub slug. */
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
  urgency: number; // 0 = highest
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
