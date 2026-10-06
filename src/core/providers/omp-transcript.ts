/** omp's session JSONL, folded into provider-neutral facts and timeline events.
 *
 * Pure: records in, state and events out. The file handling (tailing, the
 * mutable title slot, subagent directories) is `omp.ts`'s job.
 *
 * What a session file looks like (omp 17.2, session version 3), confirmed
 * against ~/.omp/agent/sessions:
 *
 *   line 0   {"type":"title","v":1,"title":…,"pad":"   "}   a fixed 256-byte
 *            slot omp rewrites IN PLACE when the title changes — the one line
 *            that is not append-only, so the reader re-reads it by hand
 *   line 1   {"type":"session","version":3,"id":<uuidv7>,"cwd":…}
 *   then     model_change, thinking_level_change, message (user | assistant |
 *            toolResult | developer), custom (tool_execution_start,
 *            session_exit), custom_message (async-result, irc:incoming, …),
 *            compaction, title_change, session_init (subagents only), …
 *
 * Every entry after the header carries `id`/`parentId` (omp sessions are a
 * tree, for /branch and /tree). The timeline shows entries in file order, which
 * is the active branch for every session that was never re-rooted.
 */

import type { AskQuestion, TimelineEvent, TokenTotals } from "../types";
import type { LimitHit, TranscriptFacts, Wake } from "./types";
import { addUsage, emptyTotals } from "../pricing";
import { capJson } from "./jsonl-reader";
import { countPrRepos } from "../prrepo";
import { askQuestionsOf } from "./ask";

/** Prompts are previews, capped as Claude's and Codex's are: a board row
 *  carries them on every push. */
const PROMPT_CAP = 2000;

export interface OmpHeader {
  id: string;
  cwd: string | null;
  startedAt: number | null;
  /** Legacy (pre-slot) sessions kept the title on the header. */
  title: string | null;
  /** Set on forks; NOT a subagent marker — a fork is a real session. */
  parentSession: string | null;
}

export interface OmpState {
  header: OmpHeader | null;
  /** Latest `title_change` entry; the slot on line 0 wins when non-empty. */
  titleChange: string | null;
  /** omp writes `session_init` only into subagent logs. */
  sessionInit: boolean;
  model: string | null;
  tokens: TokenTotals;
  firstPrompt: string | null;
  lastPrompt: string | null;
  lastPromptAt: number | null;
  lastMessage: string | null;
  lastActivityAt: number | null;
  turnOpen: boolean;
  contextUsed: number | null;
  rateLimitHits: LimitHit[];
  /** The error the turn ended on, until a prompt or an answer follows. */
  turnError: TranscriptFacts["turnError"];
  /** Record indices that produce at least one timeline event, ascending. */
  anchors: number[];
  /** toolCallId → record index of the assistant message that made the call. */
  calls: Map<string, number>;
  /** toolCallId → record index of its toolResult. */
  results: Map<string, number>;
  /** Every toolResult in file order, so `since` can find results that landed
   *  after a cursor for calls made before it. */
  resultLog: { rec: number; callId: string }[];
  /** Background jobs and supervised processes still running, by job id or
   *  `daemon:<name>` (TranscriptFacts.wakes). */
  wakes: Map<string, Wake>;
  /** An `async` bash call's command, until its result names the job. */
  asyncCalls: Map<string, string>;
  /** The repos it names as the home of PRs (`countPrRepos`). */
  prRepos: Map<string, number>;
  /** An `ask` call still waiting for its answer. */
  pendingAsk: { id: string; questions: AskQuestion[] } | null;
}

export function newOmpState(): OmpState {
  return {
    header: null,
    titleChange: null,
    sessionInit: false,
    model: null,
    tokens: emptyTotals(),
    firstPrompt: null,
    lastPrompt: null,
    lastPromptAt: null,
    lastMessage: null,
    lastActivityAt: null,
    turnOpen: false,
    contextUsed: null,
    rateLimitHits: [],
    turnError: null,
    anchors: [],
    calls: new Map(),
    results: new Map(),
    resultLog: [],
    wakes: new Map(),
    asyncCalls: new Map(),
    prRepos: new Map(),
    pendingAsk: null,
  };
}

