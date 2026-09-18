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
  /** The omp process itself. */
  pid: number | null;
  /**
   * The `agentbox host <id>` process that owns the omp child.
   *
   * Agents outlive the web server, so "is this session live" can no longer be
   * answered by looking in a map on the server's heap. This is the durable
   * half of that answer — the socket is the other half, and the authoritative
   * one, since a pid can be reused by an unrelated process.
   */
  hostPid: number | null;
  prNumber: number | null;
  repoFullName: string | null;
  costUsd: number | null;
  /** Live context occupancy in tokens — the last ACP `usage_update` `used`,
   *  set rather than accumulated. Null until omp has reported once. */
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
  closedAt: number | null;
  /**
   * When the host stopped this session's omp process for sitting idle, or null.
   *
   * Orthogonal to `status`, like `closedAt`. A parked session is still
   * `waiting` or `done`, because both already mean "the turn is over and a
   * message continues it", and that stays true with no process behind it:
   * `sendMessage` finds no host and starts one onto the same omp conversation.
   * What this field buys is the one place that has to tell a deliberate stop
   * from a crash, `reconcile`, which would otherwise mark it `dead`.
   * Cleared by the host that picks the session back up.
   */
  parkedAt: number | null;

  /**
   * The permission prompt the agent is parked on, set iff `blocked`.
   *
   * Persisted, which it did not used to be. It lived on the ACP connection in
   * the server's memory, so restarting the server lost the question while the
   * agent went on waiting for an answer to it — survivable when the restart
   * killed the agent too, and a deadlock now that it doesn't. The host still
   * holds the promise that answers it; this is the copy the UI reads.
   */
  permission: PermissionRequest | null;

  /**
   * This session's subagent roster: one entry per subagent the run has
   * dispatched, merged across every tool call that mentioned it and across
   * every turn.
   *
   * It used to be "the latest snapshot any tool call carried", replaced whole.
   * That was wrong in two ways at once. A run that dispatched in two batches
   * showed only whichever batch reported last, because the second snapshot
   * overwrote the first; and every entry kept the status of the last frame the
   * parent's turn happened to carry, so a fan-out that finished overnight was
   * still drawn as running the next morning. Entries are merged by name now,
   * and `observedAt` says when each was last actually described — see
   * `roster.ts`.
   */
  subs: SubagentProgress[] | null;
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

export type SubagentStatus = "pending" | "running" | "completed" | "failed";

/**
 * One dispatched subagent, as the roster holds it.
 *
 * The live half of this is omp's own progress entry
 * (`rawOutput.details.progress[]` on a task call's updates), which is the only
 * visibility the protocol offers while a turn is running — omp runs these
 * in-process, not as ACP sessions of their own. The durable half comes from
 * omp's session directory on disk, which is what still answers after the turn
 * ends. `source` says which described this entry last, and `observedAt` when.
 */
export interface SubagentProgress {
  id: string;
  /** The subagent type omp ran this one as ("scout", "reviewer", …). */
  agent: string;
  status: SubagentStatus;
  /** The task text the subagent was dispatched with. */
  task: string;
  /** The tool the subagent is inside right now, when one is. */
  currentTool?: string;
  currentToolArgs?: string;
  /** omp's intent string for the current or last tool call. */
  lastIntent?: string;
  toolCount: number;
  tokens: number;
  cost: number;
  durationMs: number;
  recentTools?: { tool: string; args?: string }[];

  /**
   * When this entry was last described by anything. A roster without it
   * cannot tell "running" from "was running when we last heard", which is the
   * one distinction a reader of a finished run needs.
   */
  observedAt?: number;
  /** What described it last: omp's live progress stream, or its session
   *  directory on disk. */
  source?: "stream" | "disk";
  /** When it ended, once something observed an end. */
  endedAt?: number;
  /** The parent's `agent://<name>` read has taken the result into the
   *  conversation. */
  collected?: boolean;
  /** omp wrote a report file for it. A subagent that ended without one was
   *  disposed of before it answered, which is not the same as succeeding. */
  hasResult?: boolean;
  /** The subagent that dispatched this one, when omp nested it a level
   *  deeper than the board's own agent. */
  parent?: string;
}

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
  /**
   * Subagent progress snapshot, when this call is one of omp's subagent
   * tools (dispatch / wait / hub) and omp streamed one. Replaced whole on
   * every update — it is a snapshot, not a delta.
   *
   * Only the call's own start and end events carry this to the transcript.
   * The snapshots in between are a heartbeat every couple of seconds, and
   * appending each one re-wrote the whole call — including the dispatch
   * arguments, which hold every subagent's assignment — to the log. One
   * fifty-way fan-out wrote 800 MB that way. Live progress goes to the
   * session's roster, which is state; the transcript keeps the transitions.
   */
  subs?: SubagentProgress[];
  startedAt: number;
  endedAt: number | null;
}

