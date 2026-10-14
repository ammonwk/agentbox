/** agentbox domain model — the one source of truth.
 *
 * The web UI imports these types directly (type-only, so nothing ships at
 * runtime) — there is deliberately no second copy in web/src. Keep this file
 * types-only: a value export here would drag server code into the UI bundle.
 *
 * docs/v2.md is the map of how these relate.
 */

import type { ScheduleRule } from "./schedule";
export type { ScheduleRule };
import type { UserIdentity } from "./user";
export type { UserIdentity };

// -------------------------------------------------------------- providers

export type ProviderId = "claude" | "codex" | "devin" | "omp" | "opencode" | "muse";

/** The providers that hold accounts. opencode holds none of its own: it runs
 *  on OpenCode Go, which omp's accounts are sign-ins to and report usage
 *  for, so its sessions sit on those accounts and share their balancer
 *  (`accountProvider` in providers/index.ts). */
export type AccountProvider = Exclude<ProviderId, "opencode">;

// --------------------------------------------------------------- accounts

/**
 * One login on one provider. The credential home is what isolates it: the
 * provider's CLI is run with `env` and finds only this account's credentials.
 */
export interface Account {
  id: string;
  provider: AccountProvider;
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
  /** The upstream it belongs to, where one account fronts several (omp). */
  provider?: string;
}

/** One Codex usage-limit reset you can spend: the CLI's `/usage` menu's "Full
 *  reset". Spending one clears the account's spent windows so sessions stopped
 *  at the limit can carry on. */
export interface ResetCredit {
  id: string;
  /** "codex_rate_limits" today; kept as a string for whatever comes next. */
  resetType: string;
  status: "available" | "redeeming" | "redeemed" | "unknown";
  /** Epoch ms the provider granted it. */
  grantedAt: number | null;
  /** Epoch ms it stops being usable; null means it does not expire. */
  expiresAt: number | null;
  /** The provider's own words for it: "Full reset". */
  title: string | null;
  description: string | null;
}

/** Codex usage-limit resets you have left. Codex only. */
export interface ResetCredits {
  /** How many are left to spend, spent or not. */
  availableCount: number;
  /** Of those, how many the provider says apply to a window that is at its
   *  limit right now. It is advice, not a gate: a credit can be spent when
   *  this is zero (observed: `applicable_available_count: 0`, consume still
   *  cleared the window), so the UI offers the button on `availableCount`. */
  applicableCount: number | null;
  /** The credits themselves, newest first, when the details endpoint answered.
   *  Empty when only the count is known. */
  credits: ResetCredit[];
}

/** What spending a reset did, as the provider worded it. */
export type ResetOutcome = "reset" | "nothing-to-reset" | "no-credit" | "already-redeemed" | "unknown";

export interface ResetConsumeResult {
  outcome: ResetOutcome;
  /** How many windows the provider says it cleared. */
  windowsReset: number;
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
  /** Codex: usage-limit resets left to spend (docs/v2.md, Usage). Absent for
   *  every other provider, and on readings that never carried one. */
  resets?: ResetCredits | null;
}

/** Credential health as far as we can tell without refreshing anything. */
export interface AccountAuth {
  state: "ok" | "expired" | "missing" | "unknown";
  /** Access-token expiry, epoch ms, when the provider publishes one. */
  expiresAt: number | null;
  detail: string | null;
}

/**
 * An account — one login — with everything the Accounts page and the
 * balancer need. The list has one per login: a second credential home on the
 * same login (your CLI's default home, or a duplicate agentbox home) is not
 * an account of its own but an entry in `alsoAt`, and sessions in it belong
 * to this account.
 */
export interface AccountView extends Account {
  auth: AccountAuth;
  usage: AccountUsage;
  /** Active sessions on this account (in any of its homes) and what they
   *  still claim. */
  claims: ClaimView[];
  /** The balancer's current view of this account for a normal session. */
  placement: Candidate | null;
  /** Other homes logged in as this login. */
  alsoAt: { id: string; home: string; isDefault: boolean }[];
}

export interface ClaimView {
  sessionId: string;
  title: string;
  /** Weekly points claimed at placement. */
  claim: number;
  /** Weekly points attributed to this session so far. */
  consumed: number;
  /** What it is still expected to use here: forecast from what it has been
   *  spending (forecast.ts), or `max(0, claim − consumed)` while there is
   *  nothing to forecast from; 0 once the claim has lapsed. */
  outstanding: number;
  /** Which of the two `outstanding` is. */
  basis: "forecast" | "claim";
  lapsed: boolean;
  /** Since when it has been spending on this account: started, or woken
   *  there. A 5-hour pace measured before then has not seen it. */
  since: number;
}

// ------------------------------------------------------------- balancer

export interface BalancerSettings {
  /** Weekly points a normal session is assumed to use. */
  claimNormal: number;
  /** Weekly points one full short (5-hour) window is worth. */
  shortWindowInWeekly: number;
  /** A claim lapses after this long with no activity. */
  claimIdleMin: number;
  /** A short window this close to resetting is treated as partly fresh. */
  resetHorizonMin: number;
  /** How full, in percent, a 5-hour window is loaded before new sessions go
   *  to the next account to reset. */
  shortLoadPct: number;
}

