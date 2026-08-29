/** omp subagents: agents a *calling agent* owns, not the board.
 *
 * A board session is a piece of work with a life of its own — its own
 * worktree, its own branch, a human watching it, a row that outlives the
 * server. A subagent is the opposite of all of that. It is a function call
 * that happens to be a language model: it runs in the caller's own working
 * directory, it answers one question, and its whole return value is the text
 * it finishes with. The caller is blocked on it.
 *
 * So these deliberately do not go through `sessions.ts`. They have no repo, no
 * branch, no worktree, no supervisor and no board row, and giving them any of
 * those would put throwaway lookups on the board next to real work. What they
 * do reuse is `AcpRunner`, which is the only part that is genuinely the same
 * problem: one long-lived `omp acp` process, one turn at a time.
 *
 * Lifetime is the MCP server process. When it goes, so do the agents — that is
 * correct for something whose only purpose is to answer its caller, and it is
 * why nothing here is persisted to the database.
 */

import {
  appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { AcpRunner, messageOf, type AcpEvents, type LaunchOptions } from "./acp";
import {
  describePlace,
  foreignRepoPaths,
  outsidePaths,
  renderPlace,
  shortPlace,
  type ForeignPath,
  type Place,
} from "./place";
import * as live from "./live";
import { subagentDirFor, subagentRoot } from "./paths";
import { isProviderError } from "./provider-error";
import { readSubagentPrompt } from "./prompts";
import { DEFAULT_MODEL } from "./paths";
import type { ToolCall } from "./types";

/** `running` — mid-turn. `idle` — turn over, conversation alive, resumable.
 *  `dead` — the omp process is gone and this agent cannot be talked to again. */
export type SubagentState = "running" | "idle" | "dead";

/** Recent tool calls kept per agent, for `transcript`. Bounded because a long
 *  agent is exactly the one whose transcript would otherwise grow unbounded. */
const TOOL_RING = 200;

/** Cap on a returned report. The full text is always in the agent's JSONL, so
 *  this trades nothing but the caller's context. */
export const MAX_REPORT = 20_000;

/**
 * How long an abnormally-ended turn waits before being handed back.
 *
 * When omp dies mid-turn the pending prompt request rejects *first* and the
 * process exit is reported a beat later — so deciding "is this agent still
 * usable" at the instant the turn fails gets the answer wrong, and hands the
 * caller a dead agent labelled `idle` to go on talking to. Nothing observable
 * distinguishes the two at that instant, so this waits out the beat. It costs
 * a third of a second on the failure path and nothing at all on the normal one.
 */
const DEATH_GRACE_MS = 300;

/**
 * How long `omp acp` gets to start and negotiate a session.
 *
 * Nothing below this has a deadline: the ACP handshake resolves on success or
 * failure and never on time, so an omp that starts but wedges — a stale auth
 * prompt, a hung updater, a network that neither answers nor refuses — blocks
 * the spawn forever. That outlasts the caller's timeout AND its client's,
 * with no handle to collect and nothing to interrupt, which is the one way
 * this design can strand a caller completely. Generous, because a cold start
 * that pulls a model config is legitimately slow; finite, because "forever"
 * is not a failure mode a caller can do anything about.
 */
const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * How many times a turn killed by a provider error is resumed before the
 * failure is handed to the caller.
 *
 * A `session/prompt` that rejects is almost never the agent finishing — it is
 * a 429, a 500, a dropped socket. Reporting it as a completed turn is the
 * worst reading available: the caller gets a truncated answer wearing the
 * costume of a finished one, and the work up to that point is thrown away
 * because the agent is never asked to go on. omp keeps its context across the
 * failure, so resuming costs one message and salvages the whole turn.
 *
 * Bounded, because the same reasoning inverts when the error is permanent —
 * bad credentials, a model that no longer exists — and an unbounded retry
 * would spend the caller's money forever on a request that cannot succeed.
 */
const MAX_CONTINUES = 3;

/** Backoff before each resume. A provider that just refused is the one thing
 *  least likely to succeed if asked again immediately. */
const CONTINUE_BACKOFF_MS = [1_000, 4_000, 10_000];

/**
 * What we say to resume a turn a provider error cut short.
 *
 * It names the cause, because a model told only "continue" reasonably assumes
 * it did something wrong and starts over — which is the expensive failure this
 * whole mechanism exists to avoid.
 */
/**
 * Wall clock for one turn.
 *
 * A workflow has a deadline and an agent count; a bare agent had neither, and
 * `timeout_seconds` never was one — it bounded how long the *caller* waited,
 * not how long the agent ran. That is how a single turn once ran for 8,729
 * seconds and $3.71 against the wrong repository with nothing to stop it: the
 * call it was launched from had returned two hours earlier.
 *
 * Four hours is far above any turn that is going well and far below the cost
 * of one that is not. It ends the turn rather than the agent: the partial
 * report is handed back, the context survives, and the caller can look at what
 * it was doing and send it a correction.
 */
const MAX_TURN_MS = 4 * 60 * 60 * 1000;

const CONTINUE_MESSAGE =
  "Continue from exactly where you stopped. Your previous response was cut off " +
  "by a transient provider error, not by anything you did wrong and not by any " +
  "instruction from me. Do not start over and do not repeat what you already " +
  "said — carry straight on, and finish with your complete final report.";

/** One completed turn: everything the caller learns from a `settle`. */
export interface TurnReport {
  name: string;
  /** Where the agent ran. On the report because a report that does not say
   *  where it happened is the one thing a caller cannot check. */
  cwd: string;
  /**
   * Absolute paths outside `cwd` that a writing tool call touched this turn.
   *
   * Best effort — tool inputs are clipped and the transcript ring is bounded —
   * but a populated list is close to conclusive, and it is the difference
   * between an agent that edited the wrong checkout for five hours and one
   * line at the top of its answer saying so.
   */
  wroteOutside: string[];
  /**
   * Which message this answers, counting from 1.
   *
   * Reports are a queue, so without this a caller who fired-and-forgot one
   * message and then sent another would be handed the *first* answer as the
   * reply to the second — indistinguishable, and wrong. `send` returns the
   * number it just claimed; `settleFor` waits for that one specifically.
   */
  turn: number;
  state: SubagentState;
  /**
   * The agent's prose for the turn — its return value.
   *
   * All of it, not just the trailing paragraph. Splitting on tool-call
   * boundaries and keeping the last segment would match "the final message"
   * more literally, but a cheap model that puts its findings before its last
   * tool call would have them silently deleted, and a caller cannot notice
   * what it was never shown. Noise is cheaper than loss.
   */
  report: string;
  /** ACP's end_turn/max_tokens/refusal/cancelled, or agentbox's own `error`. */
  stopReason: string;
  /** Tool calls in this turn — the cheapest signal that it did real work. */
  toolCalls: number;
  durationMs: number;
  costUsd: number | null;
  contextTokens: number | null;
  /** Anything omp wrote to stderr, or a failed prompt request. Empty is normal. */
  errors: string[];
}

/**
 * An ended turn waiting to be reported or resumed.
 *
 * `text` is its prose, captured when it ended — not read from a shared buffer
 * later, because by then it may hold a different turn's words. `abandon` hands
 * the turn back if the wait is cut short.
 */
interface PendingTurn {
  text: string;
  abandon: (stopReason: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Somebody blocked in `settle`. `turn` pins them to one specific answer;
 *  undefined means "whatever comes next", which is what `collect` wants. */
interface Waiter {
  turn: number | undefined;
  deliver: (r: TurnReport) => void;
}

export interface ToolRecord {
  seq: number;
  kind: string;
  title: string;
  status: string;
  ms: number | null;
  input: string | null;
  output: string | null;
}

export interface SpawnOptions {
  prompt: string;
  /** Addressable handle. Generated when omitted; must be unique and unused. */
  name?: string;
  /** Defaults to the MCP server's own cwd — the caller's repository. */
  cwd?: string;
  /**
   * Skip the pre-flight refusal when the prompt names files in a different git
   * work tree. For a task that genuinely spans repositories; not for getting
   * past a warning that is telling the truth.
   */
  allowOutsideCwd?: boolean;
  /** Wall clock for a single turn. Defaults to `MAX_TURN_MS`. */
  maxTurnMs?: number;
  /** Suppress this agent's own live status line. Set by the workflow runner,
   *  which publishes one roster line for the whole fan-out instead. */
  quiet?: boolean;
  model?: string;
  /** Extra system-prompt text appended below the subagent contract, for
   *  role-shaping ("you only write tests", "answer in French"). */
  role?: string;
  /**
   * Enforced read-only: permission requests for anything but reading are
   * DENIED at the permission layer, not merely discouraged in the prompt.
   * Prose in `role` is a request to a model; this is a rule of the harness.
   */
  readOnly?: boolean;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [truncated, ${s.length} chars total]`;
}

/**
 * Bound a report, keeping both ends.
 *
 * Head-only clipping is wrong for a resumed turn, whose finished answer is at
 * the tail behind the salvaged fragments — it would keep the abandoned scraps
 * and cut the conclusion. Tail-only clipping is wrong for an ordinary turn,
 * which is told to lead with its answer. Keeping both ends is right for both,
 * and the middle of an over-long report is the part worth losing.
 */
function clipReport(s: string): string {
  const text = s.trim();
  if (text.length <= MAX_REPORT) return text;
  const head = Math.floor(MAX_REPORT * 0.4);
  const tail = MAX_REPORT - head;
  return (
    `${text.slice(0, head)}\n\n… [${text.length - MAX_REPORT} chars omitted from the ` +
    `middle of an over-long report]\n\n${text.slice(-tail)}`
  );
}

/**
 * A model id for a subagent, in order of specificity.
 *
 * There is deliberately no read of agentbox's settings database here: the MCP
 * server must work when the agentbox server has never been run.
 *
 * `explicit` is no longer reachable from the MCP tools. Calling models kept
 * passing the names they know — "sonnet", "opus" — which are not omp model ids
 * and are not rejected either: `omp acp --model sonnet` starts perfectly
 * happily and only fails later, at the first prompt, as a provider error that
 * reads like the agent's own failure. A knob whose wrong values are both easy
 * to reach and hard to diagnose is not worth its own existence. The operator's
 * `AGENTBOX_SUBAGENT_MODEL` remains, because whoever sets that can also read
 * `omp models`.
 */
export function resolveModel(explicit?: string): string {
  return explicit || process.env.AGENTBOX_SUBAGENT_MODEL || DEFAULT_MODEL;
}

/**
 * The slice of `AcpRunner` a subagent actually uses.
 *
 * It exists so tests can stand in for the omp process. Everything interesting
 * in this file is about *ordering* — a turn failing a beat before the process
 * exit is reported, two messages queued behind one another — and none of that
 * can be provoked reliably against a live model, which is exactly why the bugs
 * were there in the first place.
 */
export interface Runner {
  readonly pid: number | null;
  readonly alive: boolean;
  launch(opts: LaunchOptions): Promise<string>;
  send(text: string): void;
  interrupt(): void;
  replyPermission(id: string, approved: boolean): void;
  kill(): void;
}

export type RunnerFactory = (
  id: string,
  events: AcpEvents,
  autoApprove: () => boolean,
) => Runner;

const ompRunner: RunnerFactory = (id, events, autoApprove) =>
  new AcpRunner(id, events, autoApprove);

/**
 * Tool kinds a read-only agent may use. ACP has no tool names on the wire,
 * only kinds — and `execute` is deliberately absent: a shell can write, so a
 * read-only agent that could run commands would be read-only in name only.
 * `think` never asks permission but is harmless if it ever does.
 */
const READ_ONLY_KINDS = new Set(["read", "search", "fetch", "think"]);

/** Names are addresses — the caller types them back. Keep them typeable. */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * The "where you are" block prepended to every subagent's system prompt.
 *
 * The contract in `prompts/subagent.md` can say "you are in the caller's
 * working directory"; only this can say *which* one, and the difference is the
 * whole point. A rule with a path in it is checkable — an agent can compare it
 * against the paths in its brief and stop. An agent merely assured it is in
 * the right place has no way to discover that it is not, which is exactly how
 * a five-hour run once landed in somebody else's branch.
 */
function placeSection(place: Place, readOnly: boolean): string {
  const lines = ["## Where you are", "", `Working directory: \`${place.path}\``];
  if (place.toplevel === null) {
    lines.push("This directory is not a git work tree.");
  } else {
    lines.push(`Git work tree: \`${place.toplevel}\``);
    lines.push(
      `Branch: \`${place.branch ?? "detached HEAD"}\`` +
        (place.dirty === true ? " — carrying uncommitted changes that are not yours" : ""),
    );
  }
  lines.push(
    "",
    "Everything you change must be under that working directory. If your task names " +
      "files outside it, do not edit them: say so in your report, name both the path " +
      "you were given and the directory you are actually in, and stop. A brief written " +
      "about a different checkout is a real and expensive mistake, and you are the only " +
      "one in a position to catch it.",
  );
  if (!readOnly) {
    lines.push(
      "",
      "Before your first edit, run `pwd` and `git branch --show-current` and check both " +
        "against the two lines above. Do it once, at the start, not as you go.",
    );
  }
  return lines.join("\n");
}

/**
 * One omp subagent: an `omp acp` process, a conversation, and a mailbox of
 * turns its caller has not collected yet.
 */
export class Subagent {
  readonly name: string;
  readonly cwd: string;
  readonly model: string;
  readonly dir: string;
  readonly createdAt = Date.now();

  private runner: Runner;
  private launched = false;
  /** Assistant prose of the turn in flight. */
  private buf: string[] = [];
  /** Prose salvaged from earlier attempts at the turn in flight, kept apart
   *  from `buf` so a resume cannot clobber chunks still arriving. */
  private carried: string[] = [];
  /** Ended turns awaiting disposition, each with its own captured prose and
   *  its own cancellable timer. */
  private pending: PendingTurn[] = [];
  /**
   * Completed turns the caller has not taken yet.
   *
   * This queue is the whole reason a blocking call can time out without losing
   * anything: the turn finishes into here whether or not anyone is waiting, and
   * a later `settle` picks it up. Without it, a caller whose `agent` call timed
   * out would come back to a finished agent with no record of what it said.
   */
  private mailbox: TurnReport[] = [];
  private waiters: Waiter[] = [];

  private turnStartedAt = 0;
  private turnTools = 0;
  /** Messages sent, ever. The turn number a report will carry. */
  private sentTurns = 0;
  /** Reports handed back, ever. `answeredTurns + 1` is the next one out. */
  private answeredTurns = 0;
  /** Turns sent but not yet answered. A counter rather than a flag because two
   *  queued messages are two turns, and each owes the caller its own report. */
  private owed = 0;
  /** Automatic resumes spent on the turn in flight. Reset when a turn is
   *  actually reported, so the budget is per-turn and not per-agent. */
  private continues = 0;
  private errors: string[] = [];
  private tools: ToolRecord[] = [];
  private byId = new Map<string, ToolRecord>();
  private seq = 0;

  private _state: SubagentState = "idle";
  /**
   * When the agent last did anything observable — a tool call started or
   * ended, or a chunk of prose arrived.
   *
   * Kept separately from the tool ring because "how long ago" is the question
   * a watcher actually asks, and prose is activity too: an agent three
   * minutes into writing a long report is working, not stuck, and a clock
   * driven only by tool calls would say the opposite.
   */
  private lastActivityAt = 0;
  /** What that activity was, as a short label. */
  private lastAction = "";
  /** When the most recent turn was handed back. Zero until one has been. The
   *  status line and the uncollected notice both want "finished how long ago",
   *  which is the number that makes an unread answer look like a mistake. */
  private lastAnsweredAt = 0;
  private cost: number | null = null;
  private tokens: number | null = null;
  private totalTools = 0;
  private turns = 0;

  readonly readOnly: boolean;
  /** Suppress this agent's own live line; the workflow runner draws its own. */
  readonly quiet: boolean;
  /** Wall clock for one turn. Public so `send_message` can raise it for a job
   *  the caller knows is long. */
  maxTurnMs: number;

  /** Where this agent runs, resolved once. Branch and dirtiness are a snapshot
   *  taken at launch: they are for saying which tree this is, not for deciding
   *  anything, and re-forking git on every status tick would cost more than the
   *  answer is worth. */
  private placeCache: Place | null = null;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wall clock fired. Turns the `cancelled` that the interrupt produces
   *  into a `deadline` the caller can tell apart from its own interrupt. */
  private deadlineHit = false;
  /** `seq` when the turn in flight began, so the escape scan reads this turn's
   *  tool calls rather than the whole ring. */
  private turnSeqFrom = 0;

  constructor(
    name: string,
    cwd: string,
    model: string,
    dir: string,
    makeRunner: RunnerFactory = ompRunner,
    readOnly = false,
    maxTurnMs = MAX_TURN_MS,
    quiet = false,
  ) {
    this.name = name;
    this.cwd = cwd;
    this.model = model;
    this.dir = dir;
    this.readOnly = readOnly;
    this.maxTurnMs = maxTurnMs;
    this.quiet = quiet;
    this.runner = makeRunner(
      name,
      {
        onText: (_id, text) => {
          this.buf.push(text);
          this.mark("writing");
        },
        onToolStart: (_id, call) => this.recordTool(call),
        onToolUpdate: () => {},
        onToolEnd: (_id, call) => this.recordTool(call),
        onAdvisory: () => {},
        onTurnEnd: (_id, stopReason) => this.finishTurn(stopReason),
        onContext: (_id, used) => {
          if (used > 0) this.tokens = used;
        },
        onUsage: (_id, costUsd) => {
          this.cost = costUsd;
        },
        // Nobody is here to answer a permission prompt — the caller is an
        // agent blocked inside a tool call, not a human at a board — so every
        // request is answered immediately, by rule. Ordinary agents approve
        // everything (autoApprove short-circuits this handler); a read-only
        // agent lands here and is judged by tool kind. A denial is an answer,
        // not a hang: omp is told no and the turn continues, so the agent can
        // report what it was not allowed to do.
        onPermission: (_id, info) => {
          const allowed = !this.readOnly || READ_ONLY_KINDS.has(info.tool);
          if (!allowed) {
            this.errors.push(
              `denied (read-only agent): ${info.title || info.tool || "a tool call"}`,
            );
          }
          this.log({ type: "permission", title: info.title, kind: info.tool, approved: allowed });
          this.runner.replyPermission(info.id, allowed);
        },
        onError: (_id, message) => {
          this.errors.push(message);
          this.log({ type: "error", message });
        },
        onExit: (_id, code) => this.die(`omp exited with code ${code}`),
      },
      // A read-only agent routes every request through the handler above so
      // it can be judged; anything else approves at the source.
      () => !this.readOnly,
    );
  }

  get state(): SubagentState {
    return this._state;
  }

  get pid(): number | null {
    return this.runner.pid;
  }

  /** Whether omp is still there. The authority on liveness — `state` is a
   *  summary that can lag it by a tick. */
  get alive(): boolean {
    return this.runner.alive;
  }

  /** The oldest uncollected turn, without taking it. For a notice that wants
   *  to show an unread answer without deciding it has now been delivered. */
  peek(): TurnReport | null {
    return this.mailbox[0] ?? null;
  }

  /** When the last turn ended, or 0. */
  get answeredAt(): number {
    return this.lastAnsweredAt;
  }

  /** What the agent has cost so far, as omp last reported it. Exposed because
   *  a runaway turn is only visible while it is still running. */
  get costUsd(): number | null {
    return this.cost;
  }

  /** Where this agent runs. Cheap after the first call. */
  get place(): Place {
    if (this.placeCache === null) this.placeCache = describePlace(this.cwd);
    return this.placeCache;
  }

  /** Turns finished but never handed back. Answers that were paid for and not
   *  read, so nothing may quietly discard this agent while it is above zero. */
  get uncollected(): number {
    return this.mailbox.length;
  }

  /**
   * Callers already blocked on "whatever comes next" — the queue a fresh
   * `collect` joins.
   *
   * A finished turn goes to exactly one waiter, so a second unpinned collect
   * is not a second chance at the answer: it is a caller that will wait out
   * its whole timeout for a report somebody else takes. Worth telling them,
   * because from the outside the two are indistinguishable.
   */
  get queuedCollectors(): number {
    return this.waiters.filter((w) => w.turn === undefined).length;
  }

  /** What `list` shows: enough to pick an agent, not enough to cost context. */
  summary() {
    return {
      name: this.name,
      state: this._state,
      cwd: this.cwd,
      branch: this.place.branch ?? undefined,
      model: this.model,
      readOnly: this.readOnly || undefined,
      turns: this.turns,
      toolCalls: this.totalTools,
      costUsd: this.cost,
      contextTokens: this.tokens,
      uncollected: this.uncollected,
      ageSeconds: Math.round((Date.now() - this.createdAt) / 1000),
    };
  }


  private mark(action: string) {
    this.lastActivityAt = Date.now();
    this.lastAction = action;
  }

  /**
   * What the agent is doing right now, cheap enough to ask every second.
   *
   * `summary` answers "which agent do I want"; this answers "is that one
   * alive and on what" — the thing a watcher stares at while a fan-out runs.
   * Both halves matter: the action alone cannot distinguish an agent mid-grep
   * from one that greppped four minutes ago and hung, and the clock alone
   * cannot say whether the wait is reasonable.
   */
  activity(): { action: string; idleMs: number; turnMs: number; toolCalls: number } {
    const now = Date.now();
    return {
      // Before the first event there is genuinely nothing to report but the
      // fact that omp is booting, which is worth saying — a blank line reads
      // as a hang.
      action: this.lastAction || (this._state === "running" ? "starting" : "idle"),
      idleMs: this.lastActivityAt ? now - this.lastActivityAt : 0,
      turnMs: this.turnStartedAt ? now - this.turnStartedAt : 0,
      toolCalls: this.turnTools,
    };
  }

  /** The prose of the turn in flight, for showing a caller what an agent is
   *  concluding before it has finished concluding it. Tail-clipped: the end is
   *  the current thought, and the beginning is usually preamble. */
  partial(max = 1200): string {
    const text = (this.carried.join("") + this.buf.join("")).trim();
    if (text.length <= max) return text;
    return `… [${text.length - max} earlier chars omitted]\n${text.slice(-max)}`;
  }

  transcript(limit = 40): ToolRecord[] {
    return this.tools.slice(-limit);
  }

  /** Launch omp and send the first message. Throws if omp will not start. */
  async start(prompt: string, role?: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const promptFile = join(this.dir, "system.md");
    const place = describePlace(this.cwd, { dirty: true });
    this.placeCache = place;
    const parts = [readSubagentPrompt(), placeSection(place, this.readOnly)];
    if (this.readOnly) {
      parts.push(
        "This agent is READ-ONLY, enforced by the harness: any tool call that " +
          "edits, moves, deletes or executes will be denied automatically. Work " +
          "within that — read, search and report.",
      );
    }
    if (role) parts.push(role.trim());
    writeFileSync(promptFile, `${parts.join("\n\n---\n\n")}\n`);

    const launch = this.runner.launch({
      worktree: this.cwd,
      model: this.model,
      promptFile,
      advisor: false,
      resumeSessionId: null,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        launch,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `omp did not finish starting within ${LAUNCH_TIMEOUT_MS / 1000}s ` +
                    `(cwd ${this.cwd}, model ${this.model}) — check \`omp acp\` runs by hand`,
                ),
              ),
            LAUNCH_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      // The losing promise of a race is still live; an unhandled rejection
      // from a launch that fails after we gave up would crash the server.
      launch.catch(() => {});
    }
    this.launched = true;
    this.send(prompt);
  }

  /** Queue a message. omp delivers it now if idle, at the next turn boundary
   *  if not — same contract as steering a board session. Returns the turn
   *  number this message claimed, so the caller can wait for *its* answer. */
  send(text: string): number {
    if (!this.launched) throw new Error(`subagent ${this.name} has not started`);
    // `alive` beats `_state`. When omp dies mid-turn the connection closes
    // before the exit is reported, so for a moment the failed turn has already
    // landed as `idle` while the process is gone — and a caller that trusted
    // `_state` there would queue a message into a corpse and wait out its whole
    // timeout for a reply that cannot come.
    if (!this.alive) {
      this.die("omp is gone");
      throw new Error(
        `subagent ${this.name} is dead — its process is gone and its context with it. ` +
          `Start a fresh agent.`,
      );
    }
    if (this._state === "idle") {
      this.turnStartedAt = Date.now();
      this.turnTools = 0;
      this.turnSeqFrom = this.seq;
    }
    this._state = "running";
    this.mark("starting");
    this.owed++;
    this.armTurnClock();
    this.continues = 0;
    const turn = ++this.sentTurns;
    this.log({ type: "message", turn, text });
    this.runner.send(text);
    return turn;
  }

  /**
   * Wait for the next turn this agent has not yet handed back.
   *
   * Returns null on timeout, which is not a verdict: the agent is still
   * working and its turn will land in the mailbox regardless.
   */
  settle(timeoutMs: number, forTurn?: number): Promise<TurnReport | null> {
    // Waiting for a specific turn: anything older in the mailbox is somebody
    // else's answer and stays there. Without this, a caller who sent a second
    // message would be handed the first message's report as its reply.
    if (forTurn !== undefined) {
      const at = this.mailbox.findIndex((r) => r.turn === forTurn);
      if (at !== -1) return Promise.resolve(this.mailbox.splice(at, 1)[0]!);
      if (this.answeredTurns >= forTurn) {
        // Already handed back to someone else; it is not coming again.
        return Promise.resolve(null);
      }
    }
    const taken = forTurn === undefined ? this.mailbox.shift() : undefined;
    if (taken) return Promise.resolve(taken);
    if (this._state !== "running") {
      // Idle or dead: nothing is running and nothing is owed. Waiting here
      // would burn the whole timeout on a turn that can never arrive.
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        resolve(null);
      }, timeoutMs);
      const entry: Waiter = {
        turn: forTurn,
        deliver: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      this.waiters.push(entry);
    });
  }

  /** Cancel the turn in flight. Returns false when there was nothing to
   *  cancel — an idle agent has no turn, and telling the caller "interrupted"
   *  would be a lie it might act on. */
  interrupt(): boolean {
    if (this._state !== "running") return false;
    // Two independent things can be in flight, and a caller reaching for
    // `interrupt` means to stop both. A turn waiting out a grace window or a
    // resume backoff is waiting on OUR timer, and passing a cancel to omp
    // would do nothing for it. A turn the caller queued behind it really is
    // running inside omp, and only omp can stop that one.
    const waiting = this.pending.splice(0);
    for (const p of waiting) clearTimeout(p.timer);
    for (const p of waiting) p.abandon("cancelled");
    if (this.owed > 0) this.runner.interrupt();
    return true;
  }

  stop(): void {
    this.runner.kill();
    // `die` clears the pending waits; without it a backoff would outlive the
    // agent and hold the event loop open past `stopAll()`.
    this.die("stopped by the caller");
  }

  // ------------------------------------------------------------- internals

  /**
   * Fold a tool call into the ring. Start and end arrive as separate events
   * with the same `toolCallId`, so the record is updated in place — two rows
   * for one call would read as the agent having done twice the work.
   */
  private recordTool(call: ToolCall) {
    const fields = {
      kind: call.kind,
      title: call.title,
      status: call.status,
      ms: call.endedAt === null ? null : call.endedAt - call.startedAt,
      input: call.input === null ? null : clip(JSON.stringify(call.input), 300),
      output: call.output === null ? null : clip(call.output, 600),
    };
    const existing = this.byId.get(call.id);
    const rec: ToolRecord = existing
      ? Object.assign(existing, fields)
      : { seq: ++this.seq, ...fields };
    if (!existing) {
      // Counted here rather than in onToolStart: a call can reach us only as
      // a terminal update (its start was never announced), and the count must
      // agree with the transcript — it is the caller's did-it-really-work
      // signal, and an undercount reads as an agent that did less than it did.
      this.turnTools++;
      this.totalTools++;
      this.byId.set(call.id, rec);
      this.tools.push(rec);
      // Evicting from the ring must evict from the index too, or a long agent
      // leaks one entry per tool call for as long as it lives.
      while (this.tools.length > TOOL_RING) {
        const gone = this.tools.shift();
        if (gone) for (const [id, r] of this.byId) if (r === gone) this.byId.delete(id);
      }
    }
    this.mark(rec.title || rec.kind || "a tool call");
    this.log({ type: "tool", call: rec });
  }

  /**
   * A turn has ended. Capture everything about it NOW.
   *
   * Everything after this point — a grace window, a resume backoff — is time
   * during which text belonging to a *different* turn can arrive, and during
   * which `owed` moves as other turns complete. The previous version kept the
   * prose in one shared slot and re-read `owed` when a timer fired; two turns
   * failing inside one window then overwrote each other's prose, and the
   * "never resume while the caller is steering" guard read an `owed` that had
   * already been decremented and waved the resume through. So: each ended turn
   * carries its own copy of both.
   */
  private finishTurn(stopReason: string) {
    const text = this.buf.join("");
    this.buf = [];
    const owedAtEnd = this.owed;

    // `error` is agentbox's own stop reason, not one of ACP's: the prompt
    // request itself failed. That is also what a process dying under a running
    // turn looks like from here, a beat before the exit lands — so wait out
    // the beat before deciding this agent is still usable.
    if (stopReason === "error" && this._state === "running" && this.runner.alive) {
      this.defer(DEATH_GRACE_MS, text, (sr) => this.report(sr, text), () =>
        this.decide(stopReason, text, owedAtEnd),
      );
      return;
    }
    this.report(stopReason, text);
  }

  /**
   * Schedule work on a turn that has ended but is not yet reported, keeping it
   * cancellable.
   *
   * Every such wait is a turn the caller is still blocked on. An untracked
   * timer is therefore a turn that cannot be interrupted, cannot be cleaned up
   * on death, and outlives `stopAll()` — so they all go through here.
   */
  private defer(
    ms: number,
    text: string,
    abandon: (stopReason: string) => void,
    run: () => void,
  ) {
    const entry: PendingTurn = {
      text,
      abandon,
      timer: setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== entry);
        run();
      }, ms),
    };
    this.pending.push(entry);
  }

  /** The grace window is over: resume this turn, or report it. */
  private decide(stopReason: string, text: string, owedAtEnd: number) {
    // `alive` is the one input re-read here — waiting for it is what the grace
    // window is for. Everything else was captured when the turn ended.
    const resumable =
      stopReason === "error" &&
      this.runner.alive &&
      this._state === "running" &&
      // Only when this turn is the only one outstanding, both then and now.
      // A caller who has queued a follow-up is steering, and their message is
      // already running inside omp — a `Continue` would queue behind it and
      // the two turns' prose would interleave.
      owedAtEnd === 1 &&
      this.owed === 1 &&
      this.continues < MAX_CONTINUES;
    if (resumable) this.resumeAfterError(text, owedAtEnd);
    else this.report(stopReason, text);
  }

  /**
   * Carry the interrupted turn's prose forward and ask omp to go on.
   *
   * The salvage is *carried*, never written back into `buf`. Chunks from the
   * failed turn can still be in flight and land in the buffer during the
   * window; overwriting it would throw away exactly what this mechanism exists
   * to preserve.
   */
  private resumeAfterError(text: string, owedAtEnd: number) {
    const attempt = ++this.continues;
    if (text) this.carried.push(text);
    this.errors.push(
      `provider error cut the turn short; resumed automatically ` +
        `(attempt ${attempt} of ${MAX_CONTINUES})`,
    );
    this.log({ type: "continue", attempt, salvagedChars: text.length });

    const delay = CONTINUE_BACKOFF_MS[attempt - 1] ?? CONTINUE_BACKOFF_MS.at(-1)!;
    // The salvage is already in `carried`, so an abandoned backoff reports it.
    this.defer(delay, "", (sr) => this.report(sr, ""), () => {
      // The caller may have steered while we waited out the backoff. If so
      // their message is the continuation and ours would only queue behind it,
      // so hand this turn back instead of sending.
      if (this._state !== "running" || !this.runner.alive || this.owed !== owedAtEnd) {
        this.report("error", "");
        return;
      }
      try {
        this.runner.send(CONTINUE_MESSAGE);
      } catch (err) {
        this.errors.push(`could not resume: ${messageOf(err)}`);
        this.report("error", "");
      }
    });
  }

  /**
   * Hand one owed turn back.
   *
   * Does nothing when the turn has already been answered — `die` answers every
   * turn in flight, and a timer can still fire after it.
   */
  private report(stopReason: string, text: string) {
    if (this.owed <= 0) {
      this.carried = [];
      return;
    }
    this.owed--;
    this.continues = 0;
    // Nothing is owed, so nothing is running: the clock has no turn to bound.
    if (this.owed === 0) this.clearTurnClock();
    // The interrupt the wall clock fired reaches omp as an ordinary cancel,
    // and a caller cannot tell that from its own `interrupt` unless we say so.
    let reason = stopReason;
    if (this.deadlineHit) {
      this.deadlineHit = false;
      reason = "deadline";
    }
    const gone = this._state === "dead" || !this.runner.alive;
    const whole = this.carried.join("") + text;
    this.carried = [];
    // A turn whose entire output is a provider failure arrives here wearing
    // the costume of a success: `end_turn`, no errors, a short confident
    // paragraph. The resume machinery cannot help — it keys on the prompt
    // request having *rejected*, and this one did not. Discovered by handing
    // omp `--model sonnet`, which it accepts, routes somewhere unexpected, and
    // answers with `402 Insufficient credits.` as though the agent had said
    // it. Saying so is cheap; a caller acting on a billing message as if it
    // were an answer is not.
    if (isProviderError(whole)) {
      this.errors.push(
        "the entire report reads as a provider error rather than something the agent " +
          "said — treat it as a failed turn, not an answer",
      );
    }
    const report: TurnReport = {
      name: this.name,
      turn: ++this.answeredTurns,
      cwd: this.cwd,
      state: gone ? "dead" : "idle",
      report: clipReport(whole),
      stopReason: reason,
      wroteOutside: this.escapedPaths(),
      toolCalls: this.turnTools,
      durationMs: this.turnStartedAt ? Date.now() - this.turnStartedAt : 0,
      costUsd: this.cost,
      contextTokens: this.tokens,
      errors: this.errors.splice(0),
    };
    this.turns++;
    // Another message may already be queued behind this one; only an agent
    // that owes nothing is genuinely idle.
    this._state = gone ? "dead" : this.owed > 0 ? "running" : "idle";
    this.turnStartedAt = Date.now();
    this.turnTools = 0;
    this.turnSeqFrom = this.seq;
    this.lastAnsweredAt = Date.now();
    this.log({ type: "turn", report });
    this.deliver(report);
  }

  /**
   * Start the wall clock for the turn in flight, if it is not already running.
   *
   * One clock per agent rather than one per queued message: pipelined turns
   * run inside a single omp process one after another, and there is only ever
   * one of them actually executing. It is disarmed when the agent stops owing
   * anything.
   */
  private armTurnClock() {
    if (this.turnTimer !== null) return;
    const timer = setTimeout(() => {
      this.turnTimer = null;
      if (this._state !== "running") return;
      const hours = this.maxTurnMs / 3_600_000;
      this.deadlineHit = true;
      this.errors.push(
        `the turn passed its ${hours}h wall clock and was interrupted; the report ` +
          `above is whatever it had produced by then`,
      );
      this.log({ type: "deadline", maxTurnMs: this.maxTurnMs });
      this.interrupt();
    }, this.maxTurnMs);
    // Never hold the process open for a deadline that may never fire.
    (timer as { unref?: () => void }).unref?.();
    this.turnTimer = timer;
  }

  private clearTurnClock() {
    if (this.turnTimer !== null) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  /**
   * Absolute paths outside the working directory that a writing tool call
   * touched this turn.
   *
   * Read off the transcript we already keep, so it costs a scan and no
   * cooperation from the agent. Best effort in both directions: tool inputs
   * are clipped at 300 characters and the ring is bounded, so a long turn can
   * hide an escape — but anything it *does* find is close to conclusive, and
   * one line at the top of a report beats discovering it five hours later in
   * somebody else's `git status`.
   */
  private escapedPaths(): string[] {
    const inputs: string[] = [];
    for (const t of this.tools) {
      if (t.seq <= this.turnSeqFrom) continue;
      if (READ_ONLY_KINDS.has(t.kind)) continue;
      if (t.title) inputs.push(t.title);
      if (t.input) inputs.push(t.input);
    }
    if (inputs.length === 0) return [];
    try {
      return outsidePaths(inputs.join("\n"), this.cwd);
    } catch {
      // A scan is a courtesy; it must never be why a report fails to arrive.
      return [];
    }
  }

  /** Drop every pending wait, returning the prose they were holding. Used by
   *  `die`, which answers the owed turns itself. */
  private clearPending(): string {
    const held = this.pending.map((p) => p.text).join("");
    for (const p of this.pending) clearTimeout(p.timer);
    this.pending = [];
    return held;
  }

  private die(reason: string) {
    if (this._state === "dead") return;
    this.clearTurnClock();
    const held = this.clearPending();
    const owed = this.owed;
    this.owed = 0;
    this._state = "dead";
    this.log({ type: "dead", reason });
    // Every turn in flight when the process vanished still owes its caller an
    // answer. Silence is the deadlock: a caller waits out its whole timeout
    // for a turn that can no longer end. `owed` can exceed one — messages
    // pipeline — and answering only the first stranded every message behind
    // it, so each gets its own report. Only the first carries the partial
    // prose and the tool count; the rest never started.
    const partial = clipReport(this.carried.join("") + held + this.buf.join(""));
    this.carried = [];
    this.buf = [];
    const errors = [...this.errors.splice(0), reason];
    if (owed > 0) this.lastAnsweredAt = Date.now();
    for (let i = 0; i < owed; i++) {
      this.turns++;
      this.deliver({
        name: this.name,
        cwd: this.cwd,
        turn: ++this.answeredTurns,
        state: "dead",
        report: i === 0 ? partial : "",
        stopReason: "died",
        wroteOutside: i === 0 ? this.escapedPaths() : [],
        toolCalls: i === 0 ? this.turnTools : 0,
        durationMs: i === 0 && this.turnStartedAt ? Date.now() - this.turnStartedAt : 0,
        costUsd: this.cost,
        contextTokens: this.tokens,
        errors: i === 0 ? errors : [reason],
      });
    }
  }

  private deliver(report: TurnReport) {
    const pinned = this.waiters.findIndex((w) => w.turn === report.turn);
    const at = pinned !== -1 ? pinned : this.waiters.findIndex((w) => w.turn === undefined);
    if (at === -1) {
      this.mailbox.push(report);
      return;
    }
    this.waiters.splice(at, 1)[0]!.deliver(report);
  }

  private log(entry: Record<string, unknown>) {
    try {
      appendFileSync(join(this.dir, "transcript.jsonl"), `${JSON.stringify({ ts: Date.now(), ...entry })}\n`);
    } catch {
      // The transcript is a debugging aid. Failing to write one must never
      // take down the agent it is describing.
    }
  }
}

