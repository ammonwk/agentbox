/** Where an account's usage went: every model call in its transcripts over
 *  the last days, priced and grouped (`UsageInsights`, the Accounts page's
 *  Usage insights).
 *
 *  A week of one busy Claude account is a gigabyte of transcript, a dozen
 *  seconds to read. So each file is read once and then only what was
 *  appended: its state (an offset, the calls it held, the little the fold
 *  needs to carry on) is kept per account in memory and on disk, the way the
 *  transcript readers keep theirs (`readercache.ts`). What is kept is token
 *  counts and timestamps, a title and a command line per wait — nothing of
 *  the conversation that the transcript is not still the record of.
 *
 *  What the transcripts show that the weekly bar does not:
 *
 *  - Cache reads, not output, are most of the spend: each call re-reads the
 *    whole context, so a session at 600K pays for 600K tokens per tool call.
 *  - Claude caches a session's context for an hour but a subagent's for five
 *    minutes. A subagent that waits longer than that — on a subagent of its
 *    own, a CI watch, a teammate's reply — writes its whole context again,
 *    at 25× the price of reading it. `Rebuild` is that, with what it waited on.
 *  - Subagents and teammates can be most of an account's week while the
 *    board shows one session.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { deserialize, serialize } from "bun:jsc";
import { agentboxHome } from "./paths";
import { priceOf } from "./pricing";
import { classifyUserText } from "./providers/claude-transcript";
import { codexUsage } from "./providers/codex-transcript";
import { isAgentSent } from "./sent";
import { sessionsOnAccounts, tokenSampleAt, tokenSamplesAfter, usageSamplesSince, rateLimitHitsSince } from "./db";
import type { Account, InsightAgent, InsightSession, ProviderId, Rebuild, RebuildCause, Spend, SpendPart, UsageInsights } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Calls are kept this far back, so a 7-day window can slide. */
const KEEP_MS = 8 * DAY;
/** Bump when what a FileState means changes; older caches are dropped. */
const FOLD_VERSION = 1;
/** A call that writes fewer new tokens than this rebuilt nothing worth a row. */
const REBUILD_MIN = 8_000;
const READ_BLOCK = 4 * 1024 * 1024;

// ------------------------------------------------------------------ state

interface Call {
  t: number;
  model: string;
  input: number;
  w5: number;
  w1h: number;
  read: number;
  output: number;
  thinking: number;
  /** Set when this call wrote a cached context again. */
  cause?: RebuildCause;
  gap?: number;
  detail?: string | null;
}

type Wake = "you" | "teammate" | "background";

interface FileState {
  path: string;
  /** The provider's session id: the transcript's, or its parent's for a subagent. */
  key: string;
  agent: { name: string; type: string | null } | null;
  size: number;
  offset: number;
  /** When the file came to be in this home. A session moved here from
   *  another account (`Fleet.wake`) or forked brings its history with it;
   *  calls from before this were not made on this account. */
  born: number;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
  calls: Call[];
  prompts: number[];
  // The fold, carried between reads.
  model: string | null;
  /** Codex: the cumulative total last counted, so a repeated count is not. */
  lastTotal: number;
  /** Claude: recent message ids and their call's index, for the repeats of
   *  one message across its content blocks. -1: before the kept span. */
  ids: string[];
  idx: number[];
  prevT: number | null;
  prevCtx: number;
  prevTtl: "5m" | "1h";
  /** The tool calls of the last assistant message: what it is waiting on. */
  waiting: string[];
  /** Codex: tool calls of the response whose usage has not come yet. */
  queued: string[];
  wake: Wake | null;
  compacted: boolean;
}

interface AccountCache {
  v: number;
  files: Record<string, FileState>;
}

const caches = new Map<string, AccountCache>();
const inflight = new Map<string, Promise<AccountCache>>();

const cachePath = (accountId: string): string => join(agentboxHome(), "cache", "insights", `${accountId}.bin`);

function loadCache(accountId: string): AccountCache {
  let c = caches.get(accountId);
  if (c) return c;
  try {
    const d = deserialize(readFileSync(cachePath(accountId))) as AccountCache;
    if (d?.v === FOLD_VERSION && d.files) c = d;
  } catch {
    /* none yet, or unreadable: start over */
  }
  c ??= { v: FOLD_VERSION, files: {} };
  caches.set(accountId, c);
  return c;
}

