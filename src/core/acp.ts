import { isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import {
  client,
  ndJsonStream,
  ClientContext,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AdvisorySeverity, SubagentProgress, ToolCall, ToolKind, ToolStatus } from "./types";

/** Upper bound on the tool output we put in a transcript event. The full
 *  `rawOutput` object still goes to the session's JSONL log. */
export const MAX_TOOL_OUTPUT = 4000;

/** Calls we keep addressable for late updates. Beyond this the oldest are
 *  evicted; an update for an evicted call is treated as a new one. */
const TRACKED_CALLS = 500;

export interface PermissionInfo {
  id: string;
  title: string;
  tool: string;
  options: { id: string; name: string }[];
}

export interface AcpEvents {
  /** Incremental assistant text. */
  onText: (sessionId: string, text: string) => void;
  /** A tool call was announced. `call.status` is pending or running. */
  onToolStart: (sessionId: string, call: ToolCall) => void;
  /**
   * A still-running tool call moved, and the move is worth a transcript
   * event — today only subagent progress snapshots qualify. Ordinary tool
   * chatter stays off the wire; only the terminal update is recorded.
   */
  onToolUpdate: (sessionId: string, call: ToolCall) => void;
  /** A tool call reached a terminal status. `raw` is ACP's whole rawOutput. */
  onToolEnd: (sessionId: string, call: ToolCall, raw: unknown) => void;
  /** An advisor note, parsed out of a user_message_chunk. */
  onAdvisory: (sessionId: string, severity: AdvisorySeverity, text: string) => void;
  /**
   * A turn finished. stopReason is one of ACP's end_turn/max_tokens/refusal/
   * cancelled — plus `error`, which is agentbox's own and means the prompt
   * request itself failed rather than the model finishing.
   */
  onTurnEnd: (sessionId: string, stopReason: string) => void;
  /**
   * Live context occupancy, from ACP's `usage_update`: `used` is the tokens
   * currently in context and `size` the window. Set, never accumulated —
   * each report replaces the last.
   */
  onContext: (sessionId: string, used: number, size: number) => void;
  /** Cumulative session cost in USD. omp reports it as a running total, and it
   *  survives a resume into a new process, so it is set rather than added. */
  onUsage: (sessionId: string, costUsd: number) => void;
  /** The agent asked for permission and we are not auto-approving. */
  onPermission: (sessionId: string, info: PermissionInfo) => void;
  onError: (sessionId: string, message: string) => void;
  onExit: (sessionId: string, code: number) => void;
}

export interface LaunchOptions {
  worktree: string;
  model: string;
  /**
   * Absolute path to the file passed as `--append-system-prompt`.
   *
   * omp treats a value containing a newline as literal prompt text and
   * otherwise tries to read it as a file — falling back to the raw string
   * *silently* when the read fails. A missing file therefore does not error,
   * it just runs the agent with a path as its system prompt. Hence the
   * assertions in `launch`.
   */
  promptFile: string;
  /** Pass `--advisor`, enabling omp's advisor runtime. */
  advisor: boolean;
  /** Resume this omp conversation instead of opening a new one. */
  resumeSessionId: string | null;
}

// ------------------------------------------------------------ tool calls

const TOOL_KINDS = new Set<ToolKind>([
  "read", "edit", "delete", "move", "execute", "search", "fetch", "think", "other",
]);

function toolKindOf(raw: unknown): ToolKind {
  return typeof raw === "string" && TOOL_KINDS.has(raw as ToolKind) ? (raw as ToolKind) : "other";
}

/** ACP tool status → ours. ACP has no "ok"/"error"; it has completed/failed. */
function toolStatusOf(raw: unknown, fallback: ToolStatus): ToolStatus {
  switch (raw) {
    case "pending": return "pending";
    case "in_progress": return "running";
    case "completed": return "ok";
    case "failed": return "error";
    default: return fallback;
  }
}

function isTerminal(s: ToolStatus): boolean {
  return s === "ok" || s === "error";
}

// ------------------------------------------------------------- subagents

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function subagentStatusOf(raw: unknown): SubagentProgress["status"] {
  return raw === "completed" || raw === "failed" || raw === "running" || raw === "pending"
    ? raw
    : "pending";
}

function recentToolsOf(raw: unknown): SubagentProgress["recentTools"] {
  if (!Array.isArray(raw)) return undefined;
  const out: { tool: string; args?: string }[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.tool !== "string" || !e.tool) continue;
    out.push({ tool: e.tool, args: typeof e.args === "string" ? e.args : undefined });
  }
  return out.length ? out : undefined;
}