/** Rough elapsed time, for a status line and a nag. Two significant figures
 *  at most: the point is "minutes or hours", not the minutes. */
export function ago(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 360_000) / 10}h ago`;
}

/**
 * One agent's status line, or null when it has nothing worth a row.
 *
 * Three states are worth showing and one is not. A running agent is the
 * obvious case. An agent sitting on an answer nobody collected is the
 * important one — that answer was paid for, and the line is the only place it
 * is visible from outside the client. An idle agent owing nothing is just a
 * process, and a status line that lists those teaches the reader to stop
 * reading it.
 */
export function renderAgentLine(a: Subagent): string | null {
  const where = shortPlace(a.place);
  const cost = a.costUsd === null ? "" : ` · $${a.costUsd.toFixed(2)}`;
  if (a.state === "running") {
    const act = a.activity();
    const idle = act.idleMs >= 5000 ? ` ${Math.round(act.idleMs / 1000)}s` : "";
    const action = act.action.length > 40 ? `${act.action.slice(0, 39)}…` : act.action;
    return (
      `${a.name} ${where} · ${Math.round(act.turnMs / 1000)}s · ${act.toolCalls} tool` +
      `${act.toolCalls === 1 ? "" : "s"}${cost} → ${action}${idle}`
    );
  }
  if (a.uncollected > 0) {
    const when = a.answeredAt ? ` ${ago(Date.now() - a.answeredAt)}` : "";
    return (
      `${a.name} ${where} · finished${when}, ${a.uncollected} answer` +
      `${a.uncollected === 1 ? "" : "s"} UNCOLLECTED${cost}`
    );
  }
  return null;
}

/** How often the pool redraws its agents' status lines. Matches the workflow
 *  roster's heartbeat; readers judge staleness off the timestamp either way. */
const LIVE_TICK_MS = 2000;

/** The refusal for a prompt written about somebody else's checkout. */
function foreignPromptError(foreign: ForeignPath[], cwd: string): string {
  const there = foreign
    .map((f) => `  ${f.path}\n    which is in ${renderPlace(describePlace(f.toplevel))}`)
    .join("\n");
  return (
    `refusing to spawn: this prompt names files in a different git work tree.\n\n` +
    `The agent would run in:\n  ${renderPlace(describePlace(cwd))}\n\n` +
    `The prompt names:\n${there}\n\n` +
    `Edits would land in the wrong repository and nothing downstream would notice. ` +
    `Pass \`cwd\` for the checkout this task is about. If the task genuinely spans ` +
    `repositories, set \`allow_outside_cwd\`.`
  );
}

