/** devin's transcripts, folded into provider-neutral facts and events. Pure.
 *
 * devin (3000.11) keeps a session in two places:
 *
 *   sessions.db                      the live store: a message *forest* per
 *                                    session (compaction copies, subagent
 *                                    chains), prompt_history, session rows
 *   transcripts/<id>.json            an ATIF-v1.7 export of the main chain,
 *                                    rewritten whole at the end of every turn
 *                                    ("save_session_state: Exported
 *                                    conversation to …" in devin's log)
 *
 * The ATIF export is the readable one — a flat list of steps, each agent step
 * with its reasoning, tool calls, their observations and token metrics — but it
 * is only written at a turn's end, so reading it freezes a working session's
 * timeline until the turn finishes. The forest is written message by message as
 * the turn runs, so it is the timeline's source (`chainTo`, `chainFacts`,
 * `chainEvents`): the chain from the session's `main_chain_id` back to a root,
 * OpenAI-style chat messages. A compaction starts a new chain whose summary
 * node's `summarized_from` is the old chain's last node, so following it gives
 * the whole conversation, not just the part since the last one. The export is
 * the fallback, for a session the database has no nodes for at all.
 *
 * The prompt that STARTED the current turn is in `prompt_history` as soon as it
 * is sent, and is shown as a pending user event until the forest has its node.
 *
 * Step shape (confirmed across 70 local transcripts):
 *   { step_id, timestamp, source: "system" | "user" | "agent", message,
 *     reasoning_content?, model_name?, tool_calls?: [{tool_call_id,
 *     function_name, arguments}], observation?: {results: [{source_call_id,
 *     content}]}, metrics?: {prompt_tokens, completion_tokens, cached_tokens,
 *     extra?: {cache_creation_input_tokens}}, extra: {generation_model?} }
 *
 * `prompt_tokens` is the whole input: uncached + cache reads + cache writes
 * (checked against the per-message metrics in sessions.db, which split them).
 */

import type { AskQuestion, TimelineEvent, TokenTotals } from "../types";
import type { TranscriptFacts } from "./types";
import { askQuestionsOf } from "./ask";
import { addUsage, emptyTotals } from "../pricing";
import type { DevinPrompt, DevinSessionRow } from "./devin-db";

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function oneLine(s: string, n: number): string {
  return clip(s.replace(/\s+/g, " ").trim(), n);
}

function ts(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A message or observation body: a string, or ATIF content parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && typeof (p as any).text === "string" ? (p as any).text : ""))
    .filter(Boolean)
    .join("\n");
}

function imagesIn(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((p) => p && typeof p === "object" && /image/.test(String((p as any).type))).length;
}

