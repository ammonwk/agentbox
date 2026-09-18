/** omp's own session directory, read back as the record of a fan-out.
 *
 * omp runs `hub` subagents in-process and streams their progress on the
 * parent's `tool_call_update`s. That stream is real-time and it is the only
 * thing agentbox used to have — which made the roster a cache of the last
 * frame the parent's turn happened to carry. Between turns omp sends nothing,
 * so a fan-out that ran for ten hours after its parent went idle was still
 * drawn as "32 running" the next morning: the last frame, replayed as if it
 * were current.
 *
 * The stream is not the record. omp writes one directory per session under
 * `~/.omp/agent/sessions/<slug>/<stamp>_<ompSessionId>/`, and inside it every
 * subagent gets its own pair of files:
 *
 *   Gnc5199.jsonl   the agent's whole life — every message, every tool call
 *                   with its arguments, usage per request, and a trailing
 *                   `session_exit` when it is over.
 *   Gnc5199.md      the report it finished with. Written at yield, so its
 *                   existence is the fact that it answered.
 *
 * A subagent that dispatches subagents of its own gets a directory named after
 * it holding `<parent>.<child>.jsonl` — the tree the progress stream cannot
 * describe at all, because omp only reports one level to its client.
 *
 * So this module reads that record. It is the primary source for anything
 * terminal — did it finish, when, with what — and it keeps working when the
 * stream cannot: after the turn ends, after the host exits, after the server
 * is restarted, and for a session whose worktree has since been reclaimed.
 * The live stream still wins for a *running* agent, which is the one question
 * a file on disk answers slowly; see `roster.ts` for how the two are merged.
 *
 * Nothing here writes. The directory belongs to omp.
 */