/** omp writes ISO strings on entries and epoch millis inside messages. */
export function tsOf(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function oneLine(s: string, n: number): string {
  return clip(s.replace(/\s+/g, " ").trim(), n);
}

/** The readable text of a content array (or string), ignoring thinking and
 *  tool blocks — those become events of their own. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object" && (b as any).type === "text" && typeof (b as any).text === "string") {
      parts.push((b as any).text);
    }
  }
  return parts.join("\n");
}

function imagesIn(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && typeof b === "object" && (b as any).type === "image").length;
}

/**
 * One line for a tool call. The argument a reader scans for is named
 * explicitly; `i` is omp's intent echo and never the interesting part.
 */
export function toolSummary(args: unknown, intent?: unknown): string {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const k of ["command", "cmd", "path", "file_path", "pattern", "url", "query", "agent", "name"]) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) return oneLine(v, 200);
    }
  }
  if (typeof intent === "string" && intent.trim()) return oneLine(intent, 200);
  return "";
}

function argsJson(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rest = Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([k]) => k !== "i"));
  if (Object.keys(rest).length === 0) return undefined;
  try {
    return capJson(rest, 4000);
  } catch {
    return undefined;
  }
}

/**
 * Whether a failed assistant message was the provider refusing on a limit.
 * Real records carry `errorStatus: 429` for most of these; the text match
 * catches the providers that report a limit with some other status
 * ("5-hour usage limit reached" from opencode arrives as a plain error).
 */
export function isRateLimitError(msg: { errorStatus?: unknown; errorMessage?: unknown }): boolean {
  if (msg.errorStatus === 429) return true;
  const m = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
  return /rate.?limit|usage limit|quota|too many requests|FreeUsageLimitError/i.test(m);
}

/**
 * How an error that ended the turn classifies (TranscriptFacts.turnError):
 * fatal when a retry cannot fix it — out of funds or credits, a rejected
 * key, a request the provider refuses — and transient otherwise: stream
 * timeouts, dropped sockets, 5xx. omp has already retried a transient one
 * itself by the time it gives up, but minutes later a retry often goes.
 */
export function ompErrorKind(msg: { errorStatus?: unknown; errorMessage?: unknown }): "transient" | "fatal" {
  const status = typeof msg.errorStatus === "number" ? msg.errorStatus : null;
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "fatal";
  const m = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
  return /insufficient (account )?(funds|balance|credits)|invalid_request|unauthori[sz]ed|forbidden|context (length|window)|too many tokens|prompt is too long/i.test(m)
    ? "fatal"
    : "transient";
}

interface FoldOptions {
  /** Keep the timeline index. Off for subagent logs, which are folded only
   *  for their tokens and rate-limit hits. */
  events: boolean;
}

/** Fold one record (in file order) into the state. */
export function foldOmpRecord(s: OmpState, rec: any, index: number, opts: FoldOptions = { events: true }): void {
  if (!rec || typeof rec !== "object") return;
  const at = tsOf(rec.timestamp);
  if (at !== null && rec.type !== "title") s.lastActivityAt = Math.max(s.lastActivityAt ?? 0, at);

  switch (rec.type) {
    case "session":
      if (!s.header && typeof rec.id === "string") {
        s.header = {
          id: rec.id,
          cwd: typeof rec.cwd === "string" ? rec.cwd : null,
          startedAt: at,
          title: typeof rec.title === "string" && rec.title ? rec.title : null,
          parentSession: typeof rec.parentSession === "string" ? rec.parentSession : null,
        };
      }
      return;
    case "title_change":
      if (typeof rec.title === "string" && rec.title) s.titleChange = rec.title;
      return;
    case "session_init":
      s.sessionInit = true;
      return;
    case "model_change":
      if (typeof rec.model === "string" && rec.model) s.model = rec.model;
      return;
    case "compaction":
      // The window was rebuilt; the last request's size no longer describes it.
      s.contextUsed = null;
      if (opts.events) s.anchors.push(index);
      return;
    case "custom":
      if (rec.customType === "session_exit") {
        s.turnOpen = false;
        // Its jobs, supervised processes and dialogs die with it.
        s.wakes.clear();
        s.asyncCalls.clear();
        s.pendingAsk = null;
      }
      return;
    case "custom_message":
      if (opts.events && rec.display !== false) s.anchors.push(index);
      if (rec.customType === "async-result") {
        for (const j of arrayOf(rec.details?.jobs)) if (typeof j?.jobId === "string") s.wakes.delete(j.jobId);
      }
      noteDaemons(s, rec.details, at);
      return;
    case "message":
      foldMessage(s, rec.message, index, at, opts);
      return;
  }
}

