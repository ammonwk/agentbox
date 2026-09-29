import type { Launch } from "./launch";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { dbPath, ensureDirs } from "./paths";
import { isGitRepo, resolveDefaultBranch, repoFullNameOf, run } from "./git";
import type {
  Account,
  AgentSettings,
  BalancerSettings,
  Btw,
  Candidate,
  ProviderId,
  Repo,
  Schedule,
  TokenTotals,
  UsageWindow,
} from "./types";

let db: Database | null = null;
let openedAt = "";

export function getDb(): Database {
  // Keyed on the resolved path, not just "is it open": a changed
  // AGENTBOX_HOME (tests) must not keep answering from the old database.
  const path = dbPath();
  if (db && openedAt === path) return db;
  ensureDirs();
  db = new Database(path, { create: true });
  openedAt = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** Close the handle, for tests that swap homes. */
export function closeDb(): void {
  db?.close();
  db = null;
  openedAt = "";
}

// ---------------------------------------------------------------- schema

/**
 * Versioned, append-only. Each entry runs once, in order, inside a
 * transaction, and bumps `user_version`. Never edit a shipped entry — add one.
 *
 * v1's `agentbox.db` is a different file (`box.db` is v2's), so none of v1's
 * ad-hoc column patching carries over.
 */
const MIGRATIONS: string[] = [
  // 1 — the v2 schema.
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE repos (
    id             TEXT PRIMARY KEY,
    ref            TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    full_name      TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    added_at       INTEGER NOT NULL
  );

  CREATE TABLE accounts (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    label      TEXT NOT NULL,
    email      TEXT,
    plan       TEXT,
    home       TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE (provider, home)
  );

  -- What agentbox knows about a session that the provider's transcript does
  -- not: the account pin, the claim, the tmux session, a label. Plus a cached
  -- copy of the derived facts so the board renders before the first scan.
  CREATE TABLE sessions (
    id               TEXT PRIMARY KEY,
    provider         TEXT NOT NULL,
    agent_session_id TEXT,
    account_id       TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    cwd              TEXT NOT NULL,
    worktree         TEXT,
    label            TEXT,
    big              INTEGER NOT NULL DEFAULT 0,
    claim            REAL NOT NULL DEFAULT 0,
    origin           TEXT NOT NULL,
    tmux             TEXT,
    transcript_path  TEXT,
    started_at       INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL,
    archived_at      INTEGER,
    facts            TEXT,
    created_at       INTEGER NOT NULL,
    UNIQUE (provider, agent_session_id)
  );
  CREATE INDEX sessions_activity ON sessions (last_activity_at);

  -- Every usage reading, for calibration. One row per window per reading, and
  -- only when the reading moved or an hour passed (see recordUsage).
  CREATE TABLE usage_samples (
    account_id TEXT NOT NULL,
    at         INTEGER NOT NULL,
    window_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    used_pct   REAL NOT NULL,
    resets_at  INTEGER,
    source     TEXT NOT NULL
  );
  CREATE INDEX usage_samples_acct ON usage_samples (account_id, window_id, at);

  -- Cumulative token totals per session, sampled when they move.
  CREATE TABLE token_samples (
    session_id  TEXT NOT NULL,
    at          INTEGER NOT NULL,
    input       INTEGER NOT NULL,
    output      INTEGER NOT NULL,
    cache_read  INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cost_equiv  REAL NOT NULL
  );
  CREATE INDEX token_samples_session ON token_samples (session_id, at);

  -- Weekly points attributed to a session over one usage interval.
  CREATE TABLE attributions (
    session_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    at         INTEGER NOT NULL,
    points     REAL NOT NULL
  );
  CREATE INDEX attributions_session ON attributions (session_id);

  -- Every placement, with every candidate's inputs, so a week of them can be
  -- replayed against different settings.
  CREATE TABLE assignments (
    id         TEXT PRIMARY KEY,
    session_id TEXT,
    at         INTEGER NOT NULL,
    provider   TEXT NOT NULL,
    account_id TEXT,
    mode       TEXT NOT NULL,
    big        INTEGER NOT NULL,
    claim      REAL NOT NULL,
    candidates TEXT NOT NULL,
    settings   TEXT NOT NULL,
    why        TEXT NOT NULL
  );

  CREATE TABLE rate_limit_hits (
    session_id TEXT NOT NULL,
    account_id TEXT,
    at         INTEGER NOT NULL,
    detail     TEXT NOT NULL,
    UNIQUE (session_id, at)
  );
  `,
  // 2 — how an adopted session was launched (src/core/launch.ts), JSON.
  `ALTER TABLE sessions ADD COLUMN launch TEXT;`,
  // 3 — the reasoning effort a session was started with, kept for its resumes.
  `ALTER TABLE sessions ADD COLUMN effort TEXT;`,
  // 4 — the model it was started with, likewise: a resume without `--model`
  // runs on the CLI's default.
  `ALTER TABLE sessions ADD COLUMN model TEXT;`,
  // 5 — the session that started this one (Session.parent); set once, by the
  // fleet, when it can prove it.
  `ALTER TABLE sessions ADD COLUMN parent TEXT;`,
  // 6 — when the fleet stopped this session for sitting idle (src/core/park.ts);
  // null once it runs again or you stop it yourself.
  `ALTER TABLE sessions ADD COLUMN parked_at INTEGER;`,
  // 7 — the teammates stopped with it, JSON; told to it when it resumes.
  `ALTER TABLE sessions ADD COLUMN parked_mates TEXT;`,
  // 8 — sessions to start later (src/core/scheduler.ts). `rule` and `spec` are JSON.
  `
  CREATE TABLE schedules (
    id              TEXT PRIMARY KEY,
    rule            TEXT NOT NULL,
    spec            TEXT NOT NULL,
    label           TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    next_at         INTEGER,
    created_at      INTEGER NOT NULL,
    last_run_at     INTEGER,
    last_session_id TEXT,
    last_error      TEXT
  );
  `,
  // 9 — every pull request of the repos agentbox tracks, kept current from
  // GitHub (src/core/prs.ts), and how far each repo's copy has got.
  `
  CREATE TABLE prs (
    repo         TEXT NOT NULL,
    number       INTEGER NOT NULL,
    title        TEXT NOT NULL,
    head_ref     TEXT NOT NULL,
    base_ref     TEXT NOT NULL,
    state        TEXT NOT NULL,
    draft        INTEGER NOT NULL,
    author       TEXT NOT NULL,
    url          TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    merge_commit TEXT,
    PRIMARY KEY (repo, number)
  );
  CREATE INDEX prs_state ON prs (repo, state);

  -- etag: of the newest-updated page, so an unchanged one answers 304.
  -- updated_to: the newest updated_at seen; the next sync reads down to it.
  -- open_at: when every open PR was last read; 0 for never.
  -- history_page: the next page of the oldest-first walk; 0 once it is done.
  CREATE TABLE pr_sync (
    repo         TEXT PRIMARY KEY,
    etag         TEXT,
    updated_to   TEXT,
    open_at      INTEGER NOT NULL DEFAULT 0,
    history_page INTEGER NOT NULL DEFAULT 1
  );
  `,
  // 10 — side questions (Claude's /btw) and their answers: Claude keeps them
  // only in the process's memory, so this is their one record.
  `
  CREATE TABLE btw (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    question    TEXT NOT NULL,
    answer      TEXT,
    error       TEXT,
    status      TEXT NOT NULL,
    source      TEXT NOT NULL,
    asked_at    INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX btw_session ON btw (session_id, asked_at);
  `,
  // 11 — why a session was parked when it was not for sitting idle (a crash
  // took its process; src/core/recovery.ts); told to it when it resumes.
  `ALTER TABLE sessions ADD COLUMN parked_why TEXT;`,
  // 12 — where a repo's sessions usually run, remembered from the last pick.
  // Null until picked once; no name matching anywhere.
  `ALTER TABLE repos ADD COLUMN worktree_default INTEGER;`,
];

function migrate(d: Database) {
  const current = (d.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.transaction(() => {
      d.exec(MIGRATIONS[v]!);
      d.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

// --------------------------------------------------------------- accounts

type AccountRow = {
  id: string; provider: string; label: string; email: string | null; plan: string | null;
  home: string; is_default: number; enabled: number; created_at: number;
};

function rowToAccount(r: AccountRow): Account {
  return {
    id: r.id, provider: r.provider as ProviderId, label: r.label, email: r.email,
    plan: r.plan, home: r.home, isDefault: !!r.is_default, enabled: !!r.enabled,
    createdAt: r.created_at,
  };
}

export function listAccounts(provider?: ProviderId): Account[] {
  const rows = provider
    ? getDb().query("SELECT * FROM accounts WHERE provider = ? ORDER BY is_default DESC, created_at").all(provider)
    : getDb().query("SELECT * FROM accounts ORDER BY provider, is_default DESC, created_at").all();
  return (rows as AccountRow[]).map(rowToAccount);
}

export function getAccount(id: string): Account | null {
  const row = getDb().query("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | null;
  return row ? rowToAccount(row) : null;
}

export function insertAccount(a: Account): void {
  getDb().run(
    `INSERT INTO accounts (id,provider,label,email,plan,home,is_default,enabled,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [a.id, a.provider, a.label, a.email, a.plan, a.home, a.isDefault ? 1 : 0, a.enabled ? 1 : 0, a.createdAt],
  );
}

export function updateAccount(
  id: string,
  patch: Partial<Pick<Account, "label" | "email" | "plan" | "enabled">>,
): void {
  const cols: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.label !== undefined) { cols.push("label = ?"); vals.push(patch.label); }
  if (patch.email !== undefined) { cols.push("email = ?"); vals.push(patch.email); }
  if (patch.plan !== undefined) { cols.push("plan = ?"); vals.push(patch.plan); }
  if (patch.enabled !== undefined) { cols.push("enabled = ?"); vals.push(patch.enabled ? 1 : 0); }
  if (cols.length === 0) return;
  getDb().run(`UPDATE accounts SET ${cols.join(", ")} WHERE id = ?`, [...vals, id]);
}

export function deleteAccount(id: string): void {
  getDb().run("DELETE FROM accounts WHERE id = ?", [id]);
}

// --------------------------------------------------------------- sessions

/**
 * The persisted half of a session. Everything else on `Session` is derived
 * each scan from the transcript and the process table, and cached in `facts`.
 */
export interface SessionRecord {
  id: string;
  provider: ProviderId;
  agentSessionId: string | null;
  accountId: string | null;
  cwd: string;
  worktree: string | null;
  label: string | null;
  big: boolean;
  claim: number;
  origin: "agentbox" | "external";
  tmux: string | null;
  transcriptPath: string | null;
  startedAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
  /** Opaque to the database: the fleet's last derived snapshot. */
  facts: unknown;
  createdAt: number;
  /** Flags and environment carried over by adopt; absent for sessions we started. */
  launch?: Launch | null;
  /** The effort level it was started with; null for the CLI's default. */
  effort?: string | null;
  /** The model asked for at spawn (`--model`), e.g. `claude-fable-5-1[1m]`. */
  model?: string | null;
  /** The session that started this one, once proven (see `Fleet.linkParents`). */
  parent?: string | null;
  /** When the fleet stopped it for sitting idle (`Fleet.parkIdle`); null once
   *  it runs again, or once you stop it yourself. */
  parkedAt?: number | null;
  /** Teammates whose panes were stopped with it. */
  parkedMates?: string[] | null;
  /** Why it is parked, when that is not idleness: its process was lost in a
   *  crash while it waited on you (src/core/recovery.ts). */
  parkedWhy?: string | null;
}

type SessionRow = {
  id: string; provider: string; agent_session_id: string | null; account_id: string | null;
  cwd: string; worktree: string | null; label: string | null; big: number; claim: number;
  origin: string; tmux: string | null; transcript_path: string | null; started_at: number;
  last_activity_at: number; archived_at: number | null; facts: string | null; created_at: number;
  launch: string | null; effort: string | null; model: string | null; parent: string | null;
  parked_at: number | null; parked_mates: string | null; parked_why: string | null;
};

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function rowToRecord(r: SessionRow): SessionRecord {
  return {
    id: r.id, provider: r.provider as ProviderId, agentSessionId: r.agent_session_id,
    accountId: r.account_id, cwd: r.cwd, worktree: r.worktree, label: r.label,
    big: !!r.big, claim: r.claim, origin: r.origin as SessionRecord["origin"], tmux: r.tmux,
    transcriptPath: r.transcript_path, startedAt: r.started_at,
    lastActivityAt: r.last_activity_at, archivedAt: r.archived_at,
    facts: parseJson(r.facts), createdAt: r.created_at,
    launch: (parseJson(r.launch) as Launch | null) ?? null,
    effort: r.effort ?? null,
    model: r.model ?? null,
    parent: r.parent ?? null,
    parkedAt: r.parked_at ?? null,
    parkedMates: (parseJson(r.parked_mates) as string[] | null) ?? null,
    parkedWhy: r.parked_why ?? null,
  };
}

const RECORD_COLUMNS = {
  provider: "provider",
  agentSessionId: "agent_session_id",
  accountId: "account_id",
  cwd: "cwd",
  worktree: "worktree",
  label: "label",
  big: "big",
  claim: "claim",
  origin: "origin",
  tmux: "tmux",
  transcriptPath: "transcript_path",
  startedAt: "started_at",
  lastActivityAt: "last_activity_at",
  archivedAt: "archived_at",
  facts: "facts",
  createdAt: "created_at",
  launch: "launch",
  effort: "effort",
  model: "model",
  parent: "parent",
  parkedAt: "parked_at",
  parkedMates: "parked_mates",
  parkedWhy: "parked_why",
} as const satisfies Record<Exclude<keyof SessionRecord, "id">, string>;

type RecordKey = keyof typeof RECORD_COLUMNS;

function recordToSql(key: RecordKey, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (key === "facts" || key === "launch" || key === "parkedMates") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number;
}

export function insertSessionRecord(r: SessionRecord): void {
  const keys = Object.keys(RECORD_COLUMNS) as RecordKey[];
  const cols = ["id", ...keys.map((k) => RECORD_COLUMNS[k])];
  getDb().run(
    `INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    [r.id, ...keys.map((k) => recordToSql(k, r[k]))],
  );
}

export function updateSessionRecord(id: string, patch: Partial<SessionRecord>): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const key of Object.keys(patch) as (keyof SessionRecord)[]) {
    if (key === "id" || !(key in RECORD_COLUMNS)) continue;
    const k = key as RecordKey;
    sets.push(`${RECORD_COLUMNS[k]} = ?`);
    vals.push(recordToSql(k, patch[key]));
  }
  if (sets.length === 0) return;
  getDb().run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
}

export function getSessionRecord(id: string): SessionRecord | null {
  const row = getDb().query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null;
  return row ? rowToRecord(row) : null;
}

export function findSessionRecord(provider: ProviderId, agentSessionId: string): SessionRecord | null {
  const row = getDb()
    .query("SELECT * FROM sessions WHERE provider = ? AND agent_session_id = ?")
    .get(provider, agentSessionId) as SessionRow | null;
  return row ? rowToRecord(row) : null;
}

/** Sessions active since `sinceMs`, plus every session that is not closed
 *  and was started by agentbox (those stay until you close them).
 *  (`archived_at` is when it was closed: the old name for it.) */
export function listSessionRecords(sinceMs = 0): SessionRecord[] {
  const rows = getDb()
    .query(
      `SELECT * FROM sessions
        WHERE last_activity_at >= ?
           OR (origin = 'agentbox' AND archived_at IS NULL)
        ORDER BY last_activity_at DESC`,
    )
    .all(sinceMs) as SessionRow[];
  return rows.map(rowToRecord);
}

/** Every closed session, the most recently closed first. */
export function listClosedRecords(): SessionRecord[] {
  const rows = getDb()
    .query("SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC, id DESC")
    .all() as SessionRow[];
  return rows.map(rowToRecord);
}

// -------------------------------------------------------------- schedules

type ScheduleRow = {
  id: string; rule: string; spec: string; label: string | null; enabled: number; next_at: number | null;
  created_at: number; last_run_at: number | null; last_session_id: string | null; last_error: string | null;
};

function rowToSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    rule: parseJson(r.rule) as Schedule["rule"],
    spec: parseJson(r.spec) as Schedule["spec"],
    label: r.label,
    enabled: r.enabled === 1,
    nextAt: r.next_at,
    createdAt: r.created_at,
    lastRunAt: r.last_run_at,
    lastSessionId: r.last_session_id,
    lastError: r.last_error,
  };
}

const SCHEDULE_COLUMNS = {
  rule: "rule",
  spec: "spec",
  label: "label",
  enabled: "enabled",
  nextAt: "next_at",
  createdAt: "created_at",
  lastRunAt: "last_run_at",
  lastSessionId: "last_session_id",
  lastError: "last_error",
} as const satisfies Record<Exclude<keyof Schedule, "id">, string>;

type ScheduleKey = keyof typeof SCHEDULE_COLUMNS;

function scheduleToSql(key: ScheduleKey, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (key === "rule" || key === "spec") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number;
}

/** The soonest first; those with nothing coming last. */
export function listSchedules(): Schedule[] {
  const rows = getDb()
    .query("SELECT * FROM schedules ORDER BY next_at IS NULL, next_at, created_at")
    .all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function getSchedule(id: string): Schedule | null {
  const row = getDb().query("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | null;
  return row ? rowToSchedule(row) : null;
}

export function insertSchedule(s: Schedule): void {
  const keys = Object.keys(SCHEDULE_COLUMNS) as ScheduleKey[];
  const cols = ["id", ...keys.map((k) => SCHEDULE_COLUMNS[k])];
  getDb().run(
    `INSERT INTO schedules (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    [s.id, ...keys.map((k) => scheduleToSql(k, s[k]))],
  );
}

export function updateSchedule(id: string, patch: Partial<Schedule>): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const key of Object.keys(patch) as (keyof Schedule)[]) {
    if (key === "id" || !(key in SCHEDULE_COLUMNS)) continue;
    const k = key as ScheduleKey;
    sets.push(`${SCHEDULE_COLUMNS[k]} = ?`);
    vals.push(scheduleToSql(k, patch[key]));
  }
  if (sets.length === 0) return;
  getDb().run(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, [...vals, id]);
}

