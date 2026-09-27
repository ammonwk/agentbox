/** Claude Code's transcript format: the facts fold and the timeline projection.
 *
 * Pure — nothing here touches the filesystem, so every rule below is tested
 * against hand-written records. The shapes were read off real transcripts
 * written by Claude Code 2.1.2xx; comments name the record each rule is for.
 *
 * One transcript line is one record. An assistant *message* is split across
 * several lines — one per content block (thinking, text, tool_use), each with
 * its own `uuid` but the same `message.id` and, crucially, the same `usage`.
 * Summing usage per line double- or triple-counts every message; half the
 * assistant lines on this machine are such repeats.
 */

import { basename, dirname, sep } from "node:path";
import { addUsage, emptyTotals } from "../pricing";
import type { AskQuestion, TimelineEvent, TokenTotals } from "../types";
import { cap, INPUT_CAP, OUTPUT_CAP, type Piece, type ToolEvent, type TranscriptFormat } from "./jsonl-reader";
import { isAgentSent, type TranscriptFacts, type TranscriptRef } from "./types";

/** Claude's project directory name for a cwd. Lossy (`a_b` and `a-b`
 *  collide), so it only ever proves a candidate, never recovers a path. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// ------------------------------------------------------------- context

const BASE_LIMIT = 200_000;
const LONG_LIMIT = 1_000_000;

/**
 * Models whose standard window is 1M. The transcript records the bare model id
 * (`claude-opus-5`), never the `[1m]` suffix, so the family has to be known:
 * every one of these has been observed on this machine holding 930K–1M tokens,
 * while `claude-opus-4-5-*` and `claude-sonnet-4-5-*` never passed 200K.
 */
const LONG_CONTEXT = /\[1m\]|fable|mythos|opus-[5-9]|opus-4-[6-9]|sonnet-[5-9]/i;

/**
 * The window a session is running against, preferring evidence to inference:
 * a known 1M family; then an *automatic* compaction's `preTokens`, which is
 * the ceiling it hit (a manual `/compact` can fire at any size, so it proves
 * nothing); then the high-water mark — a session holding 700K is self-evidently
 * not on a 200K window.
 */
export function contextLimitFor(model: string | null, observedMax: number, autoCompactPre: number): number {
  if (model && LONG_CONTEXT.test(model)) return LONG_LIMIT;
  if (autoCompactPre > 0) return autoCompactPre <= BASE_LIMIT * 1.02 ? BASE_LIMIT : LONG_LIMIT;
  if (observedMax > BASE_LIMIT * 0.95) return LONG_LIMIT;
  return BASE_LIMIT;
}

// ------------------------------------------------------------- user text

/**
 * Claude writes much more than your prompts as `type: "user"`: tool results,
 * slash-command wrappers, command output, background-task notifications,
 * skill bodies (`isMeta`), compaction summaries and interrupt notices. Each
 * kind is shown differently and only `prompt` counts as something you said.
 */
export type UserTextKind =
  | "prompt"
  | "command" // <command-name>/foo</command-name><command-args>…
  | "bash" // `!ls` typed at the prompt: <bash-input>
  | "output" // <local-command-stdout>, <bash-stdout>, …
  | "notification" // <task-notification>: a background task finished
  | "interrupted"
  | "hidden"; // caveats and other wrappers nobody needs to see

const WRAPPER_TAG = /^\s*<([a-z][a-z0-9_-]*)>/;

export function classifyUserText(text: string): UserTextKind {
  if (text.startsWith("[Request interrupted")) return "interrupted";
  if (text.startsWith("Caveat:")) return "hidden";
  // An agent teammate's message, delivered as a plain user record with no
  // origin: not yours, so it must not count as when you last wrote to it.
  if (text.startsWith("Another Claude session sent a message:") || text.startsWith("<teammate-message")) return "notification";
  const m = WRAPPER_TAG.exec(text);
  if (!m) return "prompt";
  switch (m[1]) {
    case "command-name":
    case "command-message":
    case "command-args":
      return "command";
    case "bash-input":
      return "bash";
    case "local-command-stdout":
    case "local-command-stderr":
    case "bash-stdout":
    case "bash-stderr":
      return "output";
    case "task-notification":
      return "notification";
    case "local-command-caveat":
    case "system-reminder":
    case "user-memory-input":
    case "ide_opened_file":
    case "ide_selection":
      return "hidden";
    default:
      // A prompt that merely starts with markup (`<div>` pasted in) is still
      // a prompt; only a tag Claude itself wraps things in is not.
      return "prompt";
  }
}

