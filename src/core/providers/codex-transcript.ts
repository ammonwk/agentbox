/** Codex rollout format: the facts fold and the timeline projection.
 *
 * Pure — no filesystem. Shapes read off real rollouts written by codex-cli
 * 0.149–0.156. A rollout line is `{timestamp, ordinal?, type, payload}` where
 * `type` is one of:
 *
 *   session_meta        who this thread is (always record 0; see below)
 *   turn_context        per-turn settings: cwd, model, approval policy
 *   response_item       the model-visible history: message (user/assistant/
 *                       developer), reasoning, function_call(+_output),
 *                       custom_tool_call(+_output), web_search_call,
 *                       tool_search_call(+_output), agent_message, …
 *   event_msg           UI events: task_started/complete, turn_aborted,
 *                       token_count, item_completed (a cleaner duplicate of
 *                       the response items), thread_goal_updated, …
 *   compacted           the replacement history after a compaction
 *   token_usage_record, world_state, inter_agent_communication_metadata
 *
 * The timeline is built from response items only; `item_completed` repeats
 * them and would show everything twice.
 */

import { addUsage, emptyTotals } from "../pricing";
import type { TimelineEvent, TokenTotals, UsageWindow, WindowKind } from "../types";
import { PrRepoFold } from "../prrepo";
import { oneLine, tidyPath } from "./claude-transcript";
import { cap, capJson, INPUT_CAP, OUTPUT_CAP, type Piece, type ToolEvent, type TranscriptFormat } from "./jsonl-reader";
import { isAgentSent, type TranscriptFacts, type TranscriptRef } from "./types";

const ms = (t: unknown): number | null => {
  if (typeof t !== "string") return null;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
};

// ------------------------------------------------------------- lineage

export interface CodexLineage {
  id: string | null;
  cwd: string | null;
  startedAt: number | null;
  /** "cli" (the TUI), "exec", "vscode", or a subagent object flattened to "subagent". */
  source: string | null;
  originator: string | null;
  isSubagent: boolean;
  parentId: string | null;
  /** Records before this ordinal were copied from the parent (a forked
   *  subagent starts with its parent's history). */
  inheritedBefore: number;
}

/**
 * What a rollout is, from record 0. A subagent's rollout sits beside its
 * parent's with nothing in the filename to tell them apart; record 0 says
 * `thread_source: "subagent"` and `source.subagent.thread_spawn.parent_thread_id`.
 * Other `source.subagent` kinds (`{"other":"guardian"}`, review, compact) are
 * helper threads with no user-visible parent link.
 */
export function codexLineage(first: any): CodexLineage {
  const p = first?.type === "session_meta" ? (first.payload ?? {}) : {};
  const sub = p.source && typeof p.source === "object" ? p.source.subagent : undefined;
  const spawn = sub?.thread_spawn;
  const isSubagent = p.thread_source === "subagent" || sub !== undefined;
  return {
    id: typeof p.id === "string" ? p.id : null,
    cwd: typeof p.cwd === "string" ? p.cwd : null,
    startedAt: ms(p.timestamp) ?? ms(first?.timestamp),
    source: typeof p.source === "string" ? p.source : sub !== undefined ? "subagent" : null,
    originator: typeof p.originator === "string" ? p.originator : null,
    isSubagent,
    parentId: isSubagent ? (spawn?.parent_thread_id ?? p.parent_thread_id ?? null) : null,
    inheritedBefore: typeof p.subagent_history_start_ordinal === "number" ? p.subagent_history_start_ordinal : -1,
  };
}

// ------------------------------------------------------------- user text

/**
 * Codex sends a lot to the model as `role: "user"` that you never typed: the
 * AGENTS.md body, <environment_context>, <recommended_plugins>, a <skill> body
 * after `$skill`, <turn_aborted>, <subagent_notification>, <goal_context>,
 * <codex_internal_context>. A prompt with an image is
 * `[<image name=…>, input_image, </image>, your text]` — the wrappers go, the
 * text stays.
 */