/** One account, as the balancer saw it when placing a session. */
export interface Candidate {
  accountId: string;
  label: string;
  eligible: boolean;
  /** Why not, in a sentence, when not eligible. */
  reason: string | null;
  /** Not eligible because the provider is refusing the model here
   *  (core/refusals.ts): no estimate, so overflow does not go there either. */
  refused?: boolean;
  /** Weekly used, and with outstanding claims added. */
  weekly: number | null;
  weeklyEffective: number | null;
  weeklyResetsAt: number | null;
  /** Short window used (claude), and where it is headed: with a pace, where
   *  it stands at its reset if it keeps filling that fast, plus the claims of
   *  sessions too new for the pace to have seen; without one, with every
   *  outstanding claim added. */
  short: number | null;
  shortEffective: number | null;
  shortResetsAt: number | null;
  /** 0–100: short-window room left by `shortEffective`, raised by reset
   *  proximity. */
  legRoom: number | null;
  /** How full the balancer will load the 5-hour window: `shortLoadPct`, or
   *  more when its weekly needs more to be used up before it resets. A
   *  session has room here while the window stays under that. */
  shortLoadTo: number | null;
  /** Weekly points left per hour until the weekly reset. */
  weeklyPerHour: number | null;
  /** 5-hour points an hour at the pace of the last readings; null when there
   *  are too few to say. */
  shortPace: number | null;
  /** When the 5-hour window runs out at that pace, when that is before it resets. */
  shortRunsOutAt: number | null;
  outstanding: number;
  /** Room before it is floored at 0 (below zero: how far claims overrun
   *  it); what orders accounts that all have none. -Number.MAX_VALUE when
   *  usage is unknown. */
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
  claim: number;
  candidates: Candidate[];
  /** One sentence: why this account. */
  why: string;
}

export interface CalibrationReport {
  /** How many days of samples this is built from. */
  days: number;
  shortWindowInWeekly: { estimate: number | null; samples: number; r2: number | null };
  sessionUse: Percentiles & { samples: number };
  placements: number;
  /** Placements followed by a rate-limit hit on the chosen account. */
  hitAfterPlacement: number;
  suggested: Partial<BalancerSettings>;
  current: BalancerSettings;
  forecast: ForecastReport;
}

/** The table sessions' outstanding claims are forecast from (forecast.ts). */
export interface ForecastReport {
  fittedAt: number;
  /** Bucket edges, in cost-equivalent: spent in the last ten minutes, and so far this stretch. */
  recentEdges: number[];
  soFarEdges: number[];
  providers: {
    provider: string;
    /** Weekly points per cost-equivalent on its median account; null when none has a price yet. */
    pointsPerCost: number | null;
    /** `recent` and `soFar` index the buckets the edges make. `points` is null
     *  where too few stretches were seen, or the points have no price. */
    cells: { recent: number; soFar: number; stretches: number; points: number | null }[];
  }[];
}

export interface Percentiles {
  p50: number | null;
  p75: number | null;
  p90: number | null;
}

// ---------------------------------------------------------------- insights

/** The ways an input token is billed, plus output. Disjoint: they add up. */
export type SpendPart = "input" | "write5m" | "write1h" | "cacheRead" | "output";

/** Model calls, their tokens and what those would cost at API prices. */
export interface Spend {
  calls: number;
  tokens: Record<SpendPart, number>;
  /** API-equivalent dollars (src/core/pricing.ts), per part. */
  cost: Record<SpendPart, number>;
  /** Of `tokens.output`, how many were thinking. */
  thinking: number;
}

/**
 * Why a call wrote again a context that had been cached: what the session
 * was waiting on while its cache expired (5 minutes for a subagent, an hour
 * for a session), or that nothing was and it missed anyway.
 */
export type RebuildCause =
  | "you" // waited for your next message
  | "subagent" // a subagent it started and waited on
  | "teammate" // a message from its lead, a teammate or another session
  | "background" // a background task's notification, a wakeup
  | "command" // a long tool call
  | "compact" // compaction: the summary is new context
  | "miss"; // no long wait: a restart, a model or tool change

export interface Rebuild {
  /** The transcript's session (see InsightSession.key). */
  key: string;
  /** The subagent that rebuilt, when it was one. */
  agent: string | null;
  at: number;
  /** Since its previous call. */
  gapMs: number;
  /** Tokens written again. */
  tokens: number;
  cost: number;
  /** What it would have cost to read them from a warm cache instead. */
  warmCost: number;
  cause: RebuildCause;
  /** The tool it waited on (a command line, `Agent: …`). */
  detail: string | null;
}

export interface InsightAgent {
  name: string;
  type: string | null;
  spend: Spend;
  peakContext: number;
  rebuildCost: number;
  firstAt: number;
}

export interface InsightSession {
  /** The provider's session id. */
  key: string;
  /** The board's session, when agentbox knows it. */
  sessionId: string | null;
  title: string;
  cwd: string | null;
  /** The session's own calls and its subagents' together. */
  spend: Spend;
  /** Of `spend`, its subagents'. */
  agentSpend: Spend;
  /** Messages you sent it in the window. */
  prompts: number;
  firstAt: number;
  lastAt: number;
  /** The most context one call carried, in tokens. */
  peakContext: number;
  rebuilds: number;
  rebuildCost: number;
  /** Its costliest subagents, at most a dozen; `agentCount` is all of them. */
  agents: InsightAgent[];
  agentCount: number;
}