function foldMessage(s: OmpState, m: any, index: number, at: number | null, opts: FoldOptions): void {
  if (!m || typeof m !== "object") return;
  const when = tsOf(m.timestamp) ?? at ?? 0;
  switch (m.role) {
    case "user": {
      s.turnOpen = true;
      s.turnError = null;
      if (opts.events) s.anchors.push(index);
      // Subagent assignments are user messages attributed to the agent; the
      // human's own prompts are what a list row should quote.
      if (m.attribution === "agent") return;
      const text = textOf(m.content).trim().slice(0, PROMPT_CAP);
      if (!text) return;
      countPrRepos(s.prRepos, text);
      s.firstPrompt ??= text;
      s.lastPrompt = text;
      if (when) s.lastPromptAt = when;
      return;
    }
    case "developer":
      if (opts.events) s.anchors.push(index);
      return;
    case "toolResult":
      s.turnOpen = true;
      s.turnError = null;
      if (typeof m.toolCallId === "string") {
        s.results.set(m.toolCallId, index);
        if (opts.events) s.resultLog.push({ rec: index, callId: m.toolCallId });
        noteJobs(s, m.toolCallId, m.details, when);
        if (s.pendingAsk?.id === m.toolCallId) s.pendingAsk = null;
      }
      return;
    case "assistant": {
      if (opts.events) s.anchors.push(index);
      if (typeof m.model === "string" && m.model) {
        s.model = typeof m.provider === "string" && m.provider ? `${m.provider}/${m.model}` : m.model;
      }
      const u = m.usage;
      if (u && typeof u === "object") {
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        const usage = { input: n(u.input), output: n(u.output), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite) };
        addUsage(s.tokens, m.model, usage);
        const total = n(u.totalTokens) || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
        if (m.stopReason !== "error" && total > 0) s.contextUsed = total;
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === "text") countPrRepos(s.prRepos, b.text);
          if (b?.type !== "toolCall" || typeof b.id !== "string") continue;
          s.calls.set(b.id, index);
          countPrRepos(s.prRepos, b.arguments?.command);
          countPrRepos(s.prRepos, b.arguments?.url);
          if (b.name === "ask") {
            const questions = askQuestionsOf(b.arguments);
            if (questions) s.pendingAsk = { id: b.id, questions };
          }
          if (b.name === "bash" && b.arguments?.async === true && typeof b.arguments.command === "string") {
            s.asyncCalls.set(b.id, oneLine(b.arguments.command, 80));
          }
        }
      }
      const said = textOf(m.content).trim();
      if (said) s.lastMessage = said.length > 300 ? `…${said.slice(-299)}` : said;
      s.turnError = null;
      if (m.stopReason === "error") {
        const who = [m.provider, m.model].filter((x) => typeof x === "string" && x).join("/");
        const first = String(m.errorMessage ?? `HTTP ${m.errorStatus}`).split("\n")[0]!;
        if (isRateLimitError(m)) {
          const hit: LimitHit = { at: when, detail: oneLine(who ? `${who}: ${first}` : first, 200) };
          if (typeof m.provider === "string" && m.provider) hit.provider = m.provider;
          s.rateLimitHits.push(hit);
        } else {
          s.turnError = { at: when, kind: ompErrorKind(m), detail: oneLine(first, 300) };
        }
      } else if (m.stopReason === "length") {
        s.turnError = { at: when, kind: "output-cap", detail: "the reply hit the model's output token limit" };
      }
      // A tool call means the turn goes on; anything else ends it.
      s.turnOpen = m.stopReason === "toolUse";
      return;
    }
  }
}