import { existsSync, openSync, closeSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * omp's data root.
 *
 * `AGENTBOX_OMP_HOME` is ours — it exists so tests can point this at a
 * fixture without a real omp install. `OMP_HOME` is read too on the chance the
 * user has relocated omp itself; agentbox does not otherwise know omp's
 * configuration, and guessing further would be pretending to.
 */
export function ompHome(): string {
  return process.env.AGENTBOX_OMP_HOME ?? process.env.OMP_HOME ?? join(homedir(), ".omp");
}

function ompSessionsRoot(): string {
  return join(ompHome(), "agent", "sessions");
}

/**
 * omp's directory name for a working directory: the path with `/` turned into
 * `-`, and the user's home stripped first, so
 * `~/.local/share/agentbox/worktrees/<id>` becomes
 * `-.local-share-agentbox-worktrees-<id>`.
 *
 * Built forwards only. The mapping is lossy — a directory whose own name
 * contains `-` is indistinguishable from a path separator — so it is never
 * inverted, and a miss falls back to searching for the session id, which is
 * unique.
 */
export function ompSlugFor(cwd: string): string {
  const home = homedir();
  const rel = cwd === home ? "" : cwd.startsWith(`${home}/`) ? cwd.slice(home.length) : cwd;
  return rel.replace(/\//g, "-");
}

/**
 * The directory omp kept for one agentbox session, or null when there is none
 * to read — no omp session id yet, omp's home relocated, or a session old
 * enough that omp has since pruned it.
 *
 * Tries the slug first because that is one `readdir` in the common case. The
 * fallback scan exists for the uncommon ones: a session whose worktree moved,
 * or a cwd whose slug we would derive differently from omp. It is bounded by
 * the number of directories omp has ever written, and it only runs when the
 * cheap path missed.
 */
export function ompSessionDir(cwd: string | null, ompSessionId: string | null): string | null {
  if (!ompSessionId) return null;
  const root = ompSessionsRoot();
  if (!existsSync(root)) return null;

  const suffix = `_${ompSessionId}`;
  const inDir = (parent: string): string | null => {
    let entries: string[];
    try {
      entries = readdirSync(parent);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.endsWith(suffix));
    return hit ? join(parent, hit) : null;
  };

  if (cwd) {
    const direct = inDir(join(root, ompSlugFor(cwd)));
    if (direct) return direct;
  }

  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const hit = inDir(join(root, slug));
    if (hit) return hit;
  }
  return null;
}

/** What omp's files say about one subagent. Terminal facts only — a running
 *  agent is described by the progress stream, which is fresher. */
export interface HubAgent {
  /** The subagent's name, as the dispatching agent chose it. Unique per run. */
  name: string;
  /** The subagent that dispatched this one, for agents omp nested a level
   *  deeper. Null for the ones the board's own agent dispatched. */
  parent: string | null;
  /**
   * `running` here means "omp has not recorded an end", not "a process is
   * definitely alive" — a host killed mid-fan-out leaves logs that stop
   * without an exit line. Callers that know the parent is gone should say
   * "last seen" rather than "running"; `lastActivityAt` is what they show.
   */
  status: "running" | "completed" | "failed";
  startedAt: number | null;
  /** When omp recorded the session's exit, or null while it is open. */
  endedAt: number | null;
  /** Last write to either of the agent's files. */
  lastActivityAt: number;
  /** A report file exists — the agent answered rather than being disposed of
   *  mid-thought. A `completed` agent without one ended without saying
   *  anything, which is worth showing and is not the same as success. */
  hasResult: boolean;
  /** Bytes of the agent's log. The cheap proxy for "how much did it do", and
   *  what tells a drilldown whether reading the whole thing is reasonable. */
  logBytes: number;
  /**
   * Tool calls and peak context, counted from the log — present only on a
   * deep scan.
   *
   * The live stream carries both, but it stops when the parent's turn does,
   * so for a subagent that went on working they are whatever it had reached
   * by then. One real fan-out left the roster saying 12 tools and 78.8k
   * tokens for an agent that finished with 121 and 171.1k, which is the kind
   * of disagreement that makes a reader stop believing either number.
   */
  toolCount?: number;
  tokens?: number;
}

export interface ScanOptions {
  /**
   * Count each agent's tool calls and peak context by reading its whole log.
   *
   * Byte-level — no JSON parsing — so it is far cheaper than it sounds: 58 MB
   * across 49 subagents takes about a quarter of a second. Still not free, so
   * it belongs at a turn boundary rather than on a path a browser can hit.
   */
  deep?: boolean;
}

/** Files that are not an agent's log: omp's per-tool output captures
 *  (`1203.bash.log`, `0.read.log`) and its `local/` scratch directory. */
function isAgentLog(name: string): boolean {
  return name.endsWith(".jsonl") && !/^\d/.test(name);
}

/**
 * Every subagent omp recorded for one session, parents before children.
 *
 * Costs two `stat`s and two small reads per agent — the head of the log for
 * its start, the tail for its exit — so scanning a fifty-way fan-out is
 * cheap enough to do on every turn boundary. Nothing here parses a whole log;
 * that is `readHubAgent`, and only when a human asks for one.
 */
export function scanHubAgents(
  dir: string | null,
  opts: ScanOptions = {},
  depth = 0,
  parent: string | null = null,
): HubAgent[] {
  if (!dir || depth > 3 || !existsSync(dir)) return [];
  let entries: { name: string; dir: boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
    }));
  } catch {
    return [];
  }

  const out: HubAgent[] = [];
  for (const e of entries) {
    if (e.dir || !isAgentLog(e.name)) continue;
    const base = e.name.slice(0, -".jsonl".length);
    // A nested agent's files are prefixed with the whole chain
    // (`Pr4141.Wave4Audit.jsonl`); the last segment is its own name.
    const name = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
    const agent = describeAgent(dir, base, name, parent, opts);
    if (agent) out.push(agent);
  }
  out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  // Children live in a directory named after the agent that dispatched them.
  for (const e of entries) {
    if (!e.dir || e.name === "local") continue;
    out.push(...scanHubAgents(join(dir, e.name), opts, depth + 1, e.name));
  }
  return out;
}

function describeAgent(
  dir: string,
  base: string,
  name: string,
  parent: string | null,
  opts: ScanOptions = {},
): HubAgent | null {
  const logPath = join(dir, `${base}.jsonl`);
  let log: ReturnType<typeof statSync>;
  try {
    log = statSync(logPath);
  } catch {
    return null;
  }

  let resultAt = 0;
  let hasResult = false;
  try {
    resultAt = statSync(join(dir, `${base}.md`)).mtimeMs;
    hasResult = true;
  } catch {
    // No report: still running, or disposed of before it yielded one.
  }

  const exit = exitOf(logPath, log.size);
  const failed = hasResult && resultIsFailure(readResult(dir, base));
  const counted = opts.deep ? countWork(logPath) : null;
  return {
    name,
    parent,
    status: failed ? "failed" : exit !== null || hasResult ? "completed" : "running",
    startedAt: startOf(logPath),
    endedAt: exit,
    lastActivityAt: Math.max(log.mtimeMs, resultAt),
    hasResult,
    logBytes: log.size,
    ...(counted ?? {}),
  };
}