/**
 * Where one account's usage went: every model call in its transcripts over
 * the window, in API-equivalent dollars. Subscriptions do not bill per token,
 * but list prices are the one scale on which a cache read, a cache write and
 * an output token add up — and the weekly bar is drawn from roughly that.
 */
export interface UsageInsights {
  accountId: string;
  provider: ProviderId;
  from: number;
  to: number;
  /** `transcripts`: every call, read from the provider's files. `samples`:
   *  per-session totals agentbox recorded as they moved (devin, omp), with
   *  no cache, context or wait detail. */
  source: "transcripts" | "samples";
  scan: { files: number; bytes: number; ms: number };
  total: Spend;
  /** One per hour from `from`. */
  hours: Spend[];
  /** The account's weekly window over the same span. */
  weekly: {
    points: { at: number; pct: number }[];
    /** Points it rose by (across a reset too). */
    gained: number;
    /** API-equivalent dollars per weekly point, when it rose enough to say. */
    perPoint: number | null;
    /** When it first read 100%, and when that window reset. */
    limitAt: number | null;
    limitResetAt: number | null;
    /** What ran while the window read 100%: the provider serves that only
     *  as extra usage, billed apart from the plan. */
    atLimit: { calls: number; cost: number };
  } | null;
  models: { model: string; calls: number; cost: number }[];
  /** Calls by how much context each carried. `to` null: no upper bound. */
  context: { from: number; to: number | null; calls: number; cost: number }[];
  rebuilds: {
    count: number;
    cost: number;
    warmCost: number;
    causes: { cause: RebuildCause; count: number; cost: number; warmCost: number }[];
    /** Of them, subagents' and teammates': five-minute caches. */
    agents: { count: number; cost: number };
    /** Many sessions rebuilding within minutes of each other: woken together,
     *  by a restart, a recovery or a message to all of them. */
    bursts: { at: number; sessions: number; cost: number }[];
    /** The costliest, at most 20. */
    worst: Rebuild[];
  } | null;
  /** By cost, at most 40. */
  sessions: InsightSession[];
  sessionCount: number;
  /** Claude's subagents and teammates, across every session. */
  agents: { count: number; spend: Spend; byType: { type: string; count: number; cost: number }[] } | null;
  /** Rate-limit stops on this account in the window. */
  limitHits: number[];
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
 *   closed    — you closed it: stopped and off the list; still resumable.
 *               Wins over the rest: a process that outlived the stop (see
 *               `host`) does not bring it back, only a message from you does
 */
export type SessionStatus = "running" | "waiting" | "blocked" | "stopped" | "closed";

/** Where the running process lives, which decides what we can do to it. */
export type SessionHost =
  /** In agentbox's tmux: we can type into it, attach to it, interrupt it. */
  | "tmux"
  /** A process we did not start, in some other terminal: read-only until adopted. */
  | "external"
  /** A pool agent of another session's subagent MCP: read-only, and it stops
   *  when that session does. Resumable here only once it has stopped. */
  | "subagent"
  /** No process. */
  | "none";

export interface Session {
  /** agentbox's short id, stable for the row's life. */
  id: string;
  /** Registered agent ownership for navigation; not a messaging capability. */
  agentOwner?: string | null;
  provider: ProviderId;
  /** The provider's own session id — what `--resume` takes. Null for the few
   *  seconds between spawning a provider that cannot be told its id up front
   *  and finding the transcript it wrote. */
  agentSessionId: string | null;
  /** The account it runs on. Its transcript may live in another home of the
   *  same login (see `AccountView.alsoAt`); the account is what matters for
   *  limits, claims and where it can move. */
  accountId: string | null;
  status: SessionStatus;
  host: SessionHost;

  title: string;
  /** Your label, when you gave one; wins over the derived title. */
  label: string | null;
  cwd: string;
  /** The git work tree root containing cwd, if any. */
  repoRoot: string | null;
  /** The GitHub repo (`owner/name`) it names most as the home of PRs, when
   *  it named one; its `#1234`s are that repo's. */
  prRepo: string | null;
  branch: string | null;
  /** agentbox cut this worktree for the session. */
  worktree: string | null;
  model: string | null;

  firstPrompt: string | null;
  lastPrompt: string | null;
  /** Timestamp of lastPrompt, including agent messages; the start if unknown. */
  lastPromptAt: number;
  /** Tail of the last assistant text, for the list row. */
  lastMessage: string | null;

  /** Tokens currently in the context window, and the window's size. */
  contextUsed: number | null;
  contextLimit: number | null;
  tokens: TokenTotals;