const INJECTED_PREFIX = /^\s*(# AGENTS\.md instructions|<(environment_context|user_instructions|INSTRUCTIONS|codex_internal_context|recommended_plugins|goal_context|skill|turn_aborted|subagent_notification|permissions instructions|apps_instructions|collaboration_mode|model_switch|persistent_mode|user_shell_command)\b)/;
/** A message that is one tag block and nothing else is an injection too, even
 *  for tags not listed above. */
const WHOLE_TAG = /^\s*<([A-Za-z_][\w-]*)\b[^>]*>[\s\S]*<\/\1>\s*$/;

export function codexUserPrompt(content: unknown): { text: string; images: number } | null {
  if (!Array.isArray(content)) return null;
  let images = 0;
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "input_image") images++;
    else if ((b?.type === "input_text" || b?.type === "text") && typeof b.text === "string") {
      if (/^\s*<image\b[^>]*>\s*$/.test(b.text) || /^\s*<\/image>\s*$/.test(b.text)) continue;
      parts.push(b.text);
    }
  }
  const text = parts.join("\n").trim();
  if (!text && !images) return null;
  if (text && (INJECTED_PREFIX.test(text) || WHOLE_TAG.test(text))) return null;
  return { text, images };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

// ------------------------------------------------------------- usage

/**
 * `rate_limits` on a token_count event: `{limit_id, limit_name, primary,
 * secondary, plan_type, rate_limit_reached_type, credits}`, each window
 * `{used_percent, window_minutes, resets_at (unix s)}`. `limit_id` "codex" is
 * the account's own limit; others (e.g. "codex_bengalfox", limit_name
 * "GPT-5.3-Codex-Spark") are per-model limits.
 */
export function codexWindows(rl: any): UsageWindow[] {
  if (!rl || typeof rl !== "object") return [];
  const limitId = typeof rl.limit_id === "string" ? rl.limit_id : "codex";
  const scoped = limitId !== "codex";
  const out: UsageWindow[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w || typeof w.used_percent !== "number") continue;
    const minutes = typeof w.window_minutes === "number" ? w.window_minutes : 0;
    const { id, kind, label } = windowShape(minutes);
    const scopeName = typeof rl.limit_name === "string" && rl.limit_name ? rl.limit_name : limitId;
    const win: UsageWindow = {
      id: scoped ? `${id}:${limitId}` : id,
      kind,
      label: scoped ? `${label} · ${scopeName}` : label,
      usedPct: w.used_percent,
      resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : null,
      windowMs: minutes * 60_000,
    };
    if (scoped) win.scope = { model: scopeName };
    out.push(win);
  }
  return out;
}

function windowShape(minutes: number): { id: string; kind: WindowKind; label: string } {
  if (minutes === 300) return { id: "five_hour", kind: "short", label: "5-hour" };
  if (minutes === 10080) return { id: "weekly", kind: "weekly", label: "Weekly" };
  if (minutes === 1440) return { id: "daily", kind: "daily", label: "Daily" };
  const kind: WindowKind = minutes <= 360 ? "short" : minutes <= 2160 ? "daily" : minutes <= 15120 ? "weekly" : "monthly";
  const label = minutes < 120 ? `${minutes}-minute` : minutes < 2880 ? `${Math.round(minutes / 60)}-hour` : `${Math.round(minutes / 1440)}-day`;
  return { id: `${minutes}m`, kind, label };
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Codex's usage counts overlap: `cached_input_tokens` (and
 * `cache_write_input_tokens`) are part of `input_tokens`, and
 * `reasoning_output_tokens` is part of `output_tokens` (138 of 204 in a typical
 * record). TokenTotals keeps them disjoint, so input is what is left.
 */
export function codexUsage(u: any): Usage {
  const cacheRead = u?.cached_input_tokens ?? 0;
  const cacheWrite = u?.cache_write_input_tokens ?? 0;
  return {
    input: Math.max(0, (u?.input_tokens ?? 0) - cacheRead - cacheWrite),
    output: u?.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
  };
}