export type AdvisorySeverity = "nit" | "concern" | "blocker";

/**
 * One line of a session's history. `seq` is monotonic per session and is what
 * the UI uses to request only what it has not seen.
 */
export type TranscriptEvent = { seq: number; ts: number } & (
  | {
      type: "user";
      text: string;
      from: "human" | "supervisor" | "auto";
      /** Sent mid-turn: not in the agent's context until a `delivered` event names it. */
      queued?: boolean;
    }
  | { type: "assistant"; text: string }
  | { type: "tool"; call: ToolCall }
  | { type: "advisory"; severity: AdvisorySeverity; text: string }
  /**
   * A subagent changed state: dispatched, started, finished, failed.
   *
   * One event per transition, not per heartbeat. A fifty-way fan-out that
   * used to write fourteen thousand near-identical tool rows writes about a
   * hundred of these, and they are the part a person reading the history
   * afterwards actually wants: when each agent started and when it came back.
   */
  | {
      type: "subagent";
      name: string;
      agent: string | null;
      status: SubagentStatus;
      /** Only on the first event for a subagent, where it is news. */
      task?: string;
      toolCount?: number;
      tokens?: number;
      cost?: number;
      durationMs?: number;
      /** Whether the live stream or omp's session directory said so. */
      source: "stream" | "disk";
    }
  | { type: "permission"; title: string; approved: boolean | null }
  | { type: "supervisor"; verdict: SupervisorVerdict }
  | { type: "turn"; stopReason: string }
  | { type: "error"; message: string }
  /** The queued `user` events with these seqs are now in the agent's context. */
  | { type: "delivered"; refs: number[] }
);

// ------------------------------------------------------------- supervisor

/**
 * What the judge can decide. Neither verdict disturbs the run: `ok` does
 * nothing, `nudge` sends the agent one corrective message it can argue with.
 * There used to be a third state that halted the session for a human; it is
 * gone — a watcher that cuts a run off mid-stride does more damage than the
 * loops it catches, and a nudge naming the loop does the same job without
 * the guillotine.
 */
export type SupervisorState = "ok" | "nudge";

export interface SupervisorVerdict {
  state: SupervisorState;
  /** One sentence, shown verbatim in the UI. */
  reason: string;
  /** Sent to the agent when state === "nudge". */
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
  /** The skill directory — the folder that contains SKILL.md. */
  path: string;
  /** Length of SKILL.md, for the "size" column. */
  lines: number;
  allowedTools?: string;
  /** `disable-model-invocation: true` means slash-command only — never fires on its own. */
  modelInvocable: boolean;
}

export interface SkillResult {
  ok: boolean;
  from: string;
  to: string;
  error?: string;
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
  /** agentbox's own append-system-prompt overlay. Editable in Settings. */
  systemPrompt: string;
  supervisor: SupervisorSettings;
  advisor: AdvisorSettings;
}

// ------------------------------------------------------------------ models

/** One entry in a Model dropdown. `id` is the omp selector, `provider/model`. */
export interface ModelOption {
  id: string;
  /** A human name, for an id that does not say what the model is. */
  label?: string;
}

/** `GET /api/models`. Built in src/core/models.ts. */
export interface ModelCatalog {
  /** agentbox's short list. Always present: it does not depend on the fetch. */
  recommended: ModelOption[];
  /** Everything else OpenCode Go lists, sorted. Empty until it has loaded once. */
  go: ModelOption[];
  /** Why Go's list could not be fetched this time, or null. */
  goError: string | null;
}

// ----------------------------------------------------------------- metrics

export interface TempReading {
  name: string;
  celsius: number;
  /** The temperature at which this sensor is in trouble, when it publishes one. */
  critical?: number;
  /** Fraction of the way to critical, for ranking. */
  pressure?: number;
}

/**
 * The machine itself.
 *
 * Nearly everything is optional because nearly everything can be absent: a
 * kernel built without PSI, a desktop with no battery, a chip whose hwmon
 * publishes nothing we can name. Absent is rendered as nothing, never as zero.
 */
export interface SystemState {
  at: number;
  cores: number;
  /** Per-core busy fraction 0-1, in core order. */
  perCore: number[];
  /** Whole-machine busy fraction 0-1. */
  cpu: number;
  /** Current aggregate clock, MHz, and the maximum the CPU will do. */
  mhz?: number;
  mhzMax?: number;

  memTotal: number;
  memAvailable: number;
  /** Page cache and buffers — reclaimable, so shown apart from real use. */
  memCache: number;
  swapTotal: number;
  swapUsed: number;