  claim: number;
  /** The reasoning effort it was started with; null for the CLI's default. */
  effort: string | null;
  /** When its prompt cache goes cold: its newest model call plus the
   *  lifetime that call wrote the cache with (src/core/cache.ts). */
  cacheWarmUntil: number;
  /**
   * Past `cacheWarmUntil`, so its prompt cache is cold and nothing is lost
   * by moving it: it is no longer pinned to `accountId` (the account it last
   * ran on) and wakes — on resume or on a message — on whichever account has
   * the most room. Only for providers that can move a session between
   * accounts, and only while it is not mid-turn or showing a prompt.
   */
  cold: boolean;
  /** The provider's latest "you hit your limit", when that is the last thing
   *  the session did — it stopped there and is waiting to be continued — and
   *  its account's usage does not say that limit is gone (`Fleet.limitEnd`). */
  limitHit: {
    at: number;
    detail: string;
    provider?: string;
    /** When the limit lifts, as far as is known: the reset of the account's
     *  spent window, or the time the message names where no window of the
     *  account ever accounted for the hit. Until then every
     *  message is refused the same way, so nothing is sent (the fleet's own
     *  nudges, and `agentbox send` from an agent). Null when nothing says. */
    until?: number | null;
    /** The fleet already moved it off an account at its limit once
     *  (`Fleet.continueStalled`), so from here a move is yours. */
    hopped?: true;
  } | null;
  /**
   * The turn ended on the provider rather than finishing — cut off by the
   * output cap, a transient API error, or something a retry cannot fix —
   * and nothing has followed it. `kind` says which:
   *   output-cap — the reply was cut off mid-write; a message continues it
   *   transient  — a server/network failure; a retry has a real chance
   *   fatal      — a retry cannot fix it (context too long, model gone, login)
   * `retryAfterMs`, when set, is the longest the fleet leaves it between
   * retries (a model at capacity: 10 minutes; it backs off up to that, from a
   * minute), and it keeps retrying until the error clears. Null while the
   * turn is open or a prompt has followed.
   */
  turnError: { at: number; kind: "output-cap" | "transient" | "fatal"; detail: string; retryAfterMs?: number } | null;
  /**
   * When the fleet will tell it to go on by itself — past an error, a rate
   * limit or the reset of a spent window due within five hours of the hit
   * (`Fleet.autoResumeOf`) — and which try that is:
   * `attempt` of `of`, `of` null when it keeps trying until it works. About:
   * nudges go out one at a time across the fleet. Anything you send it first
   * does the same and calls this off. Null when nothing will. `after` says
   * what it goes on past: an error (a turn error or an error screen, which
   * the board draws as working: retrying it is not your move) or a reset.
   */
  autoResume: { at: number; attempt: number; of: number | null; after: "error" | "reset" } | null;
  /** The AskUserQuestion dialog it is showing, while it shows one: answer it
   *  with `POST /api/sessions/:id/answer`. */
  question: { id: string; questions: AskQuestion[] } | null;
  /** What it was sent mid-turn and is holding until the current step yields
   *  (claude), oldest first; empty unless it is running or blocked. Claude
   *  records its queue in the transcript, so this outlives the page that sent it. */
  queued: QueuedMessage[];
  /** Where this session came from. */
  origin: "agentbox" | "external";
  /**
   * The session that started this one — a Claude teammate's lead, or the
   * session whose process a `codex exec`, `claude -p` or omp ran under, or the
   * session that asked the API for it. Null for top-level work, which
   * includes everything the Project session launches. May name a session that
   * is closed or gone; the board shows such a child at the root.
   */
  parent: string | null;
  /** You set or cleared `parent` yourself, by dragging it on the board: a
   *  grouping of yours, not a run its parent made, so it is not closed when it
   *  stops and the fleet never links it again. */
  parentByHand: boolean;
  /** The session that took over from this one (`Fleet.handOver`), when one
   *  has: an agent's message to this one goes there instead. */
  successor: string | null;
  /** Set when this is an agent a session started through the subagent MCP
   *  (its `parent`); `answerWaiting` while that session has not collected a
   *  finished turn. */
  subagent: { name: string; answerWaiting: boolean } | null;

  pid: number | null;
  /** tmux session name, when host is "tmux". */
  tmux: string | null;
  transcriptPath: string | null;