function arrayOf(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Background work a tool result starts or ends. `bash` with `async` and
 * `task` answer "Backgrounded as job <id>" with `details.async.state:
 * "running"`, and the job's end arrives later as an `async-result` message;
 * `hub cancel` ends jobs in its own result. A bash job is killed at its
 * timeout.
 */
function noteJobs(s: OmpState, callId: string, details: any, at: number): void {
  const command = s.asyncCalls.get(callId);
  s.asyncCalls.delete(callId);
  const job = details?.async;
  if (job?.state === "running" && typeof job.jobId === "string") {
    const timeout = typeof details.timeoutSeconds === "number" ? details.timeoutSeconds * 1000 : null;
    const label = job.type === "task" ? `subagent ${job.jobId}` : `background job ${job.jobId}${command ? ` (${command})` : ""}`;
    s.wakes.set(job.jobId, { label, setAt: at, until: timeout === null ? null : at + timeout });
  }
  if (details?.op === "cancel") for (const j of arrayOf(details.jobs)) if (typeof j?.id === "string") s.wakes.delete(j.id);
  noteDaemons(s, details, at);
}

const DAEMON_LIVE = new Set(["starting", "ready", "running", "restarting"]);

/** Supervised processes (`hub start`): every result or notice that shows one
 *  says what state it is in. A listing can show other sessions' too. */
function noteDaemons(s: OmpState, details: any, at: number | null): void {
  if (!details || typeof details !== "object") return;
  for (const d of [details.daemon, ...arrayOf(details.daemons)]) {
    if (typeof d?.name !== "string" || typeof d.state !== "string") continue;
    if (typeof d.owner === "string" && s.header && d.owner !== s.header.id) continue;
    const key = `daemon:${d.name}`;
    if (!DAEMON_LIVE.has(d.state)) s.wakes.delete(key);
    else if (!s.wakes.has(key)) s.wakes.set(key, { label: `supervised process ${d.name}`, setAt: tsOf(d.startedAt) ?? at ?? 0, until: null });
  }
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  /** When the toolResult record was written, for showing how long the call took. */
  at: number | null;
}

/** The outcome a toolResult record carries, for merging into its call. */
export function toolOutcomeOf(rec: any): ToolOutcome | null {
  const m = rec?.message;
  if (rec?.type !== "message" || m?.role !== "toolResult") return null;
  return { isError: m.isError === true, text: textOf(m.content), at: tsOf(m.timestamp) };
}

/**
 * Timeline events for one record. `outcome` resolves a tool call id to its
 * result when that has been written; a call without one is still running.
 * Ids are `<record index>.<n>`, stable for the life of the file.
 */
export function ompEvents(
  rec: any,
  index: number,
  outcome: (callId: string) => ToolOutcome | null | undefined,
): TimelineEvent[] {
  if (!rec || typeof rec !== "object") return [];
  const at = tsOf(rec.timestamp) ?? 0;
  const id = (n: number | string) => `${index}.${n}`;

  if (rec.type === "compaction") {
    const short = typeof rec.shortSummary === "string" ? rec.shortSummary : "";
    return [{ id: id(0), at, kind: "meta", text: short ? `Context compacted: ${oneLine(short, 200)}` : "Context compacted", tone: "info" }];
  }
  if (rec.type === "custom_message") {
    if (rec.display === false) return [];
    const text = textOf(rec.content).trim();
    if (!text) return [];
    return [{ id: id(0), at, kind: "meta", text: clip(`[${rec.customType ?? "message"}] ${text}`, 2000), tone: "info" }];
  }
  if (rec.type !== "message") return [];
  const m = rec.message;
  if (!m || typeof m !== "object") return [];
  const when = tsOf(m.timestamp) ?? at;

  if (m.role === "user") {
    const images = imagesIn(m.content);
    const ev: TimelineEvent = { id: id(0), at: when, kind: "user", text: textOf(m.content) };
    if (images > 0) (ev as { images?: number }).images = images;
    return [ev];
  }
  if (m.role === "developer") {
    const text = textOf(m.content).trim();
    return text ? [{ id: id(0), at: when, kind: "meta", text: clip(text, 2000), tone: "info" }] : [];
  }
  if (m.role !== "assistant") return [];

  const out: TimelineEvent[] = [];
  const blocks: any[] = Array.isArray(m.content) ? m.content : [];
  blocks.forEach((b, j) => {
    if (!b || typeof b !== "object") return;
    if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
      out.push({ id: id(j), at: when, kind: "thinking", text: b.thinking });
    } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      out.push({ id: id(j), at: when, kind: "assistant", text: b.text });
    } else if (b.type === "toolCall" && typeof b.id === "string") {
      const r = outcome(b.id);
      const ev: TimelineEvent = {
        id: id(j),
        at: when,
        kind: "tool",
        name: typeof b.name === "string" ? b.name : "tool",
        summary: toolSummary(b.arguments, b.intent),
        status: r ? (r.isError ? "error" : "ok") : "running",
      };
      const input = argsJson(b.arguments);
      if (input) ev.input = input;
      if (typeof b.intent === "string" && b.intent.trim() && ev.summary !== oneLine(b.intent, 200)) ev.title = oneLine(b.intent, 200);
      const questions = b.name === "ask" ? askQuestionsOf(b.arguments) : null;
      if (questions) ev.ask = { id: b.id, questions, answers: r ? ompAskAnswers(r.text, questions) : undefined };
      if (r?.text) ev.output = clip(r.text, 4000);
      if (typeof r?.at === "number" && r.at > when) ev.endedAt = r.at;
      out.push(ev);
    }
  });
  if (m.stopReason === "error" || m.stopReason === "aborted") {
    const msg = typeof m.errorMessage === "string" && m.errorMessage ? m.errorMessage : m.stopReason === "aborted" ? "Interrupted" : "Error";
    out.push({ id: id("e"), at: when, kind: "meta", text: clip(msg, 1000), tone: m.stopReason === "aborted" ? "warn" : "error" });
  }
  return out;
}

