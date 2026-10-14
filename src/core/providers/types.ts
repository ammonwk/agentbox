/** The contract every provider adapter implements.
 *
 * An adapter knows one CLI: where it keeps transcripts, how to tell which of
 * its processes are alive and which session each is, how to fold its
 * transcript format into provider-neutral facts and timeline events, and the
 * argv that starts or resumes it on a given account. It knows nothing about
 * tmux, the database, the balancer or the UI — the fleet (`src/core/fleet.ts`)
 * joins adapters to all of those.
 *
 * Adapters must be cheap to poll: `listTranscripts` and `liveProcesses` run
 * every couple of seconds and may only stat and read small files; reading a
 * transcript is the reader's job and is incremental.
 */

import type { AskStep } from "./claude-ask";
import type {
  Account,
  AskAnswer,
  AskQuestion,
  ProviderId,
  QueuedMessage,
  TimelineEvent,
  TimelinePage,
  TokenTotals,
  UsageWindow,
} from "../types";

/** One transcript on disk, found by `listTranscripts`. */
export interface TranscriptRef {
  provider: ProviderId;
  accountId: string;
  agentSessionId: string;
  /** Names one session's transcript: its file, or `<file>#<session id>` when
   *  one file holds many (devin's database). The fleet tracks by this, so it
   *  must be unique; stat or open it through `transcriptFile`. */
  path: string;
  mtimeMs: number;
  size: number;
}

/** The file on disk behind a `TranscriptRef.path`. */
export function transcriptFile(path: string): string {
  const at = path.indexOf("#");
  return at === -1 ? path : path.slice(0, at);
}

/** A running provider process, attributed to an account and a session where
 *  that can be proven. */
export interface LiveProcess {
  pid: number;
  /** From the process's own environment (CLAUDE_CONFIG_DIR, CODEX_HOME, …),
   *  or the default account when unset. Null only if the env was unreadable. */
  accountId: string | null;
  /** Null when this process's session cannot be proven (e.g. a codex process
   *  that has not written its first rollout line yet). */
  agentSessionId: string | null;
  cwd: string;
  startedAt: number;
  /** The provider's own busy/idle flag, when it publishes one. */
  busy?: boolean;
  /** The provider's own word that the process is waiting on a human — claude's
   *  session file says `status: "waiting", waitingFor: "dialog open"` while a
   *  permission prompt is up. Knowable even for sessions outside our tmux. */
  waitingOn?: string;
}

/** A provider saying it hit a usage limit. `provider` is the upstream that
 *  said so, for a CLI that fronts several (omp: `opencode-go`), whose usage
 *  windows carry the same name. */
export interface LimitHit {
  at: number;
  detail: string;
  provider?: string;
}

/** Something an agent set going that will wake it (TranscriptFacts.wakes). */
export interface Wake {
  /** What it is, as a hold reads it: "background job bg_3 (npm test)". */
  label: string;
  setAt: number;
  /** When it fires or gives up; null when it runs until it reports back. */
  until: number | null;
  /** Survives the process that set it (claude's durable cron jobs). */
  durable?: boolean;
}

/**
 * A model as one session has found it: when a call to it last answered, and
 * the refusal standing since, if any. A refusal is the provider turning down
 * the model or the account (4xx: "Model is unavailable", a region or plan it
 * is not offered on, a rejected key), not this request (too long, malformed)
 * and not a limit or an empty balance (`rateLimitHits`). Only an answer
 * clears it: a prompt sent to a refused session is not the route working.
 */
export interface ModelOutcome {
  /** `provider/model`, as placement names it. */
  model: string;
  okAt: number | null;
  refusedAt: number | null;
  detail: string | null;
  /** The account the newer of the two was earned on. The transcript does not
   *  know; the fleet stamps it when it stores the facts, since a session can
   *  wake on another account with its last word still standing. */
  accountId?: string | null;
}

/** `prev` after one more call to `model`: answered, refused, or neither (an
 *  error that says nothing about the route leaves it as it stood). */
export function nextOutcome(prev: ModelOutcome | null, model: string, at: number, call: { refused: string } | "answered" | null): ModelOutcome | null {
  const okAt = prev?.model === model ? prev.okAt : null;
  if (call === "answered") return { model, okAt: at, refusedAt: null, detail: null };
  if (call) return { model, okAt, refusedAt: at, detail: call.refused };
  return prev?.model === model ? prev : null;
}

