import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DEFAULT_MODEL, dbPath, ensureDirs } from "./paths";
import { isGitRepo, resolveDefaultBranch, repoFullNameOf, run } from "./git";
import type { Session, SessionStatus, Repo, AgentSettings, PermissionRequest, SubagentProgress } from "./types";

let db: Database | null = null;
let openedAt = "";

export function getDb(): Database {
  // Keyed on the resolved path, not just "is it open". Caching the handle alone
  // would be the module-scope `AGENTBOX_HOME` bug one level down: a changed home
  // would keep answering from the database opened against the previous one.
  const path = dbPath();
  if (db && openedAt === path) return db;
  ensureDirs();
  db = new Database(path, { create: true });
  openedAt = path;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  // There is more than one writer now: every live session's host process
  // writes its own transcript and status, alongside the server. WAL lets them
  // read concurrently but still serialises writes, and without a busy timeout
  // the loser of a race gets an instant SQLITE_BUSY rather than waiting the
  // millisecond the other write takes — which would surface as a dropped
  // transcript event under nothing more exotic than two agents talking at once.
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

// ---------------------------------------------------------------- schema

const SESSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id             TEXT PRIMARY KEY,
    title          TEXT NOT NULL,
    prompt         TEXT NOT NULL,
    status         TEXT NOT NULL,
    repo           TEXT NOT NULL,
    branch         TEXT NOT NULL,
    worktree       TEXT,
    model          TEXT NOT NULL,
    follow_ups     INTEGER NOT NULL DEFAULT 0,
    last_message   TEXT,
    tool_calls     INTEGER NOT NULL DEFAULT 0,
    exit_code      INTEGER,
    pid            INTEGER,
    host_pid       INTEGER,
    permission     TEXT,
    pr_number      INTEGER,
    repo_full_name TEXT,
    cost_usd       REAL,
    tokens         INTEGER,
    blocked        INTEGER NOT NULL DEFAULT 0,
    flag_reason    TEXT,
    omp_session_id TEXT,
    subs           TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    started_at     INTEGER,
    archived_at    INTEGER,
    parked_at      INTEGER
  );
`;

const REPOS_DDL = `
  CREATE TABLE IF NOT EXISTS repos (
    id             TEXT PRIMARY KEY,
    ref            TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    full_name      TEXT,
    default_branch TEXT NOT NULL DEFAULT 'main',
    added_at       INTEGER NOT NULL
  );