/**
 * What you answered an `ask`, by question text, from its result: `User
 * selected: Blue` for one question, and for several a line per question id,
 * `color: "Teal please"` or `sizes: [Small, Large]`. Undefined for anything
 * else (a cancel reads "Ask input was cancelled").
 */
export function ompAskAnswers(output: string, questions: AskQuestion[]): Record<string, string> | undefined {
  const unwrap = (v: string) => v.trim().replace(/^\[(.*)\]$/, "$1").replace(/^"(.*)"$/, "$1");
  const one = /^User (?:selected|answered|provided)[^:\n]*:\s*(.+)$/.exec(output.trim());
  if (one && questions.length === 1) return { [questions[0]!.question]: unwrap(one[1]!) };
  if (!output.startsWith("User answers:")) return undefined;
  const out: Record<string, string> = {};
  for (const line of output.split("\n").slice(1)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    const q = m && questions.find((x) => x.header === m[1]!.trim());
    if (q) out[q.question] = unwrap(m![2]!);
  }
  return Object.keys(out).length ? out : undefined;
}

/** The title from the fixed-width slot on line 0, or null. */
export function titleFromSlot(line: string): string | null {
  try {
    const v = JSON.parse(line);
    return v?.type === "title" && typeof v.title === "string" && v.title.trim() ? v.title.trim() : null;
  } catch {
    return null;
  }
}

/** `2026-08-30T04-36-10-023Z_<uuid>.jsonl` → the uuid. */
export function sessionIdFromFileName(name: string): string | null {
  const m = /^\d{4}-\d\d-\d\dT[\d-]+Z_([0-9a-f-]{8,})\.jsonl$/i.exec(name);
  return m ? m[1]! : null;
}

/** `2026-08-30T04-36-10-023Z_…` → epoch ms of the session's creation. */
export function startFromFileName(name: string): number | null {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z_/.exec(name);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * omp's directory name for a cwd (`session-paths.ts`, 17.2.x): home-relative
 * paths become `-a-b`, temp-relative ones `-tmp-a`, anything else the legacy
 * `--abs-path--`. Callers pass paths already resolved through symlinks, as
 * omp canonicalises before encoding.
 */
export function ompSlug(cwd: string, home: string, tmp: string): string {
  const rel = (base: string): string | null => {
    if (cwd === base) return "";
    return cwd.startsWith(`${base}/`) ? cwd.slice(base.length + 1) : null;
  };
  const encode = (prefix: string, r: string) => {
    const e = r.replace(/[/\\:]/g, "-");
    return e ? (prefix.endsWith("-") ? `${prefix}${e}` : `${prefix}-${e}`) : prefix;
  };
  const h = rel(home);
  if (h !== null) return encode("-", h);
  const t = rel(tmp);
  if (t !== null) return encode("-tmp", t);
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