function saveCache(accountId: string, c: AccountCache): void {
  try {
    const p = cachePath(accountId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(`${p}.tmp`, new Uint8Array(serialize(c)));
    renameSync(`${p}.tmp`, p);
  } catch {
    /* the next server reads again; nothing is lost */
  }
}

// ------------------------------------------------------------------ files

/** Every `.jsonl` under `root` written since `sinceMs`. */
function transcriptsUnder(root: string, sinceMs: number): { path: string; size: number; born: number }[] {
  const out: { path: string; size: number; born: number }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        // A Claude session's tool output is kept beside it; nothing to count there.
        if (e.name !== "tool-results" && depth < 6) walk(p, depth + 1);
      } else if (e.name.endsWith(".jsonl")) {
        try {
          const st = statSync(p);
          if (st.mtimeMs >= sinceMs) out.push({ path: p, size: st.size, born: st.birthtimeMs || 0 });
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Calls each line of `path` from `from` to its last newline; returns the
 *  offset after it. Reads in blocks and yields between them, so a gigabyte
 *  does not hold the server up. */
async function readLines(path: string, from: number, size: number, onLine: (line: string) => void): Promise<number> {
  const dec = new TextDecoder();
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return from;
  }
  let pos = from;
  let carry: Buffer | null = null;
  try {
    while (pos < size) {
      const buf = Buffer.allocUnsafe(Math.min(READ_BLOCK, size - pos));
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const chunk: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, start)) {
        if (i > start) onLine(dec.decode(chunk.subarray(start, i)));
        start = i + 1;
      }
      carry = start < chunk.length ? Buffer.from(chunk.subarray(start)) : null;
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    closeSync(fd);
  }
  return pos - (carry?.length ?? 0);
}

function newState(path: string, key: string, agent: FileState["agent"], born: number): FileState {
  return {
    path, key, agent, size: 0, offset: 0, born, cwd: null, title: null, firstPrompt: null, calls: [], prompts: [],
    model: null, lastTotal: -1, ids: [], idx: [], prevT: null, prevCtx: 0, prevTtl: "1h", waiting: [], queued: [], wake: null, compacted: false,
  };
}

// ----------------------------------------------------------------- the fold

/** Records a call, judging first whether it wrote a cached context again. */
function addCall(s: FileState, c: Call, keepFrom: number): number {
  const fresh = c.input + c.w5 + c.w1h;
  const ctx = fresh + c.read;
  if (s.prevT !== null && s.prevCtx >= REBUILD_MIN && fresh >= REBUILD_MIN && c.read < s.prevCtx * 0.5) {
    const gap = c.t - s.prevT;
    const ttl = s.prevTtl === "1h" ? HOUR : 5 * 60_000;
    c.gap = gap;
    c.detail = null;
    if (s.compacted) c.cause = "compact";
    else if (gap < ttl) c.cause = "miss";
    else if (s.wake) c.cause = s.wake;
    else {
      const sub = s.waiting.find((w) => /^(Agent|Task)\b/.test(w));
      c.detail = sub ?? s.waiting[s.waiting.length - 1] ?? null;
      c.cause = sub ? "subagent" : c.detail ? "command" : "you";
    }
  }
  s.prevT = c.t;
  s.prevCtx = ctx;
  if (c.w1h > 0 || c.w5 > 0) s.prevTtl = c.w1h >= c.w5 ? "1h" : "5m";
  s.waiting = [];
  s.wake = null;
  s.compacted = false;
  if (c.t < keepFrom) return -1;
  s.calls.push(c);
  return s.calls.length - 1;
}

const oneLine = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** What a tool call was, for a wait's label: the command, the subagent's task. */
function toolLabel(b: any): string {
  const name = String(b?.name ?? "tool");
  const i = b?.input ?? {};
  if (name === "Bash" && typeof i.command === "string") return `Bash: ${oneLine(i.command, 120)}`;
  if ((name === "Agent" || name === "Task") && (i.description || i.prompt)) return `${name}: ${oneLine(String(i.description ?? i.prompt), 100)}`;
  if (name.startsWith("mcp__")) return name.split("__").slice(1).join(" ");
  return name;
}

function claudeLine(s: FileState, line: string, keepFrom: number): void {
  if (!line.includes('"usage"')) {
    // A tool result: the tool finished, and its output can be megabytes.
    if (line.includes('"tool_use_id"')) return;
    if (!(line.includes('"type":"user"') || line.includes('"compact_boundary"') || line.includes('"scheduled_task_fire"') || line.includes('-title"'))) return;
  }
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  if (r.cwd && !s.cwd) s.cwd = r.cwd;
  const t = Date.parse(r.timestamp ?? "");
  switch (r.type) {
    case "assistant": {
      const m = r.message;
      const u = m?.usage;
      if (!u || m.model === "<synthetic>" || !Number.isFinite(t)) return;
      const tools = Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "tool_use").map(toolLabel) : [];
      const total = (u.cache_creation_input_tokens ?? 0) as number;
      const cc = u.cache_creation;
      const c: Call = {
        t,
        model: m.model ?? "",
        input: u.input_tokens ?? 0,
        // Older records have no split; Claude Code wrote 5-minute entries then.
        w5: cc ? (cc.ephemeral_5m_input_tokens ?? 0) : total,
        w1h: cc ? (cc.ephemeral_1h_input_tokens ?? 0) : 0,
        read: u.cache_read_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
      };
      const id: string | undefined = m.id;
      const at = id ? s.ids.lastIndexOf(id) : -1;
      if (at >= 0) {
        // The same message again, for its next content block: same usage.
        const i = s.idx[at]!;
        if (i >= 0) s.calls[i] = { ...c, cause: s.calls[i]!.cause, gap: s.calls[i]!.gap, detail: s.calls[i]!.detail };
        s.waiting.push(...tools);
        return;
      }
      const i = addCall(s, c, keepFrom);
      s.waiting.push(...tools);
      if (id) {
        s.ids.push(id);
        s.idx.push(i);
        if (s.ids.length > 16) {
          s.ids.shift();
          s.idx.shift();
        }
      }
      return;
    }
    case "user": {
      const content = r.message?.content;
      if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) return;
      const text: string = typeof content === "string" ? content : Array.isArray(content) ? (content.find((b: any) => b?.type === "text")?.text ?? "") : "";
      if (r.isCompactSummary) return;
      if (r.isMeta) {
        // A peer's message, a /loop wakeup; the rest (skill bodies) wake nothing.
        if (/<teammate-message|<cross-session-message|<agent-message/.test(text)) s.wake = "teammate";
        else if (/^\s*<scheduled-task|\/loop/.test(text)) s.wake = "background";
        return;
      }
      const kind = classifyUserText(text);
      if (kind === "interrupted" || kind === "hidden" || kind === "output") return;
      const origin = r.origin?.kind;
      if (kind === "notification" || origin === "task-notification" || origin === "auto-continuation" || text.startsWith("[SYSTEM NOTIFICATION")) {
        s.wake = text.startsWith("<task-notification") || origin === "task-notification" || origin === "auto-continuation" || text.startsWith("[SYSTEM") ? "background" : "teammate";
        return;
      }
      // A subagent's messages all come from whoever runs it.
      if (s.agent || origin === "peer" || isAgentSent(text)) {
        s.wake = "teammate";
        return;
      }
      s.wake = "you";
      if (Number.isFinite(t) && t >= keepFrom) s.prompts.push(t);
      if (!s.firstPrompt && kind === "prompt" && text.trim()) s.firstPrompt = oneLine(text, 140);
      return;
    }
    case "system":
      if (r.subtype === "compact_boundary") s.compacted = true;
      else if (r.subtype === "scheduled_task_fire") s.wake = "background";
      return;
    case "custom-title":
      if (r.customTitle) s.title = String(r.customTitle);
      return;
    case "ai-title":
      if (r.aiTitle && !s.title) s.title = String(r.aiTitle);
      return;
  }
}