// ------------------------------------------------------------- the fold

/**
 * A turn refused because the account is out of usage. Since 0.155 codex puts
 * it on the turn's end: `task_complete.error = {message: "You've hit your
 * usage limit. Visit https://chatgpt.com/codex/settings/usage … try again at
 * Sep 26th, 2026 9:14 AM.", codex_error_info: "usage_limit_exceeded"}`; older
 * versions sent an `error` event with the same text. A per-minute API
 * "Rate limit reached for <model> … (TPM)" is transient and not counted.
 */
export function isUsageLimit(e: any): boolean {
  if (!e || typeof e !== "object") return false;
  if (JSON.stringify(e.codex_error_info ?? "").includes("usage_limit")) return true;
  return /hit your usage limit|usage limit (reached|exceeded)/i.test(String(e.message ?? ""));
}

const MAX_HITS = 200;
const PROMPT_CAP = 2000;

export class CodexFold {
  private lineage: CodexLineage | null = null;
  private cwd: string | null = null;
  private model: string | null = null;
  private gitBranch: string | null = null;
  private firstPrompt: string | null = null;
  private lastPrompt: string | null = null;
  private lastPromptAt: number | null = null;
  private lastMessage: string | null = null;
  private prRepo = new PrRepoFold();
  private startedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private turnOpen = false;
  private contextUsed: number | null = null;
  private contextLimit: number | null = null;
  private tokens: TokenTotals = emptyTotals();
  /** The cumulative usage as last reported, and what earlier process lives
   *  had already reported: `total_token_usage` restarts when a session is
   *  resumed in a new process, and those totals must add, not replace. */
  private reported: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private windows = new Map<string, UsageWindow[]>();
  private usageAt: number | null = null;
  private limited = false;
  private hits: { at: number; detail: string }[] = [];

  constructor(
    private readonly ref: Pick<TranscriptRef, "agentSessionId">,
    private readonly titleOf: () => string | null = () => null,
  ) {}

  get inheritedBefore(): number {
    return this.lineage?.inheritedBefore ?? -1;
  }

  reset(): void {
    Object.assign(this, new CodexFold(this.ref, this.titleOf));
  }

  /** Records a forked subagent copied from its parent, which are not its own. */
  isInherited(r: any, index: number): boolean {
    return index > 0 && typeof r?.ordinal === "number" && r.ordinal < this.inheritedBefore;
  }