  load1: number;
  load5: number;
  load15: number;
  /** Runnable tasks, straight from /proc/loadavg. */
  runnable?: number;

  /**
   * Pressure stall information: the share of the last ten seconds in which at
   * least one task was stalled waiting for a resource. This is the number that
   * actually explains a machine feeling slow, and no other metric substitutes
   * for it — CPU can read 100% while nothing is stalled, and 40% while
   * everything is.
   */
  psiCpu?: number;
  psiIo?: number;
  psiMem?: number;

  temps: TempReading[];
  /** Times the package has been thermally throttled since boot. */
  throttleCount?: number;
  /** Fraction of the last sample interval spent thermally throttled, 0-1. */
  throttleDuty: number;
  /** True when the package was throttled at all during the last sample. */
  throttling: boolean;

  diskFree?: number;
  diskTotal?: number;

  acOnline?: boolean;
  batteryPct?: number;
  batteryStatus?: string;
  /** Watts, positive whether charging or discharging. */
  watts?: number;
}

/** How much of the machine one session's process subtree is holding. */
export interface LoadSample {
  /** Percent of ONE core, htop-style: 400% is four cores, not an error. */
  cpuPct: number;
  memBytes: number;
  /**
   * Which memory figure this is. `pss` divides shared pages between the
   * processes holding them and is the one that can be summed; `rss` is the
   * first-poll fallback and overstates. Labelled so the fallback is visible
   * rather than silently wrong.
   */
  memKind: "pss" | "rss";
  /** Processes in the subtree, the agent included. */
  procs: number;
  /** Recent cpuPct samples, oldest first, for the sparkline. */
  history: number[];
  /** Shell tool calls outliving a parked turn. Absent when there are none. */
  backgroundShells?: number;
}

/** What a process in a session's subtree is doing there. */
export type ProcRole = "agent" | "mcp" | "tool" | "child";

export interface ProcDetail {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  role: ProcRole;
  /** Percent of one core, over the interval between the two process tables. */
  cpuPct: number;
  rssBytes: number;
  pssBytes?: number;
  /** Depth below the agent, for indenting the tree. */
  depth: number;
  ageMs: number;
}

/**
 * Pushed on a fixed cadence, never suppressed — see metrics.ts for why this is
 * a third channel rather than part of `hot`. `system` is null before the first
 * sweep lands, and on any platform that cannot be measured.
 */
export interface MetricsState {
  at: number;
  system: SystemState | null;
  /** Keyed by session id. A session with no pid is simply absent. */
  load: Record<string, LoadSample>;
}

// ------------------------------------------------------------ wire shapes

/** Pushed on every change. Small enough to send often. */
export interface HotState {
  sessions: (Session & { attention: Attention })[];
  serverTime: number;
}

/** Changes rarely and costs subprocesses to build. Pushed only when it moves. */
// ------------------------------------------------------------- worktrees

/** Why a worktree may or may not be reclaimed. `reason` is for the UI to group
 *  on; `detail` is the sentence a human reads. */
export interface WorktreeVerdict {
  safe: boolean;
  reason:
    | "merged" | "closed" | "clean" | "orphan"
    | "main" | "locked" | "live" | "dirty" | "open-pr" | "ahead" | "unknown";
  detail: string;
}

export interface WorktreeInfo {
  path: string;
  repoId: string;
  repoName: string;
  branch: string | null;
  bytes: number;
  /** The repo's own checkout, listed so its size is visible but never offered
   *  for removal. */
  isMain: boolean;
  /** agentbox cut this one, as opposed to a worktree made by hand. */
  ours: boolean;
  /** Registered with git but no longer on disk — `git worktree prune` fodder. */
  missing: boolean;
  sessionId: string | null;
  sessionTitle: string | null;
  live: boolean;
  pr: "open" | "merged" | "closed" | "none" | "unknown";
  verdict: WorktreeVerdict;
}

export interface WorktreeScan {
  scannedAt: number;
  items: WorktreeInfo[];
  /** `gh` was needed to judge at least one branch and never answered, so every
   *  PR state below is a guess. */
  ghUnavailable: boolean;
}

export interface ReclaimResult {
  removed: string[];
  /** Per-path, with the reason — a reclaim that silently skips half its input
   *  reads as a reclaim that worked. */
  failed: { path: string; error: string }[];
  bytesFreed: number;
}

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
  // Its own channel because it is neither: pushed on a fixed cadence and never
  // suppressed, since every sample differs and a suppressed one reads as live.
  | { type: "metrics"; state: MetricsState }
  | { type: "error"; message: string };

/** Client → server. A client watches at most one session's event stream. */
export type ClientMessage =
  | { type: "watch"; sessionId: string | null; since?: number }
  | { type: "ping" };