const tag = (s: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s);
  return m ? m[1]! : null;
};

/** `/review 3305` from the wrapper Claude records a slash command as. */
export function commandLine(s: string): string {
  const name = (tag(s, "command-name") ?? tag(s, "command-message") ?? "").trim();
  const args = (tag(s, "command-args") ?? "").trim();
  const n = name.startsWith("/") ? name : `/${name}`;
  return args ? `${n} ${args}` : n;
}

/** The text of a background-task notification or a teammate's message, for a one-line meta event. */
function notificationLine(s: string): string {
  const mate = /<teammate-message teammate_id="([^"]*)"[^>]*>([\s\S]*?)(?:<\/teammate-message>|$)/.exec(s);
  if (mate) return `from teammate ${mate[1]}: ${oneLine(mate[2]!, 200)}`;
  const summary = tag(s, "summary") ?? tag(s, "status") ?? "";
  return `background task: ${oneLine(summary || s.replace(/<[^>]+>/g, " "), 200)}`;
}

const stripTags = (s: string) => s.replace(/<\/?[a-z][a-z0-9_-]*>/g, "").trim();

export function oneLine(s: string, max = 140): string {
  const line = String(s ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const PROMPT_CAP = 2000;

/** A user record's own words and attached images, or null when it has none. */
function promptOf(content: unknown): { text: string; images: number } | null {
  if (typeof content === "string") {
    return classifyUserText(content) === "prompt" ? { text: content, images: 0 } : null;
  }
  if (!Array.isArray(content)) return null;
  let images = 0;
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === "image" || b?.type === "document") images++;
    else if (b?.type === "text" && typeof b.text === "string") {
      if (classifyUserText(b.text) === "prompt") parts.push(b.text);
      else if (classifyUserText(b.text) === "interrupted") return null;
    } else if (b?.type === "tool_result") return null;
  }
  const text = parts.join("\n").trim();
  return text || images ? { text, images } : null;
}

// ------------------------------------------------------------- tools

function home(): string {
  return process.env.HOME ?? "";
}

/** Paths are long and mostly prefix; keep the part that says something. */
export function tidyPath(p: unknown): string {
  if (typeof p !== "string" || !p) return "";
  const h = home();
  let out = h && p.startsWith(h + "/") ? `~${p.slice(h.length)}` : p;
  out = out.replace(/^(.*)\/\.claude\/worktrees\/([^/]+)\//, "$2:");
  return out;
}

/** One line per tool call: at fleet scale a timeline is skimmed, not read. */
export function summarizeClaudeTool(name: string, input: any): string {
  const i = input ?? {};
  switch (name) {
    case "Read":
      return tidyPath(i.file_path) + (i.offset ? ` @${i.offset}` : "");
    case "Write":
    case "Edit":
    case "MultiEdit":
      return tidyPath(i.file_path) + (i.replace_all ? " (all)" : "");
    case "NotebookEdit":
      return tidyPath(i.notebook_path);
    case "Bash":
      return oneLine(i.command ?? "");
    case "BashOutput":
    case "KillShell":
    case "TaskStop":
      return String(i.bash_id ?? i.shell_id ?? i.task_id ?? "");
    case "Glob":
      return `${i.pattern ?? ""}${i.path ? ` in ${tidyPath(i.path)}` : ""}`;
    case "Grep":
      return `/${i.pattern ?? ""}/${i.path ? ` in ${tidyPath(i.path)}` : ""}`;
    case "WebFetch":
      return String(i.url ?? "");
    case "WebSearch":
      return String(i.query ?? "");
    case "Task":
    case "Agent":
      return `${i.subagent_type ?? "agent"} · ${oneLine(i.description ?? i.prompt ?? "", 100)}`;
    case "Skill":
      return `/${i.skill ?? i.command ?? ""}${i.args ? ` ${oneLine(i.args, 60)}` : ""}`;
    case "TodoWrite":
      return `${i.todos?.length ?? 0} items`;
    case "ExitPlanMode":
      return "presented a plan";
    case "AskUserQuestion":
      return oneLine(i.questions?.[0]?.question ?? "asked a question");
    case "SendMessage":
      return `→ ${i.to ?? i.recipient ?? "?"}: ${oneLine(i.message ?? i.content ?? "", 80)}`;
    case "Monitor":
      return oneLine(i.command ?? i.description ?? "");
    default: {
      if (name.startsWith("mcp__")) {
        const label = name.split("__").slice(2).join("__") || name;
        return `${label} ${oneLine(JSON.stringify(i), 80)}`;
      }
      const s = JSON.stringify(i);
      return s === "{}" ? "" : oneLine(s, 100);
    }
  }
}

/** AskUserQuestion's questions, or null for input that is not that shape. */
export function askQuestionsOf(input: any): AskQuestion[] | null {
  const qs = input?.questions;
  if (!Array.isArray(qs) || qs.length === 0) return null;
  const out: AskQuestion[] = [];
  for (const q of qs) {
    if (typeof q?.question !== "string" || !Array.isArray(q.options)) return null;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options: q.options
        .filter((o: any) => typeof o?.label === "string")
        .map((o: any) => (typeof o.description === "string" && o.description ? { label: o.label, description: o.description } : { label: o.label })),
    });
  }
  return out;
}