/**
 * Pull omp's subagent progress snapshot out of a task/hub tool call's
 * `rawOutput`.
 *
 * omp runs background subagents in-process — they are not separate ACP
 * sessions — and streams their progress as `details.progress[]` on the
 * parent call's partial results. That stream is the only visibility the
 * protocol gives into them, so anything shaped like it is kept whole.
 * Returns undefined when the payload carries no snapshot, which is the
 * common case for every non-subagent tool.
 */
export function subagentsOf(rawOutput: unknown): SubagentProgress[] | undefined {
  if (!rawOutput || typeof rawOutput !== "object") return undefined;
  const details = (rawOutput as Record<string, unknown>).details;
  if (!details || typeof details !== "object") return undefined;
  const progress = (details as Record<string, unknown>).progress;
  if (!Array.isArray(progress) || progress.length === 0) return undefined;

  const subs: SubagentProgress[] = [];
  for (const entry of progress) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    if (!id) continue;
    subs.push({
      id,
      agent: typeof e.agent === "string" && e.agent ? e.agent : "task",
      status: subagentStatusOf(e.status),
      task:
        typeof e.task === "string"
          ? e.task
          : typeof e.assignment === "string"
            ? e.assignment
            : "",
      currentTool: typeof e.currentTool === "string" ? e.currentTool : undefined,
      currentToolArgs: typeof e.currentToolArgs === "string" ? e.currentToolArgs : undefined,
      lastIntent: typeof e.lastIntent === "string" ? e.lastIntent : undefined,
      toolCount: num(e.toolCount),
      tokens: num(e.tokens),
      cost: num(e.cost),
      durationMs: num(e.durationMs),
      recentTools: recentToolsOf(e.recentTools),
    });
  }
  return subs.length ? subs : undefined;
}

function locationsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const loc of raw) {
    const path = (loc as { path?: unknown } | null)?.path;
    if (typeof path === "string" && path) out.push(path);
  }
  return out;
}

/** Pull readable text out of one ACP content block, of any of its shapes. */
function textOfBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  // ToolCallContent wraps a ContentBlock under `content`; diffs and terminals
  // carry no prose, so name them rather than dumping their whole payload.
  if (b.type === "content") return textOfBlock(b.content);
  if (b.type === "diff") return typeof b.path === "string" ? `[diff ${b.path}]` : "[diff]";
  if (b.type === "terminal") return typeof b.terminalId === "string" ? `[terminal ${b.terminalId}]` : "[terminal]";
  if (b.type === "resource_link" && typeof b.uri === "string") return `[${b.uri}]`;
  return "";
}

function textOfContent(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map(textOfBlock).filter(Boolean).join("\n");
  }
  return textOfBlock(content);
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Circular or otherwise unserialisable: the shape is still worth naming.
    return String(value);
  }
}

/**
 * Compact a tool result into something a human can read in a transcript row.
 *
 * omp's `rawOutput` is its internal result object `{content, details,
 * errorMessage}`; `content` is also delivered separately as ACP content
 * blocks, which is the fallback when rawOutput is absent.
 */