export function deleteSchedule(id: string): void {
  getDb().run("DELETE FROM schedules WHERE id = ?", [id]);
}

// ---------------------------------------------------------------- pull requests

/** A pull request as the table keeps it (src/core/prs.ts). */
export interface StoredPr {
  repo: string;
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  /** The commit it landed as, once merged. */
  mergeCommit: string | null;
}

interface PrRow {
  repo: string;
  number: number;
  title: string;
  head_ref: string;
  base_ref: string;
  state: StoredPr["state"];
  draft: number;
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  merge_commit: string | null;
}

function rowToPr(r: PrRow): StoredPr {
  return {
    repo: r.repo,
    number: r.number,
    title: r.title,
    headRef: r.head_ref,
    baseRef: r.base_ref,
    state: r.state,
    isDraft: r.draft === 1,
    author: r.author,
    url: r.url,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mergeCommit: r.merge_commit,
  };
}

/** Insert or refresh, keeping whichever copy of a PR is newer: the history
 *  walk can read one after the catch-up already has a later version. */
export function upsertPrs(prs: readonly StoredPr[]): void {
  if (prs.length === 0) return;
  const d = getDb();
  const q = d.prepare(
    `INSERT INTO prs (repo,number,title,head_ref,base_ref,state,draft,author,url,created_at,updated_at,merge_commit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT (repo, number) DO UPDATE SET
       title = excluded.title, head_ref = excluded.head_ref, base_ref = excluded.base_ref,
       state = excluded.state, draft = excluded.draft, author = excluded.author, url = excluded.url,
       created_at = excluded.created_at, updated_at = excluded.updated_at, merge_commit = excluded.merge_commit
     WHERE excluded.updated_at >= prs.updated_at`,
  );
  d.transaction(() => {
    for (const p of prs) {
      q.run(p.repo, p.number, p.title, p.headRef, p.baseRef, p.state, p.isDraft ? 1 : 0, p.author, p.url, p.createdAt, p.updatedAt, p.mergeCommit);
    }
  })();
}

