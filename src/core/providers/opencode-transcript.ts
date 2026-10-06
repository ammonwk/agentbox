/** opencode 2.0's session messages, folded into provider-neutral facts and
 * timeline events.
 *
 * Pure: rows in, summaries, facts and events out. The database is
 * `opencode-db.ts`'s, the incremental reading `opencode.ts`'s.
 *
 * A session is `session_message` rows in seq order, `data` a JSON object
 * whose shape depends on `type` (confirmed against opencode 2.0.12–2.0.14):
 *
 *   user        {time:{created}, text, files:[{mime,…}], agents}
 *   assistant   one model step: {time:{created, streamed?, completed?},
 *               model:{id, providerID, variant?}, content:[reasoning | text |
 *               tool], tokens:{input, output, reasoning, cache:{read,
 *               write}}, finish, error?:{type, message, status?}, retry?}
 *               — rewritten in place while the step runs; a tool block is
 *               {id, name, state:{status: pending|running|completed|error,
 *               input, content:[{type:"text",text}], error?, metadata}, time}
 *   idle        the turn ended: {outcome: succeeded | failed | interrupted}
 *   synthetic   something delivered into the conversation that you did not
 *               type: a background shell's or subagent's result
 *               (metadata.source "shell" | "subagent"), "Continue." nudges
 *   system      instruction changes (the date, an edited AGENTS.md)
 *   compaction  {status, reason, summary}
 *   location-switched  {location:{directory}}
 *   agent-switched     {agent}
 */

import type { AskQuestion, TimelineEvent, TokenTotals } from "../types";
import type { LimitHit, TranscriptFacts, Wake } from "./types";
import { addUsage, emptyTotals } from "../pricing";
import { capJson } from "./jsonl-reader";
import { countSlugs, mostNamed, prReposIn } from "../prrepo";
import { askQuestionsOf } from "./ask";
import { clip, ompErrorKind, toolSummary } from "./omp-transcript";
import type { OpencodeChildRow, OpencodeMessageRow, OpencodeSessionRow } from "./opencode-db";

const PROMPT_CAP = 2000;