  startedAt: number;
  lastActivityAt: number;
  /** When you closed it; null while it is on the list. */
  closedAt: number | null;
  /** Pinned to the top of the session list, at this place among the pinned
   *  (lower first; `PATCH` with `pinOrder`). Null when it is not pinned. A
   *  pinned or bookmarked session stays on the board when closed. */
  pinOrder: number | null;
  /** When you bookmarked it, for the list's bookmarks menu; null when it is not. */
  bookmarkedAt: number | null;
  /**
   * When the fleet stopped its process for sitting idle. A parked session is
   * still shown as `waiting` — it is still your move — and the next message
   * resumes it. Null for one that is running or that you stopped yourself.
   */
  parkedAt: number | null;
  /** Idle past `parkIdleMin` but kept running, and why: "a background command
   *  is running (…)", "a /loop wakeup is due in 12m", "teammate x is mid-turn". */
  parkHold: string | null;
  /** Running only on work it left going: the provider says busy, but its own
   *  turn is over and it is waiting on teammates, background agents or
   *  shells, not thinking. */
  background: boolean;
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
/** Who sent a message that came in through the provider's user role, as the
 *  server verified it (src/core/senders.ts); absent on your own messages. */
export interface SenderView {
  /** agent: a registered agent; session: another agent session; system and
   *  schedule: agentbox's own notes; cloud: another installation, as the
   *  cloud vouches; peer: Claude's own delivery between its sessions;
   *  unverified: a mark the server has no matching record of. */
  kind: "agent" | "session" | "system" | "schedule" | "cloud" | "peer" | "unverified";
  label: string;
  /** The sending session, when known and in scope. */
  session: string | null;
  agent?: { id: string; name: string; role: string; creator: boolean; avatar: string | null };
}

export type TimelineEvent = { id: string; at: number } & (
  | { kind: "user"; text: string; images?: number; sender?: SenderView }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      name: string;
      /** One line: the command, the file, the pattern. */
      summary: string;
      /** What the agent said the call is for, in its words (Bash's description), when it said. */
      title?: string;
      input?: string;
      output?: string;
      status: "running" | "ok" | "error";
      /** When the result landed, for showing how long the call took. */
      endedAt?: number;
      /** AskUserQuestion: what was asked, uncapped, and what was answered. */
      ask?: { id: string; questions: AskQuestion[]; answers?: Record<string, string> };
    }
  | { kind: "meta"; text: string; tone?: "info" | "warn" | "error"; mate?: MateMessage }
);

/**
 * A side question (Claude's /btw) and its answer. Claude keeps these only in
 * the running process's memory, never in the transcript, so agentbox keeps
 * them: asked from the Timeline, or seen asked in the terminal.
 */
/** Delivery metadata only; the provider's transcript remains the record. */
export interface SendReceipt {
  id: string;
  sessionId: string;
  state: "pending" | "attempting" | "sent" | "failed" | "unconfirmed";
  at: number;
  error: string | null;
}

export interface Btw {
  id: number;
  sessionId: string;
  question: string;
  /** The answer's markdown, as Claude's panel copies it. */
  answer: string | null;
  error: string | null;
  status: "asking" | "answered" | "failed" | "dismissed";
  source: "timeline" | "terminal";
  askedAt: number;
  answeredAt: number | null;
}

/** A message between the members of a Claude agent team, as the one receiving it recorded it. */
export interface MateMessage {
  /** Who sent it: a teammate's name (its session's title), or `team-lead`. */
  name: string;
  /** The colour Claude gave the sender: blue, red, … */
  color?: string;
  /** The sender's one-line summary of what it sent. */
  summary?: string;
  /** What it said, clipped; empty for an idle notice that reported nothing. */
  body: string;
  /** An idle notice rather than a message: why it stopped (`available`, or `failed: …`). */
  idle?: string;
}

/** A message waiting in the agent's queue: as it will be delivered, and when it was queued. */
export interface QueuedMessage {
  text: string;
  at: number;
}

/** One question of an AskUserQuestion call, as the agent asked it. */
export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** Your answer to one question: the options picked (at most one unless
 *  multi-select), and text of your own ("Type something"). */
export interface AskAnswer {
  labels: string[];
  other?: string;
}

/**
 * Something you said to a session, for the message rail beside the terminal
 * and the timeline (`GET /api/sessions/:id/turns`).
 */
export interface Turn {
  /** The timeline event it is: a `user` event, or the question tool it answers. */
  id: string;
  at: number;
  /**
   * `prompt` you typed (or sent from here); `answer` to the agent's question;
   * `agent`, typed in by another session; `command`, a slash command or a
   * `!` shell line.
   */
  kind: "prompt" | "answer" | "agent" | "command";
  /** The message, capped. An answer is the question, a newline, and the answer. */
  text: string;
  /** How many events come before it, to place it along the conversation. */
  seq: number;
}

export interface TurnList {
  turns: Turn[];
  /** Events in the whole conversation. */
  total: number;
}

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
  provider: AccountProvider;
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
  /** How the session list says which repo or folder a session is in: its
   *  name before the title, or the repo's shape, which takes less room. */
  repoMark: "name" | "shape";
  /** Which of the agent's working steps the timeline folds away between the
   *  things it says: all of them, those of turns it has finished, or none. */
  hideSteps: "always" | "done" | "never";
  /** Days of inactive sessions to keep on the board. */
  boardDays: number;
  /** Skip permission prompts (each provider's bypass flag). */
  autoApprove: boolean;
  /** Stop a Claude session's process after this many minutes idle with
   *  nothing holding it up (src/core/park.ts); 0 never does. */
  parkIdleMin: number;
  /** Remove the worktrees with nothing to lose every night at 3am
   *  (src/core/nightly.ts). */
  reclaimNightly: boolean;
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
  /** Resolved checkout root for navigation, including GitHub clones and linked worktrees. */
  checkoutRoot?: string;
  /** Local absolute path, or an `owner/name` GitHub slug. */
  ref: string;
  kind: "local" | "github";
  displayName: string;
  /** Resolved GitHub slug, if this repo has one. Cached; may be null. */
  fullName: string | null;
  /** Branch new worktrees are cut from. Resolved once at registration. */
  defaultBranch: string;
  addedAt: number;
  /** Where this repo's new sessions start, set in Settings: true — a new
   *  worktree; false — the checkout itself; null — no default. */
  worktreeDefault: boolean | null;
  /** What a new worktree of this repo is given as it is cut. */
  setup: RepoSetup;
}

/**
 * A fresh worktree has what git tracks and nothing else: no `.env`, no
 * `node_modules`. `copy` fills in the first before the agent starts; `run`
 * does the slow part alongside it (src/core/setup.ts).
 */