export function summarizeToolOutput(rawOutput: unknown, content?: unknown): string | null {
  const parts: string[] = [];
  if (rawOutput && typeof rawOutput === "object") {
    const o = rawOutput as Record<string, unknown>;
    if (typeof o.errorMessage === "string" && o.errorMessage.trim()) parts.push(o.errorMessage.trim());
    const body = textOfContent(o.content);
    if (body.trim()) parts.push(body.trim());
    if (!parts.length && o.details !== undefined && o.details !== null) {
      const details = stringify(o.details);
      if (details && details !== "{}") parts.push(details);
    }
  } else if (typeof rawOutput === "string" && rawOutput.trim()) {
    parts.push(rawOutput.trim());
  }
  if (!parts.length) {
    const body = textOfContent(content);
    if (body.trim()) parts.push(body.trim());
  }
  if (!parts.length) return null;

  const text = parts.join("\n");
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated, ${text.length} chars total]`;
}

/**
 * Assembles ACP's `tool_call` + `tool_call_update` stream into `ToolCall`s,
 * keyed by `toolCallId`.
 *
 * There is no tool *name* on the wire — `title` comes from an `intent` string
 * when the call carries one, so it cannot be parsed back into a name.
 * Consumers classify on `kind` plus the shape of `input`.
 */
export class ToolCallTracker {
  private calls = new Map<string, ToolCall>();

  /** Handle a `tool_call`. Returns null when the payload has no id. */
  start(payload: Record<string, unknown>, now = Date.now()): ToolCall | null {
    const id = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
    if (!id) return null;
    const call: ToolCall = {
      id,
      kind: toolKindOf(payload.kind),
      title: typeof payload.title === "string" && payload.title ? payload.title : "tool call",
      input: payload.rawInput ?? null,
      status: toolStatusOf(payload.status, "pending"),
      locations: locationsOf(payload.locations),
      // Only read `content` once the call is over. On a pending `execute` omp
      // puts the command echo there ("$ ls -1 src"), which is the input wearing
      // the output's clothes.
      output: null,
      subs: subagentsOf(payload.rawOutput),
      startedAt: now,
      endedAt: null,
    };
    if (isTerminal(call.status)) {
      call.endedAt = now;
      call.output = summarizeToolOutput(payload.rawOutput, payload.content);
    } else {
      call.output = summarizeToolOutput(payload.rawOutput);
    }
    this.remember(id, call);
    return call;
  }

  /**
   * Handle a `tool_call_update`. `finished` is true only on the transition
   * into a terminal status, so callers can fire once per call.
   *
   * An update for a call we never saw start is treated as a start: dropping it
   * would lose the only record of that call.
   */
  update(
    payload: Record<string, unknown>,
    now = Date.now()
  ): { call: ToolCall; finished: boolean } | null {
    const id = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
    if (!id) return null;
    const prev = this.calls.get(id);
    if (!prev) {
      const call = this.start(payload, now);
      return call ? { call, finished: isTerminal(call.status) } : null;
    }

    const wasTerminal = isTerminal(prev.status);
    const status = toolStatusOf(payload.status, prev.status);
    const output = summarizeToolOutput(payload.rawOutput, payload.content);
    const locations = locationsOf(payload.locations);
    const subs = subagentsOf(payload.rawOutput);
    const call: ToolCall = {
      ...prev,
      kind: payload.kind === undefined || payload.kind === null ? prev.kind : toolKindOf(payload.kind),
      title: typeof payload.title === "string" && payload.title ? payload.title : prev.title,
      input: payload.rawInput === undefined ? prev.input : payload.rawInput,
      status,
      locations: locations.length ? locations : prev.locations,
      output: output ?? prev.output,
      // A snapshot replaces the last one whole; an update without one leaves
      // the previous snapshot standing rather than erasing the roster.
      subs: subs ?? prev.subs,
      endedAt: isTerminal(status) ? (prev.endedAt ?? now) : prev.endedAt,
    };
    this.remember(id, call);
    return { call, finished: isTerminal(status) && !wasTerminal };
  }

  private remember(id: string, call: ToolCall) {
    this.calls.delete(id);
    this.calls.set(id, call);
    while (this.calls.size > TRACKED_CALLS) {
      const oldest = this.calls.keys().next();
      if (oldest.done) break;
      this.calls.delete(oldest.value);
    }
  }
}

// -------------------------------------------------------------- advisories

const ADVISORY_TAG = /<advisory\b([^>]*)>([\s\S]*?)<\/advisory>/gi;
const SEVERITY_ATTR = /severity\s*=\s*["']?([a-z]+)/i;
const SEVERITIES = new Set<AdvisorySeverity>(["nit", "concern", "blocker"]);

/**
 * Parse omp advisor notes out of a chunk. They arrive as `user_message_chunk`,
 * which otherwise means "the human said this" — so without this they would
 * read as the human talking.
 */
export function parseAdvisories(text: string): { severity: AdvisorySeverity; text: string }[] {
  const out: { severity: AdvisorySeverity; text: string }[] = [];
  for (const m of text.matchAll(ADVISORY_TAG)) {
    const sev = m[1]?.match(SEVERITY_ATTR)?.[1]?.toLowerCase();
    const body = (m[2] ?? "").trim();
    if (!body) continue;
    out.push({
      severity: SEVERITIES.has(sev as AdvisorySeverity) ? (sev as AdvisorySeverity) : "concern",
      text: body,
    });
  }
  return out;
}

// ------------------------------------------------------------------ runner

function approveOption(options: { id: string; name: string }[]) {
  const match = options.find(
    (o) => /allow|approve|accept|yes/i.test(o.name) || /allow|approve/i.test(o.id)
  );
  return (match ?? options[0])?.id ?? "";
}

interface PendingPermission {
  resolve: (approved: boolean) => void;
  info: PermissionInfo;
}

/**
 * One persistent, interactive omp ACP session.
 *
 * A single `omp acp` process serves the whole agentbox session: messages are
 * queued and delivered one turn at a time, the agent can ask for permission
 * (blocking until answered), and turns can be interrupted. The process stays
 * alive between turns, so "waiting" is real.
 */
export class AcpRunner {
  readonly id: string;
  private events: AcpEvents;
  private proc: Bun.Subprocess | null = null;
  private ctx: ClientContext | null = null;
  private ompSessionId: string | null = null;
  private busy = false;
  private queue: string[] = [];
  private pendingPerm: PendingPermission | null = null;
  private autoApprove: () => boolean;
  private closed = false;
  /** `onExit` is a terminal event and consumers act on it; two would take a
   *  relaunched session down as if it had just died. */
  private exitReported = false;
  private tools = new ToolCallTracker();

  constructor(id: string, events: AcpEvents, autoApprove: () => boolean) {
    this.id = id;
    this.events = events;
    this.autoApprove = autoApprove;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  get alive(): boolean {
    return !!this.proc && !this.closed;
  }

  /** The omp conversation this runner is attached to, once it has opened one.
   *  The host reports it so a reconnecting server can tell a launched agent
   *  apart from one still negotiating. */
  get ompSession(): string | null {
    return this.ompSessionId;
  }

  /** Launch `omp acp` and open (or resume) an ACP session. Returns its id. */
  async launch(opts: LaunchOptions): Promise<string> {
    if (this.closed) throw new Error("runner closed");
    if (!isAbsolute(opts.promptFile)) {
      throw new Error(`system prompt path must be absolute, got "${opts.promptFile}"`);
    }
    if (!existsSync(opts.promptFile)) {
      // omp would silently use the path itself as the prompt text.
      throw new Error(`system prompt file is missing: ${opts.promptFile}`);
    }

    const argv = [
      "omp", "acp",
      "--model", opts.model,
      "--append-system-prompt", opts.promptFile,
    ];
    if (opts.advisor) argv.push("--advisor");

    const proc = Bun.spawn(argv, {
      // NOTE: no --session-dir here. omp's ACP session list/resume look up
      // sessions in the default cwd-derived store (~/.omp/agent/sessions/<cwd>/),
      // and each agentbox worktree has a unique cwd, so sessions never collide.
      cwd: opts.worktree,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // AGENTBOX_OMP_SESSION is the conversation id opencode.ai asks for on
      // every request (`x-opencode-session`). agentbox never speaks to them —
      // omp holds the HTTP client — so the id rides in on the environment and
      // ~/.omp/agent/models.yml maps it onto the header for the opencode
      // providers. `this.id` is the agentbox session, which is stable across a
      // relaunch and a resume, so one conversation keeps one id for its life.
      env: { ...process.env, AGENTBOX_OMP_SESSION: this.id },
    });
    this.proc = proc;

    const onErr = this.events.onError;
    const myId = this.id;
    proc.stderr
      ?.pipeTo(
        new WritableStream({
          write(c) {
            const s = Buffer.from(c).toString("utf8").trim();
            if (s) onErr(myId, s);
          },
        })
      )
      .catch((err: unknown) => onErr(myId, `stderr closed: ${messageOf(err)}`));

    proc.exited.then((code) => {
      // Reported even when the exit was our own doing. This used to be guarded
      // by `closed`, which `kill` sets before killing — so a deliberate stop
      // was the one exit nobody was ever told about. That was survivable while
      // the server owned the runner and simply dropped it from a map; it is
      // not now, because a session's host process waits on exactly this to
      // know its work is over, and without it the host outlives its agent.
      this.closed = true;
      this.reportExit(code);
    });

    const output = new WritableStream<Uint8Array>({
      write(chunk) {
        void proc.stdin?.write(chunk);
      },
      close() {
        void proc.stdin?.end();
      },
    });
    const stream = ndJsonStream(output, proc.stdout as ReadableStream<Uint8Array>);

    const app = client({ name: "agentbox" });

    app.onNotification("session/update", async (req: { params: SessionNotification }) => {
      const n = req.params;
      if (this.ompSessionId === n.sessionId) this.handleUpdate(n.update);
    });

    app.onRequest(
      "session/request_permission",
      async (req: { params: RequestPermissionRequest }): Promise<RequestPermissionResponse> => {
        const p = req.params;
        const options = (p.options ?? []).map((o) => ({ id: o.optionId, name: o.name }));
        if (this.autoApprove()) {
          return { outcome: { outcome: "selected", optionId: approveOption(options) } };
        }
        return await new Promise<RequestPermissionResponse>((resolve) => {
          this.pendingPerm = {
            resolve: (approved) =>
              approved
                ? resolve({ outcome: { outcome: "selected", optionId: approveOption(options) } })
                : resolve({ outcome: { outcome: "cancelled" } }),
            info: {
              id: p.toolCall?.toolCallId ?? "perm",
              title: p.toolCall?.title ?? "Permission requested",
              // There is no tool name on the wire; `kind` is the real
              // classification, and repeating the title here would say nothing.
              tool: p.toolCall?.kind ?? "",
              options,
            },
          };
          this.events.onPermission(this.id, this.pendingPerm.info);
        });
      }
    );

    let resolveSid: (s: string) => void;
    let rejectSid: (e: Error) => void;
    const sidP = new Promise<string>((r, j) => {
      resolveSid = r;
      rejectSid = j;
    });

    const connectPromise = app.connectWith(stream, async (ctx: ClientContext) => {
      this.ctx = ctx;
      let sid: string;
      try {
        sid = await this.openSession(ctx, opts.worktree, opts.resumeSessionId);
      } catch (err) {
        rejectSid(new Error(`failed to open omp session: ${messageOf(err)}`));
        throw err;
      }
      this.ompSessionId = sid;
      resolveSid(sid);
      return new Promise<void>(() => {}); // hold the connection open until the process exits
    });
    connectPromise.catch((err: unknown) => {
      if (!this.closed) {
        this.closed = true;
        rejectSid(new Error(messageOf(err)));
        this.events.onError(this.id, messageOf(err));
        this.reportExit(-1);
      }
    });

    return await sidP;
  }

  private async openSession(
    ctx: ClientContext,
    worktree: string,
    resumeSessionId: string | null
  ): Promise<string> {
    if (!resumeSessionId) {
      const res = await ctx.request("session/new", { cwd: worktree, mcpServers: [] });
      return res.sessionId;
    }
    try {
      await ctx.request("session/resume", {
        sessionId: resumeSessionId,
        cwd: worktree,
        mcpServers: [],
      });
    } catch {
      // Older omp builds only implement session/load.
      await ctx.request("session/load", {
        sessionId: resumeSessionId,
        cwd: worktree,
        mcpServers: [],
      });
    }
    // Neither response carries a session id — they only echo modes and config
    // options — so the id we resumed is the id we have.
    return resumeSessionId;
  }

  private handleUpdate(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOfBlock(update.content);
        if (text) this.events.onText(this.id, text);
        break;
      }
      case "agent_thought_chunk":
        // Reasoning, not output. It would read as assistant prose and it is
        // long, so it stays out of the transcript entirely.
        break;
      case "user_message_chunk": {
        // Normally omp echoing back the prompt we just sent, which we already
        // logged. The exception is the advisor, whose notes arrive this way.
        for (const a of parseAdvisories(textOfBlock(update.content))) {
          this.events.onAdvisory(this.id, a.severity, a.text);
        }
        break;
      }
      case "tool_call": {
        const call = this.tools.start(update as unknown as Record<string, unknown>);
        if (call) {
          this.events.onToolStart(this.id, call);
          // A call can arrive already finished when the tool was instantaneous.
          if (call.endedAt !== null) this.events.onToolEnd(this.id, call, update.rawOutput);
        }
        break;
      }
      case "tool_call_update": {
        const res = this.tools.update(update as unknown as Record<string, unknown>);
        if (res?.finished) this.events.onToolEnd(this.id, res.call, update.rawOutput);
        // A mid-flight move that carries a subagent snapshot is the one kind
        // of progress worth a transcript event — it is how a human watches a
        // fan-out live. Everything else waits for its terminal update.
        else if (res && res.call.subs) this.events.onToolUpdate(this.id, res.call);
        break;
      }
      case "usage_update": {
        // `used` is the tokens currently in context and `size` the window —
        // exactly what a context meter should show, unlike the turn's billed
        // totals. Cost stays cumulative.
        this.events.onContext(this.id, update.used, update.size);
        if (update.cost) this.events.onUsage(this.id, update.cost.amount);
        break;
      }
      default:
        // plan/mode/config updates carry nothing agentbox shows.
        break;
    }
  }

  /** Queue a message. Delivered immediately when idle, else at the next turn. */
  send(text: string) {
    if (this.closed || !this.ctx || !this.ompSessionId) throw new Error("session is not connected");
    this.queue.push(text);
    this.pump();
  }

  private pump() {
    if (this.busy || this.closed || !this.ctx || !this.ompSessionId) return;
    const text = this.queue.shift();
    if (text === undefined) return;
    this.busy = true;
    this.ctx
      .request("session/prompt", {
        sessionId: this.ompSessionId,
        prompt: [{ type: "text", text }],
      })
      .then((res) => {
        // The turn is done. stopReason is authoritative even when updates raced ahead.
        this.busy = false;
        this.events.onTurnEnd(this.id, res.stopReason);
        this.pump();
      })
      .catch((err: unknown) => {
        this.busy = false;
        this.events.onError(this.id, messageOf(err));
        // A rejected prompt request is still a turn boundary. Without this the
        // session row stays `running` forever — busy is false, the runner is
        // idle, and nothing ever says the turn is over. `error` is not an ACP
        // stopReason; it is ours, and consumers treat it as an abnormal end.
        this.events.onTurnEnd(this.id, "error");
        this.pump();
      });
  }

  /** Interrupt the current turn. Queue survives; the turn stops with `cancelled`. */
  interrupt() {
    if (!this.ctx || !this.ompSessionId) return;
    if (this.pendingPerm) {
      const p = this.pendingPerm;
      this.pendingPerm = null;
      p.resolve(false);
    }
    void this.ctx
      .notify("session/cancel", { sessionId: this.ompSessionId })
      .catch((err: unknown) => this.events.onError(this.id, `cancel failed: ${messageOf(err)}`));
  }

  /** Reply to a surfaced permission request. */
  replyPermission(id: string, approved: boolean) {
    if (!this.pendingPerm || this.pendingPerm.info.id !== id) return;
    const p = this.pendingPerm;
    this.pendingPerm = null;
    p.resolve(approved);
  }

  get hasPendingPermission(): boolean {
    return !!this.pendingPerm;
  }

  get permission(): PermissionInfo | null {
    return this.pendingPerm?.info ?? null;
  }

  /** An exit is announced once, whichever path notices it first. */
  private reportExit(code: number) {
    if (this.exitReported) return;
    this.exitReported = true;
    this.events.onExit(this.id, code);
  }

  /** Stop the omp process. The conversation survives via its omp session id. */
  kill() {
    this.closed = true;
    try {
      this.proc?.kill();
    } catch (err) {
      this.events.onError(this.id, `kill failed: ${messageOf(err)}`);
    }
  }
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