/** How long a finished agent's transcript is kept. */
const TRANSCRIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete subagent transcripts older than the TTL.
 *
 * These are debugging aids for agents that no longer exist, one directory per
 * spawn, and nothing else ever removes them — an unbounded write into the
 * user's home is not a reasonable price for a log almost nobody reads. Best
 * effort by design: a transcript that cannot be deleted is not worth failing
 * a spawn over, and one being written by a *live* agent of another MCP server
 * is protected by its own mtime.
 */
export function pruneTranscripts(now = Date.now(), ttlMs = TRANSCRIPT_TTL_MS): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(subagentRoot());
  } catch {
    return 0; // nothing has ever run
  }
  for (const entry of entries) {
    const dir = join(subagentRoot(), entry);
    try {
      if (now - statSync(dir).mtimeMs < ttlMs) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Busy, gone, or not ours. Leave it.
    }
  }
  return removed;
}

/** Every subagent this process owns, addressed by name. */
export class SubagentPool {
  private agents = new Map<string, Subagent>();
  private counter = 0;

  /** `defaultCwd` is the MCP server's cwd — the caller's repository. */
  constructor(
    private defaultCwd: string,
    private makeRunner: RunnerFactory = ompRunner,
  ) {}

  list(): Subagent[] {
    return [...this.agents.values()];
  }

