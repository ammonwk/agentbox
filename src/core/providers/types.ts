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

import type {
  Account,
  ProviderId,
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
  path: string;
  mtimeMs: number;
  size: number;
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
  /** Tail of the latest assistant text, at most ~300 chars. */
  lastMessage: string | null;
  model: string | null;
  gitBranch: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  /**
   * True when the transcript shows a turn in progress: the newest thing is a
   * prompt or a tool call, not an end of turn. Combined with process liveness
   * by the fleet; on its own it cannot tell a working agent from a killed one.
   */
  turnOpen: boolean;
  contextUsed: number | null;
  contextLimit: number | null;
  /** Cumulative over the whole session, including subagents where the
   *  provider records them in the same place. */
  tokens: TokenTotals;
  /** Rate-limit windows the transcript itself reports (codex `token_count`).
   *  The newest reading only. */
  usage: { at: number; windows: UsageWindow[] } | null;
  /** Each time the provider said it hit a limit. */
  rateLimitHits: { at: number; detail: string }[];
  /** Provider subagent / sidechain transcripts are folded into their parent
   *  and never become sessions of their own. */
  isSubagent: boolean;
  /** For subagents: the parent's agentSessionId. */
  parentId: string | null;
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
}

export interface SpawnOptions {
  account: Account;
  cwd: string;
  prompt?: string;
  model?: string;
  autoApprove: boolean;
}

export interface ResumeOptions {
  account: Account;
  agentSessionId: string;
  /** The cwd to run in — the caller has already proven it (see resumeCwd). */
  cwd: string;
  prompt?: string;
  model?: string;
  autoApprove: boolean;
}

export interface Command {
  argv: string[];
  /** Added on top of the server's environment. */
  env: Record<string, string>;
  /** Variables to remove from the inherited environment (e.g. a stray
   *  CLAUDE_CONFIG_DIR from the shell that started the server). */
  unset?: string[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;

  /** Is the CLI installed, and what version. */
  detect(): Promise<{ installed: boolean; version: string | null }>;

  /** The provider's default credential home (`~/.claude`, `~/.codex`, …). */
  defaultHome(): string;

  /** Environment that points the CLI at this account; `{}` plus `unset` of
   *  the relevant variable for the default account. */
  accountCommand(account: Account): Pick<Command, "env" | "unset">;

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

  /**
   * argv for a new interactive session. `agentSessionId` is set when the CLI
   * can be told its session id up front (claude `--session-id`); otherwise the
   * fleet discovers it from the first new transcript in `cwd`.
   */
  spawnCommand(opts: SpawnOptions): Command & { agentSessionId: string | null };

  resumeCommand(opts: ResumeOptions): Command;

  /**
   * Given the visible text of the session's terminal, the keys to press to get
   * past a known start-up dialog (folder trust, theme picker, "update
   * available"), or null. Only dialogs that are safe to accept blindly.
   */
  autoAnswer?(screen: string): string[] | null;

  /** Given the visible terminal text, what the session is waiting on a human
   *  for (a permission prompt, a login), in a few words — or null. */
  blockedOn?(screen: string): string | null;
}