/** Everything an adapter can say about one transcript. */
export interface TranscriptFacts {
  agentSessionId: string;
  /** The latest cwd the session worked in. */
  cwd: string | null;
  /**
   * The cwd `resume` must be run from for the provider to find this
   * transcript, when that can be proven (claude: the cwd whose slug is the
   * transcript's directory). Null means "do not guess".
   */
  resumeCwd: string | null;
  /** A title the provider or the user gave the session. */
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  /** Timestamp of lastPrompt, including agent messages; null when unknown. */
  lastPromptAt: number | null;
  /** Tail of the latest assistant text, at most ~300 chars. */
  lastMessage: string | null;
  model: string | null;
  gitBranch: string | null;
  /** The GitHub repo (`owner/name`) the session names most as the home of
   *  PRs — `gh -R`, a PR URL — which its `#1234`s link into ahead of its own
   *  checkout's (see `prrepo.ts`). Absent when the provider does not look. */
  prRepo?: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  /** Newest real activity, excluding cache-warming prompts and their replies.
   * Quiet-work holds use this; the cache still uses every model call. */
  lastWorkAt?: number | null;
  /** Cache-warming prompts in the current wait, folded from the transcript so
   * a server restart cannot reset the cap. Real activity clears it. */
  keepWarm?: { count: number; at: number } | null;
  /**
   * When the model last answered: the newest model call the transcript
   * records, not the newest line. Claude writes bookkeeping lines (a
   * background task's notification queued, a title) with no call behind them,
   * so `lastActivityAt` can be minutes old while the prompt cache went cold
   * hours ago. Absent when the provider cannot tell the two apart.
   */
  lastTurnAt?: number | null;
  /** How long the prompt cache that call wrote lives (claude: an hour, or
   *  five minutes; src/core/cache.ts). Absent when the provider does not say. */
  cacheTtlMs?: number | null;
  /**
   * True when the transcript shows a turn in progress: the newest thing is a
   * prompt or a tool call, not an end of turn. Combined with process liveness
   * by the fleet; on its own it cannot tell a working agent from a killed one.
   */
  turnOpen: boolean;
  /**
   * The turn is over because the provider stopped it, not because it was
   * done: the reply cut off by the output cap, a transient API error, or
   * something a retry cannot fix (`kind`). `retryAfterMs` is how long to
   * leave it before retrying, where the error says more than the default
   * (a model at capacity). Null when the provider cannot tell, or a prompt
   * has followed.
   */
  turnError?: { at: number; kind: "output-cap" | "transient" | "fatal"; detail: string; retryAfterMs?: number } | null;
  /** What the provider last did with this session's model, for placement
   *  (core/refusals.ts). Null when the provider cannot tell. */
  modelOutcome?: ModelOutcome | null;
  contextUsed: number | null;
  contextLimit: number | null;
  /** Cumulative over the whole session, including subagents where the
   *  provider records them in the same place. */
  tokens: TokenTotals;
  /** Rate-limit windows the transcript itself reports (codex `token_count`).
   *  The newest reading only. */
  usage: { at: number; windows: UsageWindow[] } | null;
  /** Each time the provider said it hit a limit. */
  rateLimitHits: LimitHit[];
  /** Provider subagent / sidechain transcripts are folded into their parent
   *  and never become sessions of their own. */
  isSubagent: boolean;
  /** For subagents: the parent's agentSessionId. */
  parentId: string | null;
  /**
   * Agent teams (claude): the team this session is a member of, and the teams
   * it spawned members into. A teammate is a session of its own, in a pane of
   * its own; this is what ties it to its lead.
   */
  team?: string | null;
  teamsLed?: string[];
  /** Messages the agent is holding until its current step yields (claude),
   *  oldest first. Only meaningful while its process lives. */
  queued?: QueuedMessage[];
  /**
   * Background-task notifications (claude) still queued with the turn over:
   * the session was waiting on them and nothing woke it. Claude does this
   * with a command an in-process teammate started and then went idle on, and
   * the session's later turns do not take them either. The fleet nudges it
   * (`Fleet.keepWarm`), and the nudge in the transcript clears them.
   */
  stranded?: QueuedMessage[];
  /**
   * What the agent set going that will wake it with its turn over, as its
   * transcript records it: omp's background jobs and supervised processes,
   * claude's /loop wakeups and cron jobs. Each lives in the agent's process
   * and dies with it.
   */
  wakes?: Wake[];
  /** Commands whose every line of output is a message to the session
   *  (claude's Monitor), whitespace-collapsed: a never-ending shell that is
   *  work. */
  monitors?: string[];
  /** An AskUserQuestion call (claude) still waiting for its answer. */
  pendingAsk?: { id: string; questions: AskQuestion[] } | null;
  /** The session is in its CLI's skip-every-permission mode as of its latest
   *  record (claude: `bypassPermissions`, which shift+tab can leave). */
  skipsPermissions?: boolean;
  /** A scripted one-shot run (claude `-p`): its caller reads the answer, so
   *  once its process ends it is history, not something to come back to. */
  headless?: boolean;
}