/** The answers Claude recorded for an AskUserQuestion, question → answer. */
function askAnswersOf(r: any): Record<string, string> | undefined {
  const a = r?.toolUseResult?.answers;
  if (!a || typeof a !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) if (typeof v === "string") out[k] = v;
  return out;
}

/** A tool_result's content as text. Images become a marker. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "text") return b.text ?? "";
      if (b?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n");
}

// ------------------------------------------------------------- the fold

const SYNTHETIC = "<synthetic>";

/**
 * What a rate-limit refusal looks like. Claude records it as an assistant
 * message with model `<synthetic>`, `isApiErrorMessage: true`,
 * `error: "rate_limit"`, `apiErrorStatus: 429`, and text such as
 *   "You've hit your session limit · resets 9:10pm (America/Denver)"
 *   "You've hit your weekly limit · resets Sep 26, 5pm (America/Denver)"
 *   "You're out of extra usage · resets 4pm (America/Denver)"
 *   "You're out of usage credits. Run /usage-credits to keep using Fable 5.1 …"
 * The text match is the fallback for versions that did not set `error`.
 */
const LIMIT_TEXT = /hit your .*limit|out of (usage credits|extra usage)|usage limit reached/i;

export function isRateLimitRecord(r: any): boolean {
  if (!r?.isApiErrorMessage) return false;
  return r.error === "rate_limit" || LIMIT_TEXT.test(blocksText(r.message?.content));
}

const ms = (t: unknown): number | null => {
  if (typeof t !== "string") return null;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
};

interface Counted {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  model: string | null;
}

/** The usage of one assistant message, split by the model that produced it.
 *  A model fallback records each attempt in `usage.iterations`; the top-level
 *  usage is only the last one, so the earlier attempt would go uncounted. */
function usageParts(model: string | null, u: any): Counted[] {
  const one = (m: string | null, x: any): Counted => ({
    input: x?.input_tokens ?? 0,
    output: x?.output_tokens ?? 0,
    cacheRead: x?.cache_read_input_tokens ?? 0,
    cacheWrite: x?.cache_creation_input_tokens ?? 0,
    model: m,
  });
  if (Array.isArray(u?.iterations) && u.iterations.length > 1) {
    return u.iterations.map((it: any) => one(it?.model ?? model, it));
  }
  return [one(model, u)];
}

/** Bounded memory of which message ids were already counted. Repeats of one
 *  message are adjacent in practice; a few hundred covers interleaving. */
const SEEN_IDS = 512;
const MAX_HITS = 200;
const MAX_CWDS = 64;
const MAX_TEAMS = 64;

/** Token totals over assistant records, deduplicated by message id. Used for
 *  the main transcript and for each subagent transcript. */
export class ClaudeTokenFold {
  totals: TokenTotals = emptyTotals();
  private seen = new Map<string, Counted[]>();

  reset(): void {
    this.totals = emptyTotals();
    this.seen.clear();
  }