  add(r: any, index: number): void {
    if (!r || typeof r !== "object") return;
    if (index === 0 || this.lineage === null) {
      if (r.type === "session_meta" && this.lineage === null) {
        this.lineage = codexLineage(r);
        this.cwd = this.lineage.cwd;
        const git = r.payload?.git;
        if (typeof git?.branch === "string") this.gitBranch = git.branch;
        if (typeof r.payload?.model === "string") this.model = r.payload.model;
      }
    }
    if (this.isInherited(r, index)) return;
    // The copy of the parent's session_meta a forked subagent carries says
    // nothing about this thread.
    if (r.type === "session_meta" && index > 0) return;

    const at = ms(r.timestamp);
    if (at !== null) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.lastActivityAt === null || at > this.lastActivityAt) this.lastActivityAt = at;
    }
    const p = r.payload ?? {};

    if (r.type === "turn_context") {
      if (typeof p.cwd === "string" && p.cwd) this.cwd = p.cwd;
      if (typeof p.model === "string" && p.model) this.model = p.model;
      return;
    }
    if (r.type === "response_item") {
      if (p.type === "message" && p.role === "user") {
        const prompt = codexUserPrompt(p.content);
        if (prompt?.text) {
          const t = prompt.text.slice(0, PROMPT_CAP);
          this.firstPrompt ??= t;
          this.lastPrompt = t;
          this.prRepo.add(prompt.text);
        }
        if (prompt && at !== null && !isAgentSent(prompt.text ?? "")) this.lastPromptAt = at;
        // Rollouts from before task_started existed only had the message.
        if (prompt) this.turnOpen = true;
      } else if (p.type === "message" && p.role === "assistant") {
        const text = contentText(p.content).trim();
        if (text) this.lastMessage = text.length > 300 ? `…${text.slice(-299)}` : text;
        this.prRepo.add(text);
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        // A JSON string of the arguments; unescaped so `-R "owner/name"` reads as typed.
        const args = p.type === "custom_tool_call" ? p.input : p.arguments;
        if (typeof args === "string") this.prRepo.add(args.replace(/\\"/g, '"'));
      }
      return;
    }
    if (r.type !== "event_msg") return;

    switch (p.type) {
      case "task_started":
        this.turnOpen = true;
        if (typeof p.model_context_window === "number") this.contextLimit = p.model_context_window;
        return;
      case "task_complete":
        this.turnOpen = false;
        if (p.error && isUsageLimit(p.error)) this.hit(at, oneLine(String(p.error.message ?? "usage limit"), 300));
        return;
      case "turn_aborted":
        this.turnOpen = false;
        return;
      case "thread_settings_applied": {
        const s = p.thread_settings ?? {};
        if (typeof s.model === "string" && s.model) this.model = s.model;
        if (typeof s.cwd === "string" && s.cwd) this.cwd = s.cwd;
        return;
      }
      case "token_count":
        this.tokenCount(p, at);
        return;
      case "error":
        if (isUsageLimit(p)) this.hit(at, oneLine(String(p.message ?? "usage limit"), 300));
        this.turnOpen = false;
        return;
    }
  }

  private hit(at: number | null, detail: string): void {
    this.hits.push({ at: at ?? this.lastActivityAt ?? 0, detail });
    if (this.hits.length > MAX_HITS) this.hits.shift();
  }

  private tokenCount(p: any, at: number | null): void {
    const info = p.info;
    if (info?.total_token_usage) {
      const now = codexUsage(info.total_token_usage);
      const prev = this.reported;
      const restarted = now.input + now.cacheRead + now.cacheWrite + now.output < prev.input + prev.cacheRead + prev.cacheWrite + prev.output;
      // After a restart the new process counts from zero: all of it is new.
      const delta = restarted
        ? now
        : {
            input: Math.max(0, now.input - prev.input),
            output: Math.max(0, now.output - prev.output),
            cacheRead: Math.max(0, now.cacheRead - prev.cacheRead),
            cacheWrite: Math.max(0, now.cacheWrite - prev.cacheWrite),
          };
      addUsage(this.tokens, this.model, delta);
      this.reported = now;
    }
    if (info?.last_token_usage) {
      const l = info.last_token_usage;
      // The last request's prompt (cached part included) plus its answer is
      // what the next request carries: the window's current occupancy.
      this.contextUsed = l.total_tokens ?? (l.input_tokens ?? 0) + (l.output_tokens ?? 0);
    }
    if (typeof info?.model_context_window === "number") this.contextLimit = info.model_context_window;

    const rl = p.rate_limits;
    if (rl) {
      const windows = codexWindows(rl);
      if (windows.length) {
        this.windows.set(typeof rl.limit_id === "string" ? rl.limit_id : "codex", windows);
        this.usageAt = at ?? this.usageAt;
      }
      // Repeated on every token_count while limited; one hit per episode.
      const reached = rl.rate_limit_reached_type;
      if (reached && !this.limited) this.hit(at, `rate limit reached: ${typeof reached === "string" ? reached : JSON.stringify(reached)}`);
      this.limited = !!reached;
    }
  }

  facts(): TranscriptFacts {
    const l = this.lineage;
    const windows = [...this.windows.values()].flat();
    return {
      agentSessionId: this.ref.agentSessionId,
      cwd: this.cwd,
      // `codex resume` finds a session by id from anywhere, but started from
      // another directory it stops to ask which one to use; the session's
      // own directory skips the question.
      resumeCwd: this.cwd,
      title: this.titleOf(),
      firstPrompt: this.firstPrompt,
      lastPrompt: this.lastPrompt,
      lastPromptAt: this.lastPromptAt,
      lastMessage: this.lastMessage,
      model: this.model,
      gitBranch: this.gitBranch,
      prRepo: this.prRepo.repo,
      startedAt: l?.startedAt ?? this.startedAt,
      lastActivityAt: this.lastActivityAt,
      turnOpen: this.turnOpen,
      contextUsed: this.contextUsed,
      contextLimit: this.contextLimit,
      tokens: { ...this.tokens },
      usage: windows.length && this.usageAt !== null ? { at: this.usageAt, windows } : null,
      rateLimitHits: [...this.hits],
      isSubagent: l?.isSubagent ?? false,
      parentId: l?.parentId ?? null,
    };
  }
}