function codexLine(s: FileState, line: string, keepFrom: number): void {
  if (line.includes('"type":"function_call_output"') || line.includes('"type":"custom_tool_call_output"')) return;
  if (!(line.includes('"token_count"') || line.includes('"turn_context"') || line.includes('"user_message"') || line.includes('"function_call"') || line.includes('"custom_tool_call"') || line.includes('"compacted"'))) return;
  let r: any;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  const p = r.payload ?? {};
  const t = Date.parse(r.timestamp ?? "");
  if (r.type === "turn_context") {
    if (typeof p.model === "string" && p.model) s.model = p.model;
    if (typeof p.cwd === "string" && !s.cwd) s.cwd = p.cwd;
    return;
  }
  if (r.type === "compacted") {
    s.compacted = true;
    return;
  }
  if (r.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")) {
    let detail = String(p.name ?? "tool");
    try {
      const a = typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.input ?? {});
      const cmd = Array.isArray(a?.command) ? a.command.join(" ") : (a?.cmd ?? a?.command);
      if (typeof cmd === "string") detail = `${detail}: ${oneLine(cmd, 120)}`;
    } catch {
      /* the name alone */
    }
    s.queued.push(detail);
    return;
  }
  if (r.type !== "event_msg") return;
  if (p.type === "user_message") {
    const text = String(p.message ?? "");
    if (isAgentSent(text)) {
      s.wake = "teammate";
      return;
    }
    s.wake = "you";
    if (Number.isFinite(t) && t >= keepFrom) s.prompts.push(t);
    if (!s.firstPrompt && text.trim()) s.firstPrompt = oneLine(text, 140);
    return;
  }
  if (p.type === "token_count" && p.info?.last_token_usage && Number.isFinite(t)) {
    const total = p.info.total_token_usage?.total_tokens ?? -1;
    if (total === s.lastTotal) return; // a repeat: only the rate limits moved
    s.lastTotal = total;
    const u = codexUsage(p.info.last_token_usage);
    addCall(s, {
      t,
      model: s.model ?? "",
      // Codex bills no writes: what it did not have cached is plain input.
      input: u.input + u.cacheWrite,
      w5: 0,
      w1h: 0,
      read: u.cacheRead,
      output: u.output,
      thinking: p.info.last_token_usage.reasoning_output_tokens ?? 0,
    }, keepFrom);
    // A response's tool calls are recorded before its usage, so they become
    // what the session waits on only now.
    s.waiting = s.queued;
    s.queued = [];
    return;
  }
}