  /** Fold one record; returns the message's usage when it counted one. */
  add(r: any): void {
    if (r?.type !== "assistant") return;
    const m = r.message;
    if (!m?.usage || m.model === SYNTHETIC) return;
    const parts = usageParts(m.model ?? null, m.usage);
    const id: string | undefined = m.id;
    if (id) {
      const prev = this.seen.get(id);
      if (prev) {
        // Same message again (the next content block). Usage is repeated, not
        // incremental; take the newest in case a later line carries more.
        for (const p of prev) addUsage(this.totals, p.model, { input: -p.input, output: -p.output, cacheRead: -p.cacheRead, cacheWrite: -p.cacheWrite });
        this.seen.delete(id);
      } else if (this.seen.size >= SEEN_IDS) {
        this.seen.delete(this.seen.keys().next().value!);
      }
      this.seen.set(id, parts);
    }
    for (const p of parts) addUsage(this.totals, p.model, p);
  }
}

export class ClaudeFold {
  private tokens = new ClaudeTokenFold();
  private cwd: string | null = null;
  private cwds = new Set<string>();
  private customTitle: string | null = null;
  private aiTitle: string | null = null;
  private agentName: string | null = null;
  private team: string | null = null;
  private teamsLed = new Set<string>();
  private firstPrompt: string | null = null;
  private lastPrompt: string | null = null;
  private lastPromptAt: number | null = null;
  /** A slash command not yet answered; see `user`. */
  private command: string | null = null;
  private lastMessage: string | null = null;
  private model: string | null = null;
  private gitBranch: string | null = null;
  private startedAt: number | null = null;
  private lastActivityAt: number | null = null;
  private turnOpen = false;
  /** An AskUserQuestion still waiting for its answer. */
  private pendingAsk: { id: string; questions: AskQuestion[] } | null = null;
  private contextUsed: number | null = null;
  private observedMax = 0;
  private autoCompactPre = 0;
  private hits: { at: number; detail: string }[] = [];
  private sawMain = false;
  private sawSidechain = false;
  private recordSessionId: string | null = null;

  constructor(
    private readonly ref: Pick<TranscriptRef, "path" | "agentSessionId">,
    /** Tokens from sources outside this file (subagent transcripts). */
    private readonly extraTokens: () => TokenTotals | null = () => null,
  ) {}

  reset(): void {
    const fresh = new ClaudeFold(this.ref, this.extraTokens);
    Object.assign(this, fresh);
  }

  private noteCwd(c: unknown): void {
    if (typeof c !== "string" || !c) return;
    this.cwd = c;
    if (this.cwds.size < MAX_CWDS) this.cwds.add(c);
  }