export interface RepoSetup {
  /** Paths relative to the repo root, copied from its checkout. */
  copy: string[];
  /** A shell command run in the new worktree; empty for none. */
  run: string;
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
  /** The live session that has it now (`AppState.prClaims`), or null: free. */
  owner: string | null;
}

/** A pull request and the live session that has it (src/core/prclaims.ts). */
/** What a close did: the sessions it closed, those it started that it left
 *  open for the work they hold, and what the one asked for gave up. */
export interface Closed {
  closed: string[];
  kept: { id: string; holds: string[] }[];
  dropped: string[];
  /** The above in words, to follow "closed <id>"; empty when it took nothing else. */
  said: string;
}

export interface PrClaim {
  repo: string;
  number: number;
  sessionId: string;
  /** `said`: it claimed it (`agentbox pr claim`, `--claim` at its start).
   *  `branch`: it is on the PR's branch and nobody claimed otherwise. */
  how: "said" | "branch";
  /** When it said so; for a branch, when the PR was opened. */
  at: number;
}

// -------------------------------------------------------------------- MCPs

/** How agentbox reaches a global MCP server: a command it starts, or a URL
 *  (Streamable HTTP). */
export type McpTransport = "stdio" | "http";

/**
 * A global MCP server as the page sees it (src/core/mcp.ts). Env and header
 * values never leave the server: only their names do.
 */
export interface McpServerView {
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command: string | null;
  args: string[];
  envKeys: string[];
  url: string | null;
  headerKeys: string[];
  /** Where it was imported from, when it was. */
  from: string | null;
  createdAt: number;
  updatedAt: number;
  /** What is wrong with it that shows without starting it. */
  problem: string | null;
  /** For each agent, whether its sessions get it. */
  reach: McpReach[];
}

export interface McpReach {
  provider: ProviderId;
  /** on: passed to it; own: it has its own server of this name with the same
   *  definition; conflict: it has a different one, which it keeps; off: the
   *  server is turned off; unsupported: agentbox does not pass servers to it;
   *  error: sessions start without it (its command is not on the PATH, or the
   *  agent's own config cannot be read), and `detail` says why. */
  state: "on" | "own" | "conflict" | "off" | "unsupported" | "error";
  detail: string;
}

/** An MCP server an agent's own config defines, found without starting it. */
export interface McpFound {
  id: string;
  provider: ProviderId;
  /** user: every session of that agent; project: one directory's sessions. */
  scope: "user" | "project";
  /** The files it is defined in (the same definition in each). */
  sources: string[];
  project: string | null;
  name: string;
  /** Null when agentbox cannot carry its shape (see `unsupported`). */
  transport: McpTransport | null;
  command: string | null;
  args: string[];
  envKeys: string[];
  url: string | null;
  headerKeys: string[];
  unsupported: string | null;
  /** The global server of that name: none, this definition, or another. */
  global: "none" | "same" | "different";
}

export interface McpAgent {
  provider: ProviderId;
  installed: boolean;
  /** Whether agentbox passes global servers to its sessions. */
  supported: boolean;
  /** A configuration problem that keeps the global servers out of its
   *  launches (they still start, without them). */
  error?: string | null;
  /** How, or why not, in words. */
  how: string;
}

export interface McpState {
  servers: McpServerView[];
  found: McpFound[];
  discoveryError?: string | null;
  agents: McpAgent[];
  /** When the global list last changed. */
  changedAt: number | null;
  /** Configuration snapshot handed to each running session, not a health check. */
  sessions?: { id: string; title: string; provider: ProviderId; changedAt: number | null; given: string[]; kept: { name: string; same: boolean; enabled: boolean }[]; known: boolean;
    /** Servers left out of its launch, and why. */
    skipped?: { name: string; why: string }[];
    /** Why it was launched without the global layer at all. */
    error?: string | null }[];
  /** Sessions agentbox runs whose process started before that change: they
   *  get it when they next start or resume. */
  stale: { id: string; title: string; provider: ProviderId; since: number }[];
}

/** A global server as the page sends it. An env or header entry without a
 *  `value` keeps the value already saved under that name. */
export interface McpServerInput {
  name: string;
  enabled?: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: { key: string; value?: string }[];
  url?: string;
  headers?: { key: string; value?: string }[];
}

/** What a check found when it started the server and asked for its tools. */
export interface McpCheck {
  ok: boolean;
  tools: string[];
  error: string | null;
  ms: number;
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
    | "merged" | "closed" | "clean" | "orphan" | "stale"
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
  /** A repo's PRs were needed to judge at least one branch and are not loaded
   *  from GitHub yet (src/core/prs.ts), so every PR state below is a guess. */
  ghUnavailable: boolean;
}

/** What the last nightly sweep did (src/core/nightly.ts). */
export interface NightlyReclaim {
  startedAt: number;
  finishedAt: number;
  removed: number;
  bytesFreed: number;
  /** Safe by the scan, but in use or changed by the time its turn came. */
  kept: number;
  failed: { path: string; error: string }[];
  /** Stopped at its deadline with worktrees still to go. */
  cutShort: boolean;
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
  /** A detail worth a column — a cost tier, a flag ("beta"). Shown only when
   *  the row has no recency or release to display. */
  note?: string;
  /** Reasoning-effort levels this model takes, lowest first, when the catalog
   *  knows them per model (codex). Overrides the provider's `efforts`. */
  efforts?: string[];
}