/** The open PRs of these repos, most recently updated first. */
export function listOpenPrs(repos: readonly string[]): StoredPr[] {
  if (repos.length === 0) return [];
  const rows = getDb()
    .query(`SELECT * FROM prs WHERE state = 'OPEN' AND repo IN (${repos.map(() => "?").join(",")}) ORDER BY updated_at DESC`)
    .all(...repos) as PrRow[];
  return rows.map(rowToPr);
}

export function getPr(repo: string, number: number): StoredPr | null {
  const row = getDb().query("SELECT * FROM prs WHERE repo = ? AND number = ?").get(repo, number) as PrRow | null;
  return row ? rowToPr(row) : null;
}

/** Every PR of a repo, open or not, as branch and state. */
export function prBranchesOf(repo: string): { headRef: string; state: StoredPr["state"] }[] {
  return getDb().query("SELECT head_ref AS headRef, state FROM prs WHERE repo = ?").all(repo) as {
    headRef: string;
    state: StoredPr["state"];
  }[];
}

export interface PrSync {
  etag: string | null;
  updatedTo: string | null;
  openAt: number;
  historyPage: number;
}

export function getPrSync(repo: string): PrSync | null {
  const r = getDb().query("SELECT * FROM pr_sync WHERE repo = ?").get(repo) as {
    etag: string | null;
    updated_to: string | null;
    open_at: number;
    history_page: number;
  } | null;
  return r ? { etag: r.etag, updatedTo: r.updated_to, openAt: r.open_at, historyPage: r.history_page } : null;
}