/**
 * How much work an agent's log records, counted without parsing it.
 *
 * Tool calls are occurrences of omp's `tool_execution_start` marker, and
 * context is the largest `totalTokens` any request reported — the same peak
 * `readHubAgent` computes from the parsed log, reached here by scanning bytes.
 * A chunk boundary can land in the middle of either, so each read carries the
 * tail of the last one forward.
 */
function countWork(path: string): { toolCount: number; tokens: number } {
  const TOOL = '"tool_execution_start"';
  const TOKENS = /"totalTokens":(\d+)/g;
  // Enough that neither marker can be cut in half by a chunk boundary.
  const OVERLAP = 64;

  let toolCount = 0;
  let tokens = 0;
  // Absolute offset just past the last marker counted. Chunks are read with an
  // overlap so a marker straddling the seam is still found whole, which means
  // the next chunk re-reads bytes already scanned — counting by position is
  // what keeps a marker inside that overlap from being counted twice.
  let countedTo = -1;
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const chunk = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(chunk);
    let pos = 0;
    let carry = "";
    while (pos < size) {
      const read = readSync(fd, buf, 0, chunk, pos);
      if (read <= 0) break;
      const base = pos - Buffer.byteLength(carry, "utf8");
      pos += read;
      const text = carry + buf.subarray(0, read).toString("utf8");

      let at = text.indexOf(TOOL);
      while (at !== -1) {
        const absolute = base + at;
        if (absolute > countedTo) {
          toolCount++;
          countedTo = absolute;
        }
        at = text.indexOf(TOOL, at + TOOL.length);
      }

      // A maximum, so re-reading the overlap cannot inflate it.
      TOKENS.lastIndex = 0;
      for (const m of text.matchAll(TOKENS)) {
        const n = Number(m[1]);
        if (n > tokens) tokens = n;
      }
      carry = text.slice(-OVERLAP);
    }
  } catch {
    // An unreadable log is a count we do not have, not a zero we assert.
    return { toolCount: 0, tokens: 0 };
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return { toolCount, tokens };
}

/** Everything one subagent's log can say, for the drilldown. */
export interface HubAgentDetail extends HubAgent {
  /** The assignment, from omp's own session header when it wrote one and from
   *  the first message it sent the subagent otherwise. */
  task: string | null;
  /** The subagent type omp ran it as. */
  agentType: string | null;
  model: string | null;
  /** Its report, verbatim. This is the primary source for the result — the
   *  parent's `agent://` read is a copy, and only exists if it collected. */
  result: string | null;
  /** Peak context occupancy across its requests, and total billed cost. */
  tokens: number;
  cost: number;
  toolCount: number;
  steps: HubStep[];
  /** True when the log was too large to parse and `steps` is empty. */
  truncated: boolean;
}

/** One thing the subagent did: a tool call, or something it said. */
export interface HubStep {
  ts: number;
  kind: "tool" | "text";
  /** Tool steps: omp's tool name, its intent line, and a one-line argument. */
  tool?: string;
  intent?: string;
  args?: string;
  /** What the tool returned, clipped. omp logs the result as its own message
   *  carrying the call id, so this is the real output rather than a summary. */
  output?: string;
  /** Text steps: what the agent said, clipped. */
  text?: string;
}

/** Steps kept for one drilldown. A long agent is exactly the one that would
 *  otherwise hand a browser tens of thousands of rows. */
const MAX_STEPS = 2_000;
/** Logs past this are not parsed. Nothing observed comes close (the largest
 *  seen is 4 MB); the guard is here so a pathological one cannot stall the
 *  server that reads it. */
const MAX_LOG_BYTES = 128 * 1024 * 1024;

/**
 * One subagent's whole history, parsed from omp's log.
 *
 * This replaces reconstructing a timeline from the `recentTools` fragments the
 * progress stream carried. Those were a sample — the k newest tool names at
 * each snapshot, with no arguments for half of them — and the reconstruction
 * silently lost every call that happened between two frames. The log has all
 * of them, with arguments and intents, because it is what omp actually wrote
 * down rather than what it found room to mention.
 */
