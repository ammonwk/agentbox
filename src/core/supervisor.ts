/** The babysitter.
 *
 * Two layers, cheapest first, both clocked on tool calls. A turn in ACP is a
 * whole agentic loop, so turn boundaries would fire roughly never.
 *
 *   1. Heuristics — free, run on every call, and never decide anything on
 *      their own. A hit escalates to layer 2 with a note about what it saw.
 *   2. The judge — one-shot `omp -p`, reusing the user's existing omp auth.
 *
 * The one hard rule in this file: **the supervisor must never be able to take
 * a session down by failing.** Every path out of a failure resolves to `ok`.
 * A watcher that can kill the thing it watches is worse than no watcher.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { getSettings } from "./db";
import { agentboxHome } from "./paths";
import { readJudgePrompt } from "./prompts";
import type {
  Session,
  SupervisorState,
  SupervisorVerdict,
  ToolCall,
  ToolKind,
  ToolStatus,
  TranscriptEvent,
} from "./types";

/** "verdict" → (sessionId: string, verdict: SupervisorVerdict) */
export const supervisorEvents = new EventEmitter();

// ------------------------------------------------------------- thresholds

/** Identical `execute` command this many times. */
const REPEAT_COMMAND = 3;
/** Tool results in a row with status "error". */
const ERROR_STREAK = 4;
/** Edits to one path before it counts as thrashing. */
const EDIT_SAME_FILE = 6;
/** Evidence lines handed to the judge. */
const WINDOW = 40;
/** A cheap model reading a cheap model; it should not need longer than this. */
const JUDGE_TIMEOUT_MS = 60_000;
/** Sessions untouched for this long are forgotten by the periodic sweep. */
const IDLE_TTL_MS = 6 * 60 * 60 * 1000;
/** Cap on the per-session counter maps, so a very long run cannot grow them
 *  without bound. Oldest key evicted first — Map preserves insertion order. */
const MAX_KEYS = 256;

// ------------------------------------------------------------ evidence

/**
 * One compacted line of what the agent did, as the judge will see it.
 *
 * `detail` carries a snippet of the failure text on a failed call, and it is
 * the single most load-bearing field here. Measured against the real judge on
 * an identical seven-round edit-then-test loop: without it the verdict is
 * `ok` ("each run is preceded by an edit, so it is iterating"); with it the
 * verdict is `spiraling` ("each edit reproduces the identical failure"). The
 * same fixture with *differing* error text still comes back `ok`, so this buys
 * the detection without costing a false positive — the error text is what
 * separates debugging from thrashing, and nothing else in the line does.
 */
export type Evidence =
  | { t: "tool"; kind: ToolKind; summary: string; status: ToolStatus; detail?: string }
  | { t: "text"; text: string };

/** One line, bounded. Evidence is line-per-call, so newlines have to go. */
function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/** Bounded, but keeps its shape — used for the task, where the line breaks of
 *  a multi-step request are most of the meaning. */
function clipBlock(s: string, n: number): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** Substitute without letting `$&`, `$1` and friends in the *replacement*
 *  be interpreted — a shell command in the evidence can contain any of them. */
function fill(template: string, key: string, value: string): string {
  return template.replace(key, () => value);
}

/**
 * Pull the shell command out of an `execute` call's raw input.
 *
 * omp does not put the tool's name on the wire, so this sniffs shape rather
 * than name. Returns null when nothing command-shaped is there, which the
 * repeat heuristic reads as "cannot compare these".
 */
export function commandOf(input: unknown): string | null {
  if (typeof input === "string") return input.trim() || null;
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "shellCommand"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return (v as string[]).join(" ").trim() || null;
    }
  }
  return null;
}

/** A short, comparable description of what a call did. */
export function summarizeCall(call: ToolCall): string {
  const cmd = call.kind === "execute" ? commandOf(call.input) : null;
  if (cmd) return clip(cmd, 160);
  const loc = call.locations[0];
  if (loc) return clip(loc, 160);
  if (call.title) return clip(call.title, 160);
  try {
    return clip(JSON.stringify(call.input) ?? "", 160);
  } catch {
    // Circular or non-serialisable rawInput. The kind and status still carry
    // most of the signal, so an empty summary is an acceptable evidence line.
    return "";
  }
}