export function savePrSync(repo: string, s: PrSync): void {
  getDb().run(
    `INSERT INTO pr_sync (repo,etag,updated_to,open_at,history_page) VALUES (?,?,?,?,?)
     ON CONFLICT (repo) DO UPDATE SET etag = excluded.etag, updated_to = excluded.updated_to,
       open_at = excluded.open_at, history_page = excluded.history_page`,
    [repo, s.etag, s.updatedTo, s.openAt, s.historyPage],
  );
}

// ---------------------------------------------------------------- metrics

export function insertUsageSample(accountId: string, at: number, w: UsageWindow, source: string): void {
  getDb().run(
    `INSERT INTO usage_samples (account_id,at,window_id,kind,used_pct,resets_at,source)
     VALUES (?,?,?,?,?,?,?)`,
    [accountId, at, w.id, w.kind, w.usedPct, w.resetsAt, source],
  );
}

export interface UsageSampleRow {
  accountId: string;
  at: number;
  windowId: string;
  kind: string;
  usedPct: number;
  resetsAt: number | null;
  source: string;
}

export function lastUsageSample(accountId: string, windowId: string): UsageSampleRow | null {
  const r = getDb()
    .query(
      `SELECT account_id, at, window_id, kind, used_pct, resets_at, source FROM usage_samples
        WHERE account_id = ? AND window_id = ? ORDER BY at DESC LIMIT 1`,
    )
    .get(accountId, windowId) as
    | { account_id: string; at: number; window_id: string; kind: string; used_pct: number; resets_at: number | null; source: string }
    | null;
  return r
    ? { accountId: r.account_id, at: r.at, windowId: r.window_id, kind: r.kind, usedPct: r.used_pct, resetsAt: r.resets_at, source: r.source }
    : null;
}