/** A Claude subagent's name and kind, from the `.meta.json` beside it. */
function claudeAgent(path: string): FileState["agent"] {
  let meta: any = {};
  try {
    meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    /* an older Claude wrote none */
  }
  const type = typeof meta.agentType === "string" ? meta.agentType : null;
  const name = typeof meta.description === "string" && meta.description ? meta.description : (type ?? basename(path, ".jsonl"));
  return { name, type };
}

function keyOf(provider: ProviderId, path: string): { key: string; agent: FileState["agent"] } {
  if (provider === "claude") {
    const sub = /([^/]+)\/subagents\/(?:.*\/)?[^/]+\.jsonl$/.exec(path);
    if (sub) return { key: sub[1]!, agent: claudeAgent(path) };
    return { key: basename(path, ".jsonl"), agent: null };
  }
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return { key: m ? m[1]! : basename(path, ".jsonl"), agent: null };
}

/** Bring an account's file states up to date with its transcripts. */
async function scan(account: Pick<Account, "id" | "provider">, homes: string[], stats: { files: number; bytes: number }): Promise<AccountCache> {
  const cache = loadCache(account.id);
  const now = Date.now();
  const keepFrom = now - KEEP_MS;
  const sub = account.provider === "claude" ? "projects" : "sessions";
  const found = homes.flatMap((h) => transcriptsUnder(join(h, sub), keepFrom));
  const live = new Set(found.map((f) => f.path));
  for (const p of Object.keys(cache.files)) if (!live.has(p)) delete cache.files[p];
  const fold = account.provider === "claude" ? claudeLine : codexLine;
  for (const f of found) {
    let s: FileState | undefined = cache.files[f.path];
    // Shorter than read: rewritten, read it again.
    if (s && f.size < s.offset) s = undefined;
    if (!s) {
      const { key, agent } = keyOf(account.provider, f.path);
      s = cache.files[f.path] = newState(f.path, key, agent, f.born);
    }
    stats.files++;
    if (f.size > s.offset) {
      stats.bytes += f.size - s.offset;
      const st = s;
      // Calls from before the file was here were made on another account.
      const floor = Math.max(keepFrom, st.born - 60_000);
      st.offset = await readLines(f.path, st.offset, f.size, (line) => fold(st, line, floor));
    }
    s.size = f.size;
    if (s.calls.length && s.calls[0]!.t < keepFrom) s.calls = s.calls.filter((c) => c.t >= keepFrom);
    if (s.prompts.length && s.prompts[0]! < keepFrom) s.prompts = s.prompts.filter((t) => t >= keepFrom);
  }
  if (stats.bytes > 0) saveCache(account.id, cache);
  return cache;
}