`;

function columnsOf(d: Database, table: string): string[] {
  return (d.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/**
 * The old schema carried `session_dir` and `waiting_for_input`, both of which
 * the new model dropped — `waiting` is a status now, and nothing ever read the
 * session dir back out. Rather than accreting columns forever we rebuild the
 * table and copy every row across; there is one real database (the author's
 * laptop) and no row is worth losing.
 */
function migrate(d: Database) {
  d.exec(SESSIONS_DDL);
  d.exec(REPOS_DDL);
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  migrateSessions(d);
  migrateRepos(d);
}

function migrateSessions(d: Database) {
  const cols = columnsOf(d, "sessions");
  const legacy = cols.includes("session_dir") || cols.includes("waiting_for_input");
  if (!legacy) {
    // A table created by this version, or one already rebuilt. Only genuinely
    // new columns can be missing, and those are safe to add in place.
    if (!cols.includes("tool_calls")) d.exec("ALTER TABLE sessions ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0");
    if (!cols.includes("flag_reason")) d.exec("ALTER TABLE sessions ADD COLUMN flag_reason TEXT");
    if (!cols.includes("started_at")) d.exec("ALTER TABLE sessions ADD COLUMN started_at INTEGER");
    if (!cols.includes("host_pid")) d.exec("ALTER TABLE sessions ADD COLUMN host_pid INTEGER");
    if (!cols.includes("permission")) d.exec("ALTER TABLE sessions ADD COLUMN permission TEXT");
    if (!cols.includes("subs")) d.exec("ALTER TABLE sessions ADD COLUMN subs TEXT");
    if (!cols.includes("parked_at")) d.exec("ALTER TABLE sessions ADD COLUMN parked_at INTEGER");
    return;
  }

  const hadOmpId = cols.includes("omp_session_id");
  const hadBlocked = cols.includes("blocked");
  d.transaction(() => {
    d.exec("ALTER TABLE sessions RENAME TO sessions_legacy");
    d.exec(SESSIONS_DDL);
    // `started_at` is genuinely unknown for old rows — a session's first turn
    // was never recorded — so it stays null rather than being guessed from
    // created_at, which would put a wrong elapsed time on the detail header.
    d.exec(`
      INSERT INTO sessions (
        id, title, prompt, status, repo, branch, worktree, model, follow_ups,
        last_message, tool_calls, exit_code, pid, pr_number, repo_full_name,
        cost_usd, tokens, blocked, flag_reason, omp_session_id,
        created_at, updated_at, started_at, archived_at
      )
      SELECT
        id, title, prompt, status, repo, branch, worktree, model, follow_ups,
        last_message, 0, exit_code, pid, pr_number, repo_full_name,
        cost_usd, tokens, ${hadBlocked ? "COALESCE(blocked, 0)" : "0"}, NULL,
        ${hadOmpId ? "omp_session_id" : "NULL"},
        created_at, updated_at, NULL, archived_at
      FROM sessions_legacy
    `);
    d.exec("DROP TABLE sessions_legacy");
  })();
}

function migrateRepos(d: Database) {
  const cols = columnsOf(d, "repos");
  if (!cols.includes("full_name")) d.exec("ALTER TABLE repos ADD COLUMN full_name TEXT");
  if (!cols.includes("default_branch")) {
    d.exec("ALTER TABLE repos ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main'");
  }
  // Backfill the two fields registration now resolves up front. Only rows that
  // predate them are touched, so this runs once and costs nothing thereafter.
  const stale = d
    .query("SELECT id, ref, kind FROM repos WHERE full_name IS NULL OR default_branch = ''")
    .all() as { id: string; ref: string; kind: string }[];
  for (const row of stale) {
    const path = row.kind === "local" ? row.ref : null;
    const fullName = row.kind === "github" ? row.ref : path ? repoFullNameOf(path) : null;
    const branch = path ? resolveDefaultBranch(path) : "main";
    d.run("UPDATE repos SET full_name = ?, default_branch = ? WHERE id = ?", [fullName, branch, row.id]);
  }
}

// -------------------------------------------------------------- sessions

type SessionRow = {
  id: string; title: string; prompt: string; status: string; repo: string;
  branch: string; worktree: string | null; model: string;
  follow_ups: number; last_message: string | null; tool_calls: number;
  exit_code: number | null; pid: number | null; host_pid: number | null;
  permission: string | null; pr_number: number | null;
  repo_full_name: string | null; cost_usd: number | null; tokens: number | null;
  blocked: number; flag_reason: string | null; omp_session_id: string | null;
  subs: string | null;
  created_at: number; updated_at: number; started_at: number | null;
  archived_at: number | null; parked_at: number | null;
};

/**
 * Persisted Session fields → their column. This is the one place that knows the
 * mapping: it drives the insert, the targeted update, and (by omission) which
 * fields are in-memory only.
 *
 * `permission` is here now. It used to be excluded on the grounds that it
 * belonged to the live ACP connection, which stopped being true when agents
 * moved into host processes: the server can be restarted out from under a
 * blocked agent, and the prompt it is blocked on has to still be answerable
 * afterwards.
 */
const SESSION_COLUMNS = {
  title: "title",
  prompt: "prompt",
  status: "status",
  repo: "repo",
  branch: "branch",
  worktree: "worktree",
  model: "model",
  followUps: "follow_ups",
  lastMessage: "last_message",
  toolCalls: "tool_calls",
  exitCode: "exit_code",
  pid: "pid",
  hostPid: "host_pid",
  permission: "permission",
  prNumber: "pr_number",
  repoFullName: "repo_full_name",
  costUsd: "cost_usd",
  tokens: "tokens",
  blocked: "blocked",
  flagReason: "flag_reason",
  ompSessionId: "omp_session_id",
  subs: "subs",
  createdAt: "created_at",
  updatedAt: "updated_at",
  startedAt: "started_at",
  closedAt: "archived_at",
  parkedAt: "parked_at",
} as const satisfies Partial<Record<keyof Session, string>>;

type PersistedKey = keyof typeof SESSION_COLUMNS;

/** SQLite has no boolean; everything else round-trips as-is. */
function toSql(key: PersistedKey, value: unknown): string | number | null {
  if (key === "blocked") return value ? 1 : 0;
  if (value === undefined || value === null) return null;
  // Structured columns. Stored as JSON rather than spread across more columns
  // because nothing queries into them — they are written whole by the host and
  // read whole by the UI.
  if (key === "permission") return JSON.stringify(value);
  if (key === "subs") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as string | number;
}

function permissionFromSql(raw: string | null): PermissionRequest | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PermissionRequest;
  } catch {
    // A half-written or older-shaped value must not take the session's whole
    // row down; the worst case is a prompt the user answers from the agent's
    // own transcript instead.
    return null;
  }
}

function subsFromSql(raw: string | null): SubagentProgress[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SubagentProgress[]) : null;
  } catch {
    return null;
  }
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id, title: r.title, prompt: r.prompt, status: r.status as SessionStatus,
    repo: r.repo, branch: r.branch, worktree: r.worktree, model: r.model,
    followUps: r.follow_ups, lastMessage: r.last_message, toolCalls: r.tool_calls,
    exitCode: r.exit_code, pid: r.pid, hostPid: r.host_pid,
    permission: permissionFromSql(r.permission), prNumber: r.pr_number,
    repoFullName: r.repo_full_name, costUsd: r.cost_usd, tokens: r.tokens,
    blocked: !!r.blocked, flagReason: r.flag_reason, ompSessionId: r.omp_session_id,
    subs: subsFromSql(r.subs),
    createdAt: r.created_at, updatedAt: r.updated_at, startedAt: r.started_at,
    closedAt: r.archived_at, parkedAt: r.parked_at,
  };
}

export function insertSession(s: Session) {
  const keys = Object.keys(SESSION_COLUMNS) as PersistedKey[];
  const cols = ["id", ...keys.map((k) => SESSION_COLUMNS[k])];
  const values: (string | number | null)[] = [s.id, ...keys.map((k) => toSql(k, s[k]))];
  getDb().run(
    `INSERT INTO sessions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    values
  );
}

