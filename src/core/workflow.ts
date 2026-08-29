/** Workflows: orchestrating many omp subagents from one script.
 *
 * A single subagent call is a function call — you ask, you block, you get an
 * answer. That is the right shape for one question, and the wrong shape for
 * ten: a caller who wants a fan-out has to issue ten tool calls, hold ten
 * names in its head, and reduce ten reports by hand, in its own context, while
 * blocked. The work that *coordinates* agents is deterministic — fan out,
 * collect, dedup, count, decide — and paying a language model to do it by hand
 * is both slower and less reliable than writing it down.
 *
 * So a workflow is a small program whose function calls happen to be agents.
 * `agent()` is the atom; `parallel()` and `pipeline()` compose it; everything
 * between them is ordinary JavaScript, which is exactly where the merging,
 * filtering and counting belong. The script runs here, in the MCP server, and
 * only its return value crosses back to the caller — so a hundred agents'
 * transcripts cost the caller nothing at all.
 *
 * The script is not sandboxed, and deliberately so: it is written by the same
 * agent that already has shell access through its own tools, so a sandbox
 * would add ceremony without adding safety. What is bounded is the part that
 * costs money — concurrency, agent count, and wall clock.
 */

import { SubagentPool, type Subagent, type TurnReport } from "./subagents";

/** Concurrent omp processes. Each is a real process with a real context
 *  window, so this is a memory bound as much as a rate limit. */
export const DEFAULT_CONCURRENCY = 6;

/** Total agents one workflow may ever spawn. A runaway-loop backstop, set far
 *  above any workflow a person would write on purpose. */
export const MAX_AGENTS = 200;

/** Wall-clock ceiling for a whole workflow. */
export const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

export interface AgentOptions {
  /** Shown in the log. Defaults to a truncation of the prompt. */
  label?: string;
  cwd?: string;
  /** Permit a prompt naming files in a different git work tree. See
   *  `SpawnOptions.allowOutsideCwd`; the same refusal applies here. */
  allowOutsideCwd?: boolean;
  /** Standing system-prompt text for this agent. */
  role?: string;
  /**
   * Enforced read-only. Defaults to TRUE inside workflows: a fan-out is
   * usually a survey, the agents share one working tree, and parallel writers
   * to one tree is the mistake this default exists to make hard to reach.
   * Pass false deliberately when an agent is meant to change files.
   */
  readOnly?: boolean;
  /**
   * A JSON shape to coerce the answer into. The agent is told to end with one
   * fenced JSON block; the parsed value is returned instead of prose.
   *
   * This is the difference between a workflow and a chain of chat messages.
   * Prose can only be fed to another model; a value can be counted, deduped,
   * sorted and branched on — by the script, deterministically, for free.
   */
  schema?: unknown;
}

export interface WorkflowResult {
  ok: boolean;
  /** Whatever the script returned. */
  value: unknown;
  error: string | null;
  agentsRun: number;
  durationMs: number;
  log: string[];
  /** Per-agent accounting, so a caller can see where the time went. */
  agents: { label: string; ms: number; toolCalls: number; stopReason: string; failed: boolean }[];
}

/** Thrown when a bound is hit. Distinguished from a script's own errors so the
 *  report can say which happened. */
class WorkflowLimit extends Error {}

/** One agent's place in the run, as a watcher would want it described. */
export interface Slot {
  label: string;
  state: "queued" | "running" | "done" | "failed";
  /** How long it has been running, or how long it ran. */
  ms: number;
  /** Its last observable action — a tool title, or "writing". Running only. */
  action?: string;
  /** How long ago that action was. Running only. */
  idleMs?: number;
}

/** Coarse, and deliberately: this is read at a glance off a status line, where
 *  "2m10s" says everything "2m 10.4s" does and takes half the room. */