  get(name: string): Subagent {
    const a = this.agents.get(name);
    if (a) return a;
    const known = [...this.agents.keys()];
    throw new Error(
      known.length === 0
        ? `no subagent named "${name}" — none are running. Start one with \`agent\`.`
        : `no subagent named "${name}". Running: ${known.join(", ")}`,
    );
  }

  /** Monotonic per-pool spawn counter. Part of each agent's directory name so
   *  two agents can never share one — not even successive holders of the same
   *  name, whose transcripts would otherwise interleave in one file. */
  private spawns = 0;

  async spawn(opts: SpawnOptions): Promise<Subagent> {
    const cwd = opts.cwd ?? this.defaultCwd;
    // A relative path would resolve against this server's working directory,
    // which is the very thing a caller passing `cwd` is trying to get away
    // from — so it would silently do the opposite of what was asked.
    if (!isAbsolute(cwd)) {
      throw new Error(
        `cwd must be an absolute path, but got "${cwd}". Relative paths resolve ` +
          `against this server's own working directory (${this.defaultCwd}), which ` +
          `is not where you meant.`,
      );
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error(`cwd is not a directory: ${cwd}`);
    }
    // The brief and the directory disagreeing is not a hypothetical: a prompt
    // written about one checkout and run against another edits real files and
    // reports success. Read-only agents are exempt — they can name whatever
    // they like, because they cannot change any of it.
    if (!opts.allowOutsideCwd && !opts.readOnly) {
      const foreign = foreignRepoPaths(opts.prompt, cwd);
      if (foreign.length > 0) throw new Error(foreignPromptError(foreign, cwd));
    }
    const name = this.nameFor(opts.name);
    const model = resolveModel(opts.model);
    const agent = new Subagent(
      name,
      cwd,
      model,
      subagentDirFor(`${process.pid}-${++this.spawns}-${name}`),
      this.makeRunner,
      opts.readOnly ?? false,
      opts.maxTurnMs,
      opts.quiet ?? false,
    );
    // Registered BEFORE the await, not after. Two same-name spawns in one
    // message both used to pass the name check during the first one's launch;
    // the second's set() then overwrote the first, leaving a live omp process
    // addressable by nothing. Registering synchronously makes the collision
    // check and the claim atomic; a failed launch releases the claim below —
    // but only if this agent still holds it, so a slow failure cannot evict
    // a successor that legitimately took the name over.
    this.agents.set(name, agent);
    try {
      await agent.start(opts.prompt, opts.role);
    } catch (err) {
      agent.stop();
      if (this.agents.get(name) === agent) this.agents.delete(name);
      throw new Error(`could not start omp: ${messageOf(err)}`);
    }
    if (!agent.quiet) this.startTicking();
    return agent;
  }