export function usageSamplesSince(sinceMs: number, accountId?: string): UsageSampleRow[] {
  const rows = (
    accountId
      ? getDb().query("SELECT * FROM usage_samples WHERE at >= ? AND account_id = ? ORDER BY at").all(sinceMs, accountId)
      : getDb().query("SELECT * FROM usage_samples WHERE at >= ? ORDER BY account_id, window_id, at").all(sinceMs)
  ) as { account_id: string; at: number; window_id: string; kind: string; used_pct: number; resets_at: number | null; source: string }[];
  return rows.map((r) => ({
    accountId: r.account_id, at: r.at, windowId: r.window_id, kind: r.kind,
    usedPct: r.used_pct, resetsAt: r.resets_at, source: r.source,
  }));
}

export function insertTokenSample(sessionId: string, at: number, t: TokenTotals): void {
  getDb().run(
    `INSERT INTO token_samples (session_id,at,input,output,cache_read,cache_write,cost_equiv)
     VALUES (?,?,?,?,?,?,?)`,
    [sessionId, at, t.input, t.output, t.cacheRead, t.cacheWrite, t.costEquiv],
  );
}

export interface TokenSampleRow extends TokenTotals {
  sessionId: string;
  at: number;
}

/** The newest token sample at or before `atMs`, for interval deltas. */
export function tokenSampleAt(sessionId: string, atMs: number): TokenSampleRow | null {
  const r = getDb()
    .query("SELECT * FROM token_samples WHERE session_id = ? AND at <= ? ORDER BY at DESC LIMIT 1")
    .get(sessionId, atMs) as {
      session_id: string; at: number; input: number; output: number;
      cache_read: number; cache_write: number; cost_equiv: number;
    } | null;
  return r
    ? { sessionId: r.session_id, at: r.at, input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, costEquiv: r.cost_equiv }
    : null;
}