function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m${s % 60}s`;
  return m % 60 === 0 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function clip(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * Render the roster to one line.
 *
 * Two budgets apply and only one of them is a number. `max` is the client's
 * hard cap, past which text is dropped; the real constraint is the terminal,
 * which shows this line inside a status row and truncates it at whatever the
 * window happens to be. Nothing can be done about the second except to order
 * the line so that truncation costs the least: every count goes in the head,
 * where a narrow window still gets it, and the per-agent detail follows as
 * the part a wide window is rewarded with.
 *
 * Agents are listed longest-running first, by start time rather than by
 * recent activity, so the line does not reshuffle under a reader every two
 * seconds — and because the straggler is the one worth looking at anyway.
 */
export function renderRoster(slots: Slot[], note: string | null, max = 200): string {
  const done = slots.filter((s) => s.state === "done").length;
  const failed = slots.filter((s) => s.state === "failed").length;
  const queued = slots.filter((s) => s.state === "queued").length;
  const running = slots.filter((s) => s.state === "running").sort((a, b) => b.ms - a.ms);

  if (slots.length === 0) return "starting";

  const head = [
    `${done + failed}/${slots.length} done`,
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(running.length > 0 ? [`${running.length} running`] : []),
    ...(queued > 0 ? [`${queued} queued`] : []),
  ];

  const entries = running.map((s) => {
    // Generous, because omp's tool titles are sentences ("Listing files
    // directly under src/core") rather than tool names, and the first twenty
    // characters of a sentence are usually its least specific part. Better to
    // show two agents legibly than six illegibly — the head already says how
    // many there are.
    const action = s.action ? ` → ${clip(s.action, 30)}` : "";
    // The action's own age only earns its place once it is old enough to mean
    // something. On a busy agent it is always "1s", which is noise.
    const stale = s.idleMs !== undefined && s.idleMs >= 5000 ? ` ${dur(s.idleMs)}` : "";
    return `${clip(s.label, 20)} ${dur(s.ms)}${action}${stale}`;
  });

  // The script's own last `log()` line goes last. It is the only thing here
  // its author chose to say, but it is also the least perishable — it is
  // still in the returned log afterwards, and the agents are not — so it
  // yields the narrow-terminal room to them. When nothing is running it ends
  // up right behind the counts anyway, which is where it belongs then: it is
  // the only news there is between waves.
  const tail = [...entries, ...(note ? [clip(note, 60)] : [])];

  const parts = [...head];
  for (const part of tail) {
    if (parts.join(" · ").length + 3 + part.length > max) break;
    parts.push(part);
  }
  return clip(parts.join(" · "), max);
}

function preview(s: string, max = 60): string {
  const line = s.trim().split("\n")[0] ?? "";
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/**
 * Pull a JSON value out of a model's answer.
 *
 * Models fence JSON, prefix it with prose, or emit it bare, and a workflow
 * that throws on the first two would fail on a correct answer badly formatted.
 * So: try the fence, then the whole string, then the outermost braces.
 */
/**
 * Recover an `args` value an MCP client delivered as a JSON string.
 *
 * A schema with no declared `type` (z.unknown()) gives the client nothing to
 * parse against, so an object-valued `args` arrives as its JSON text and the
 * script dies on `args.units` being undefined. Only strings that look like a
 * JSON object/array are parsed — a deliberate string arg stays a string —
 * and unparseable text passes through untouched.
 */
export function parseJsonArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  const s = args.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return args;
  try {
    return JSON.parse(s);
  } catch {
    return args;
  }
}

export function parseJsonAnswer(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  const first = text.search(/[[{]/);
  const last = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    if (!c) continue;
    try {
      return JSON.parse(c.trim());
    } catch {
      // Try the next shape.
    }
  }
  throw new Error(`agent did not return parseable JSON. It said: ${preview(text, 300)}`);
}

const SCHEMA_INSTRUCTION =
  "\n\nReturn your answer as a single JSON value matching this shape, in one " +
  "```json fenced block, as the last thing in your message. No commentary after it:\n";

/**
 * A limited semaphore. Workflows fan out wider than the machine can run, and
 * the excess has to queue rather than spawn 80 omp processes at once.
 */