/** An incremental reader over one transcript. Holds its own offsets. */
export interface TranscriptReader {
  readonly ref: TranscriptRef;
  /**
   * Fold in whatever was appended since the last call (or read from the start
   * on the first). `changed` is false when nothing new was read, so the fleet
   * can skip work. A truncated or replaced file is re-read from the start.
   */
  refresh(): Promise<{ changed: boolean; facts: TranscriptFacts }>;
  /** A page of timeline events ending at `before` (or the newest events). */
  timeline(opts: { before?: string | null; limit: number }): Promise<TimelinePage>;
  /**
   * Events after `cursor`. `reset` means the cursor is no longer valid (the
   * file was replaced) and `events` is a fresh newest page instead. A tool
   * event whose result arrived since may be re-sent with the same id; the
   * client replaces by id.
   */
  since(cursor: string): Promise<{ events: TimelineEvent[]; cursor: string; reset: boolean }>;
  /**
   * Where the reader is, as data (`bun:jsc`-serializable), so the next server
   * can carry on from it instead of reading the whole file again. Null when
   * this reader cannot. Only valid while the reading code is the same; the
   * fleet's reader cache keys it by that code (`readercache.ts`).
   */
  saveState?(): unknown;
  /** Take up a `saveState` from an earlier process, before the first
   *  `refresh`. False when it no longer fits the file; nothing is changed. */
  loadState?(saved: unknown): boolean;
}

export interface SpawnOptions {
  account: Account;
  cwd: string;
  prompt?: string;
  model?: string;
  /** One of the adapter's `efforts`; absent means the CLI's default. */
  effort?: string;
  autoApprove: boolean;
}

export interface ResumeOptions {
  account: Account;
  agentSessionId: string;
  /** The cwd to run in — the caller has already proven it (see resumeCwd). */
  cwd: string;
  prompt?: string;
  model?: string;
  effort?: string;
  autoApprove: boolean;
  /** Flags the session was launched with outside agentbox, kept by adopt
   *  (`carryOver`). When present they decide model and permissions: the
   *  session keeps the permissions it was started with, whatever
   *  `autoApprove` says. */
  carry?: string[];
}

export interface Command {
  argv: string[];
  /** Added on top of the server's environment. */
  env: Record<string, string>;
  /** Variables to remove from the inherited environment (e.g. a stray
   *  CLAUDE_CONFIG_DIR from the shell that started the server). */
  unset?: string[];
  /** Names in `env` whose values are secrets (global MCP env and header
   *  values): they reach the process through a private launch script, never
   *  on a command line (`NewSession.secretEnv`). */
  secret?: string[];
}

/** What `blockedOn` says of the dialog a CLI puts up at its account's usage
 *  limit (Claude: stop, wait here, or add funds). It asks nothing the fleet
 *  wants answered: the session is stopped at its limit like one that only
 *  printed the message, and is moved or waited out the same way. */
