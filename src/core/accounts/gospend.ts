/** What each OpenCode Go key has spent, read from the transcripts.
 *
 * OpenCode Go has no usage API: its limits are dollars of list price over a
 * rolling 5 hours, a week and a month, and the only record of what was spent
 * is what the CLIs wrote down. omp and opencode both put a cost on every
 * model call, and say which provider took it, so this module reads them:
 *
 *   omp       <sessions root>/<slug>/<iso>_<id>.jsonl, and its subagents'
 *             logs under <iso>_<id>/: assistant messages from a provider
 *             whose name starts `opencode-go`, `message.usage.cost.total`.
 *   opencode  session_message rows of type `assistant` whose model's
 *             providerID is `opencode-go`, `data.cost`, once complete.
 *
 * Each call is put on an account when it is read: the agentbox session it
 * belongs to (a subagent's is its root's) is pinned to one, and anything
 * else — a session started by hand, or on an account since removed — ran on
 * opencode's own login, the default account's. Spend is kept in agentbox's
 * database by account and minute, and how far each transcript has been read
 * beside it, written in one transaction so a restart never counts a call
 * twice. Calls older than the longest window are never counted at all.
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";
import { findSessionRecord, getAccount, getDb, listAccounts } from "../db";
import { userHome } from "../paths";
import { parentFromPath, sessionsRootOf } from "../providers/omp";
import { sessionIdFromFileName } from "../providers/omp-transcript";
import type { ProviderId, UsageWindow, WindowKind } from "../types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** OpenCode Go's limits, as omp states them. */
export const GO_LIMITS: readonly { id: string; label: string; kind: WindowKind; windowMs: number; limitUsd: number }[] = [
  { id: "rolling-5h", label: "5-hour", kind: "short", windowMs: 5 * HOUR, limitUsd: 12 },
  { id: "weekly", label: "Weekly", kind: "weekly", windowMs: 7 * DAY, limitUsd: 30 },
  { id: "monthly", label: "Monthly", kind: "monthly", windowMs: 30 * DAY, limitUsd: 60 },
];

/** How far back anything is read or kept: the longest window and a day. */
const KEEP_MS = 31 * DAY;
const PASS_MS = 60_000;
const CHUNK = 4 << 20;
/** An unfinished opencode row this old, with rows after it, was abandoned. */
const STUCK_MS = 15 * MIN;

export interface GoSpendOptions {
  /** omp's sessions root. */
  ompRoot?: () => string | null;
  /** opencode's database. */
  opencodeDb?: () => string;
  /** The account a session is pinned to, if it is an agentbox session on an
   *  account that still exists. */
  accountFor?: (provider: ProviderId, agentSessionId: string) => string | null;
  /** Where everything else is billed: opencode's own login. */
  defaultAccount?: () => string | null;
  now?: () => number;
}

function defaultOmpAccount() {
  return listAccounts("omp").find((a) => a.isDefault) ?? null;
}

const defaults: Required<GoSpendOptions> = {
  ompRoot: () => {
    const a = defaultOmpAccount();
    return sessionsRootOf(a ?? { home: join(userHome(), ".omp"), isDefault: true });
  },
  opencodeDb: () => join(process.env.XDG_DATA_HOME || join(userHome(), ".local", "share"), "opencode", "opencode.db"),
  accountFor: (provider, id) => {
    const rec = findSessionRecord(provider, id);
    return rec?.accountId && getAccount(rec.accountId) ? rec.accountId : null;
  },
  defaultAccount: () => defaultOmpAccount()?.id ?? null,
  now: Date.now,
};

let opts: Required<GoSpendOptions> = defaults;

/** For tests: point the ledger at fixtures. Resets what is in memory. */
export function configureGoSpend(o: GoSpendOptions = {}): void {
  opts = { ...defaults, ...o };
  cursors = null;
  ready = false;
  inflight = null;
}

// ------------------------------------------------------------- storage

let cursors: Map<string, number> | null = null;

function loadCursors(): Map<string, number> {
  if (!cursors) {
    cursors = new Map();
    for (const r of getDb().query("SELECT source, pos FROM go_spend_cursors").all() as { source: string; pos: number }[]) {
      cursors.set(r.source, r.pos);
    }
  }
  return cursors;
}