// ------------------------------------------------------------- skills

export type SkillSource = "global" | "agents" | "codex" | "omp" | "project";

// ------------------------------------------------------------ wire shapes

/** The board. Over a socket it holds the open sessions only, and the closed
 *  ones you pinned or bookmarked, whole on connect and then as they change
 *  (`hotDelta`); `GET /api/state` has the closed ones too, unless asked for
 *  `?open=1`. The See closed list pages them from `GET /api/sessions/closed`. */
export interface HotState {
  sessions: (Session & { attention: Attention })[];
  serverTime: number;
  /** Moves whenever a session is closed or reopened, so an open See closed
   *  list knows to fetch again. */
  closedStamp?: number;
}

/** An opening prompt you wrote, for the new-session box's history (`GET /api/prompts`). */
export interface PromptHistoryEntry {
  sessionId: string;
  prompt: string;
}

/** One line of `GET /api/grep`. */
export interface GrepHit {
  sessionId: string;
  at: number;
  kind: TimelineEvent["kind"];
  line: string;
}

// ------------------------------------------------------------------ cards

/** A decision the user owes, or something that happened: a pull request
 *  merged, a note. */
export type CardKind = "decision" | "merged" | "note";
/** `later`: kept for later, still to be answered. `closed`: withdrawn by its asker. */
export type CardState = "open" | "later" | "answered" | "closed";

/** What a session handed the user (src/core/cards.ts). */
export interface Card {
  /** Counted from 1: "card 12" is how both sides name it. */
  id: number;
  kind: CardKind;
  title: string;
  /** Two or three sentences. */
  short: string;
  hasLong: boolean;
  /** The long, extra clear version, Markdown; only on `GET /api/cards/:id`. */
  long?: string | null;
  /** The pull request it is about, a URL. */
  pr: string | null;
  /** What the asker would do. */
  recommend: string | null;
  /** What the asker does if `defaultAt` passes unanswered; agentbox only shows it. */
  default: string | null;
  defaultAt: number | null;
  /** The asker's own name for it: adding the same key again adds nothing. */
  key: string | null;
  /** The session that asked, and gets the answer. */
  sessionId: string | null;
  /** The session it is about, when that is another. */
  about: string | null;
  state: CardState;
  /** The user's words; "" when it was only seen. */
  answer: string | null;
  answeredAt: number | null;
  /** When the answer was typed into the asker, or a session said it has it. */
  deliveredAt: number | null;
  /** Answered in words that no session has yet. */
  unread: boolean;
  laterAt: number | null;
  createdAt: number;
  closedWhy: string | null;
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
  schedules: Schedule[];
  /** Every card still to be answered, then the newest answered and withdrawn
   *  ones; without their long versions. */
  cards: Card[];
  /** Who has which pull request: every PR a live session holds. One not
   *  listed is nobody's. */
  prClaims: PrClaim[];
  /** Who agentbox works for and what is still unsetup, for the first-run card. */
  onboarding: Onboarding;
}

/** What onboarding knows, all of it probed from the machine — never assumed.
 *  Every field has a probe (see core/onboarding.ts for the inventory), and
 *  the board's first-run card, `agentbox onboard` and `doctor` all render the
 *  same list from it. */
export interface Onboarding {
  identity: UserIdentity;
  /** tmux and git, the two things nothing works without. */
  depsOk: boolean;
  /** gh installed and authenticated — PR links and the PR sync read it. */
  ghReady: boolean;
  /** An account is registered *and* authenticated, not merely detected. */
  accountsReady: boolean;
  /** voice.env has its keys. */
  voiceReady: boolean;
  /** The systemd user service is installed and enabled; null where systemd is not. */
  serviceInstalled: boolean | null;
  /** Boot starts it, not first login; null where systemd is not. */
  lingering: boolean | null;
  /** The board is installed as an app; null when there is no way to tell. */
  pwaInstalled: boolean | null;
}

export interface AppState extends HotState, ColdState {}

// ----------------------------------------------------------------- waits

/** What a session waits on (src/core/waits.ts). */
export type WaitSpec =
  /** A pull request: its checks concluding on a head, or its merge. */
  | {
      kind: "pr";
      repo: string;
      number: number;
      /** The head the checks are waited for on, or the merge of; null takes the one first read (for a merge, any head). */
      head: string | null;
      /** Every CI/review check on the head has concluded; Merge gate is excluded. */
      all: boolean;
      /** Checks that must be there and concluded. A name also takes the
       *  checks that begin with it and a space: `API Tests (shard 1/3)`. */
      checks: string[];
      /** Only its merge, its closing, or a head named being replaced ends the wait. */
      merged: boolean;
      /** New review/comment feedback or a failed check, independently of readiness. */
      feedback?: boolean;
    }
  /** A GitHub Actions run concluding. */
  | { kind: "run"; repo: string; run: number }
  /** A command started as a unit of its own, which a stopped session does not take with it. */
  | { kind: "job"; unit: string; command: string; log: string; result: string }
  /** Other sessions: the first whose turn ends, or that stops. */
  | { kind: "session"; ids: string[] }
  /** A command asked again and again: exit 0 is the event, 1 is not yet. */
  | { kind: "until"; cmd: string; cwd: string; everyMs: number }
  /** Nothing but its deadline. */
  | { kind: "time" };