function evidenceOfCall(call: ToolCall): Evidence {
  const ev: Evidence = {
    t: "tool",
    kind: call.kind,
    summary: summarizeCall(call),
    status: call.status,
  };
  // Only on failures: a successful call's output is bulk, and the judge is
  // reading a compact window. See the note on Evidence for why this matters.
  if (call.status === "error" && call.output) ev.detail = clip(call.output, 200);
  return ev;
}

/** Compact a transcript into the window the judge reads. Tool calls carry the
 *  behaviour; assistant text carries the intent, and without it a judge cannot
 *  tell exploration from thrashing. */
export function evidenceFromEvents(
  events: TranscriptEvent[],
  limit = WINDOW,
): Evidence[] {
  const out: Evidence[] = [];
  for (const e of events) {
    if (e.type === "tool") out.push(evidenceOfCall(e.call));
    else if (e.type === "assistant" && e.text.trim()) {
      out.push({ t: "text", text: clip(e.text, 300) });
    }
  }
  return out.slice(-limit);
}

export function renderEvidence(evidence: Evidence[]): string {
  if (evidence.length === 0) return "(nothing recorded yet)";
  return evidence
    .map((e) =>
      e.t === "text"
        ? `  agent: ${e.text}`
        : `${e.status === "error" ? "!" : " "} ${e.kind}: ${e.summary}` +
          (e.detail ? ` → ${e.detail}` : ""),
    )
    .join("\n");
}

// ------------------------------------------------------------ heuristics

/** Per-session counters. Bounded, in memory, dropped when the session ends. */
export interface HeuristicState {
  /** execute command → times seen. */
  commands: Map<string, number>;
  /** locations[0] → times edited. */
  edits: Map<string, number>;
  /** Consecutive failed calls, most recent run. */
  errorStreak: number;
  /** Call ids whose shape has been counted, so a `tool_call_update` cannot
   *  double-count the command or the file. */
  counted: Set<string>;
  /** Call ids whose ok/error outcome has been folded into the streak. Separate
   *  from `counted` because a call is normally seen first as `pending` — if
   *  the outcome were only read on first sight, no error would ever count. */
  finished: Set<string>;
  /** Fallback evidence, used when the transcript is not reachable. */
  recent: { id: string; ev: Evidence }[];
  /** Signatures already escalated, so one stuck command does not escalate on
   *  every subsequent call for the rest of the run. */
  escalated: Set<string>;
}

export function newHeuristicState(): HeuristicState {
  return {
    commands: new Map(),
    edits: new Map(),
    errorStreak: 0,
    counted: new Set(),
    finished: new Set(),
    recent: [],
    escalated: new Set(),
  };
}

/** The window this module keeps for itself, used only when the engine's
 *  transcript is not reachable. */
export function fallbackEvidence(st: HeuristicState): Evidence[] {
  return st.recent.map((r) => r.ev);
}

function bump(m: Map<string, number>, key: string): number {
  const next = (m.get(key) ?? 0) + 1;
  m.set(key, next);
  if (m.size > MAX_KEYS) {
    const oldest = m.keys().next();
    if (!oldest.done && oldest.value !== key) m.delete(oldest.value);
  }
  return next;
}

const EDIT_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(["edit", "delete", "move"]);

function forget(set: Set<string>, cap: number): void {
  if (set.size <= cap) return;
  const oldest = set.values().next();
  if (!oldest.done) set.delete(oldest.value);
}

/**
 * Fold one tool call into the counters.
 *
 * ACP reports the same call twice — once on start, once on completion — so
 * this is split: the *shape* (which command, which file) counts once on first
 * sight, and the *outcome* counts once when it first becomes terminal.
 */
