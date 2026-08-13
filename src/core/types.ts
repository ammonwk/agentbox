/** agentbox domain model — the one source of truth.
 *
 * A "session" is one omp task: it owns a git worktree, one long-lived
 * `omp acp` process, and a conversation that survives between turns. The web
 * UI imports these types directly (type-only, so nothing ships at runtime) —
 * there is deliberately no second copy in web/src.
 */

// ---------------------------------------------------------------- session

/**
 * Where a session is in its life.
 *
 *   spawning → running ⇄ waiting → done
 *                     ↘ flagged   (the supervisor halted it)
 *                     ↘ dead      (process vanished)
 *                     ↘ failed    (never opened a conversation)
 *
 * All three of `flagged`, `dead` and `failed` are **resumable**. `failed` used
 * to be documented as terminal, which left a spawn that died before opening a
 * conversation with no way back except retyping the task. Resume continues the
 * conversation when there is an `ompSessionId`, and re-sends the original
 * prompt when there is not.
 *
 * `waiting` means the turn ended and the conversation is alive; the next
 * message resumes it. `done` is set when the session's branch has an open PR:
 * that is the only observable "it finished the job" signal we have.
 */
export type SessionStatus =
  | "spawning"
  | "running"
  | "waiting"
  | "done"
  | "flagged"
  | "failed"
  | "dead";

// Board ordering is NOT derived from status — it comes from `attentionOf`, so
// the Inbox, the board and the sidebar badge cannot disagree. A `STATUS_RANK`
// table lived here and was read by nothing; it was also the one *value* export
// in a module the browser imports type-only, so any use of it would have pulled
// server code into the UI bundle. Keep this file types-only.

export interface Session {
  id: string;
  title: string;
  /** The task as first given. Never overwritten by follow-ups. */
  prompt: string;
  status: SessionStatus;
  /** Repo this session works on: a local path or an owner/repo slug. */
  repo: string;
  branch: string;
  worktree: string | null;
  model: string;

  /** Human messages sent after the first one. */
  followUps: number;
  /** Assistant text tail, for the list row. */
  lastMessage: string | null;
  /** Total tool calls observed across every turn — the supervisor's clock. */
  toolCalls: number;

  exitCode: number | null;
  pid: number | null;
  prNumber: number | null;
  repoFullName: string | null;
  costUsd: number | null;
  tokens: number | null;

  /** The agent asked for permission and is parked until answered. */
  blocked: boolean;
  /** Why the supervisor halted this session. Set iff status === "flagged". */
  flagReason: string | null;
  /** omp ACP session id, so the conversation survives a process restart. */
  ompSessionId: string | null;

  createdAt: number;
  updatedAt: number;
  /** First moment a turn started running — for elapsed time. */
  startedAt: number | null;
  archivedAt: number | null;

  /** Live, in-memory only: set when `blocked`. Not persisted. */
  permission?: PermissionRequest | null;
}

export interface PermissionRequest {
  id: string;
  title: string;
  tool: string;
  options: { id: string; name: string }[];
}

// -------------------------------------------------------------- attention

/**
 * What this session needs from a human, if anything. Derived in exactly one
 * place (`attentionOf` in conductor.ts) so the Inbox, the board's sort order
 * and the sidebar badge can never disagree about what is urgent.
 */
export type AttentionKind =
  | "none"
  | "approval"
  | "failed"
  | "flagged"
  | "review"
  | "idle";

export interface Attention {
  kind: AttentionKind;
  /** 0 = most urgent. */
  rank: number;
  /** One human sentence: what happened and what it wants. */
  label: string;
}

// ------------------------------------------------------------- transcript

/** ACP's coarse tool classification. `other` covers anything unmapped. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "execute"
  | "search"
  | "fetch"
  | "think"
  | "other";

export type ToolStatus = "pending" | "running" | "ok" | "error";

/**
 * One tool call, assembled from ACP's `tool_call` + `tool_call_update` pair.
 *
 * NOTE: omp does not put the tool's name on the wire — `title` is built from
 * an `intent` string when the call carries one, and falls back to the name
 * otherwise. Classify on `kind` + the shape of `input`, never on a name.
 */