export function readHubAgent(dir: string | null, name: string): HubAgentDetail | null {
  if (!dir) return null;
  const found = findAgentFile(dir, name);
  if (!found) return null;
  const { dir: agentDir, base, parent } = found;
  const head = describeAgent(agentDir, base, name, parent);
  if (!head) return null;

  const detail: HubAgentDetail = {
    ...head,
    task: null,
    agentType: null,
    model: null,
    result: readResult(agentDir, base),
    tokens: 0,
    cost: 0,
    toolCount: 0,
    steps: [],
    truncated: head.logBytes > MAX_LOG_BYTES,
  };
  if (detail.truncated) return detail;

  let text: string;
  try {
    text = readFileText(join(agentDir, `${base}.jsonl`));
  } catch {
    return detail;
  }

  let dropped = 0;
  /** Tool call id → the step it produced, so a result can be attached to the
   *  call that asked for it rather than appended as a row of its own. */
  const awaiting = new Map<string, HubStep>();

  for (const line of linesOf(text)) {
    const e = parseLine(line);
    if (!e) continue;

    if (e.type === "model_change" && typeof e.model === "string") {
      detail.model = e.model;
      continue;
    }

    // omp's own header for the agent: the assignment it was given and the
    // subagent type it was run as. Preferred over reading the first message,
    // which is the same text wrapped in a prompt.
    if (e.type === "session_init") {
      if (typeof e.task === "string" && e.task.trim()) detail.task = e.task;
      if (typeof e.agent === "string" && e.agent) detail.agentType = e.agent;
      if (typeof e.resolvedModel === "string" && !detail.model) detail.model = e.resolvedModel;
      continue;
    }

    if (e.customType === "tool_execution_start") {
      detail.toolCount++;
      const data = (e.data ?? {}) as {
        toolName?: unknown;
        intent?: unknown;
        args?: unknown;
        toolCallId?: unknown;
      };
      const step: HubStep = {
        ts: tsOf(e.timestamp) ?? 0,
        kind: "tool",
        tool: typeof data.toolName === "string" ? data.toolName : "tool",
        intent: typeof data.intent === "string" ? data.intent : undefined,
        args: oneLineArgs(data.args),
      };
      if (push(detail, step)) {
        if (typeof data.toolCallId === "string") awaiting.set(data.toolCallId, step);
      } else {
        dropped++;
      }
      continue;
    }

    if (e.type !== "message") continue;
    const msg = e.message as
      | { role?: unknown; content?: unknown; model?: unknown; usage?: unknown; toolCallId?: unknown }
      | undefined;
    if (!msg) continue;

    if (msg.role === "toolResult") {
      const step = typeof msg.toolCallId === "string" ? awaiting.get(msg.toolCallId) : undefined;
      if (step) {
        step.output = clip(textOfContent(msg.content), 600);
        awaiting.delete(msg.toolCallId as string);
      }
      continue;
    }

    if (typeof msg.model === "string" && !detail.model) detail.model = msg.model;
    const usage = msg.usage as { totalTokens?: unknown; cost?: { total?: unknown } } | undefined;
    if (usage) {
      // Peak occupancy rather than a sum: `totalTokens` is one request's whole
      // window, so adding them up would report a 20k-token agent that made
      // forty calls as having held 800k.
      if (typeof usage.totalTokens === "number") {
        detail.tokens = Math.max(detail.tokens, usage.totalTokens);
      }
      if (typeof usage.cost?.total === "number") detail.cost += usage.cost.total;
    }

    // The first thing omp says to a subagent is its assignment.
    if (msg.role === "user" && detail.task === null) {
      const text = textOfContent(msg.content);
      if (text) detail.task = text;
      continue;
    }
    if (msg.role !== "assistant") continue;
    const said = textOfContent(msg.content);
    if (said && !push(detail, { ts: tsOf(e.timestamp) ?? 0, kind: "text", text: clip(said, 2_000) })) {
      dropped++;
    }
  }

  if (dropped > 0) detail.truncated = true;
  return detail;
}

/** Keep the step unless the timeline is already at its cap. Returns whether
 *  it was kept, so the caller can count what it lost. */
function push(detail: HubAgentDetail, step: HubStep): boolean {
  if (detail.steps.length >= MAX_STEPS) return false;
  detail.steps.push(step);
  return true;
}