  /** Forget a stopped agent, freeing its name. */
  remove(name: string): void {
    this.agents.get(name)?.stop();
    this.agents.delete(name);
    this.retract(name);
    if (this.agents.size === 0) this.stopTicking();
  }

  stopAll(): void {
    for (const a of this.agents.values()) {
      a.stop();
      this.retract(a.name);
    }
    this.agents.clear();
    this.stopTicking();
  }

  // ------------------------------------------------------- live status lines

  /**
   * Publish one status line per agent, for as long as the agent exists.
   *
   * Tied to the agent's life and not to the call that started it, which is the
   * whole change. The MCP layer publishes while a call is blocked; that covers
   * the ordinary case and misses the one that matters, because an agent whose
   * caller stopped waiting is precisely the agent nobody is watching. It used
   * to disappear from the status line at the moment it became worth seeing.
   *
   * An uncollected answer keeps its row for the same reason: from outside the
   * client, this file is the only place it is visible at all.
   */
  private published = new Set<string>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  private liveId(name: string): string {
    return `sub-${process.pid}-${name}`;
  }

  private retract(name: string): void {
    const id = this.liveId(name);
    if (this.published.delete(id)) live.retract(id);
  }

  private tick(): void {
    for (const a of this.agents.values()) {
      if (a.quiet) continue;
      const line = renderAgentLine(a);
      if (line === null) {
        this.retract(a.name);
        continue;
      }
      const id = this.liveId(a.name);
      this.published.add(id);
      live.publish(id, a.cwd, line);
    }
  }