// -------------------------------------------------------------- the report

const PARTS: SpendPart[] = ["input", "write5m", "write1h", "cacheRead", "output"];

export function emptySpend(): Spend {
  const z = (): Record<SpendPart, number> => ({ input: 0, write5m: 0, write1h: 0, cacheRead: 0, output: 0 });
  return { calls: 0, tokens: z(), cost: z(), thinking: 0 };
}

const costOf = (s: Spend): number => PARTS.reduce((a, p) => a + s.cost[p], 0);

function priced(c: Call): { tokens: Record<SpendPart, number>; cost: Record<SpendPart, number>; read: number } {
  const p = priceOf(c.model);
  const tokens = { input: c.input, write5m: c.w5, write1h: c.w1h, cacheRead: c.read, output: c.output };
  return {
    tokens,
    cost: {
      input: (c.input * p.input) / 1e6,
      write5m: (c.w5 * p.cacheWrite) / 1e6,
      // An hour's cache entry is billed at twice the input price.
      write1h: (c.w1h * p.input * 2) / 1e6,
      cacheRead: (c.read * p.cacheRead) / 1e6,
      output: (c.output * p.output) / 1e6,
    },
    read: p.cacheRead,
  };
}

function add(into: Spend, x: { tokens: Record<SpendPart, number>; cost: Record<SpendPart, number> }, thinking: number): void {
  into.calls++;
  into.thinking += thinking;
  for (const p of PARTS) {
    into.tokens[p] += x.tokens[p];
    into.cost[p] += x.cost[p];
  }
}

const CONTEXT_EDGES = [0, 50_000, 100_000, 200_000, 400_000, 700_000];

interface Known {
  id: string;
  title: string;
}

export interface InsightsInput {
  account: Pick<Account, "id" | "provider">;
  /** The account's own id and its twins': where its sessions and samples are kept. */
  accountIds: string[];
  /** Every credential home of the account. */
  homes: string[];
  days: number;
  /** The board's session for a provider session id. */
  known: (agentSessionId: string) => Known | null;
}