/** One line for a tool call: the argument a reader scans for. */
export function devinToolSummary(args: unknown): string {
  if (!args || typeof args !== "object") return typeof args === "string" ? oneLine(args, 200) : "";
  const a = args as Record<string, unknown>;
  if (Array.isArray(a.questions)) return oneLine((a.questions[0] as any)?.question ?? "asked a question", 200);
  for (const k of ["command", "file_path", "path", "pattern", "query", "url", "profile", "task", "name"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return oneLine(v, 200);
  }
  return "";
}

/**
 * The answers in an ask_user_question result. It reads
 * `User answered your questions:\n{ "<question>": { "selected": [...],
 * "custom_text"?, "skipped" } }` — the labels you picked, or the text you
 * typed, one line per question. Null for anything else (a cancel reads
 * "Canceled due to user interrupt").
 */
export function devinAskAnswers(output: string): Record<string, string> | undefined {
  if (!output.startsWith("User answered your questions:")) return undefined;
  const at = output.indexOf("{");
  if (at < 0) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(output.slice(at, output.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [q, v] of Object.entries(parsed)) {
    if (!v || typeof v !== "object") continue;
    const a = v as { selected?: unknown; custom_text?: unknown; skipped?: unknown };
    const parts = (Array.isArray(a.selected) ? a.selected : []).filter((l): l is string => typeof l === "string" && l !== "Other");
    const other = typeof a.custom_text === "string" ? a.custom_text.trim() : "";
    if (other) parts.push(other);
    if (parts.length) out[q] = parts.join(", ");
    else if (a.skipped === true) out[q] = "skipped";
  }
  return Object.keys(out).length ? out : undefined;
}

export interface AtifParse {
  events: TimelineEvent[];
  tokens: TokenTotals;
  /** The model id of the newest agent step (`swe-2-max`, `claude-fable-5-1-high`). */
  model: string | null;
  lastMessage: string | null;
  /** The newest request's whole window: its prompt plus its completion. */
  contextUsed: number | null;
  firstStepAt: number | null;
  lastStepAt: number | null;
  /** User messages in order, for when prompt_history is unreadable. */
  userPrompts: string[];
  /** Whether the conversation ends mid-turn; null when the source cannot say
   *  (the export is only written between turns). */
  turnOpen: boolean | null;
}

export function parseAtif(doc: unknown): AtifParse {
  const out: AtifParse = {
    events: [],
    tokens: emptyTotals(),
    model: null,
    lastMessage: null,
    contextUsed: null,
    firstStepAt: null,
    lastStepAt: null,
    userPrompts: [],
    turnOpen: null,
  };
  const d = (doc ?? {}) as { steps?: unknown; agent?: { model_name?: unknown } };
  const steps = Array.isArray(d.steps) ? (d.steps as any[]) : [];

  for (const s of steps) {
    if (!s || typeof s !== "object") continue;
    const at = ts(s.timestamp) ?? out.lastStepAt ?? 0;
    if (ts(s.timestamp) !== null) {
      out.firstStepAt ??= at;
      out.lastStepAt = Math.max(out.lastStepAt ?? 0, at);
    }
    const base = `s${s.step_id ?? out.events.length}`;

    if (s.source === "user") {
      const text = textOf(s.message);
      if (text.trim()) out.userPrompts.push(text.trim());
      const ev: TimelineEvent = { id: `${base}.u`, at, kind: "user", text };
      const images = imagesIn(s.message);
      if (images > 0) (ev as { images?: number }).images = images;
      out.events.push(ev);
      continue;
    }
    // System steps are devin's own prompt, rules and skill listings.
    if (s.source !== "agent") continue;

    const model = typeof s.model_name === "string" && s.model_name ? s.model_name : s.extra?.generation_model;
    if (typeof model === "string" && model) out.model = model;

    const m = s.metrics;
    if (m && typeof m === "object") {
      const prompt = num(m.prompt_tokens);
      const cacheRead = num(m.cached_tokens);
      const cacheWrite = num(m.extra?.cache_creation_input_tokens);
      const output = num(m.completion_tokens);
      addUsage(out.tokens, out.model, {
        input: Math.max(0, prompt - cacheRead - cacheWrite),
        output,
        cacheRead,
        cacheWrite,
      });
      if (prompt > 0) out.contextUsed = prompt + output;
    }

    if (typeof s.reasoning_content === "string" && s.reasoning_content.trim()) {
      out.events.push({ id: `${base}.r`, at, kind: "thinking", text: s.reasoning_content });
    }
    const said = textOf(s.message);
    if (said.trim()) {
      out.events.push({ id: `${base}.m`, at, kind: "assistant", text: said });
      const t = said.trim();
      out.lastMessage = t.length > 300 ? `…${t.slice(-299)}` : t;
    }
    const results = new Map<string, string>();
    for (const r of Array.isArray(s.observation?.results) ? s.observation.results : []) {
      if (r && typeof r.source_call_id === "string") results.set(r.source_call_id, textOf(r.content));
    }
    const calls: any[] = Array.isArray(s.tool_calls) ? s.tool_calls : [];
    calls.forEach((c, i) => {
      if (!c || typeof c !== "object") return;
      const output = typeof c.tool_call_id === "string" ? results.get(c.tool_call_id) : undefined;
      const ev: TimelineEvent = {
        id: `${base}.t${i}`,
        at,
        kind: "tool",
        name: typeof c.function_name === "string" ? c.function_name : "tool",
        summary: devinToolSummary(c.arguments),
        // The export is written at a turn's end, so every call in it has
        // finished; ATIF records no success flag, so "ok" means "returned".
        status: "ok",
      };
      if (c.arguments !== undefined) {
        try {
          ev.input = clip(typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments, null, 2), 4000);
        } catch {
          /* unserialisable */
        }
      }
      if (typeof c.function_name === "string" && c.function_name === "ask_user_question") {
        const questions = askQuestionsOf(c.arguments);
        if (questions) ev.ask = { id: String(c.tool_call_id ?? `${base}.t${i}`), questions, answers: output ? devinAskAnswers(output) : undefined };
      }
      if (output) ev.output = clip(output, 4000);
      out.events.push(ev);
    });
  }
  return out;
}

/** What is kept of one message-forest node: enough to walk the chain and fold
 *  its facts. Its text is read back from the database when a page shows it,
 *  so memory follows the node count, not the forest's tens of megabytes. */
export interface DevinNode {
  id: number;
  rowId: number;
  parent: number | null;
  /** The previous chain's last node, on a compaction's summary. */
  summarizedFrom: number | null;
  at: number;
  role: string;
  /** A user message whole (the prompts); an assistant's tail, for `lastMessage`. */
  said: string;
  model: string | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  /** On an assistant message: the tool calls it made. */
  calls: string[];
  /** On a tool message: the call it answers. */
  answers: string | null;
  /** The assistant stopped to run tools rather than to hand the turn back. */
  wantsTools: boolean;
}

export interface DevinNodeInput {
  row_id: number;
  node_id: number;
  parent_node_id: number | null;
  created_at: number;
  chat_message: string;
  metadata: string | null;
}

export function parseMessage(json: string): any {
  try {
    const m = JSON.parse(json);
    return m && typeof m === "object" ? m : null;
  } catch {
    return null;
  }
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > 300 ? `…${t.slice(-299)}` : t;
}

/** Parse one `message_nodes` row. Null for a row that is not a message. */
export function devinNode(row: DevinNodeInput): DevinNode | null {
  const m = parseMessage(row.chat_message);
  if (!m) return null;
  const meta = row.metadata ? parseMessage(row.metadata) : null;
  const md = m.metadata ?? {};
  const metrics = md.metrics;
  const calls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  const text = m.role === "user" || m.role === "assistant" ? textOf(m.content) : "";
  return {
    id: row.node_id,
    rowId: row.row_id,
    parent: row.parent_node_id,
    summarizedFrom: typeof meta?.summarized_from === "number" ? meta.summarized_from : null,
    at: ts(md.created_at) ?? row.created_at * 1000,
    role: typeof m.role === "string" ? m.role : "",
    said: m.role === "assistant" ? tail(text) : text,
    model: typeof md.generation_model === "string" && md.generation_model ? md.generation_model : null,
    usage:
      metrics && typeof metrics === "object"
        ? {
            input: num(metrics.input_tokens),
            output: num(metrics.output_tokens),
            cacheRead: num(metrics.cache_read_tokens),
            cacheWrite: num(metrics.cache_creation_tokens),
          }
        : null,
    calls: calls.map((c) => (c && typeof c.id === "string" ? c.id : "")).filter(Boolean),
    answers: m.role === "tool" && typeof m.tool_call_id === "string" ? m.tool_call_id : null,
    wantsTools: m.role === "assistant" && (calls.length > 0 || md.finish_reason === "tool_calls"),
  };
}

/** A node on the conversation, and whether a compaction happened just before it. */
export interface ChainLink {
  node: DevinNode;
  compacted: boolean;
}

/** Whether `node` reaches `ancestor` by parent (or a compaction's summary). */
function descendsFrom(nodes: ReadonlyMap<number, DevinNode>, node: DevinNode, ancestor: number): boolean {
  const seen = new Set<number>();
  for (let at: number | null = node.parent; at !== null && !seen.has(at); ) {
    if (at === ancestor) return true;
    seen.add(at);
    const n = nodes.get(at);
    at = n?.summarizedFrom ?? n?.parent ?? null;
  }
  return false;
}

/**
 * The node the conversation is really at. `main_chain_id` is the last
 * *committed* node: the assistant's tool call is written as soon as it decides
 * to make it, and its result lands when the tool finishes, so the step in
 * flight — the thinking and the command being run — is a descendant the session
 * has not moved its head to yet. Follow the newest such descendant, so the
 * timeline shows a running command while it runs instead of only its result.
 */
export function liveHead(nodes: ReadonlyMap<number, DevinNode>, committed: number | null): number | null {
  const at = committed === null ? null : nodes.get(committed);
  if (!at) return committed;
  let best: DevinNode | null = null;
  for (const n of nodes.values()) {
    if (n.rowId <= at.rowId || (best && n.rowId <= best.rowId)) continue;
    if (descendsFrom(nodes, n, at.id)) best = n;
  }
  return best ? best.id : committed;
}

/** The conversation ending at `head`, oldest first, through every compaction. */
export function chainTo(nodes: ReadonlyMap<number, DevinNode>, head: number | null): ChainLink[] {
  const out: ChainLink[] = [];
  const seen = new Set<number>();
  let compacted = false;
  for (let at: number | null = head; at !== null && !seen.has(at); ) {
    seen.add(at);
    const n = nodes.get(at);
    if (!n) break;
    out.push({ node: n, compacted });
    compacted = false;
    if (n.summarizedFrom !== null && nodes.has(n.summarizedFrom)) {
      compacted = true;
      at = n.summarizedFrom;
    } else at = n.parent;
  }
  return out.reverse();
}

/** The chain's facts, as the export's would be (no events: those are read per page). */
export function chainFacts(chain: readonly ChainLink[]): AtifParse {
  const out: AtifParse = {
    events: [],
    tokens: emptyTotals(),
    model: null,
    lastMessage: null,
    contextUsed: null,
    firstStepAt: null,
    lastStepAt: null,
    userPrompts: [],
    turnOpen: null,
  };
  for (const { node: n } of chain) {
    if (n.role !== "user" && n.role !== "assistant") continue;
    out.firstStepAt ??= n.at;
    out.lastStepAt = Math.max(out.lastStepAt ?? 0, n.at);
    if (n.role === "user") {
      if (n.said.trim()) out.userPrompts.push(n.said.trim());
      continue;
    }
    if (n.model) out.model = n.model;
    if (n.usage) {
      addUsage(out.tokens, out.model, n.usage);
      out.contextUsed = n.usage.input + n.usage.cacheRead + n.usage.cacheWrite + n.usage.output;
    }
    if (n.said) out.lastMessage = n.said;
  }
  // The forest is written message by message: a turn is over only when the
  // assistant last spoke without asking for tools.
  const last = chain.at(-1)?.node ?? null;
  out.turnOpen = last !== null && (last.role !== "assistant" || last.wantsTools);
  return out;
}

/** The timeline events of `links`, from their messages as read back from the
 *  database (`messages`, by row id), each call joined to its answer. */
export function chainEvents(
  links: readonly ChainLink[],
  messages: ReadonlyMap<number, string>,
  answerOf: ReadonlyMap<string, DevinNode>,
): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const { node: n, compacted } of links) {
    const base = `n${n.id}`;
    if (compacted) out.push({ id: `${base}.c`, at: n.at, kind: "meta", text: "Context compacted; the conversation continues from a summary." });
    if (n.role !== "user" && n.role !== "assistant") continue;
    const m = parseMessage(messages.get(n.rowId) ?? "");
    if (!m) continue;
    if (n.role === "user") {
      out.push({ id: `${base}.u`, at: n.at, kind: "user", text: textOf(m.content) });
      continue;
    }
    const thinking = m.thinking?.thinking;
    if (typeof thinking === "string" && thinking.trim()) out.push({ id: `${base}.r`, at: n.at, kind: "thinking", text: thinking });
    const said = textOf(m.content);
    if (said.trim()) out.push({ id: `${base}.m`, at: n.at, kind: "assistant", text: said });
    const calls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    calls.forEach((c, i) => {
      if (!c || typeof c !== "object") return;
      const answer = typeof c.id === "string" ? answerOf.get(c.id) : undefined;
      const result = answer ? parseMessage(messages.get(answer.rowId) ?? "") : null;
      const ev: TimelineEvent = {
        id: `${base}.t${i}`,
        at: n.at,
        kind: "tool",
        name: typeof c.name === "string" ? c.name : "tool",
        summary: devinToolSummary(c.arguments),
        status: !answer ? "running" : result?.metadata?.extensions?.["chisel/tool_result_meta"]?.success === false ? "error" : "ok",
      };
      const output = result ? textOf(result.content) : "";
      if (typeof c.name === "string" && c.name === "ask_user_question") {
        const questions = askQuestionsOf(c.arguments);
        if (questions) ev.ask = { id: String(c.id ?? `${base}.t${i}`), questions, answers: output ? devinAskAnswers(output) : undefined };
      }
      if (c.arguments !== undefined) {
        try {
          ev.input = clip(typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments, null, 2), 4000);
        } catch {
          /* unserialisable */
        }
      }
      if (output) ev.output = clip(output, 4000);
      if (answer && answer.at > n.at) ev.endedAt = answer.at;
      out.push(ev);
    });
  }
  return out;
}