export function foldCall(st: HeuristicState, call: ToolCall): void {
  if (!st.counted.has(call.id)) {
    st.counted.add(call.id);
    forget(st.counted, MAX_KEYS * 4);

    if (call.kind === "execute") {
      const cmd = commandOf(call.input);
      if (cmd) bump(st.commands, cmd);
    }
    if (EDIT_KINDS.has(call.kind)) {
      const path = call.locations[0];
      if (path) bump(st.edits, path);
    }

    st.recent.push({ id: call.id, ev: evidenceOfCall(call) });
    if (st.recent.length > WINDOW) st.recent.shift();
  } else {
    // The completion update is where the status and the output finally arrive,
    // so replace the line rather than patching the status onto a stale one —
    // the failure text is the field the judge actually discriminates on.
    const entry = st.recent.find((r) => r.id === call.id);
    if (entry) entry.ev = evidenceOfCall(call);
  }

  if ((call.status === "ok" || call.status === "error") && !st.finished.has(call.id)) {
    st.finished.add(call.id);
    forget(st.finished, MAX_KEYS * 4);
    if (call.status === "error") st.errorStreak += 1;
    else st.errorStreak = 0;
  }
}

/**
 * What the cheap layer noticed, if anything, as a sentence for the judge.
 *
 * Returns null on benign sequences — which is nearly all of them. A hit is
 * reported at most once per signature; the caller does not get to re-escalate
 * the same stuck command forever.
 */
export function checkHeuristics(st: HeuristicState): string | null {
  for (const [cmd, n] of st.commands) {
    if (n >= REPEAT_COMMAND && !st.escalated.has(`cmd:${cmd}`)) {
      st.escalated.add(`cmd:${cmd}`);
      return `It has run the same command ${n} times: \`${clip(cmd, 200)}\``;
    }
  }
  for (const [path, n] of st.edits) {
    if (n > EDIT_SAME_FILE && !st.escalated.has(`edit:${path}`)) {
      st.escalated.add(`edit:${path}`);
      return `It has edited the same file ${n} times: ${clip(path, 200)}`;
    }
  }
  if (st.errorStreak >= ERROR_STREAK) {
    // Reset rather than mark: the *next* run of failures is new information,
    // where the same command repeating is not.
    const n = st.errorStreak;
    st.errorStreak = 0;
    return `Its last ${n} tool calls in a row failed.`;
  }
  return null;
}

// --------------------------------------------------------- verdict parsing

const STATES: ReadonlySet<string> = new Set<SupervisorState>([
  "ok",
  "adrift",
  "spiraling",
]);

/** Everything between the first `{` and the last `}`, so a model that wrapped
 *  its JSON in a fence or a sentence still parses. */
function extractJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    // Truncated or malformed output. The caller falls back to "ok"; this is
    // the single most likely way a cheap judge misbehaves and it must not
    // disturb the session.
    return null;
  }
}

/**
 * Parse a judge response. Returns null when the output does not contain a
 * usable verdict — the caller turns that into `ok`, never into an escalation.
 */
export function parseVerdict(
  raw: string,
  atToolCall: number,
  source: SupervisorVerdict["source"],
): SupervisorVerdict | null {
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;

  const state = typeof o.state === "string" ? o.state.toLowerCase().trim() : "";
  if (!STATES.has(state)) return null;

  const reason =
    typeof o.reason === "string" && o.reason.trim()
      ? clip(o.reason, 300)
      : "The supervisor gave no reason.";
  const nudge =
    typeof o.nudge === "string" && o.nudge.trim() ? clip(o.nudge, 600) : undefined;

  // An "adrift" verdict with nothing to say cannot be acted on — the action is
  // literally "send the nudge" — so it is an "ok" with extra steps.
  if (state === "adrift" && !nudge) {
    return { state: "ok", reason, source, atToolCall };
  }

  const verdict: SupervisorVerdict = {
    state: state as SupervisorState,
    reason,
    source,
    atToolCall,
  };
  if (nudge) verdict.nudge = nudge;
  return verdict;
}

// ---------------------------------------------------------------- the judge