/** account → minute → dollars, for one source's new calls. */
type Buckets = Map<string, Map<number, number>>;

function add(b: Buckets, account: string, at: number, cost: number): void {
  if (!(cost > 0)) return;
  let m = b.get(account);
  if (!m) b.set(account, (m = new Map()));
  const minute = Math.floor(at / MIN);
  m.set(minute, (m.get(minute) ?? 0) + cost);
}

/** The new spend and the cursor past it, together. */
function commit(source: string, pos: number, b: Buckets): void {
  const db = getDb();
  const now = opts.now();
  db.transaction(() => {
    const up = db.query(
      "INSERT INTO go_spend (account_id, minute, cost) VALUES (?, ?, ?) ON CONFLICT (account_id, minute) DO UPDATE SET cost = cost + excluded.cost",
    );
    for (const [account, m] of b) for (const [minute, cost] of m) up.run(account, minute, cost);
    db.query("INSERT INTO go_spend_cursors (source, pos, seen_at) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET pos = excluded.pos, seen_at = excluded.seen_at").run(
      source,
      pos,
      now,
    );
  })();
  loadCursors().set(source, pos);
}

function prune(now: number): void {
  const db = getDb();
  db.query("DELETE FROM go_spend WHERE minute < ?").run(Math.floor((now - KEEP_MS) / MIN));
  // A cursor nobody has moved in this long names a transcript too old to
  // read again; lines are filtered by time anyway.
  const old = db.query("SELECT source FROM go_spend_cursors WHERE seen_at < ?").all(now - KEEP_MS - 10 * DAY) as { source: string }[];
  if (old.length) {
    db.query("DELETE FROM go_spend_cursors WHERE seen_at < ?").run(now - KEEP_MS - 10 * DAY);
    for (const o of old) cursors?.delete(o.source);
  }
}

const breathe = () => new Promise<void>((r) => setImmediate(r));

/** Attribution, cached for one pass. */
function attributor() {
  const cache = new Map<string, string | null>();
  const fallback = opts.defaultAccount();
  return (provider: ProviderId, id: string): string | null => {
    const key = `${provider}:${id}`;
    let a = cache.get(key);
    if (a === undefined) {
      a = opts.accountFor(provider, id) ?? fallback;
      cache.set(key, a);
    }
    return a;
  };
}

// ------------------------------------------------------------------ omp

/** Agent logs: `<root>/<slug>/<iso>_<id>.jsonl`, and the subagent logs in
 *  each session's directory — named after the agent, where omp's numbered
 *  tool-output captures are not; its `local/` scratch is skipped. */
function ompFiles(root: string): string[] {
  const out: string[] = [];
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
        if (depth < 6 && e.name !== "local") walk(p, depth + 1);
      } else if (depth === 1 ? sessionIdFromFileName(e.name) !== null : depth > 1 && e.name.endsWith(".jsonl") && !/^\d/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** The session a log's calls belong to: its own, or its parent's. */
function ompSessionOf(path: string): string | null {
  return parentFromPath(path) ?? sessionIdFromFileName(basename(path));
}

/** One assistant line's cost and time, if OpenCode Go took the call. */
export function ompCall(line: string): { at: number; cost: number } | null {
  if (!line.includes('"opencode-go') || !line.includes('"assistant"')) return null;
  let v: any;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  const m = v?.message;
  if (v?.type !== "message" || m?.role !== "assistant") return null;
  if (typeof m.provider !== "string" || !m.provider.startsWith("opencode-go")) return null;
  const cost = Number(m.usage?.cost?.total);
  if (!Number.isFinite(cost) || cost <= 0) return null;
  let at = typeof v.timestamp === "string" ? Date.parse(v.timestamp) : NaN;
  if (!Number.isFinite(at)) at = typeof m.timestamp === "number" ? m.timestamp : NaN;
  return Number.isFinite(at) ? { at, cost } : null;
}

async function readOmpFile(path: string, size: number, since: number, who: ReturnType<typeof attributor>): Promise<void> {
  const source = `omp:${path}`;
  const start = loadCursors().get(source) ?? 0;
  if (size === start) return;
  if (size < start) {
    // Rewritten shorter: what it held is counted; never count it again.
    commit(source, size, new Map());
    return;
  }
  const session = ompSessionOf(path);
  const account = session ? who("omp", session) : null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    let pos = start;
    let carry = "";
    const buf = Buffer.allocUnsafe(CHUNK);
    while (pos < size) {
      const b: Buckets = new Map();
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      const text = carry + buf.subarray(0, n).toString("utf8");
      const nl = text.lastIndexOf("\n");
      let readTo = pos + n;
      if (nl < 0) {
        // No complete line in this chunk: keep it for the next.
        carry = text;
        pos = readTo;
        if (pos >= size) break;
        continue;
      }
      const tail = text.slice(nl + 1);
      for (const line of text.slice(0, nl).split("\n")) {
        const call = account ? ompCall(line) : null;
        if (call && call.at >= since) add(b, account!, call.at, call.cost);
      }
      // The cursor stops after the last complete line.
      const committed = readTo - Buffer.byteLength(tail, "utf8");
      commit(source, committed, b);
      carry = tail;
      pos = readTo;
      await breathe();
    }
  } finally {
    closeSync(fd);
  }
}