/** Prompts newer than the export, as user events: the turn in progress. */
export function pendingPromptEvents(prompts: DevinPrompt[], afterMs: number | null): TimelineEvent[] {
  return prompts
    .filter((p) => afterMs === null || p.timestamp * 1000 > afterMs)
    .map((p) => ({ id: `p${p.id}`, at: p.timestamp * 1000, kind: "user" as const, text: p.content }));
}

/**
 * Rate-limit and quota failures from a devin process log.
 *
 * devin does not put these in the transcript; its agent loop logs them, once
 * per exhausted retry budget, as
 *   `<iso> ERROR affogato::agent::control_loop: attempts=3
 *    error=Inference(ServerError(message=Reached free model rate limit. …
 *    (trace ID: …))) Exhausted inference retries; stopping turn`
 * Only ERROR lines count: the WARN lines before them are the retries.
 */
export function parseDevinRateLimits(text: string): { at: number; detail: string }[] {
  const out: { at: number; detail: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^(\S+Z)\s+ERROR\s+(.*)$/.exec(line);
    if (!m) continue;
    const body = m[2]!;
    if (!/rate.?limit|quota|usage limit|UsageLimitReached|QuotaExhausted/i.test(body)) continue;
    const at = Date.parse(m[1]!);
    if (Number.isNaN(at)) continue;
    const msg = /message=(.*?)(?: \(trace ID|\)\)|$)/.exec(body)?.[1] ?? body;
    const detail = oneLine(msg, 200);
    // A turn with subagents logs the same failure once per agent, ms apart.
    const key = `${Math.floor(at / 1000)}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at, detail });
  }
  return out;
}

export interface DevinFactsInput {
  id: string;
  row: DevinSessionRow | null;
  prompts: DevinPrompt[];
  atif: AtifParse | null;
  rateLimitHits: { at: number; detail: string }[];
  /** An ask_user_question call still waiting for its answer. */
  pendingAsk?: { id: string; questions: AskQuestion[] } | null;
}

export function devinFacts(i: DevinFactsInput): TranscriptFacts {
  const { row, prompts, atif } = i;
  const lastPrompt = prompts.length > 0 ? prompts[prompts.length - 1]! : null;
  const lastPromptAt = lastPrompt ? lastPrompt.timestamp * 1000 : null;
  const activity = row ? row.last_activity_at * 1000 : null;
  // A prompt sent after the last exported step is a turn still running. With
  // no export at all, compare against the row (seconds, so >=: a fresh
  // session's first prompt lands in the same second it is created).
  const turnOpen =
    atif?.turnOpen ??
    (lastPromptAt !== null &&
      (atif?.lastStepAt != null ? lastPromptAt > atif.lastStepAt : activity === null || lastPromptAt >= activity));
  const times = [activity, lastPromptAt, atif?.lastStepAt ?? null].filter((x): x is number => x !== null);
  return {
    agentSessionId: i.id,
    cwd: row?.working_directory ?? null,
    // devin records the directory on the session row; `devin -r` finds the
    // session from anywhere, but running it there keeps trust and tools right.
    resumeCwd: row?.working_directory ?? null,
    title: row?.title ?? null,
    firstPrompt: prompts[0]?.content ?? atif?.userPrompts[0] ?? null,
    lastPrompt: lastPrompt?.content ?? atif?.userPrompts[atif.userPrompts.length - 1] ?? null,
    lastPromptAt,
    lastMessage: atif?.lastMessage ?? null,
    model: atif?.model ?? (row?.model || null),
    gitBranch: null,
    startedAt: row ? row.created_at * 1000 : (atif?.firstStepAt ?? null),
    lastActivityAt: times.length > 0 ? Math.max(...times) : null,
    turnOpen,
    contextUsed: atif?.contextUsed ?? null,
    contextLimit: null,
    tokens: atif ? { ...atif.tokens } : emptyTotals(),
    usage: null,
    rateLimitHits: i.rateLimitHits,
    isSubagent: false,
    parentId: null,
    pendingAsk: i.pendingAsk ?? null,
  };
}