export async function usageInsights(input: InsightsInput): Promise<UsageInsights> {
  const started = performance.now();
  const to = Date.now();
  const hours = Math.max(1, Math.round(input.days * 24));
  // Whole hours, so the buckets line up with the clock.
  const from = Math.floor(to / HOUR) * HOUR - (hours - 1) * HOUR;
  const base = {
    accountId: input.account.id,
    provider: input.account.provider,
    from,
    to,
    weekly: weeklyOf(input.accountIds, from, to),
    limitHits: rateLimitHitsSince(from).filter((h) => h.accountId && input.accountIds.includes(h.accountId)).map((h) => h.at),
  };
  if (input.account.provider !== "claude" && input.account.provider !== "codex") {
    const r = fromSamples(input, from, hours);
    return finish({ ...base, ...r, source: "samples", scan: { files: 0, bytes: 0, ms: Math.round(performance.now() - started) } });
  }

  const stats = { files: 0, bytes: 0 };
  const key = input.account.id;
  let pending = inflight.get(key);
  if (!pending) {
    pending = scan(input.account, input.homes, stats).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const cache = await pending;

  const total = emptySpend();
  const buckets = Array.from({ length: hours }, emptySpend);
  const models = new Map<string, { calls: number; cost: number }>();
  const context = CONTEXT_EDGES.map((e, i) => ({ from: e, to: CONTEXT_EDGES[i + 1] ?? null, calls: 0, cost: 0 }));
  const sessions = new Map<string, InsightSession & { agentMap: Map<string, InsightAgent> }>();
  const rebuilds: Rebuild[] = [];
  const agentTotal = emptySpend();
  const byType = new Map<string, { count: number; cost: number }>();
  let agentFiles = 0;
  // Spans where the weekly read 100%: from that reading to the next below it.
  const full: [number, number][] = [];
  const pts = base.weekly?.points ?? [];
  pts.forEach((p, i) => {
    if (p.pct < 100 || (i > 0 && pts[i - 1]!.pct >= 100)) return;
    const end = pts.slice(i + 1).find((q) => q.pct < 100);
    full.push([p.at, end?.at ?? to]);
  });

  for (const s of Object.values(cache.files)) {
    const calls = s.calls.filter((c) => c.t >= from && c.t <= to);
    const prompts = s.agent ? 0 : s.prompts.filter((t) => t >= from && t <= to).length;
    if (calls.length === 0 && prompts === 0) continue;
    let sess = sessions.get(s.key);
    if (!sess) {
      const k = input.known(s.key);
      sess = {
        key: s.key, sessionId: k?.id ?? null, title: k?.title ?? "", cwd: s.cwd, spend: emptySpend(), agentSpend: emptySpend(),
        prompts: 0, firstAt: Infinity, lastAt: 0, peakContext: 0, rebuilds: 0, rebuildCost: 0, agents: [], agentCount: 0, agentMap: new Map(),
      };
      sessions.set(s.key, sess);
    }
    if (!s.agent) {
      if (!sess.title) sess.title = s.title ?? s.firstPrompt ?? "";
      if (s.cwd) sess.cwd = s.cwd;
    } else if (!sess.cwd) sess.cwd = s.cwd;
    sess.prompts += prompts;
    let agent: InsightAgent | undefined;
    if (s.agent && calls.length) {
      agentFiles++;
      agent = { name: s.agent.name, type: s.agent.type, spend: emptySpend(), peakContext: 0, rebuildCost: 0, firstAt: calls[0]!.t };
      sess.agentMap.set(s.path, agent);
      const ty = s.agent.type ?? "subagent";
      const b = byType.get(ty) ?? { count: 0, cost: 0 };
      b.count++;
      byType.set(ty, b);
    }
    for (const c of calls) {
      const x = priced(c);
      const cost = PARTS.reduce((a, p) => a + x.cost[p], 0);
      const ctx = c.input + c.w5 + c.w1h + c.read;
      add(total, x, c.thinking);
      add(buckets[Math.min(hours - 1, Math.floor((c.t - from) / HOUR))]!, x, c.thinking);
      add(sess.spend, x, c.thinking);
      if (base.weekly && full.some(([a, b]) => c.t >= a && c.t < b)) {
        base.weekly.atLimit.calls++;
        base.weekly.atLimit.cost += cost;
      }
      sess.firstAt = Math.min(sess.firstAt, c.t);
      sess.lastAt = Math.max(sess.lastAt, c.t);
      sess.peakContext = Math.max(sess.peakContext, ctx);
      const m = models.get(c.model || "unknown") ?? { calls: 0, cost: 0 };
      m.calls++;
      m.cost += cost;
      models.set(c.model || "unknown", m);
      let band = context[0]!;
      for (const b of context) if (ctx >= b.from) band = b;
      band.calls++;
      band.cost += cost;
      if (agent) {
        add(sess.agentSpend, x, c.thinking);
        add(agent.spend, x, c.thinking);
        add(agentTotal, x, c.thinking);
        agent.peakContext = Math.max(agent.peakContext, ctx);
        byType.get(s.agent!.type ?? "subagent")!.cost += cost;
      }
      if (c.cause) {
        const fresh = c.input + c.w5 + c.w1h;
        const rc = x.cost.input + x.cost.write5m + x.cost.write1h;
        rebuilds.push({
          key: s.key, agent: s.agent?.name ?? null, at: c.t, gapMs: c.gap ?? 0, tokens: fresh, cost: rc,
          warmCost: (fresh * x.read) / 1e6, cause: c.cause, detail: c.detail ?? null,
        });
        sess.rebuilds++;
        sess.rebuildCost += rc;
        if (agent) agent.rebuildCost += rc;
      }
    }
  }

  const all = [...sessions.values()].filter((s) => s.spend.calls > 0 || s.prompts > 0);
  all.sort((a, b) => costOf(b.spend) - costOf(a.spend));
  const out: InsightSession[] = all.slice(0, 40).map(({ agentMap, ...s }) => {
    const agents = [...agentMap.values()].sort((a, b) => costOf(b.spend) - costOf(a.spend));
    return {
      ...s,
      title: s.title || (s.cwd ? basename(s.cwd) : s.key.slice(0, 8)),
      firstAt: Number.isFinite(s.firstAt) ? s.firstAt : from,
      agents: agents.slice(0, 12),
      agentCount: agents.length,
    };
  });

  const causes = new Map<RebuildCause, { count: number; cost: number; warmCost: number }>();
  for (const r of rebuilds) {
    const c = causes.get(r.cause) ?? { count: 0, cost: 0, warmCost: 0 };
    c.count++;
    c.cost += r.cost;
    c.warmCost += r.warmCost;
    causes.set(r.cause, c);
  }
  rebuilds.sort((a, b) => b.cost - a.cost);

  return finish({
    ...base,
    source: "transcripts",
    scan: { files: stats.files, bytes: stats.bytes, ms: Math.round(performance.now() - started) },
    total,
    hours: buckets,
    models: [...models].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.cost - a.cost),
    context,
    rebuilds: {
      count: rebuilds.length,
      cost: rebuilds.reduce((a, r) => a + r.cost, 0),
      warmCost: rebuilds.reduce((a, r) => a + r.warmCost, 0),
      causes: [...causes].map(([cause, c]) => ({ cause, ...c })).sort((a, b) => b.cost - a.cost),
      agents: { count: rebuilds.filter((r) => r.agent).length, cost: rebuilds.reduce((a, r) => a + (r.agent ? r.cost : 0), 0) },
      bursts: burstsOf(rebuilds),
      worst: rebuilds.slice(0, 20),
    },
    sessions: out,
    sessionCount: all.length,
    agents: agentFiles
      ? { count: agentFiles, spend: agentTotal, byType: [...byType].map(([type, b]) => ({ type, ...b })).sort((a, b) => b.cost - a.cost) }
      : null,
  });
}