function okVerdict(
  atToolCall: number,
  source: SupervisorVerdict["source"],
  reason: string,
): SupervisorVerdict {
  return { state: "ok", reason, source, atToolCall };
}

/**
 * Ask omp for a verdict. Resolves to raw stdout, or null when the run failed
 * in any way at all — the caller treats null as "ok" and logs.
 *
 * Three things here were established by running the real binary (v17.2.11),
 * not read off `--help`:
 *
 *  - **The prompt goes on stdin.** If stdin is an open pipe omp announces
 *    "Reading prompt from piped stdin (waiting for EOF)" and blocks there
 *    *ignoring any positional message*, which is what `execFile` sets up by
 *    default. That version of this function hung until the timeout on every
 *    single call and, by the fallback below, reported `ok` every time — a
 *    supervisor that was pure theatre. stdin also sidesteps ARG_MAX and stops
 *    an evidence line that happens to start with `-` being read as a flag.
 *  - **Only the model's text reaches stdout.** No banner, no title line, no
 *    ANSI. Progress ("Working...") goes to stderr, so stderr must never be
 *    parsed — it is captured for the failure log and nothing else.
 *  - **`--no-tools` does not change the output shape**, and a bad `--model`
 *    exits non-zero with the reason on stderr.
 */
function runJudge(model: string, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: string | null, why?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (why) console.error(`[supervisor] judge (model ${model}) ${why}: ${clip(err, 400)}`);
      resolve(value);
    };

    try {
      const child = spawn(
        "omp",
        [
          "-p",
          "--no-session",
          "--no-tools",
          "--no-skills",
          "--no-rules",
          "--no-extensions",
          "--model",
          model,
        ],
        {
          // A neutral cwd: the judge must not pick up the repo's rules, and
          // must not trip omp's "started in $HOME" temp-dir switch.
          cwd: agentboxHome(),
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null, "timed out");
      }, JUDGE_TIMEOUT_MS);

      child.stdout?.setEncoding("utf8").on("data", (d: string) => {
        // Bound the buffer: a runaway model must not grow the server's heap.
        if (out.length < 1_000_000) out += d;
      });
      child.stderr?.setEncoding("utf8").on("data", (d: string) => {
        if (err.length < 8_000) err += d;
      });

      // Missing binary, or omp died before reading. Either way: no verdict.
      child.on("error", (e) => finish(null, `failed to run (${e.message})`));
      child.on("close", (code) =>
        code === 0 ? finish(out) : finish(null, `exited ${code}`),
      );

      child.stdin?.on("error", () => {
        // omp exited before reading stdin — a bad --model does exactly this.
        // The `close` handler above reports it; an unhandled EPIPE would take
        // the server down, which is the one thing this module may never do.
      });
      // Ending stdin is the whole point — see the note above.
      child.stdin?.end(prompt);
    } catch (e) {
      finish(null, `could not be spawned (${(e as Error).message})`);
    }
  });
}

/** The transcript lives in the engine, which imports this module; a static
 *  import would close the cycle. Loaded lazily, off the hot path, and only
 *  when a judge run is already about to cost a subprocess. */
async function recentEvents(sessionId: string): Promise<TranscriptEvent[] | null> {
  try {
    // Typed as optional rather than cast, so a drift in the engine's signature
    // is a compile error while a not-yet-written engine still builds.
    const mod: { eventsOf?: (id: string, since?: number) => TranscriptEvent[] } =
      await import("./sessions");
    return mod.eventsOf ? mod.eventsOf(sessionId) : null;
  } catch {
    // The engine is not loaded (tests, or a partially started server). The
    // caller falls back to the tool-call window this module keeps itself.
    return null;
  }
}

export function renderJudgePrompt(
  task: string,
  evidence: Evidence[],
  trigger: string | null,
): string {
  let out = fill(readJudgePrompt(), "{{task}}", clipBlock(task, 2000));
  out = fill(
    out,
    "{{trigger}}",
    trigger
      ? `## What the cheap check noticed\n\n${trigger}\n\nThat is a pattern match, not a conclusion. Confirm it against the log below before acting on it.`
      : "",
  );
  return fill(out, "{{evidence}}", renderEvidence(evidence));
}