export function insertAttribution(sessionId: string, accountId: string, at: number, points: number): void {
  getDb().run("INSERT INTO attributions (session_id,account_id,at,points) VALUES (?,?,?,?)", [
    sessionId, accountId, at, points,
  ]);
}

/** Weekly points attributed to each session, summed. */
export function attributedPoints(sessionIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (sessionIds.length === 0) return out;
  const rows = getDb()
    .query(
      `SELECT session_id, SUM(points) AS points FROM attributions
        WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) GROUP BY session_id`,
    )
    .all(...sessionIds) as { session_id: string; points: number }[];
  for (const r of rows) out.set(r.session_id, r.points);
  return out;
}

export interface AssignmentRow {
  id: string;
  sessionId: string | null;
  at: number;
  provider: ProviderId;
  accountId: string | null;
  mode: string;
  big: boolean;
  claim: number;
  candidates: Candidate[];
  settings: BalancerSettings;
  why: string;
}

export function insertAssignment(a: AssignmentRow): void {
  getDb().run(
    `INSERT INTO assignments (id,session_id,at,provider,account_id,mode,big,claim,candidates,settings,why)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [a.id, a.sessionId, a.at, a.provider, a.accountId, a.mode, a.big ? 1 : 0, a.claim,
     JSON.stringify(a.candidates), JSON.stringify(a.settings), a.why],
  );
}

export function assignmentsSince(sinceMs: number): AssignmentRow[] {
  const rows = getDb().query("SELECT * FROM assignments WHERE at >= ? ORDER BY at").all(sinceMs) as {
    id: string; session_id: string | null; at: number; provider: string; account_id: string | null;
    mode: string; big: number; claim: number; candidates: string; settings: string; why: string;
  }[];
  return rows.map((r) => ({
    id: r.id, sessionId: r.session_id, at: r.at, provider: r.provider as ProviderId,
    accountId: r.account_id, mode: r.mode, big: !!r.big, claim: r.claim,
    candidates: (parseJson(r.candidates) as Candidate[]) ?? [],
    settings: parseJson(r.settings) as BalancerSettings, why: r.why,
  }));
}

export function insertRateLimitHit(sessionId: string, accountId: string | null, at: number, detail: string): void {
  getDb().run(
    "INSERT OR IGNORE INTO rate_limit_hits (session_id,account_id,at,detail) VALUES (?,?,?,?)",
    [sessionId, accountId, at, detail],
  );
}

export function rateLimitHitsSince(sinceMs: number): { sessionId: string; accountId: string | null; at: number; detail: string }[] {
  const rows = getDb().query("SELECT * FROM rate_limit_hits WHERE at >= ? ORDER BY at").all(sinceMs) as {
    session_id: string; account_id: string | null; at: number; detail: string;
  }[];
  return rows.map((r) => ({ sessionId: r.session_id, accountId: r.account_id, at: r.at, detail: r.detail }));
}

// -------------------------------------------------------------------- btw

type BtwRow = {
  id: number; session_id: string; question: string; answer: string | null; error: string | null;
  status: string; source: string; asked_at: number; answered_at: number | null;
};

const rowToBtw = (r: BtwRow): Btw => ({
  id: r.id, sessionId: r.session_id, question: r.question, answer: r.answer, error: r.error,
  status: r.status as Btw["status"], source: r.source as Btw["source"], askedAt: r.asked_at, answeredAt: r.answered_at,
});

export function insertBtw(b: Pick<Btw, "sessionId" | "question" | "source" | "askedAt">): Btw {
  const r = getDb()
    .query("INSERT INTO btw (session_id,question,status,source,asked_at) VALUES (?,?,'asking',?,?) RETURNING *")
    .get(b.sessionId, b.question, b.source, b.askedAt) as BtwRow;
  return rowToBtw(r);
}

export function finishBtw(id: number, done: { answer: string } | { error: string }, at: number): void {
  if ("answer" in done) getDb().run("UPDATE btw SET status='answered', answer=?, error=NULL, answered_at=? WHERE id=?", [done.answer, at, id]);
  else getDb().run("UPDATE btw SET status='failed', error=?, answered_at=? WHERE id=?", [done.error, at, id]);
}

export function listBtw(sessionId: string): Btw[] {
  return (getDb().query("SELECT * FROM btw WHERE session_id = ? ORDER BY asked_at, id").all(sessionId) as BtwRow[]).map(rowToBtw);
}

/** Taken back before it answered: the card is hidden from the Timeline; the record stays. */
export function dismissBtw(id: number, at: number): void {
  getDb().run("UPDATE btw SET status='dismissed', error=NULL, answered_at=? WHERE id=? AND status='asking'", [at, id]);
}

/** Ones still asking when the server stopped: nothing is waiting on them any more. */
export function failUnfinishedBtw(error: string, at: number): string[] {
  const rows = getDb().query("UPDATE btw SET status='failed', error=?, answered_at=? WHERE status='asking' RETURNING session_id").all(error, at) as { session_id: string }[];
  return [...new Set(rows.map((r) => r.session_id))];
}

// ------------------------------------------------------------------ repos

type RepoRow = {
  id: string; ref: string; kind: string; display_name: string;
  full_name: string | null; default_branch: string; added_at: number;
  worktree_default: number | null;
};

function rowToRepo(r: RepoRow): Repo {
  return {
    id: r.id, ref: r.ref, kind: r.kind as Repo["kind"], displayName: r.display_name,
    fullName: r.full_name, defaultBranch: r.default_branch, addedAt: r.added_at,
    worktreeDefault: r.worktree_default === null ? null : !!r.worktree_default,
  };
}

export function insertRepo(r: Repo) {
  getDb().run(
    "INSERT OR IGNORE INTO repos (id,ref,kind,display_name,full_name,default_branch,added_at) VALUES (?,?,?,?,?,?,?)",
    [r.id, r.ref, r.kind, r.displayName, r.fullName, r.defaultBranch, r.addedAt]
  );
}

export function listRepos(): Repo[] {
  const rows = getDb().query("SELECT * FROM repos ORDER BY added_at ASC").all() as RepoRow[];
  return rows.map(rowToRepo);
}

export function getRepoById(id: string): Repo | null {
  const row = getDb().query("SELECT * FROM repos WHERE id = ?").get(id) as RepoRow | null;
  return row ? rowToRepo(row) : null;
}

/** Look a repo up by the `ref` a Session stores. Sessions record the ref, not
 *  the id, so this is the lookup the engine needs to find a session's repo. */
export function getRepo(ref: string): Repo | null {
  const row = getDb().query("SELECT * FROM repos WHERE ref = ?").get(ref) as RepoRow | null;
  return row ? rowToRepo(row) : null;
}

export function deleteRepo(id: string) {
  getDb().run("DELETE FROM repos WHERE id = ?", [id]);
}

/** Remember where this repo's sessions usually run, from an explicit pick. */
export function setRepoWorktreeDefault(id: string, value: boolean | null): void {
  getDb().run("UPDATE repos SET worktree_default = ? WHERE id = ?", [value === null ? null : value ? 1 : 0, id]);
}

/**
 * Register a repo from what the human typed: a local path or an `owner/name`
 * slug.
 *
 * Registration is where the slow questions get asked — is this a git repo, what
 * is its default branch, does it have a GitHub remote — so that spawning a
 * session and listing PRs never have to. Async because it talks to the network
 * for a slug we have not cloned yet.
 */
export async function addRepo(ref: string): Promise<Repo> {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("a repo path or owner/name slug is required");

  const existing = getRepo(normalizeRef(trimmed));
  if (existing) return existing;

  const isPath = /^[~./]/.test(trimmed) || trimmed.startsWith("/");
  const record: Repo = isPath
    ? localRepo(normalizeRef(trimmed))
    : githubRepo(trimmed);
  insertRepo(record);
  return getRepo(record.ref) ?? record;
}

function normalizeRef(ref: string): string {
  if (ref.startsWith("~/")) return join(homedir(), ref.slice(2));
  if (ref === "~") return homedir();
  if (/^[./]/.test(ref)) return resolve(ref);
  return ref;
}

function localRepo(path: string): Repo {
  if (!isGitRepo(path)) throw new Error(`not a git repository: ${path}`);
  return {
    id: randomUUID(),
    ref: path,
    kind: "local",
    displayName: basename(path) || path,
    fullName: repoFullNameOf(path),
    defaultBranch: resolveDefaultBranch(path),
    addedAt: Date.now(),
    worktreeDefault: null,
  };
}

function githubRepo(slug: string): Repo {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) {
    throw new Error(`use a local path or an owner/repo GitHub slug, not "${slug}"`);
  }
  return {
    id: randomUUID(),
    ref: slug,
    kind: "github",
    displayName: slug,
    fullName: slug,
    // Asked before the clone exists, so it goes to the remote directly. A
    // wrong answer here sends every worktree off the wrong branch, so failing
    // is better than assuming "main".
    defaultBranch: remoteDefaultBranch(slug),
    addedAt: Date.now(),
    worktreeDefault: null,
  };
}

function remoteDefaultBranch(slug: string): string {
  const r = run(["git", "ls-remote", "--symref", `https://github.com/${slug}.git`, "HEAD"]);
  if (r.code !== 0) {
    throw new Error(`could not reach github.com/${slug}: ${r.stderr.split("\n")[0]?.trim() ?? "unknown error"}`);
  }
  const m = r.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  if (!m) throw new Error(`github.com/${slug} reported no default branch`);
  return m[1];
}

// -------------------------------------------------------------- settings

export const DEFAULT_BALANCER: BalancerSettings = {
  claimNormal: 3,
  claimBig: 20,
  shortWindowInWeekly: 24,
  claimIdleMin: 60,
  resetHorizonMin: 60,
};

export const DEFAULT_SETTINGS: AgentSettings = {
  theme: "system",
  boardDays: 3,
  autoApprove: true,
  parkIdleMin: 60,
  models: { claude: "", codex: "", devin: "", omp: "" },
  balancer: DEFAULT_BALANCER,
};

/** A partial of AgentSettings whose nested objects may also be partial. */
export type SettingsPatch = {
  [K in keyof AgentSettings]?: AgentSettings[K] extends object
    ? Partial<AgentSettings[K]>
    : AgentSettings[K];
};

/**
 * Merge a patch over a full settings object, one level into the nested groups.
 *
 * A flat `{...base, ...patch}` would replace `balancer` wholesale, so a UI
 * that sends `{balancer: {claimBig: 25}}` would drop every other knob. Keys the
 * base does not have are dropped, so a setting deleted from the code cannot
 * ride along in the stored row forever.
 */
export function mergeSettings(base: AgentSettings, patch: SettingsPatch): AgentSettings {
  const { balancer, models, ...scalars } = patch;
  return {
    ...base,
    ...defined(known(scalars, base)),
    models: { ...base.models, ...defined(known(models ?? {}, base.models)) },
    balancer: { ...base.balancer, ...defined(known(balancer ?? {}, base.balancer)) },
  };
}

function known<T extends object>(o: Record<string, unknown>, base: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(o)) {
    if (key in base) out[key] = o[key];
  }
  return out as Partial<T>;
}

