/** agentbox domain model — the one source of truth.
 *
 * The web UI imports these types directly (type-only, so nothing ships at
 * runtime) — there is deliberately no second copy in web/src. Keep this file
 * types-only: a value export here would drag server code into the UI bundle.
 *
 * docs/v2.md is the map of how these relate.
 */

// -------------------------------------------------------------- providers

export type ProviderId = "claude" | "codex" | "devin" | "omp";

// --------------------------------------------------------------- accounts

/**
 * One login on one provider. The credential home is what isolates it: the
 * provider's CLI is run with `env` and finds only this account's credentials.
 */
export interface Account {
  id: string;
  provider: ProviderId;
  /** What you called it. Defaults to the email. */
  label: string;
  email: string | null;
  /** "max", "pro", "prolite", "Devin Max" — whatever the provider reports. */
  plan: string | null;
  /**
   * The credential home: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or the XDG data
   * dir devin logged in under. For the default account this is the provider's
   * own default (`~/.claude`, `~/.codex`, …) and no env is set.
   */
  home: string;
  isDefault: boolean;
  /** Off means the balancer never places a new session here. Existing
   *  sessions pinned to it are unaffected. */
  enabled: boolean;
  createdAt: number;
}

export type WindowKind = "short" | "daily" | "weekly" | "monthly";

/** One rate-limit window as the provider reports it. */
export interface UsageWindow {
  /** Stable within a provider: "five_hour", "seven_day", "seven_day:Fable", "weekly". */
  id: string;
  kind: WindowKind;
  label: string;
  /** 0–100. */
  usedPct: number;
  /** Epoch ms; null when the window has not started (nothing used yet). */
  resetsAt: number | null;
  windowMs: number;
  /** A limit that applies only to one model. */
  scope?: { model: string };
}

export interface AccountUsage {
  accountId: string;
  /** When these numbers were true, not when we last tried. */
  at: number | null;
  windows: UsageWindow[];
  /** Why the numbers are old or missing: "token expired", "429 until 14:02". */
  stale: string | null;
  source: "endpoint" | "cache" | "rollout" | "cli" | "none";
  /** Anything else worth a line: extra-usage state, credits, a locked reason. */
  notes: string[];
}

/** Credential health as far as we can tell without refreshing anything. */
export interface AccountAuth {
  state: "ok" | "expired" | "missing" | "unknown";
  /** Access-token expiry, epoch ms, when the provider publishes one. */
  expiresAt: number | null;
  detail: string | null;
}

/** An account with everything the Accounts page and the balancer need. */
export interface AccountView extends Account {
  auth: AccountAuth;
  usage: AccountUsage;
  /** Active sessions pinned here and what they still claim. */
  claims: ClaimView[];
  /** The balancer's current view of this account for a normal session. */
  placement: Candidate | null;
}

export interface ClaimView {
  sessionId: string;
  title: string;
  big: boolean;
  /** Weekly points claimed at placement. */
  claim: number;
  /** Weekly points attributed to this session so far. */
  consumed: number;
  /** max(0, claim − consumed), or 0 once the claim has lapsed. */
  outstanding: number;
  lapsed: boolean;
}

// ------------------------------------------------------------- balancer

export interface BalancerSettings {
  /** Weekly points a normal session is assumed to use. */
  claimNormal: number;
  /** Weekly points a Big session is assumed to use. */
  claimBig: number;
  /** Weekly points one full short (5-hour) window is worth. */
  shortWindowInWeekly: number;
  /** A claim lapses after this long with no activity. */
  claimIdleMin: number;
  /** A short window this close to resetting is treated as partly fresh. */
  resetHorizonMin: number;
  /** Leg room within this many points of the best counts as a tie. */
  tieBand: number;
}

/** One account, as the balancer saw it when placing a session. */
export interface Candidate {
  accountId: string;
  label: string;
  eligible: boolean;
  /** Why not, in a sentence, when not eligible. */
  reason: string | null;
  /** Weekly used, and with outstanding claims added. */
  weekly: number | null;
  weeklyEffective: number | null;
  weeklyResetsAt: number | null;
  /** Short window used, and with claims added (claude). */
  short: number | null;
  shortEffective: number | null;
  shortResetsAt: number | null;
  /** 0–100: short-window room after claims and reset proximity. */
  legRoom: number | null;
  /** Weekly points left per hour until the weekly reset. */
  weeklyPerHour: number | null;
  outstanding: number;
  /** Ordering key; higher wins. */
  score: number;
}

