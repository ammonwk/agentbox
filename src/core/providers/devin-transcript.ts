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
 * with its reasoning, tool calls, their observations and token metrics — so it
 * is the timeline's source. Its one weakness is that it is only written at a
 * turn's end; the prompt that STARTED the current turn is already in
 * `prompt_history`, and is shown as a pending user event until the export
 * catches up.
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

import type { TimelineEvent, TokenTotals } from "../types";
import type { TranscriptFacts } from "./types";
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
  for (const k of ["command", "file_path", "path", "pattern", "query", "url", "profile", "task", "name"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return oneLine(v, 200);
  }
  return "";
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
      if (output) ev.output = clip(output, 4000);
      out.events.push(ev);
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
    lastPromptAt !== null &&
    (atif?.lastStepAt != null ? lastPromptAt > atif.lastStepAt : activity === null || lastPromptAt >= activity);
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
  };
}