function oneLine(s: string, n: number): string {
  return clip(s.replace(/\s+/g, " ").trim(), n);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function parseData(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** `{id, providerID}` (a message's or the session row's) as `provider/id`. */
export function modelName(m: unknown): string | null {
  const o = (typeof m === "string" ? parseData(m) : m) as { id?: unknown; providerID?: unknown } | null;
  const id = str(o?.id);
  if (!id) return null;
  const p = str(o?.providerID);
  return p ? `${p}/${id}` : id;
}

/** What one row contributes to the facts, kept so that a row rewritten in
 *  place (a running step) can be folded again without re-reading the rest. */
export interface RowSummary {
  seq: number;
  type: string;
  at: number;
  updated: number;
  /** Bumped by the reader each time this row changed (`since`). */
  ver: number;
  /** Produces timeline events. */
  shown: boolean;
  /** Still being written: an assistant step not completed, or with a tool
   *  not finished; a compaction still running. Re-read until it settles. */
  open: boolean;
  /** user: the prompt, capped. */
  text?: string;
  /** assistant */
  model?: string | null;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  context?: number;
  completedAt?: number | null;
  said?: string;
  finish?: string | null;
  error?: { type: string; message: string; status: number | null } | null;
  /** A `question` call still waiting for its answer. */
  ask?: { id: string; questions: AskQuestion[] } | null;
  /** Background shells and subagents this step started: id → label. */
  started?: [string, string][];
  /** synthetic: the background job whose end this reports. */
  ended?: string | null;
  /** location-switched: where the session moved. */
  dir?: string;
  repos?: string[];
}

function textParts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

const TOOL_OPEN = new Set(["pending", "running"]);

/** Fold one row into its summary. `ver` is the reader's. */
export function summarize(row: OpencodeMessageRow, ver: number): RowSummary {
  const d = parseData(row.data) ?? {};
  const at = num(d.time?.created) || row.time_created;
  const s: RowSummary = { seq: row.seq, type: row.type, at, updated: row.time_updated, ver, shown: false, open: false };
  const repos: string[] = [];
  switch (row.type) {
    case "user": {
      const text = typeof d.text === "string" ? d.text : "";
      s.text = text.trim().slice(0, PROMPT_CAP);
      repos.push(...prReposIn(text));
      s.shown = true;
      break;
    }
    case "assistant": {
      s.model = modelName(d.model);
      const t = d.tokens;
      if (t && typeof t === "object") {
        s.tokens = { input: num(t.input), output: num(t.output) + num(t.reasoning), cacheRead: num(t.cache?.read), cacheWrite: num(t.cache?.write) };
        const total = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
        if (total > 0 && !d.error) s.context = total;
      }
      s.completedAt = num(d.time?.completed) || null;
      s.finish = str(d.finish);
      s.error = d.error && typeof d.error === "object"
        ? { type: str(d.error.type) ?? "unknown", message: String(d.error.message ?? ""), status: typeof d.error.status === "number" ? d.error.status : null }
        : null;
      const blocks: any[] = Array.isArray(d.content) ? d.content : [];
      let toolOpen = false;
      const started: [string, string][] = [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") repos.push(...prReposIn(b.text));
        if (b?.type !== "tool") continue;
        const st = b.state ?? {};
        const status = str(st.status) ?? "pending";
        if (TOOL_OPEN.has(status)) toolOpen = true;
        const input = st.input ?? {};
        repos.push(...prReposIn(typeof input.command === "string" ? input.command : ""));
        if (b.name === "question" && TOOL_OPEN.has(status) && typeof b.id === "string") {
          const questions = askQuestionsOf(input);
          if (questions) s.ask = { id: b.id, questions };
        }
        if (status === "completed" && input.background === true) {
          const shell = str(st.metadata?.shellID);
          const child = str(st.metadata?.sessionID);
          if (shell) started.push([shell, `background job ${shell}${typeof input.command === "string" ? ` (${oneLine(input.command, 80)})` : ""}`]);
          else if (child) started.push([child, `subagent ${str(input.description) ?? child}`]);
        }
      }
      if (started.length) s.started = started;
      const said = textParts(blocks).trim();
      if (said) s.said = said.length > 300 ? `…${said.slice(-299)}` : said;
      s.open = !s.completedAt || toolOpen;
      s.shown = blocks.length > 0 || !!s.error;
      break;
    }
    case "synthetic": {
      const m = d.metadata ?? {};
      if (m.source === "shell") s.ended = str(m.shellID) ?? str(m.jobID);
      else if (m.source === "subagent") s.ended = str(m.childID);
      s.shown = typeof d.text === "string" && d.text.trim() !== "";
      break;
    }
    case "system":
      s.shown = typeof d.text === "string" && d.text.trim() !== "";
      break;
    case "compaction":
      s.open = d.status === "running" || d.status === "pending";
      s.shown = true;
      break;
    case "location-switched":
      s.dir = str(d.location?.directory) ?? undefined;
      s.shown = !!s.dir;
      break;
  }
  if (repos.length) s.repos = repos;
  return s;
}

/** A limit the provider refused on, rather than a fault: 429s and quota
 *  errors, but not running out of prepaid funds, which no wait fixes. */
function isLimit(e: NonNullable<RowSummary["error"]>): boolean {
  if (/insufficient (account )?(funds|balance|credits)/i.test(e.message)) return false;
  if (e.type === "provider.quota" || e.status === 429) return true;
  return /rate.?limit|usage limit|quota|too many requests|FreeUsageLimitError/i.test(e.message);
}

export interface FactsInput {
  id: string;
  row: OpencodeSessionRow | null;
  rows: readonly RowSummary[];
  children: readonly OpencodeChildRow[];
}

export function opencodeFacts({ id, row, rows, children }: FactsInput): TranscriptFacts {
  const tokens: TokenTotals = emptyTotals();
  const repos = new Map<string, number>();
  const hits: LimitHit[] = [];
  const wakes = new Map<string, Wake>();
  let firstPrompt: string | null = null;
  let lastPrompt: string | null = null;
  let lastPromptAt: number | null = null;
  let lastMessage: string | null = null;
  let model: string | null = null;
  let lastActivityAt: number | null = null;
  let lastTurnAt: number | null = null;
  let contextUsed: number | null = null;
  let turnOpen = false;
  let turnError: TranscriptFacts["turnError"] = null;
  let pendingAsk: TranscriptFacts["pendingAsk"] = null;
  let dir: string | null = null;

  for (const r of rows) {
    lastActivityAt = Math.max(lastActivityAt ?? 0, r.at, r.updated);
    if (r.repos) countSlugs(repos, r.repos);
    switch (r.type) {
      case "user":
        turnOpen = true;
        turnError = null;
        pendingAsk = null;
        if (r.text) {
          firstPrompt ??= r.text;
          lastPrompt = r.text;
          lastPromptAt = r.at;
        }
        break;
      case "assistant":
        turnOpen = true;
        if (r.model) model = r.model;
        if (r.tokens) addUsage(tokens, r.model, r.tokens);
        if (r.context) contextUsed = r.context;
        if (r.completedAt) lastTurnAt = r.completedAt;
        if (r.said) lastMessage = r.said;
        pendingAsk = r.ask ?? null;
        for (const [k, label] of r.started ?? []) wakes.set(k, { label, setAt: r.completedAt ?? r.at, until: null });
        turnError = null;
        if (r.error && r.error.type !== "aborted") {
          const who = r.model ?? "";
          if (isLimit(r.error)) {
            const hit: LimitHit = { at: r.at, detail: oneLine(who ? `${who}: ${r.error.message}` : r.error.message, 200) };
            const provider = r.model?.includes("/") ? r.model.slice(0, r.model.indexOf("/")) : null;
            if (provider) hit.provider = provider;
            hits.push(hit);
          } else {
            turnError = { at: r.at, kind: ompErrorKind({ errorStatus: r.error.status, errorMessage: r.error.message }), detail: oneLine(r.error.message || r.error.type, 300) };
          }
        } else if (r.finish === "length") {
          turnError = { at: r.at, kind: "output-cap", detail: "the reply hit the model's output token limit" };
        }
        break;
      case "idle":
        turnOpen = false;
        break;
      case "synthetic":
        if (r.ended) wakes.delete(r.ended);
        break;
      case "compaction":
        contextUsed = null;
        break;
      case "location-switched":
        if (r.dir) dir = r.dir;
        break;
    }
  }
  if (!turnOpen) pendingAsk = null;

  for (const c of children) {
    addUsage(tokens, modelName(c.model), {
      input: num(c.tokens_input),
      output: num(c.tokens_output),
      cacheRead: num(c.tokens_cache_read),
      cacheWrite: num(c.tokens_cache_write),
    });
  }

  const cwd = row?.directory ?? dir;
  const parentId = row?.parent_id ?? null;
  return {
    agentSessionId: id,
    cwd,
    resumeCwd: parentId === null ? cwd : null,
    title: str(row?.title),
    firstPrompt,
    lastPrompt,
    lastPromptAt,
    lastMessage,
    model: model ?? modelName(row?.model ?? null),
    gitBranch: null,
    prRepo: mostNamed(repos),
    startedAt: row?.time_created ?? rows[0]?.at ?? null,
    lastActivityAt: Math.max(lastActivityAt ?? 0, row?.time_updated ?? 0) || null,
    lastTurnAt,
    turnOpen,
    turnError,
    contextUsed,
    contextLimit: null,
    tokens,
    usage: null,
    rateLimitHits: hits,
    isSubagent: parentId !== null,
    parentId,
    wakes: [...wakes.values()],
    pendingAsk,
  };
}

// ------------------------------------------------------------ events

function argsJson(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return undefined;
  try {
    return capJson(args, 4000);
  } catch {
    return undefined;
  }
}

/** What you answered a `question`, by question text: opencode keeps the
 *  chosen labels per question, in order. */
function askAnswers(answers: unknown, questions: AskQuestion[]): Record<string, string> | undefined {
  if (!Array.isArray(answers)) return undefined;
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const a = answers[i];
    if (Array.isArray(a) && a.length) out[q.question] = a.filter((x) => typeof x === "string").join(", ");
  });
  return Object.keys(out).length ? out : undefined;
}