/**
 * Write only the fields that were passed. The streamed-text path calls this on
 * every chunk of assistant output; rewriting all 24 columns (after a read to
 * find their current values) turned one character of text into a whole-row
 * round-trip.
 */
export function updateSession(id: string, patch: Partial<Session>) {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];
  for (const key of Object.keys(patch) as (keyof Session)[]) {
    if (!(key in SESSION_COLUMNS) || key === "updatedAt") continue;
    const k = key as PersistedKey;
    assignments.push(`${SESSION_COLUMNS[k]} = ?`);
    values.push(toSql(k, patch[key]));
  }
  if (assignments.length === 0) return;
  assignments.push("updated_at = ?");
  values.push(patch.updatedAt ?? Date.now());
  values.push(id);
  getDb().run(`UPDATE sessions SET ${assignments.join(", ")} WHERE id = ?`, values);
}

export function getSession(id: string): Session | null {
  const row = getDb()
    .query("SELECT * FROM sessions WHERE id = ?")
    .get(id) as SessionRow | null;
  return row ? rowToSession(row) : null;
}

/**
 * `includeClosed` is required, deliberately.
 *
 * It defaulted to `false`, which is how "the Inbox excludes closed sessions"
 * came to be true by accident rather than by decision — nothing stated the
 * intent, so widening the source later would have silently re-entered closed
 * rows into consumers that had never had to think about them. Every caller now
 * says which it wants at the callsite, and a new one cannot get an answer it
 * did not ask for.
 */
export function listSessions(includeClosed: boolean): Session[] {
  const rows = getDb()
    .query(includeClosed ? "SELECT * FROM sessions ORDER BY updated_at DESC"
                          : "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC")
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

// ----------------------------------------------------------------- repos

type RepoRow = {
  id: string; ref: string; kind: string; display_name: string;
  full_name: string | null; default_branch: string; added_at: number;
};

function rowToRepo(r: RepoRow): Repo {
  return {
    id: r.id, ref: r.ref, kind: r.kind as Repo["kind"], displayName: r.display_name,
    fullName: r.full_name, defaultBranch: r.default_branch, addedAt: r.added_at,
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

export const DEFAULT_SETTINGS: AgentSettings = {
  theme: "system",
  model: DEFAULT_MODEL,
  autoApprove: true,
  systemPrompt: "",
  supervisor: {
    enabled: true,
    everyToolCalls: 25,
    model: DEFAULT_MODEL,
  },
  advisor: {
    enabled: false,
    model: DEFAULT_MODEL,
  },
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
 * A flat `{...base, ...patch}` replaces `supervisor` wholesale, so a UI toggle
 * that sends `{supervisor: {enabled: false}}` would drop `everyToolCalls` and
 * `model` — the setting reads back as whatever the default happened to be.
 */
export function mergeSettings(base: AgentSettings, patch: SettingsPatch): AgentSettings {
  // The two nested groups are named rather than discovered, so adding a third
  // is a compile error here instead of a field that silently stops merging.
  const { supervisor, advisor, ...scalars } = patch;
  return {
    ...base,
    // Keyed off `base` rather than spread blind: the stored row is JSON written
    // by an older build, so it can carry settings that no longer exist. It
    // carried `maxMinutes` for exactly this reason — a removed setting that
    // would otherwise ride along in every GET and get rewritten on every save.
    ...defined(known(scalars, base)),
    supervisor: { ...base.supervisor, ...defined(supervisor ?? {}) },
    advisor: { ...base.advisor, ...defined(advisor ?? {}) },
  };
}

/** Drop keys whose value is `undefined`: JSON round-trips absent fields as
 *  undefined, and spreading those would erase the value they are absent from. */
/** Drops keys that `base` does not have, so a setting deleted from the code
 *  cannot survive in the stored row. */
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
  let stored: SettingsPatch;
  try {
    stored = JSON.parse(row.value) as SettingsPatch;
  } catch {
    // A corrupt row would otherwise throw on every request; defaults keep the
    // app usable and the next save overwrites it.
    console.error("agentbox: settings row is not valid JSON — falling back to defaults");
    return DEFAULT_SETTINGS;
  }
  return mergeSettings(DEFAULT_SETTINGS, stored);
}

export function saveSettings(s: AgentSettings) {
  getDb().run("INSERT OR REPLACE INTO settings (key,value) VALUES ('agent',?)", [
    JSON.stringify(s),
  ]);
}