function defined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(o) as (keyof T)[]) {
    if (o[key] !== undefined) out[key] = o[key];
  }
  return out;
}

export function getSettings(): AgentSettings {
  const row = getDb().query("SELECT value FROM settings WHERE key = 'agent'").get() as
    | { value: string }
    | null;
  if (!row) return DEFAULT_SETTINGS;
  const stored = parseJson(row.value);
  if (!stored || typeof stored !== "object") {
    console.error("agentbox: settings row is not valid JSON — falling back to defaults");
    return DEFAULT_SETTINGS;
  }
  return mergeSettings(DEFAULT_SETTINGS, stored as SettingsPatch);
}

export function saveSettings(s: AgentSettings): void {
  getDb().run("INSERT OR REPLACE INTO settings (key,value) VALUES ('agent',?)", [JSON.stringify(s)]);
}

/** Small persisted values that are not settings: last usage readings, etc. */
export function getKv<T>(key: string): T | null {
  const row = getDb().query("SELECT value FROM settings WHERE key = ?").get(`kv:${key}`) as
    | { value: string }
    | null;
  return row ? (parseJson(row.value) as T) : null;
}

export function setKv(key: string, value: unknown): void {
  getDb().run("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)", [`kv:${key}`, JSON.stringify(value)]);
}