  add(r: any): void {
    if (!r || typeof r !== "object") return;
    const at = ms(r.timestamp);
    if (at !== null) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.lastActivityAt === null || at > this.lastActivityAt) this.lastActivityAt = at;
    }
    if (typeof r.sessionId === "string" && !this.recordSessionId) this.recordSessionId = r.sessionId;
    const side = r.isSidechain === true;
    if (r.type === "user" || r.type === "assistant") {
      if (side) this.sawSidechain = true;
      else this.sawMain = true;
    }
    // Sidechain tokens are this session's spend, recorded in this file.
    this.tokens.add(r);

    switch (r.type) {
      case "custom-title":
        if (r.customTitle) this.customTitle = String(r.customTitle);
        return;
      case "ai-title":
        if (r.aiTitle) this.aiTitle = String(r.aiTitle);
        return;
      case "agent-name":
        if (r.agentName) this.agentName = String(r.agentName);
        return;
      case "relocated":
        // The session moved (EnterWorktree); its transcript may now live
        // under the new directory's slug, so this is a resume candidate.
        this.noteCwd(r.relocatedCwd);
        return;
      case "worktree-state":
        if (this.cwds.size < MAX_CWDS) {
          for (const c of [r.worktreeSession?.originalCwd, r.worktreeSession?.worktreePath]) {
            if (typeof c === "string" && c) this.cwds.add(c);
          }
        }
        return;
      case "attachment": {
        // A prompt typed while the agent was busy is delivered mid-turn as
        // a queued_command attachment, not as a user record.
        const a = r.attachment;
        if (a?.type === "queued_command" && a.commandMode === "prompt" && !side) {
          const p = promptOf(a.prompt);
          if (p?.text) this.prompt(p.text);
          this.turnOpen = true;
          // Yours unless it says otherwise — and it is when you last sent it
          // something, which the board sorts by. A session you keep talking to
          // mid-turn sank below ones you had not touched in hours.
          const kind = a.origin?.kind;
          const when = at ?? (typeof a.timestamp === "string" ? Date.parse(a.timestamp) : NaN);
          if ((kind === undefined || kind === "human") && !isAgentSent(String(a.prompt ?? "")) && Number.isFinite(when)) this.lastPromptAt = when;
        }
        return;
      }
      case "system":
        if (side) return;
        if (r.subtype === "turn_duration") this.turnOpen = false;
        else if (r.subtype === "scheduled_task_fire") this.turnOpen = true;
        else if (r.subtype === "compact_boundary") {
          const meta = r.compactMetadata ?? {};
          if (meta.trigger === "auto" && typeof meta.preTokens === "number") {
            this.autoCompactPre = Math.max(this.autoCompactPre, meta.preTokens);
          }
          if (typeof meta.postTokens === "number") this.contextUsed = meta.postTokens;
        }
        this.noteCwd(r.cwd);
        return;
      case "user":
        this.noteCwd(r.cwd);
        if (typeof r.gitBranch === "string" && r.gitBranch) this.gitBranch = r.gitBranch;
        if (side) return;
        this.teammate(r);
        this.user(r, at);
        return;
      case "assistant":
        this.noteCwd(r.cwd);
        if (typeof r.gitBranch === "string" && r.gitBranch) this.gitBranch = r.gitBranch;
        if (side) return;
        this.teammate(r);
        this.assistant(r, at);
        return;
    }
  }

  /**
   * Agent teams. A member stamps `teamName` and `agentName` on its records —
   * its name is a better title than its directory, since its first prompt is
   * the lead's message. The lead's transcript has a `teammate_spawned` tool
   * result per member it started, naming the team. (The team's config.json
   * has a `leadSessionId`, but it is not the lead's transcript id.)
   */
  private teammate(r: any): void {
    if (typeof r.teamName === "string" && r.teamName) {
      this.team ??= r.teamName;
      if (!this.agentName && typeof r.agentName === "string" && r.agentName) this.agentName = r.agentName;
    }
    const spawned = r.toolUseResult;
    if (spawned?.status !== "teammate_spawned" || this.teamsLed.size >= MAX_TEAMS) return;
    const team = typeof spawned.team_name === "string" ? spawned.team_name : String(spawned.agent_id ?? "").split("@")[1];
    if (team) this.teamsLed.add(team);
  }

  private prompt(text: string): void {
    const t = text.trim().slice(0, PROMPT_CAP);
    if (!t) return;
    this.firstPrompt ??= t;
    this.lastPrompt = t;
  }

  private user(r: any, at: number | null): void {
    if (r.isMeta || r.isCompactSummary) return;
    // Claude says who a message is from: `human`, or `peer` (another agent),
    // `task-notification`, `auto-continuation`. Older versions say nothing,
    // and then it was typed.
    const kind0 = r.origin?.kind;
    const content = r.message?.content;
    if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
      if (this.pendingAsk && content.some((b: any) => b?.type === "tool_result" && b.tool_use_id === this.pendingAsk!.id)) this.pendingAsk = null;
      // A tool finished; the model is about to continue.
      this.turnOpen = true;
      return;
    }
    const first = typeof content === "string" ? content : Array.isArray(content) ? (content.find((b: any) => b?.type === "text")?.text ?? "") : "";
    const kind = classifyUserText(first);
    const mine = (kind0 === undefined || kind0 === "human") && !isAgentSent(first);
    if (kind === "interrupted") {
      this.turnOpen = false;
      return;
    }
    if (kind === "notification") {
      // Claude answers a finished background task on its own.
      this.turnOpen = true;
      return;
    }
    if (kind === "command") {
      // `/release` is what you asked for, and for a session opened with one
      // the only thing that says what it is about. Whether it starts a turn
      // (a skill) or only prints something (`/model`) shows in what follows,
      // so it becomes a prompt when the model answers it.
      this.command = commandLine(first);
      if (mine && at !== null) this.lastPromptAt = at;
      return;
    }
    if (kind === "output") this.command = null;
    const p = promptOf(content);
    if (p) {
      if (p.text) this.prompt(p.text);
      if (mine && at !== null) this.lastPromptAt = at;
      this.turnOpen = true;
    }
  }

  private assistant(r: any, at: number | null): void {
    const m = r.message ?? {};
    if (r.isApiErrorMessage) {
      if (isRateLimitRecord(r)) {
        this.hits.push({ at: at ?? this.lastActivityAt ?? 0, detail: oneLine(blocksText(m.content), 300) });
        if (this.hits.length > MAX_HITS) this.hits.shift();
      }
      // The request failed; nothing is running until someone retries.
      this.turnOpen = false;
      return;
    }
    if (m.model === SYNTHETIC) return;
    if (this.command) {
      this.prompt(this.command);
      this.command = null;
    }
    if (m.model) this.model = m.model;
    if (m.usage) {
      const u = m.usage;
      const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (used > 0) {
        this.contextUsed = used;
        if (used > this.observedMax) this.observedMax = used;
      }
    }
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type !== "tool_use" || b.name !== "AskUserQuestion" || typeof b.id !== "string") continue;
        const questions = askQuestionsOf(b.input);
        if (questions) this.pendingAsk = { id: b.id, questions };
      }
    }
    const text = blocksText(m.content).trim();
    if (text) this.lastMessage = text.length > 300 ? `…${text.slice(-299)}` : text;
    // `end_turn`/`stop_sequence` hand back to you; `tool_use` waits on a tool;
    // null is a block written before the message finished.
    if (m.stop_reason === "end_turn" || m.stop_reason === "stop_sequence") this.turnOpen = false;
    else this.turnOpen = true;
  }

  /** The directory `claude --resume` must run from: `--resume` looks only in
   *  the project directory of the *current* cwd, and a session that moved
   *  keeps writing where it started. Only a cwd that slugs to the directory
   *  the file is actually in is proof. */
  resumeCwd(): string | null {
    const slug = basename(dirname(this.ref.path));
    for (const c of this.cwds) if (projectSlug(c) === slug) return c;
    return null;
  }

  private subagent(): { is: boolean; parent: string | null } {
    const parts = this.ref.path.split(sep);
    const i = parts.lastIndexOf("subagents");
    if (i > 0) return { is: true, parent: parts[i - 1] ?? null };
    // Older Claude wrote Task subagents as `agent-<hash>.jsonl` next to the
    // parent, every record flagged isSidechain and carrying the parent's id.
    if (basename(this.ref.path).startsWith("agent-") || (this.sawSidechain && !this.sawMain)) {
      const parent = this.recordSessionId && this.recordSessionId !== this.ref.agentSessionId ? this.recordSessionId : null;
      return { is: true, parent };
    }
    return { is: false, parent: null };
  }

  facts(): TranscriptFacts {
    const tokens = { ...this.tokens.totals };
    const extra = this.extraTokens();
    if (extra) {
      tokens.input += extra.input;
      tokens.output += extra.output;
      tokens.cacheRead += extra.cacheRead;
      tokens.cacheWrite += extra.cacheWrite;
      tokens.costEquiv += extra.costEquiv;
    }
    const sub = this.subagent();
    return {
      agentSessionId: this.ref.agentSessionId,
      cwd: this.cwd,
      resumeCwd: this.resumeCwd(),
      title: this.customTitle ?? this.aiTitle ?? this.agentName,
      firstPrompt: this.firstPrompt,
      lastPrompt: this.lastPrompt,
      lastPromptAt: this.lastPromptAt,
      lastMessage: this.lastMessage,
      model: this.model,
      gitBranch: this.gitBranch,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      turnOpen: this.turnOpen,
      contextUsed: this.contextUsed,
      contextLimit: this.contextUsed === null && !this.model ? null : contextLimitFor(this.model, this.observedMax, this.autoCompactPre),
      tokens,
      usage: null,
      rateLimitHits: [...this.hits],
      isSubagent: sub.is,
      parentId: sub.parent,
      team: this.team,
      teamsLed: [...this.teamsLed],
      pendingAsk: this.pendingAsk,
    };
  }
}