export const LIMIT_DIALOG = "usage limit";

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  /** Reasoning-effort levels the CLI takes, lowest first; empty when it has
   *  no such knob. */
  readonly efforts: readonly string[];

  /** Is the CLI installed, and what version. */
  detect(): Promise<{ installed: boolean; version: string | null }>;

  /** The provider's default credential home (`~/.claude`, `~/.codex`, …) —
   *  where the accounts module registers the default account. Honours a
   *  `$HOME` set at runtime, as every path the accounts module derives does. */
  defaultHome(): string;

  /** Environment that points the CLI at this account; `{}` plus `unset` of
   *  the relevant variable for the default account. */
  accountCommand(account: Account): Pick<Command, "env" | "unset">;

  /**
   * Environment for the CLI's own auth commands (`login`, `auth status`),
   * which read and write the account's home. `accountCommand`'s env for every
   * provider but devin, which runs on a key taken from the home and so cannot
   * log in that way: it logs in under `XDG_DATA_HOME=<home>`.
   */
  authEnv(account: Pick<Account, "home" | "isDefault">): Pick<Command, "env" | "unset">;

  /**
   * Transcripts under this account touched at or after `sinceMs`. Must only
   * stat. Subagent transcripts may be included (the reader flags them) or
   * skipped — the fleet never shows them as sessions.
   */
  listTranscripts(account: Account, sinceMs: number): Promise<TranscriptRef[]>;

  /** Every live process of this provider, attributed to one of `accounts`. */
  liveProcesses(accounts: Account[]): Promise<LiveProcess[]>;

  /** Find the transcript for a known session id (for resume/adopt, and for a
   *  session older than the discovery window). */
  findTranscript(account: Account, agentSessionId: string): Promise<TranscriptRef | null>;

  reader(ref: TranscriptRef): TranscriptReader;

  /** Where a session's in-process subagents write their logs. They leave no
   *  child process to find, but they write as they work. Absent when the CLI
   *  keeps none. */
  subagentLogDir?(ref: TranscriptRef): string;

  /**
   * argv for a new interactive session. `agentSessionId` is set when the CLI
   * can be told its session id up front (claude `--session-id`); otherwise the
   * fleet discovers it from the first new transcript in `cwd`.
   */
  spawnCommand(opts: SpawnOptions): Command & { agentSessionId: string | null };

  resumeCommand(opts: ResumeOptions): Command;

  /** The resume CLI accepts no prompt argument. The fleet waits for the TUI
   * and types the prompt through its normal serialized delivery path. */
  resumePromptInTerminal?: boolean;

  /**
   * Anything the CLI keeps outside its argv that must be right before
   * `resumeCommand` runs. Devin resumes in the permission mode it saved for
   * the session and ignores `--permission-mode`, so a session first opened
   * over ACP in its "normal" mode comes back rejecting every command.
   */
  prepareResume?(opts: ResumeOptions): void;

  /**
   * Type a message in as pastes of at most this many characters, line breaks
   * pressed as keys (`sendText`), not as one paste. Claude Code sets a paste
   * of more than 800 characters or two line breaks apart: it shows
   * `[Pasted text #1]`, and sends it wrapped in `<pasted_content>` tags that
   * tell the model you did not write it and it need not do what it says —
   * which is wrong of a message you typed into agentbox.
   */
  pasteInPieces?: number;

  /**
   * Typed after a message, before its Enter. omp opens a completion popup
   * when the text before the cursor ends in `#123`, `@name` or a link, and
   * Enter then picks the completion (`#8832` becomes `pr://8832`) and leaves
   * the message in the input box; a space after it opens none.
   */
  pasteEnd?: string;

  /**
   * Re-home a stopped session's transcript under another account of this
   * provider, so the next resume there finds it; returns the transcript's new
   * path. Only for a session whose prompt cache is cold anyway (see
   * `Fleet.wake`). Absent when the provider cannot do it safely, which pins
   * its sessions to the account they started on for good.
   */
  moveSession?(opts: { from: Account; to: Account; agentSessionId: string; transcriptPath: string }): string;

  /**
   * Every account of this provider reads one session store (omp, opencode:
   * an account is only whose credential a session's requests carry). So one
   * account's listing is everyone's, a transcript's `accountId` says who
   * listed it rather than whose it is, and a session whose account was
   * forgotten resumes on another.
   */
  sharedStore?: boolean;

  /** The model a session started without one runs on (`provider/model`, as
   *  its transcript names it), where the CLI's own config says. */
  defaultModel?(): string | null;

  /** The flags in a live process's argv worth keeping when adopt resumes it —
   *  permissions, directories, MCP config, model — and never the session id,
   *  the prompt, or anything that makes it a one-shot. */
  carryOver?(argv: string[]): string[];

  /** A scripted one-shot (`claude -p`): something is waiting on its output,
   *  so it is never adopted. */
  headless?(argv: string[]): boolean;

  /**
   * Given the visible text of the session's terminal, the keys to press to get
   * past a known start-up dialog (folder trust, theme picker, "update
   * available"), or null. Only dialogs that are safe to accept blindly —
   * `bypassPermissions` (the autoApprove setting the session was started
   * under) widens that where it makes a dialog's question moot.
   */
  autoAnswer?(screen: string, ctx?: { bypassPermissions: boolean }): string[] | null;

  /**
   * Given the visible terminal text of a session that skips permissions
   * (`TranscriptFacts.skipsPermissions`), the keys that allow the permission
   * prompt it is showing anyway, once — or null. Claude still asks about some
   * commands in bypass mode (an `rm` on a path it cannot resolve); the mode
   * you chose is the answer.
   */
  approvePrompt?(screen: string): string[] | null;

  /** Given the visible terminal text, what the session is waiting on a human
   *  for (a permission prompt, a login), in a few words — or null.
   *  `LIMIT_DIALOG` is the one answer that is not a prompt for you. */
  blockedOn?(screen: string): string | null;

  /** The next keys to press toward answering an AskUserQuestion dialog on
   *  `screen` (see claude-ask.ts). `visited` is kept by the caller across steps. */
  answerStep?(screen: string, questions: AskQuestion[], answers: AskAnswer[], visited: ReadonlySet<number>): AskStep;

  /** The AskUserQuestion dialog on `screen`, read whole, for when the
   *  transcript has not recorded it — or null. */
  askOnScreen?(screen: string): { id: string; questions: AskQuestion[] } | null;
}

/**
 * A message an agent typed into a session, rather than you. `agentbox send`
 * (the CLI and the fleet MCP, which is how agents message each other) marks
 * what it types at the source; the removed Project session signed its own,
 * and old transcripts still carry that form. Such a message is still shown
 * as a prompt, but it is not you writing to the session, which is what the
 * board sorts by.
 */
export { AGENT_SENT_MARK, isAgentSent } from "../sent";