export interface ToolCall {
  /** ACP toolCallId. Stable across the call's updates. */
  id: string;
  kind: ToolKind;
  title: string;
  /** ACP `rawInput` — the tool's arguments, verbatim. */
  input: unknown;
  status: ToolStatus;
  /** Absolute paths this call touched, when ACP reported any. */
  locations: string[];
  /** Compacted text of ACP `rawOutput`. Truncated; the log keeps it all. */
  output: string | null;
  startedAt: number;
  endedAt: number | null;
}

export type AdvisorySeverity = "nit" | "concern" | "blocker";

/**
 * One line of a session's history. `seq` is monotonic per session and is what
 * the UI uses to request only what it has not seen.
 */
export type TranscriptEvent = { seq: number; ts: number } & (
  | { type: "user"; text: string; from: "human" | "supervisor" }
  | { type: "assistant"; text: string }
  | { type: "tool"; call: ToolCall }
  | { type: "advisory"; severity: AdvisorySeverity; text: string }
  | { type: "permission"; title: string; approved: boolean | null }
  | { type: "supervisor"; verdict: SupervisorVerdict }
  | { type: "turn"; stopReason: string }
  | { type: "error"; message: string }
);

// ------------------------------------------------------------- supervisor

export type SupervisorState = "ok" | "adrift" | "spiraling";

export interface SupervisorVerdict {
  state: SupervisorState;
  /** One sentence, shown verbatim in the UI. */
  reason: string;
  /** Sent to the agent when state === "adrift". */
  nudge?: string;
  /**
   * What *initiated* this check, not what decided it — heuristics escalate to
   * the judge rather than ruling, so a "decided by" reading would make
   * `"heuristic"` unreachable. `heuristic` = a cheap signal tripped and forced
   * an early check; `model` = the scheduled every-N-tool-calls check.
   */
  source: "heuristic" | "model";
  /** Session tool-call count when this fired. */
  atToolCall: number;
}

// ------------------------------------------------------------------ diff

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  /** Unified diff body for this file. Absent when the file is binary. */
  patch: string | null;
}

export interface SessionDiff {
  /** What we diffed against, e.g. "main". */
  base: string;
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** True when the worktree is gone or the repo could not be read. */
  unavailable: boolean;
}

// ------------------------------------------------------------------ repo

export interface Repo {
  id: string;
  /** Local absolute path, or an `owner/name` GitHub slug. */
  ref: string;
  kind: "local" | "github";
  displayName: string;
  /** Resolved GitHub slug, if this repo has one. Cached; may be null. */
  fullName: string | null;
  /** Branch new worktrees are cut from. Resolved once at registration. */
  defaultBranch: string;
  addedAt: number;
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
  /** The agentbox session that produced it, when we can match the branch. */
  sessionId: string | null;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: "global" | "agents" | "project";
  path: string;
}

// -------------------------------------------------------------- settings

export interface SupervisorSettings {
  enabled: boolean;
  /** Run the check every N tool calls. */
  everyToolCalls: number;
  /** omp model id for the judge. Cheap is correct here. */
  model: string;
}

export interface AdvisorSettings {
  /** Passes --advisor to omp; needs a model on the `advisor` role to do anything. */
  enabled: boolean;
  model: string;
}

export interface AgentSettings {
  theme: "light" | "dark" | "system";
  model: string;
  autoApprove: boolean;
  /** Wall-clock cap handed to omp as --max-time. */
  maxMinutes: number;
  /** agentbox's own append-system-prompt overlay. Editable in Settings. */
  systemPrompt: string;
  supervisor: SupervisorSettings;
  advisor: AdvisorSettings;
}

// ------------------------------------------------------------ wire shapes

/** Pushed on every change. Small enough to send often. */
export interface HotState {
  sessions: (Session & { attention: Attention })[];
  serverTime: number;
}

/** Changes rarely and costs subprocesses to build. Pushed only when it moves. */
export interface ColdState {
  repos: Repo[];
  prs: PrInfo[];
  skills: SkillInfo[];
  settings: AgentSettings;
  /** Set when a dependency is missing, so the UI can say so instead of failing. */
  warnings: string[];
}

export interface AppState extends HotState, ColdState {}

/** Server → client. */
export type ServerMessage =
  | { type: "hot"; state: HotState }
  | { type: "cold"; state: ColdState }
  | { type: "events"; sessionId: string; events: TranscriptEvent[] }
  | { type: "error"; message: string };

/** Client → server. A client watches at most one session's event stream. */
export type ClientMessage =
  | { type: "watch"; sessionId: string | null; since?: number }
  | { type: "ping" };