/**
 * How a wait ended. Every wait ends in one of these and its session is told
 * which: what it waited for happened, can no longer happen by waiting (a head
 * that moved, a check that never came with nothing left running), did not
 * happen by the deadline, or could not be watched any longer.
 */
export type WaitEnd = "happened" | "stuck" | "timeout" | "broken" | "cancelled";

export interface Wait {
  id: number;
  /** The session that is told how it ends. */
  sessionId: string;
  spec: WaitSpec;
  createdAt: number;
  deadline: number;
  /** Null while it is still going. */
  ended: WaitEnd | null;
  /** What its session is told. */
  outcome: string | null;
  endedAt: number | null;
  /** When its session took the message; null until it has. */
  toldAt: number | null;
  /** Why it has not been told yet. */
  untold: string | null;
  checkedAt: number | null;
  /** What the last look found, in words. */
  seen: string | null;
  /** Since when every look has failed; null while they answer. */
  failingSince: number | null;
  /** What one look hands the next. */
  memo: { feedback?: string; failedChecks?: string[]; head?: string; readyAt?: number; headWrongAt?: number; goneAt?: number; idle?: Record<string, number>; absentAt?: number; failures?: number; error?: string };
}

// ------------------------------------------------------------- schedules

/** What a scheduled session starts with: the new-session request, as asked. */
export interface ScheduleSpec {
  provider: ProviderId;
  cwd?: string;
  repoId?: string;
  worktree?: boolean;
  branch?: string;
  pr?: number;
  prompt?: string;
  model?: string;
  effort?: string;
  /** `auto` or none: the balancer picks when it starts, not when it was asked. */
  accountId?: string | null;
}

/**
 * A session to start later (src/core/scheduler.ts). A one-time one is shown as
 * a session and starts under its own id, so a link to it keeps working; a
 * recurring one starts a new session each time, unless it keeps to one
 * (`sameSession`).
 */
export interface Schedule {
  id: string;
  rule: ScheduleRule;
  spec: ScheduleSpec;
  label: string | null;
  /** Off: a recurring one paused, or a one-time one whose start failed. */
  enabled: boolean;
  /** The next start; null when there is none coming. */
  nextAt: number | null;
  createdAt: number;
  /** When it last started a session or, with `sameSession`, said something
   *  to its own. A time its note command had nothing to say is not one. */
  lastRunAt: number | null;
  /** The session the last start made. */
  lastSessionId: string | null;
  lastError: string | null;
  /**
   * A shell command run in the schedule's directory each time it comes due
   * (timed recurring ones only). What it prints is the note: said before the
   * prompt, as a red rule's note is. When it prints nothing, nothing happens
   * that time; when it fails, that is `lastError` and nothing starts.
   */
  noteCmd: string | null;
  /**
   * Each time it comes due it speaks to the session it started last instead
   * of starting another: the note (or, with no note command, the prompt) is
   * typed into it. A new one is started, and the old one closed, when that
   * session is gone, closed, stopped at a limit, or holds more context than
   * `freshOver`. While it is mid-turn or showing a prompt, that time is skipped.
   */
  sameSession: boolean;
  /** Tokens of context past which a `sameSession` schedule starts afresh;
   *  null for the default (`FRESH_OVER`, src/core/schedule.ts). */
  freshOver: number | null;
  /** The session it replaced while that one was mid-turn: handed over at
   *  once, and closed once its turn is over. */
  retiring: string | null;
}

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
  /** Present while the server's first pass over the transcripts runs: it
   *  answers, but the board and every other route wait for that pass. */
  starting?: { read: number; of: number };
}

/** Server → client. */
export type ServerMessage =
  /** The open sessions, whole: on connect. */
  | { type: "hot"; state: HotState }
  /** What moved since the last frame: open sessions new or changed (each
   *  whole), and the ids no longer open (closed, or off the board). The open
   *  ones were a few hundred KB a frame, several frames a second, to every page. */
  | { type: "hotDelta"; sessions: HotState["sessions"]; gone: string[]; serverTime: number; closedStamp: number }
  /** Cold state, whole: on connect. */
  | { type: "cold"; state: ColdState }
  /** The parts of cold state that changed since the last frame, each whole. */
  | { type: "coldDelta"; state: Partial<ColdState> }
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
  /** The watched session's side questions, all of them, oldest first; sent on watch and on every change. */
  | { type: "btw"; sessionId: string; items: Btw[] }
  /** The UI build on disk (its entry script's name); a page on another reloads. */
  | { type: "build"; entry: string | null }
  /** The server is up but its first pass over the transcripts is still
   *  running: the board and timelines follow when it is done. Sent on connect
   *  and as it goes; `read` of `of` transcripts so far. */
  | { type: "starting"; read: number; of: number }
  /** The server is about to exit to be restarted; the socket closes next
   *  (code 1012). Reconnect promptly rather than backing off. */
  | { type: "restarting" }
  | { type: "error"; message: string };

/** Client → server. A client watches at most one session's timeline. */
export type ClientMessage =
  | { type: "watch"; sessionId: string | null }
  | { type: "ping" };