async function ompPass(since: number, who: ReturnType<typeof attributor>): Promise<void> {
  const root = opts.ompRoot();
  if (!root) return;
  let i = 0;
  for (const path of ompFiles(root)) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.mtimeMs < since) continue;
    await readOmpFile(path, st.size, since, who);
    if (++i % 50 === 0) await breathe();
  }
}

// ------------------------------------------------------------- opencode

let ocDb: { path: string; ino: number; db: Database } | null = null;

function opencode(path: string): Database | null {
  let ino: number;
  try {
    ino = statSync(path).ino;
  } catch {
    return null;
  }
  if (ocDb && ocDb.path === path && ocDb.ino === ino) return ocDb.db;
  ocDb?.db.close();
  ocDb = null;
  try {
    const db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 500");
    ocDb = { path, ino, db };
    return db;
  } catch {
    return null;
  }
}

/** For tests: let go of the opencode database. */
export function closeGoSpend(): void {
  ocDb?.db.close();
  ocDb = null;
}

interface OcRow {
  seq: number;
  time_created: number;
  time_updated: number;
  provider: string | null;
  cost: number | null;
  done: number | null;
}

const OC_COLS =
  "seq, time_created, time_updated, json_extract(data, '$.model.providerID') AS provider, json_extract(data, '$.cost') AS cost, json_extract(data, '$.time.completed') AS done";

/**
 * The calls of one session's rows, and the seq to read from next time: the
 * first assistant row still streaming (its cost is not final, and rows after
 * it wait with it), or past the last row. A row left unfinished long ago,
 * with rows after it, was abandoned and is skipped.
 */
export function opencodeCalls(rows: OcRow[], from: number, now: number): { calls: { at: number; cost: number }[]; next: number } {
  const calls: { at: number; cost: number }[] = [];
  let next = from;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const go = r.provider === "opencode-go";
    if (!r.done && go) {
      const abandoned = i < rows.length - 1 && now - r.time_updated > STUCK_MS;
      if (!abandoned) return { calls, next: r.seq };
    } else if (go && typeof r.cost === "number" && r.cost > 0) {
      calls.push({ at: r.done ?? r.time_created, cost: r.cost });
    }
    next = r.seq + 1;
  }
  return { calls, next };
}