// ------------------------------------------------------------- tools

function parseArgs(a: unknown): any {
  if (typeof a !== "string") return a ?? {};
  try {
    return JSON.parse(a);
  } catch {
    return a;
  }
}

/** `["bash","-lc","git status"]` → `git status`. */
function shellLine(cmd: unknown): string {
  if (typeof cmd === "string") return cmd;
  if (!Array.isArray(cmd)) return "";
  const a = cmd.map(String);
  if (a.length >= 3 && /(^|\/)(ba|z)?sh$/.test(a[0]!) && /^-l?c$/.test(a[1]!)) return a.slice(2).join(" ");
  return a.join(" ");
}

/** The shell commands a code-mode `exec` cell runs: `tools.exec_command({cmd:"…"})`. */
function execCells(code: string): string[] {
  const out: string[] = [];
  const re = /["']?\bcmd["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/g;
  for (let m = re.exec(code); m && out.length < 3; m = re.exec(code)) {
    const lit = m[1]!;
    if (lit.startsWith('"')) {
      try {
        out.push(JSON.parse(lit));
        continue;
      } catch {
        /* fall through */
      }
    }
    out.push(lit.slice(1, -1));
  }
  return out;
}

/** Files an apply_patch touches, `M a.ts, A b.ts`. */
function patchFiles(patch: string): string {
  const out: string[] = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  for (let m = re.exec(patch); m; m = re.exec(patch)) out.push(`${m[1]![0]} ${tidyPath(m[2]!.trim())}`);
  return out.length ? out.join(", ") : oneLine(patch, 100);
}

export function codexToolName(p: any): string {
  const name = String(p?.name ?? p?.type ?? "tool");
  const ns = typeof p?.namespace === "string" ? p.namespace : "";
  if (!ns) return name;
  return ns.startsWith("mcp__") ? `${ns}__${name}` : `${ns}.${name}`;
}

export function summarizeCodexTool(name: string, input: any): string {
  const i = input ?? {};
  switch (name) {
    case "exec": {
      if (typeof i !== "string") return oneLine(JSON.stringify(i), 100);
      const cmds = execCells(i);
      if (cmds.length) return oneLine(cmds.join(" ; "));
      return oneLine(i.split("\n").find((l) => l.trim()) ?? "", 140);
    }
    case "exec_command":
      return oneLine(i.cmd ?? shellLine(i.command));
    case "shell":
    case "container.exec":
    case "local_shell":
      return oneLine(shellLine(i.command ?? i.cmd));
    case "write_stdin":
      return `session ${i.session_id ?? "?"}${i.chars ? `: ${oneLine(JSON.stringify(i.chars), 60)}` : " (poll)"}`;
    case "wait":
      return i.cell_id !== undefined ? `cell ${i.cell_id}` : oneLine(JSON.stringify(i), 80);
    case "apply_patch":
      return typeof i === "string" ? patchFiles(i) : patchFiles(String(i.input ?? i.patch ?? ""));
    case "update_plan": {
      const plan = Array.isArray(i.plan) ? i.plan : [];
      const now = plan.find((s: any) => s?.status === "in_progress")?.step;
      return `${plan.length} steps${now ? ` · ${oneLine(now, 80)}` : ""}`;
    }
    case "view_image":
      return tidyPath(i.path);
    case "collaboration.spawn_agent":
      return `spawn ${i.task_name ?? i.agent_type ?? "agent"}`;
    case "collaboration.send_message":
    case "collaboration.followup_task":
      return `→ ${i.target ?? "?"}`;
    case "collaboration.wait_agent":
      return `wait ${Array.isArray(i.targets) ? i.targets.join(", ") : (i.target ?? "")}`.trim();
    case "web.run": {
      const q = i.search_query?.[0]?.q ?? i.open?.[0]?.ref_id ?? i.find?.[0]?.pattern;
      return q ? oneLine(String(q)) : oneLine(JSON.stringify(i), 100);
    }
    case "request_user_input_async":
    case "request_user_input":
      return oneLine(i.questions?.[0]?.title ?? i.questions?.[0]?.question ?? "asked a question");
    default: {
      if (typeof i === "string") return oneLine(i, 100);
      const s = JSON.stringify(i);
      return s === "{}" ? "" : oneLine(s, 100);
    }
  }
}

/**
 * Tool output as text, and whether it failed. Codex has no error flag on its
 * outputs; the failure is in the text: a code-mode cell says "Script failed"
 * or "Script terminated", apply_patch and shell say "Exit code: N", a unified
 * exec chunk says "Process exited with code N". Older rollouts wrapped output
 * as `{"output": "...", "metadata": {"exit_code": N}}`.
 */
export function codexOutput(raw: unknown): { text: string; error: boolean } {
  let text = contentText(raw);
  if (!text && raw && typeof raw === "object" && !Array.isArray(raw)) text = JSON.stringify(raw);
  let exit: number | null = null;
  if (text.startsWith('{"output"')) {
    try {
      const o = JSON.parse(text);
      if (typeof o.output === "string") {
        text = o.output;
        if (typeof o.metadata?.exit_code === "number") exit = o.metadata.exit_code;
      }
    } catch {
      /* not the wrapper */
    }
  }
  const head = text.slice(0, 400);
  const m = /(?:^|\n)(?:Exit code|Process exited with code):? (\d+)/.exec(head);
  if (m) exit = Number(m[1]);
  const error = (exit !== null && exit !== 0) || /^Script (failed|terminated)/.test(head);
  return { text, error };
}

// ------------------------------------------------------------- timeline

function meta(id: string, at: number, text: string, tone: "info" | "warn" | "error" = "info"): Piece {
  return { kind: "event", event: { id, at, kind: "meta", text, tone } };
}

/** Timeline pieces for one rollout record. Records carry no uuid of their
 *  own, but a record's index never changes in an append-only file. */
export function codexPieces(r: any, index: number, fold?: { isInherited(r: any, i: number): boolean }): Piece[] {
  if (!r || typeof r !== "object") return [];
  if (fold?.isInherited(r, index)) return [];
  const at = ms(r.timestamp) ?? 0;
  const id = `r${index}`;
  const p = r.payload ?? {};

  if (r.type === "compacted") return [meta(id, at, "context compacted")];
  if (r.type === "event_msg") {
    switch (p.type) {
      case "turn_aborted":
        return [meta(id, at, `turn aborted${p.reason ? ` (${p.reason})` : ""}`, "warn")];
      case "error":
        return [meta(id, at, oneLine(String(p.message ?? "error"), 300), isUsageLimit(p) ? "warn" : "error")];
      case "task_complete":
        return p.error ? [meta(id, at, oneLine(String(p.error.message ?? "turn failed"), 300), isUsageLimit(p.error) ? "warn" : "error")] : [];
      case "token_count": {
        const reached = p.rate_limits?.rate_limit_reached_type;
        return reached ? [meta(id, at, `rate limit reached: ${typeof reached === "string" ? reached : JSON.stringify(reached)}`, "warn")] : [];
      }
      default:
        return [];
    }
  }
  if (r.type !== "response_item") return [];

  switch (p.type) {
    case "message": {
      if (p.role === "user") {
        const prompt = codexUserPrompt(p.content);
        if (!prompt) return [];
        const ev: TimelineEvent = { id, at, kind: "user", text: prompt.text };
        if (prompt.images) ev.images = prompt.images;
        return [{ kind: "event", event: ev }];
      }
      if (p.role === "assistant") {
        const text = contentText(p.content);
        return text.trim() ? [{ kind: "event", event: { id, at, kind: "assistant", text } }] : [];
      }
      return [];
    }
    case "reasoning": {
      const summary = Array.isArray(p.summary) ? p.summary.map((s: any) => s?.text ?? "").filter(Boolean).join("\n\n") : "";
      const text = summary || contentText(p.content);
      return text.trim() ? [{ kind: "event", event: { id, at, kind: "thinking", text } }] : [];
    }
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "tool_search_call": {
      const name = p.type === "local_shell_call" ? "local_shell" : p.type === "tool_search_call" ? "tool_search" : codexToolName(p);
      const input = p.type === "custom_tool_call" ? p.input : p.type === "local_shell_call" ? p.action : p.type === "tool_search_call" ? p.arguments : parseArgs(p.arguments);
      const ev: ToolEvent = {
        id,
        at,
        kind: "tool",
        name,
        summary: name === "tool_search" ? oneLine(String(input?.query ?? "")) : summarizeCodexTool(name, input),
        input: typeof input === "string" ? cap(input, INPUT_CAP) : capJson(input, INPUT_CAP),
        status: "running",
      };
      const callId = p.call_id ?? p.id;
      if (!callId) return [{ kind: "event", event: { ...ev, status: "ok" } }];
      return [{ kind: "call", callId: String(callId), event: ev }];
    }
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
    case "tool_search_output": {
      if (!p.call_id) return [];
      const raw = p.type === "tool_search_output" ? (p.tools ?? p.output ?? "") : p.output;
      const { text, error } = codexOutput(raw);
      return [{ kind: "result", callId: String(p.call_id), output: cap(text, OUTPUT_CAP), error, at }];
    }
    case "web_search_call": {
      const a = p.action ?? {};
      const q = a.query ?? a.queries?.[0] ?? a.url ?? a.pattern ?? "";
      return [{ kind: "event", event: { id, at, kind: "tool", name: "web_search", summary: oneLine(String(q)), input: cap(JSON.stringify(a), INPUT_CAP), status: p.status === "failed" ? "error" : "ok" } }];
    }
    case "image_generation_call":
      return [{ kind: "event", event: { id, at, kind: "tool", name: "image_generation", summary: oneLine(String(p.revised_prompt ?? "")), status: p.status === "failed" ? "error" : "ok" } }];
    case "agent_message": {
      // Messages between agents; the payload is encrypted, the header is not.
      const header = Array.isArray(p.content) ? (p.content.find((b: any) => typeof b?.text === "string")?.text ?? "") : "";
      const kind = /Message Type: (\w+)/.exec(header)?.[1];
      return [meta(id, at, `${p.author ?? "?"} → ${p.recipient ?? "?"}${kind ? `: ${kind.toLowerCase().replace(/_/g, " ")}` : ""}`)];
    }
    default:
      return [];
  }
}

export function codexLinks(r: any): { calls?: string[]; results?: string[] } | null {
  if (r?.type !== "response_item") return null;
  const p = r.payload ?? {};
  switch (p.type) {
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call":
    case "tool_search_call": {
      const id = p.call_id ?? p.id;
      return id ? { calls: [String(id)] } : null;
    }
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
    case "tool_search_output":
      return p.call_id ? { results: [String(p.call_id)] } : null;
    default:
      return null;
  }
}

export function codexFormat(ref: Pick<TranscriptRef, "agentSessionId">, titleOf?: () => string | null): TranscriptFormat {
  const fold = new CodexFold(ref, titleOf);
  return {
    add: (v, i) => fold.add(v, i),
    reset: () => fold.reset(),
    facts: () => fold.facts(),
    links: codexLinks,
    pieces: (v, i) => codexPieces(v, i, fold),
  };
}