// ------------------------------------------------------------- timeline

function meta(id: string, at: number, text: string, tone: "info" | "warn" | "error" = "info"): Piece {
  return { kind: "event", event: { id, at, kind: "meta", text, tone } };
}

/** Timeline pieces for one Claude record. Ids are the record's uuid plus the
 *  block index, so a tool event re-sent with its result keeps its id. */
export function claudePieces(r: any, index: number): Piece[] {
  if (!r || typeof r !== "object") return [];
  // Sidechain records (pre-2.1 subagents written inline) would interleave a
  // second conversation into this one.
  if (r.isSidechain === true) return [];
  const at = ms(r.timestamp) ?? 0;
  const base = typeof r.uuid === "string" ? r.uuid : `r${index}`;
  const out: Piece[] = [];

  switch (r.type) {
    case "user": {
      if (r.isMeta) return [];
      if (r.isCompactSummary) return [meta(`${base}:0`, at, "conversation compacted — continuing from a summary")];
      const content = r.message?.content;
      if (typeof content === "string") return userStringPieces(content, `${base}:0`, at);
      if (!Array.isArray(content)) return [];
      let images = 0;
      const texts: string[] = [];
      content.forEach((b: any, i: number) => {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
          out.push({ kind: "result", callId: b.tool_use_id, output: cap(toolResultText(b.content), OUTPUT_CAP), error: b.is_error === true, answers: askAnswersOf(r) });
        } else if (b?.type === "image" || b?.type === "document") images++;
        else if (b?.type === "text" && typeof b.text === "string") {
          const kind = classifyUserText(b.text);
          if (kind === "prompt") texts.push(b.text);
          else out.push(...userStringPieces(b.text, `${base}:${i}`, at));
        }
      });
      if (texts.length || images) {
        const ev: TimelineEvent = { id: `${base}:u`, at, kind: "user", text: texts.join("\n") };
        if (images) ev.images = images;
        out.push({ kind: "event", event: ev });
      }
      return out;
    }

    case "assistant": {
      const m = r.message ?? {};
      if (r.isApiErrorMessage) {
        const text = blocksText(m.content) || "API error";
        return [meta(`${base}:0`, at, text, isRateLimitRecord(r) ? "warn" : "error")];
      }
      if (!Array.isArray(m.content)) return [];
      m.content.forEach((b: any, i: number) => {
        const id = `${base}:${i}`;
        if (b?.type === "text") {
          if (m.model === SYNTHETIC && /^No response requested\.?$/.test(b.text ?? "")) return;
          if (b.text?.trim()) out.push({ kind: "event", event: { id, at, kind: "assistant", text: b.text } });
        } else if (b?.type === "thinking") {
          // Newer models record thinking as a signature with empty text.
          if (b.thinking?.trim()) out.push({ kind: "event", event: { id, at, kind: "thinking", text: b.thinking } });
        } else if (b?.type === "tool_use" || b?.type === "server_tool_use") {
          const name = String(b.name ?? "tool");
          const ev: ToolEvent = {
            id,
            at,
            kind: "tool",
            name,
            summary: summarizeClaudeTool(name, b.input),
            input: cap(JSON.stringify(b.input ?? {}), INPUT_CAP),
            status: "running",
          };
          const questions = name === "AskUserQuestion" ? askQuestionsOf(b.input) : null;
          if (questions) ev.ask = { id: String(b.id), questions };
          out.push({ kind: "call", callId: String(b.id), event: ev });
        } else if (typeof b?.type === "string" && b.type.endsWith("_tool_result") && typeof b.tool_use_id === "string") {
          // Server tools (web search) answer inside the same message.
          out.push({ kind: "result", callId: b.tool_use_id, output: cap(toolResultText(b.content), OUTPUT_CAP), error: false });
        } else if (b?.type === "fallback") {
          out.push(meta(id, at, `model fallback: ${b.from?.model ?? "?"} → ${b.to?.model ?? "?"}`, "warn"));
        }
      });
      return out;
    }

    case "attachment": {
      const a = r.attachment;
      if (a?.type !== "queued_command" || a.commandMode !== "prompt") return [];
      const p = promptOf(a.prompt);
      if (!p) return [];
      const ev: TimelineEvent = { id: `${base}:0`, at: ms(a.timestamp) ?? at, kind: "user", text: p.text };
      if (p.images) ev.images = p.images;
      return [{ kind: "event", event: ev }];
    }

    case "system": {
      const id = `${base}:0`;
      const content = typeof r.content === "string" ? r.content : "";
      switch (r.subtype) {
        case "compact_boundary": {
          const cm = r.compactMetadata ?? {};
          const nums = cm.preTokens ? ` (${Math.round(cm.preTokens / 1000)}K → ${Math.round((cm.postTokens ?? 0) / 1000)}K tokens)` : "";
          return [meta(id, at, `${cm.trigger === "auto" ? "auto-compacted" : "compacted"}${nums}`)];
        }
        case "informational":
          return content ? [meta(id, at, content, r.level === "warning" ? "warn" : "info")] : [];
        case "model_refusal_fallback":
          return [meta(id, at, oneLine(content, 300), "warn")];
        case "api_error":
          return [meta(id, at, oneLine(content || "API error, retrying", 300), "warn")];
        case "local_command": {
          const kind = classifyUserText(content);
          if (kind === "command") return [{ kind: "event", event: { id, at, kind: "user", text: commandLine(content) } }];
          if (kind === "output") {
            const text = oneLine(stripTags(content).replace(/\x1b\[[0-9;]*m/g, ""), 300);
            return text ? [meta(id, at, text)] : [];
          }
          return [];
        }
        case "scheduled_task_fire":
        case "away_summary":
          return content ? [meta(id, at, oneLine(content, 300))] : [];
        case "agents_killed":
          return [meta(id, at, "background agents stopped", "warn")];
        default:
          return [];
      }
    }

    case "continued-in":
      return typeof r.continuedInSessionId === "string"
        ? [meta(`${base}:0`, ms(r.timestamp) ?? at, `continued in session ${r.continuedInSessionId}`)]
        : [];

    default:
      return [];
  }
}