class Gate {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * One frame of "what is this workflow doing right now".
 *
 * A *snapshot*, not an event, and that is the whole design. The surface these
 * reach — an MCP client's progress line — shows one message at a time and
 * replaces it on every update, so an event stream ("start x", "done y") shows
 * a watcher whichever agent happened to move last and nothing about the other
 * eleven. A roster shows all of them, and reads correctly no matter when you
 * glance at it.
 */
export interface Progress {
  /** The roster, rendered to one line. */
  message: string;
  /** Monotonic frame counter — a client that drops or reorders can tell. */
  event: number;
  /** Agents settled, and agents spawned so far. Both grow during the run:
   *  a script decides how many agents there are as it goes. */
  done: number;
  total: number;
}

/** How often a running workflow re-renders its roster even when nothing has
 *  happened. The clock in "2m10s" is itself the information — a frozen line
 *  is indistinguishable from a hung server — and the ticks are far cheaper
 *  than the agents they describe. */
export const HEARTBEAT_MS = 2000;

export interface RunOptions {
  script: string;
  args?: unknown;
  concurrency?: number;
  deadlineMs?: number;
  /** Where agents run. Defaults to the pool's own default. */
  cwd?: string;
  /**
   * Live observer of the workflow's roster, on every change and on a
   * heartbeat between changes. The MCP layer forwards these as
   * `notifications/progress` so a long fan-out neither times out a client's
   * idle clock nor runs dark.
   *
   * Fire-and-forget: a throwing observer is swallowed, never the workflow.
   */
  onProgress?: (p: Progress) => void;
}

/**
 * Execute a workflow script.
 *
 * The script body is compiled as an async function over the hooks below, so it
 * can `await`, loop, branch and return like ordinary code — because it *is*
 * ordinary code, with one impure call in it.
 */
export async function runWorkflow(pool: SubagentPool, opts: RunOptions): Promise<WorkflowResult> {
  const started = Date.now();
  const gate = new Gate(opts.concurrency ?? DEFAULT_CONCURRENCY);
  const deadline = started + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const log: string[] = [];
  const accounting: WorkflowResult["agents"] = [];
  const spawned: Subagent[] = [];
  let count = 0;

  let events = 0;
  let settled = 0;

  // The live roster. One entry per `agent()` call, from the moment the script
  // asks for it — including the wait at the gate, which on a wide fan-out is
  // most of an agent's wall clock and would otherwise be invisible.
  interface Live {
    label: string;
    state: Slot["state"];
    /** When it left the gate. Zero while it is still queued. */
    startedAt: number;
    /** How long it ran, once it has stopped. */
    ranMs: number;
    sub?: Subagent;
  }
  const slots: Live[] = [];
  /** The script's own last `log()` line, for the tail of the roster line. */
  let lastNote: string | null = null;

  const frame = (): Progress => {
    const now = Date.now();
    const view: Slot[] = slots.map((s) => {
      if (s.state !== "running") return { label: s.label, state: s.state, ms: s.ranMs };
      // Ask the agent itself rather than trusting a cached copy: the whole
      // point of the heartbeat is that these move without the workflow doing
      // anything.
      const a = s.sub?.activity();
      return {
        label: s.label,
        state: s.state,
        ms: now - s.startedAt,
        // There is no agent to ask for the first few seconds — omp is still
        // being started. Saying so beats a bare clock, which reads as a hang
        // at exactly the moment nothing is wrong.
        action: a?.action ?? "launching omp",
        idleMs: a?.idleMs,
      };
    });
    return {
      message: renderRoster(view, lastNote),
      event: ++events,
      // Counted off the roster, not off `settled`: an agent the deadline
      // killed at the gate never settles, and a `done` that can never reach
      // `total` leaves a client's percentage stuck short of 100 forever.
      done: view.filter((v) => v.state === "done" || v.state === "failed").length,
      total: slots.length,
    };
  };

  const emit = () => {
    try {
      opts.onProgress?.(frame());
    } catch {
      // Observer-only channel; its failure must never fail the workflow.
    }
  };

  /** An internal lifecycle line: recorded in the log, and a reason to redraw.
   *  It is not itself the progress message — the roster is. */
  const record = (message: string) => {
    log.push(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
    emit();
  };

  /** The script's `log()`. Same as `record`, and additionally the line that
   *  gets shown to a watcher when there is room for it. */
  const note = (message: string) => {
    lastNote = message;
    record(message);
  };

  const heartbeat = setInterval(emit, HEARTBEAT_MS);
  // Never hold the process open for a redraw. Bun and Node both keep running
  // while a timer is pending, and a workflow that returned would otherwise
  // outlive its own answer.
  (heartbeat as { unref?: () => void }).unref?.();

  async function agent(prompt: string, o: AgentOptions = {}): Promise<unknown> {
    if (++count > MAX_AGENTS) {
      throw new WorkflowLimit(`workflow tried to run more than ${MAX_AGENTS} agents`);
    }
    const label = o.label ?? preview(prompt);
    const index = count;
    const slot: Live = { label, state: "queued", startedAt: 0, ranMs: 0 };
    slots.push(slot);
    // Redraw now: on a fan-out wider than the gate, this is the only moment
    // the queued agents become visible at all.
    emit();
    return gate.run(async () => {
      if (Date.now() > deadline) {
        slot.state = "failed";
        throw new WorkflowLimit(`workflow deadline reached before "${label}" could start`);
      }
      const body = o.schema
        ? `${prompt}${SCHEMA_INSTRUCTION}${JSON.stringify(o.schema, null, 2)}`
        : prompt;
      const at = Date.now();
      slot.state = "running";
      slot.startedAt = at;
      let sub: Subagent | undefined;
      try {
        sub = await pool.spawn({
          prompt: body,
          name: `wf-${index}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 20)}`,
          cwd: o.cwd ?? opts.cwd,
          role: o.role,
          allowOutsideCwd: o.allowOutsideCwd,
          // Read-only unless the script says otherwise — see AgentOptions.
          readOnly: o.readOnly ?? true,
          // The roster line speaks for the whole fan-out; eighty agents each
          // publishing their own would be a status line nobody can read.
          quiet: true,
        });
        spawned.push(sub);
        slot.sub = sub;
        record(`start ${label}`);
        const report: TurnReport | null = await sub.settle(Math.max(1_000, deadline - Date.now()), 1);
        if (!report) throw new Error(`"${label}" did not finish before the workflow deadline`);
        // An agent that died hands back an empty report, not an exception —
        // and a script cannot tell "" apart from "the agent had nothing to
        // say". Silence is the worst answer available here, because the
        // script will go on to count it, dedup it, or feed it to the next
        // stage as though it were a result. Make it a failure so it surfaces
        // as a `null` the script can filter and a named entry in the log.
        if (report.state === "dead" || report.stopReason === "died") {
          throw new Error(
            `"${label}" died before answering` +
              (report.report ? `. It had said: ${preview(report.report, 200)}` : ""),
          );
        }
        if (report.stopReason === "error") {
          throw new Error(
            `"${label}" failed with a provider error that did not recover` +
              (report.errors.length ? `: ${report.errors[report.errors.length - 1]}` : ""),
          );
        }
        accounting.push({
          label,
          ms: Date.now() - at,
          toolCalls: report.toolCalls,
          stopReason: report.stopReason,
          failed: false,
        });
        slot.state = "done";
        slot.ranMs = Date.now() - at;
        record(`done  ${label} (${report.toolCalls} tools, ${Math.round(report.durationMs / 1000)}s) [${++settled}/${count} settled]`);
        return o.schema ? parseJsonAnswer(report.report) : report.report;
      } catch (err) {
        accounting.push({
          label,
          ms: Date.now() - at,
          toolCalls: 0,
          stopReason: "failed",
          failed: true,
        });
        slot.state = "failed";
        slot.ranMs = Date.now() - at;
        record(`FAIL  ${label}: ${(err as Error).message} [${++settled}/${count} settled]`);
        throw err;
      } finally {
        // The roster must not keep a handle on a process that is gone: a
        // removed agent's activity clock stops, and a frozen "→ Grep 4s" on a
        // finished agent is worse than no line at all.
        slot.sub = undefined;
        // Agents are single-shot inside a workflow: the script has its answer,
        // and an idle omp process holding a whole context window open is a
        // real cost when a fan-out has just made eighty of them.
        if (sub) pool.remove(sub.name);
      }
    });
  }

  /**
   * Fork-join. Every thunk runs, and the call returns when all have settled.
   *
   * A failure resolves to `null` rather than rejecting the batch — one agent
   * misbehaving should not throw away nine good answers — so callers filter.
   */
  async function parallel(thunks: (() => Promise<unknown>)[]): Promise<unknown[]> {
    const settled = await Promise.allSettled(thunks.map((t) => t()));
    return settled.map((r) => (r.status === "fulfilled" ? r.value : null));
  }

  /**
   * Run each item through every stage independently — no barrier between them.
   *
   * This is the default for multi-stage work, and the reason is wall clock. A
   * barrier costs `sum over stages of (slowest item in that stage)`; a
   * pipeline costs `the slowest single item's whole chain`. With agents, whose
   * durations vary wildly, that difference is most of the run. Reach for a
   * barrier only when a stage genuinely needs every item's result at once —
   * deduping across all findings, or deciding whether to continue at all.
   *
   * A stage that throws drops its own item to null; the rest carry on.
   */
  const pipeline = async (
    items: unknown[],
    ...stages: ((prev: unknown, item: unknown, i: number) => Promise<unknown>)[]
  ): Promise<unknown[]> => {
    const settled = await Promise.allSettled(
      items.map(async (item, i) => {
        let value: unknown = item;
        for (const stage of stages) value = await stage(value, item, i);
        return value;
      }),
    );
    return settled.map((r) => (r.status === "fulfilled" ? r.value : null));
  };

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  let value: unknown;
  let error: string | null = null;
  try {
    const fn = new AsyncFunction(
      "agent",
      "parallel",
      "pipeline",
      "log",
      "args",
      `"use strict";\n${opts.script}`,
    );
    value = await fn(agent, parallel, pipeline, note, opts.args);
  } catch (err) {
    error = (err as Error).message;
    note(`workflow failed: ${error}`);
  } finally {
    clearInterval(heartbeat);
    // Nothing survives the script. A workflow that threw mid-fan-out would
    // otherwise leave its agents running with no name anyone will ever use.
    for (const s of spawned) pool.remove(s.name);
    // One last frame, so a watcher's final view is the finished roster rather
    // than whatever was true two seconds before the end.
    emit();
  }

  return {
    ok: error === null,
    value,
    error,
    agentsRun: Math.min(count, MAX_AGENTS),
    durationMs: Date.now() - started,
    log,
    agents: accounting,
  };
}