function toolEvent(b: any, id: string, when: number): TimelineEvent {
  const st = b.state ?? {};
  const status = str(st.status) ?? "pending";
  const input = st.input ?? {};
  const ev: TimelineEvent = {
    id,
    at: num(b.time?.created) || when,
    kind: "tool",
    name: str(b.name) ?? "tool",
    summary: toolSummary(input) || oneLine(str(st.title) ?? "", 200),
    status: status === "completed" ? "ok" : status === "error" ? "error" : "running",
  };
  const args = argsJson(input);
  if (args) ev.input = args;
  const desc = str(input.description);
  if (desc && ev.summary !== oneLine(desc, 200)) ev.title = oneLine(desc, 200);
  const out = status === "error" ? String(st.error?.message ?? "") : textParts(st.content);
  if (out) ev.output = clip(out, 4000);
  const ended = num(b.time?.completed);
  if (ended && ended > ev.at && !TOOL_OPEN.has(status)) ev.endedAt = ended;
  if (b.name === "question") {
    const questions = askQuestionsOf(input);
    if (questions) ev.ask = { id: str(b.id) ?? id, questions, answers: askAnswers(st.metadata?.answers, questions) };
  }
  return ev;
}

/** Timeline events for one row. Ids are `<seq>.<n>`, stable for the life of
 *  the session; a row rewritten in place yields the same ids again. */