async function opencodePass(now: number, since: number, who: ReturnType<typeof attributor>): Promise<void> {
  const path = opts.opencodeDb();
  const db = opencode(path);
  if (!db) return;
  let sessions: { id: string; parent_id: string | null }[];
  try {
    sessions = db.query("SELECT id, parent_id FROM session_v2").all() as typeof sessions;
  } catch {
    return;
  }
  const parent = new Map(sessions.map((s) => [s.id, s.parent_id]));
  const rootOf = (id: string) => {
    let cur = id;
    for (let i = 0; i < 16; i++) {
      const p = parent.get(cur);
      if (!p) return cur;
      cur = p;
    }
    return cur;
  };
  const lastSeq = db.query("SELECT max(seq) AS m FROM session_message WHERE session_id = ?");
  const bySeq = db.query(`SELECT ${OC_COLS} FROM session_message WHERE session_id = ? AND type = 'assistant' AND seq >= ? ORDER BY seq`);
  // A session read for the first time: only its recent rows, by the
  // (session_id, time_created) index, never the whole history.
  const byTime = db.query(
    `SELECT ${OC_COLS} FROM session_message WHERE session_id = ? AND time_created >= ? AND type = 'assistant' ORDER BY seq`,
  );
  let i = 0;
  for (const s of sessions) {
    const source = `opencode:${path}#${s.id}`;
    const from = loadCursors().get(source);
    let rows: OcRow[];
    try {
      const max = (lastSeq.get(s.id) as { m: number | null } | null)?.m ?? null;
      if (max === null) continue;
      if (from !== undefined && from > max) continue;
      rows = (from === undefined ? byTime.all(s.id, since) : bySeq.all(s.id, from)) as OcRow[];
      if (from === undefined && rows.length === 0) {
        commit(source, max + 1, new Map());
        continue;
      }
    } catch {
      continue;
    }
    const { calls, next } = opencodeCalls(rows, from ?? 0, now);
    const account = who("opencode", rootOf(s.id));
    const b: Buckets = new Map();
    if (account) for (const c of calls) if (c.at >= since) add(b, account, c.at, c.cost);
    if (next !== from || b.size) commit(source, next, b);
    if (++i % 25 === 0) await breathe();
  }
}

// ------------------------------------------------------------------ api

let inflight: Promise<void> | null = null;
let ready = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Read whatever is new in both stores. Overlapping calls share one pass. */
export function goSpendPass(): Promise<void> {
  return (inflight ??= (async () => {
    try {
      const now = opts.now();
      const since = now - KEEP_MS;
      const who = attributor();
      await ompPass(since, who);
      await opencodePass(now, since, who);
      prune(now);
      ready = true;
    } finally {
      inflight = null;
    }
  })());
}

/** Backfill now, then keep up every minute. Idempotent. */
export function startGoSpend(): void {
  if (timer) return;
  const run = () =>
    void goSpendPass().catch((e) => console.error("agentbox: OpenCode Go spend pass failed:", e));
  run();
  timer = setInterval(run, PASS_MS);
  timer.unref?.();
}

export function stopGoSpend(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** False until the first pass — the backfill — has finished. */
export function goSpendReady(): boolean {
  return ready;
}

/** Dollars spent in each of Go's windows, and the oldest minute of it. */
function spendIn(accountId: string, now: number): { spent: number; oldest: number | null }[] {
  const longest = Math.max(...GO_LIMITS.map((l) => l.windowMs));
  const rows = getDb()
    .query("SELECT minute, cost FROM go_spend WHERE account_id = ? AND minute >= ? ORDER BY minute")
    .all(accountId, Math.floor((now - longest) / MIN)) as { minute: number; cost: number }[];
  return GO_LIMITS.map((l) => {
    const from = now - l.windowMs;
    let spent = 0;
    let oldest: number | null = null;
    for (const r of rows) {
      const at = r.minute * MIN;
      // A minute that ends inside the window counts whole.
      if (at + MIN <= from) continue;
      spent += r.cost;
      oldest ??= at;
    }
    return { spent, oldest };
  });
}

/** An account's spend against each of Go's limits. A window frees up as its
 *  oldest spend ages out, so that is when it "resets". */
export function goSpendWindows(accountId: string, now: number): UsageWindow[] {
  const spend = spendIn(accountId, now);
  return GO_LIMITS.map((l, i) => ({
    id: `opencode-go:${l.id}`,
    kind: l.kind,
    label: l.label,
    usedPct: Math.max(0, Math.min(100, (spend[i]!.spent / l.limitUsd) * 100)),
    resetsAt: spend[i]!.oldest === null ? null : spend[i]!.oldest! + l.windowMs,
    windowMs: l.windowMs,
    provider: "opencode-go",
  }));
}

/** Dollars spent in each window, by limit id ("rolling-5h", …), unclamped. */
export function goSpendDollars(accountId: string, now: number): Record<string, number> {
  const spend = spendIn(accountId, now);
  return Object.fromEntries(GO_LIMITS.map((l, i) => [l.id, Math.round(spend[i]!.spent * 100) / 100]));
}