function userStringPieces(s: string, id: string, at: number): Piece[] {
  switch (classifyUserText(s)) {
    case "prompt":
      return s.trim() ? [{ kind: "event", event: { id, at, kind: "user", text: s } }] : [];
    case "command":
      return [{ kind: "event", event: { id, at, kind: "user", text: commandLine(s) } }];
    case "bash":
      return [{ kind: "event", event: { id, at, kind: "user", text: `! ${(tag(s, "bash-input") ?? "").trim()}` } }];
    case "output": {
      const text = oneLine(stripTags(s).replace(/\x1b\[[0-9;]*m/g, ""), 300);
      return text ? [meta(id, at, text)] : [];
    }
    case "notification":
      return [meta(id, at, notificationLine(s))];
    case "interrupted":
      return [meta(id, at, "interrupted", "warn")];
    default:
      return [];
  }
}

/** Tool-call ids a record opens and closes, without building any events. */
export function claudeLinks(r: any): { calls?: string[]; results?: string[] } | null {
  const content = r?.message?.content;
  if (!Array.isArray(content) || r.isSidechain === true) return null;
  if (r.type === "assistant") {
    let calls: string[] | undefined;
    let results: string[] | undefined;
    for (const b of content) {
      if ((b?.type === "tool_use" || b?.type === "server_tool_use") && b.id) (calls ??= []).push(String(b.id));
      else if (typeof b?.type === "string" && b.type.endsWith("_tool_result") && b.tool_use_id) (results ??= []).push(b.tool_use_id);
    }
    return calls || results ? { calls, results } : null;
  }
  if (r.type === "user") {
    let results: string[] | undefined;
    for (const b of content) if (b?.type === "tool_result" && b.tool_use_id) (results ??= []).push(b.tool_use_id);
    return results ? { results } : null;
  }
  return null;
}

/** The format the generic reader drives. `extra` folds subagent tokens. */
export function claudeFormat(
  ref: Pick<TranscriptRef, "path" | "agentSessionId">,
  extra?: { totals: () => TokenTotals | null; refresh: () => boolean },
): TranscriptFormat {
  const fold = new ClaudeFold(ref, extra?.totals);
  return {
    add: (v) => fold.add(v),
    reset: () => fold.reset(),
    facts: () => fold.facts(),
    links: claudeLinks,
    pieces: claudePieces,
    refreshExtra: extra?.refresh,
  };
}