// --------------------------------------------------------------- the loop

interface SessionState {
  heur: HeuristicState;
  /** session.toolCalls at the last judge run. */
  lastJudgeAt: number;
  /** A judge is in flight; do not start a second. */
  judging: boolean;
  touchedAt: number;
}

const states = new Map<string, SessionState>();
let lastSweep = 0;

function stateFor(id: string): SessionState {
  let st = states.get(id);
  if (!st) {
    st = { heur: newHeuristicState(), lastJudgeAt: 0, judging: false, touchedAt: 0 };
    states.set(id, st);
  }
  st.touchedAt = Date.now();
  return st;
}

/** Drop a session's counters. Called when a session ends or is deleted; also
 *  reached by the idle sweep, so forgetting to call it leaks bounded memory
 *  for six hours rather than forever. */
export function forgetSession(id: string): void {
  states.delete(id);
}

function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [id, st] of states) {
    if (!st.judging && now - st.touchedAt > IDLE_TTL_MS) states.delete(id);
  }
}

/**
 * Called by the engine after every tool call. Cheap, synchronous, and it never
 * throws — an exception escaping here would surface inside the engine's ACP
 * handler and take the session with it.
 */
export function onToolCall(session: Session, call: ToolCall): void {
  try {
    const settings = getSettings();
    if (!settings.supervisor.enabled) return;

    const st = stateFor(session.id);
    sweep(st.touchedAt);
    foldCall(st.heur, call);

    if (st.judging) return;

    const trigger = checkHeuristics(st.heur);
    const every = Math.max(1, settings.supervisor.everyToolCalls);
    const due = session.toolCalls - st.lastJudgeAt >= every;
    if (!trigger && !due) return;

    st.judging = true;
    st.lastJudgeAt = session.toolCalls;
    void judge(session, st, trigger, settings.supervisor.model).finally(() => {
      st.judging = false;
    });
  } catch (err) {
    // Settings unreadable, state corrupted, anything: the session keeps going.
    console.error(`[supervisor] onToolCall failed for ${session.id}:`, err);
  }
}

async function judge(
  session: Session,
  st: SessionState,
  trigger: string | null,
  model: string,
): Promise<void> {
  const at = session.toolCalls;
  const source: SupervisorVerdict["source"] = trigger ? "heuristic" : "model";
  let verdict: SupervisorVerdict;

  try {
    const events = await recentEvents(session.id);
    const evidence =
      events && events.length > 0 ? evidenceFromEvents(events) : fallbackEvidence(st.heur);
    const raw = await runJudge(model, renderJudgePrompt(session.prompt, evidence, trigger));

    if (raw === null) {
      verdict = okVerdict(at, "model", "The supervisor could not run; assuming ok.");
    } else {
      const parsed = parseVerdict(raw, at, source);
      if (!parsed) {
        console.error(
          `[supervisor] unparseable judge response for ${session.id}: ${clip(raw, 400)}`,
        );
        verdict = okVerdict(at, "model", "The supervisor's answer was unreadable; assuming ok.");
      } else {
        verdict = parsed;
      }
    }
  } catch (err) {
    // Belt and braces around the whole async path. Same rule as onToolCall:
    // there is no supervisor failure that justifies disturbing the session.
    console.error(`[supervisor] judge threw for ${session.id}:`, err);
    verdict = okVerdict(at, "model", "The supervisor errored; assuming ok.");
  }

  if (verdict.state === "spiraling") {
    // The engine is about to interrupt and flag. When a human resumes, the
    // counters that fired must be gone, or the first tool call of the resumed
    // run re-trips the same heuristic and flags it straight back.
    st.heur = newHeuristicState();
    st.lastJudgeAt = session.toolCalls;
  }

  supervisorEvents.emit("verdict", session.id, verdict);
}