/** Five or more sessions rebuilding within ten minutes, after a wait of at
 *  least an hour each: something woke them together. */
function burstsOf(rebuilds: Rebuild[]): { at: number; sessions: number; cost: number }[] {
  const woken = rebuilds.filter((r) => r.gapMs >= HOUR).sort((a, b) => a.at - b.at);
  const out: { at: number; sessions: number; cost: number }[] = [];
  for (let i = 0; i < woken.length; ) {
    let j = i;
    while (j < woken.length && woken[j]!.at - woken[i]!.at <= 10 * 60_000) j++;
    const group = woken.slice(i, j);
    const sessions = new Set(group.map((r) => r.key)).size;
    if (sessions >= 5) {
      out.push({ at: group[0]!.at, sessions, cost: group.reduce((a, r) => a + r.cost, 0) });
      i = j;
    } else i++;
  }
  return out.sort((a, b) => b.cost - a.cost).slice(0, 5);
}

/** Cost per weekly point, now that the total is known. */
function finish(r: UsageInsights): UsageInsights {
  if (r.weekly && r.weekly.gained >= 5) r.weekly.perPoint = costOf(r.total) / r.weekly.gained;
  return r;
}

/** The account's unscoped weekly window over the span, and how far it rose. */
function weeklyOf(accountIds: string[], from: number, to: number): UsageInsights["weekly"] {
  const rows = accountIds.flatMap((id) => usageSamplesSince(from, id)).filter((r) => r.kind === "weekly" && !r.windowId.includes(":") && r.at <= to);
  if (rows.length === 0) return null;
  // One series: the home, window and source with the most readings. Two
  // homes of one login each record it, and codex's endpoint and rollouts can
  // disagree (the endpoint reading 0 while a rollout reads 40); interleaved,
  // they would rise and fall by the difference at every reading.
  const series = (r: (typeof rows)[number]) => `${r.accountId} ${r.windowId} ${r.source}`;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(series(r), (counts.get(series(r)) ?? 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  const pts = rows.filter((r) => series(r) === best).sort((a, b) => a.at - b.at);
  let gained = 0;
  let limitAt: number | null = null;
  let limitResetAt: number | null = null;
  // A window only rises, so what it gained is its highest reading less its
  // lowest — less 0 for one that started inside the span. Summing each rise
  // would count jitter: codex's sessions report 13, 14, 13, 14 in turn.
  let lo = Infinity;
  let hi = -Infinity;
  let first = true;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = pts[i - 1];
    // A reset moves `resetsAt` by about a week; jitter moves it by a second.
    if (prev && p.resetsAt && prev.resetsAt && p.resetsAt - prev.resetsAt > HOUR) {
      gained += hi - (first ? lo : 0);
      first = false;
      lo = Infinity;
      hi = -Infinity;
    }
    lo = Math.min(lo, p.usedPct);
    hi = Math.max(hi, p.usedPct);
    if (limitAt === null && p.usedPct >= 100) {
      limitAt = p.at;
      limitResetAt = p.resetsAt;
    }
  }
  gained += hi - (first ? lo : 0);
  return { points: pts.map((p) => ({ at: p.at, pct: p.usedPct })), gained, perPoint: null, limitAt, limitResetAt, atLimit: { calls: 0, cost: 0 } };
}

/** devin and omp: per-session totals from the samples agentbox took as they
 *  moved. Cache writes are counted as five-minute ones. */
function fromSamples(input: InsightsInput, from: number, hours: number): Pick<UsageInsights, "total" | "hours" | "models" | "context" | "rebuilds" | "sessions" | "sessionCount" | "agents"> {
  const total = emptySpend();
  const buckets = Array.from({ length: hours }, emptySpend);
  const models = new Map<string, { calls: number; cost: number }>();
  const sessions: InsightSession[] = [];
  for (const row of sessionsOnAccounts(input.accountIds, from)) {
    let prev = tokenSampleAt(row.id, from) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const spend = emptySpend();
    let firstAt = Infinity;
    let lastAt = 0;
    for (const s of tokenSamplesAfter(row.id, from)) {
      const c: Call = {
        t: s.at, model: row.model ?? "", input: Math.max(0, s.input - prev.input), w5: Math.max(0, s.cacheWrite - prev.cacheWrite),
        w1h: 0, read: Math.max(0, s.cacheRead - prev.cacheRead), output: Math.max(0, s.output - prev.output), thinking: 0,
      };
      prev = s;
      const x = priced(c);
      add(spend, x, 0);
      add(total, x, 0);
      add(buckets[Math.min(hours - 1, Math.max(0, Math.floor((s.at - from) / HOUR)))]!, x, 0);
      const m = models.get(c.model || "unknown") ?? { calls: 0, cost: 0 };
      m.calls++;
      m.cost += PARTS.reduce((a, p) => a + x.cost[p], 0);
      models.set(c.model || "unknown", m);
      firstAt = Math.min(firstAt, s.at);
      lastAt = Math.max(lastAt, s.at);
    }
    if (spend.calls === 0) continue;
    const k = row.agentSessionId ? input.known(row.agentSessionId) : null;
    sessions.push({
      key: row.agentSessionId ?? row.id, sessionId: row.id, title: k?.title ?? row.label ?? basename(row.cwd), cwd: row.cwd,
      spend, agentSpend: emptySpend(), prompts: 0, firstAt, lastAt, peakContext: 0, rebuilds: 0, rebuildCost: 0, agents: [], agentCount: 0,
    });
  }
  sessions.sort((a, b) => costOf(b.spend) - costOf(a.spend));
  return {
    total,
    hours: buckets,
    models: [...models].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.cost - a.cost),
    context: [],
    rebuilds: null,
    sessions: sessions.slice(0, 40),
    sessionCount: sessions.length,
    agents: null,
  };
}