  private startTicking(): void {
    if (this.ticker === null) {
      const t = setInterval(() => this.tick(), LIVE_TICK_MS);
      // A status line must never be the reason a process refuses to exit.
      (t as { unref?: () => void }).unref?.();
      this.ticker = t;
    }
    // Draw immediately: a fan-out's first seconds are the ones a watcher is
    // most likely to be looking at, and waiting a tick reads as nothing
    // happening.
    this.tick();
  }

  private stopTicking(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    for (const id of this.published) live.retract(id);
    this.published.clear();
  }

  private nameFor(requested?: string): string {
    if (requested) {
      const name = normalizeName(requested);
      if (!name) throw new Error(`unusable agent name: "${requested}"`);
      const held = this.agents.get(name);
      // A dead agent must not hold the name — reusing it is the obvious retry
      // after a crash — but deleting it deletes its mailbox, and an answer in
      // there was paid for and never read. Mail first, then the name.
      if (held && held.state === "dead") {
        if (held.uncollected > 0) {
          throw new Error(
            `"${name}" died with an uncollected answer — \`collect\` it first, ` +
              `or \`stop_agent\` to discard it, then retry`,
          );
        }
        this.agents.delete(name);
      } else if (held) {
        throw new Error(
          `a subagent named "${name}" is already running — send it a message, ` +
            `stop it, or pick another name`,
        );
      }
      return name;
    }
    for (;;) {
      const name = `agent-${++this.counter}`;
      if (!this.agents.has(name)) return name;
    }
  }
}