export function opencodeEvents(row: OpencodeMessageRow): TimelineEvent[] {
  const d = parseData(row.data);
  if (!d || typeof d !== "object") return [];
  const at = num(d.time?.created) || row.time_created;
  const id = (n: number | string) => `${row.seq}.${n}`;
  switch (row.type) {
    case "user": {
      const ev: TimelineEvent = { id: id(0), at, kind: "user", text: typeof d.text === "string" ? d.text : "" };
      const images = Array.isArray(d.files) ? d.files.filter((f: any) => typeof f?.mime === "string" && f.mime.startsWith("image/")).length : 0;
      if (images > 0) (ev as { images?: number }).images = images;
      return [ev];
    }
    case "assistant": {
      const out: TimelineEvent[] = [];
      const blocks: any[] = Array.isArray(d.content) ? d.content : [];
      blocks.forEach((b, j) => {
        if (b?.type === "reasoning" && typeof b.text === "string" && b.text.trim()) {
          out.push({ id: id(j), at: num(b.time?.created) || at, kind: "thinking", text: b.text });
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push({ id: id(j), at, kind: "assistant", text: b.text });
        } else if (b?.type === "tool") {
          out.push(toolEvent(b, id(j), at));
        }
      });
      if (d.error && typeof d.error === "object") {
        const aborted = d.error.type === "aborted";
        const msg = str(d.error.message) ?? (aborted ? "Interrupted" : "Error");
        out.push({ id: id("e"), at: num(d.time?.completed) || at, kind: "meta", text: clip(msg, 1000), tone: aborted ? "warn" : "error" });
      }
      return out;
    }
    case "synthetic":
    case "system": {
      const text = typeof d.text === "string" ? d.text.trim() : "";
      if (!text) return [];
      return [{ id: id(0), at, kind: "meta", text: clip(text, 2000), tone: "info" }];
    }
    case "compaction": {
      const why = str(d.reason);
      return [{ id: id(0), at, kind: "meta", text: why ? `Context compacted (${why})` : "Context compacted", tone: "info" }];
    }
    case "location-switched": {
      const dir = str(d.location?.directory);
      return dir ? [{ id: id(0), at, kind: "meta", text: `Moved to ${dir}`, tone: "info" }] : [];
    }
  }
  return [];
}