export interface Placement {
  provider: ProviderId;
  accountId: string | null;
  /**
   * "auto" chose it; "manual" was your pick; "overflow" means every account's
   * weekly is fully claimed, so it went to the least-claimed one that still
   * has real weekly left; "none" means nothing can take it at all.
   */
  mode: "auto" | "manual" | "overflow" | "none";
  big: boolean;
  claim: number;
  candidates: Candidate[];
  /** One sentence: why this account. */
  why: string;
}

export interface CalibrationReport {
  /** How many days of samples this is built from. */
  days: number;
  shortWindowInWeekly: { estimate: number | null; samples: number; r2: number | null };
  sessionUse: {
    normal: Percentiles & { samples: number };
    big: Percentiles & { samples: number };
  };
  placements: number;
  /** Placements followed by a rate-limit hit on the chosen account. */
  hitAfterPlacement: number;
  suggested: Partial<BalancerSettings>;
  current: BalancerSettings;
}

export interface Percentiles {
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

// ---------------------------------------------------------------- session

/**
 * What a session is doing right now.
 *
 *   running   — a live process, mid-turn
 *   waiting   — a live process, turn over, your move
 *   blocked   — a live process showing a prompt it needs answered (permission,
 *               trust, login) — only knowable for sessions in our tmux
 *   stopped   — no process; the conversation can be resumed
 *   archived  — you put it away; still resumable. Wins over the rest: its
 *               process may still be alive (see `host`), and only a message
 *               from you brings it back
 */
export type SessionStatus = "running" | "waiting" | "blocked" | "stopped" | "archived";

/** Where the running process lives, which decides what we can do to it. */
export type SessionHost =
  /** In agentbox's tmux: we can type into it, attach to it, interrupt it. */
  | "tmux"
  /** A process we did not start, in some other terminal: read-only until adopted. */
  | "external"
  /** No process. */
  | "none";

export interface Session {
  /** agentbox's short id, stable for the row's life. */
  id: string;
  provider: ProviderId;
  /** The provider's own session id — what `--resume` takes. Null for the few
   *  seconds between spawning a provider that cannot be told its id up front
   *  and finding the transcript it wrote. */
  agentSessionId: string | null;
  accountId: string | null;
  status: SessionStatus;
  host: SessionHost;

  title: string;
  /** Your label, when you gave one; wins over the derived title. */
  label: string | null;
  cwd: string;
  /** The git work tree root containing cwd, if any. */
  repoRoot: string | null;
  branch: string | null;
  /** agentbox cut this worktree for the session. */
  worktree: string | null;
  model: string | null;

  firstPrompt: string | null;
  lastPrompt: string | null;
  /** When you last sent it something (not another agent, not the CLI waking
   *  itself); the start when you never have. What the board sorts by. */
  lastPromptAt: number;
  /** Tail of the last assistant text, for the list row. */
  lastMessage: string | null;

  /** Tokens currently in the context window, and the window's size. */
  contextUsed: number | null;
  contextLimit: number | null;
  tokens: TokenTotals;

  big: boolean;
  claim: number;
  /** The reasoning effort it was started with; null for the CLI's default. */
  effort: string | null;
  /**
   * Idle past `claimIdleMin`, so its prompt cache is cold and nothing is lost
   * by moving it: it is no longer pinned to `accountId` (the account it last
   * ran on) and wakes — on resume or on a message — on whichever account has
   * the most room. Only for providers that can move a session between
   * accounts, and only while it is not mid-turn or showing a prompt.
   */
  cold: boolean;
  /** The provider's latest "you hit your limit", when that is the last thing
   *  the session did — it stopped there and is waiting to be continued. */
  limitHit: { at: number; detail: string } | null;
  /** Where this session came from. */
  origin: "agentbox" | "external";

  pid: number | null;
  /** tmux session name, when host is "tmux". */
  tmux: string | null;
  transcriptPath: string | null;

  startedAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** What these tokens would have cost at API prices — the common unit that
   *  lets usage be apportioned across sessions on different models. */
  costEquiv: number;
}

/** The board groups by status; an alias so the two can never drift apart. */
export type AttentionKind = SessionStatus;

export interface Attention {
  kind: AttentionKind;
  /** Lower sorts first. */
  rank: number;
  /** One line for the board: why this is where it is. */
  reason: string;
}

// ---------------------------------------------------------------- timeline

/**
 * A provider-neutral transcript event. Each adapter folds its own format into
 * these; the UI renders only these.
 */
export type TimelineEvent = { id: string; at: number } & (
  | { kind: "user"; text: string; images?: number }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      name: string;
      /** One line: the command, the file, the pattern. */
      summary: string;
      input?: string;
      output?: string;
      status: "running" | "ok" | "error";
    }
  | { kind: "meta"; text: string; tone?: "info" | "warn" | "error" }
);