/** The readable text of an omp content array, ignoring reasoning and tool
 *  blocks — those are shown as steps of their own or not at all. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) parts.push(b.text);
  }
  return parts.join("").trim();
}

/**
 * A tool's arguments as one line.
 *
 * The two that matter are named explicitly: a shell call is its command and a
 * read is its path, and burying either inside a JSON blob is how a timeline
 * becomes unreadable. Everything else is compacted rather than dropped —
 * an unfamiliar tool is exactly the one whose arguments a reader needs.
 */
function oneLineArgs(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const args = raw as Record<string, unknown>;
  for (const key of ["command", "path", "pattern", "url", "filePath"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return clip(v, 300);
  }
  // `i` is omp's own intent echo, already carried on the step.
  const rest = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "i"));
  if (Object.keys(rest).length === 0) return undefined;
  try {
    return clip(JSON.stringify(rest), 300);
  } catch {
    return undefined;
  }
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/** Where an agent's files live, given only its name: the session directory
 *  for a top-level agent, a subdirectory for a nested one. */
function findAgentFile(
  dir: string,
  name: string,
): { dir: string; base: string; parent: string | null } | null {
  let entries: { name: string; dir: boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
    }));
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.dir || !isAgentLog(e.name)) continue;
    const base = e.name.slice(0, -".jsonl".length);
    const own = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : base;
    if (own === name) return { dir, base, parent: null };
  }
  for (const e of entries) {
    if (!e.dir || e.name === "local") continue;
    const nested = findAgentFile(join(dir, e.name), name);
    if (nested) return { ...nested, parent: e.name };
  }
  return null;
}

// ------------------------------------------------------------ log reading

/** The agent's report, or null when it has not written one. */
function readResult(dir: string, base: string): string | null {
  const path = join(dir, `${base}.md`);
  try {
    if (!existsSync(path)) return null;
    return readFileText(path);
  } catch {
    return null;
  }
}

/**
 * Whether a report describes a failure.
 *
 * omp's reports are free text when the agent simply answered and JSON when it
 * was told to answer in a schema, so this only claims failure on the two
 * machine-readable markers omp itself writes — an `aborted` flag and a
 * non-empty `error`. Anything else is a report, and a report is an answer even
 * when its content is bad news.
 */
function resultIsFailure(result: string | null): boolean {
  if (!result) return false;
  const trimmed = result.trim();
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as { aborted?: unknown; error?: unknown };
    if (parsed.aborted === true) return true;
    return typeof parsed.error === "string" && parsed.error.trim().length > 0;
  } catch {
    return false;
  }
}

/** The `session` line omp writes first carries the start time. */
function startOf(path: string): number | null {
  for (const line of linesOf(headText(path, 8 * 1024))) {
    const e = parseLine(line);
    if (!e) continue;
    if (e.type === "session" || e.type === "title") {
      const ts = tsOf(e.timestamp);
      if (ts !== null) return ts;
    }
  }
  return null;
}

/**
 * When omp recorded the session ending, or null while it is still open.
 *
 * Read from the tail rather than by scanning: the exit line is last and small,
 * and these logs run to megabytes. A tail window can begin mid-line, which is
 * why unparseable lines are skipped rather than trusted.
 */
function exitOf(path: string, size: number): number | null {
  const lines = linesOf(tailText(path, size, 16 * 1024));
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parseLine(lines[i]!);
    if (e?.customType !== "session_exit") continue;
    const data = e.data as { recordedAt?: unknown } | undefined;
    return tsOf(data?.recordedAt) ?? tsOf(e.timestamp) ?? null;
  }
  return null;
}

interface OmpLine {
  type?: string;
  customType?: string;
  timestamp?: unknown;
  data?: unknown;
  [k: string]: unknown;
}

function parseLine(line: string): OmpLine | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as OmpLine;
  } catch {
    return null;
  }
}

function linesOf(text: string): string[] {
  return text.length ? text.split("\n") : [];
}

/** omp writes ISO strings in its envelope and epoch millis inside messages. */
function tsOf(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function readFileText(path: string): string {
  const size = statSync(path).size;
  return readRange(path, 0, size);
}

function headText(path: string, bytes: number): string {
  try {
    return readRange(path, 0, Math.min(bytes, statSync(path).size));
  } catch {
    return "";
  }
}

function tailText(path: string, size: number, bytes: number): string {
  const from = Math.max(0, size - bytes);
  try {
    return readRange(path, from, size - from);
  } catch {
    return "";
  }
}

function readRange(path: string, from: number, length: number): string {
  if (length <= 0) return "";
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