export interface TimelinePage {
  events: TimelineEvent[];
  /** Pass back as `before` to get the page before this one. Null at the start. */
  before: string | null;
  /** Pass back as `since` to get what happened after this page. */
  cursor: string;
}

// ----------------------------------------------------------------- logins

export type LoginState = "starting" | "awaiting-user" | "verifying" | "done" | "failed";

export interface LoginFlow {
  id: string;
  provider: ProviderId;
  accountId: string;
  state: LoginState;
  /** Open this. */
  url: string | null;
  /** Codex device flow: type this at the URL. */
  userCode: string | null;
  /** Claude and devin: paste what the browser gives you back here. */
  needsPaste: boolean;
  /** The tail of what the CLI printed, for when it asks something unexpected. */
  output: string;
  error: string | null;
  startedAt: number;
}

// --------------------------------------------------------------- settings

export interface AgentSettings {
  theme: "light" | "dark" | "system";
  /** Days of inactive sessions to keep on the board. */
  boardDays: number;
  /** Skip permission prompts (each provider's bypass flag). */
  autoApprove: boolean;
  /** Default model per provider; empty means the provider's own default. */
  models: Record<ProviderId, string>;
  balancer: BalancerSettings;
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
  /** Which root it came from; see `skillRoots` for the order they shadow in. */
  source: SkillSource;
  /** Repo-local skills: the repo they belong to. */
  repo?: string;
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

// ------------------------------------------------------------- models

/** One model a provider CLI will take for `--model`, as the new-session
 *  dialog offers it. `GET /api/models?provider=&accountId=`. */
export interface ModelOption {
  /** What goes after `--model`. */
  id: string;
  label: string;
  /** "2026-09-01", from the models.dev catalog when it knows the model. */
  releasedAt: string | null;
}

// ------------------------------------------------------------- skills

export type SkillSource = "global" | "agents" | "codex" | "omp" | "project";

// ------------------------------------------------------------ wire shapes

/** Pushed on every change. Small enough to send often. */
export interface HotState {
  sessions: (Session & { attention: Attention })[];
  serverTime: number;
}

/** The Project session pinned atop the board (src/core/project.ts). */
export interface ProjectState {
  provider: ProviderId;
  /** Null until it is first opened, or when its row is gone. */
  sessionId: string | null;
  /** The harness has a compact command. */
  canCompact: boolean;
}

/** One line of `GET /api/grep`. */
export interface GrepHit {
  sessionId: string;
  at: number;
  kind: TimelineEvent["kind"];
  line: string;
}

/** Changes on a slower clock; pushed only when it moves. */
export interface ColdState {
  accounts: AccountView[];
  logins: LoginFlow[];
  repos: Repo[];
  prs: PrInfo[];
  skills: SkillInfo[];
  settings: AgentSettings;
  /** Which provider CLIs are installed, their versions, and the reasoning
   *  effort levels each takes (lowest first; empty for none). */
  providers: { id: ProviderId; installed: boolean; version: string | null; efforts: string[] }[];
  /** Set when something is missing, so the UI can say so instead of failing. */
  warnings: string[];
  project: ProjectState;
}

export interface AppState extends HotState, ColdState {}

// ----------------------------------------------------------------- health

/** `ok`, installed but `unusable` (with the reason), or `missing` — src/deps.ts. */
export type DepState = "ok" | "unusable" | "missing";

export interface DepStatus {
  state: DepState;
  /**
   * A sentence about this state that a user can act on — the reason it is not
   * `ok`, or the version/account when it is. Null when there is nothing to add.
   */
  detail: string | null;
}

export interface DepSnapshot {
  tmux: DepStatus;
  gh: DepStatus;
  git: DepStatus;
  /** When this snapshot was taken. */
  at: number;
}

/** `GET /api/health`. `?refresh=1` re-probes instead of answering from cache. */
export interface Health {
  version: string;
  /** `tmux -V`, or null when tmux will not run. */
  tmux: string | null;
  providers: ColdState["providers"];
  deps: DepSnapshot;
}

/** Server → client. */
export type ServerMessage =
  | { type: "hot"; state: HotState }
  | { type: "cold"; state: ColdState }
  | {
      type: "timeline";
      sessionId: string;
      events: TimelineEvent[];
      cursor: string;
      reset: boolean;
      /** On a reset frame: pass as `before` to page further back; null at the start. */
      before?: string | null;
    }
  | { type: "metrics"; state: MetricsState }
  | { type: "error"; message: string };

/** Client → server. A client watches at most one session's timeline. */
export type ClientMessage =
  | { type: "watch"; sessionId: string | null }
  | { type: "ping" };
