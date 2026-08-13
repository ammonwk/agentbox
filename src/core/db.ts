import { Database } from "bun:sqlite";
import { dbPath, ensureDirs } from "./paths";
import type { Session, SessionStatus, Repo, AgentSettings } from "./types";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  ensureDirs();
  db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      prompt        TEXT NOT NULL,
      status        TEXT NOT NULL,
      repo          TEXT NOT NULL,
      branch        TEXT NOT NULL,
      worktree      TEXT,
      session_dir   TEXT NOT NULL,
      model         TEXT NOT NULL,
      follow_ups    INTEGER NOT NULL DEFAULT 0,
      last_message  TEXT,
      exit_code     INTEGER,
      pid           INTEGER,
      pr_number     INTEGER,
      repo_full_name TEXT,
      cost_usd      REAL,
      tokens        INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      archived_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS repos (
      id           TEXT PRIMARY KEY,
      ref          TEXT NOT NULL UNIQUE,
      kind         TEXT NOT NULL,
      display_name TEXT NOT NULL,
      added_at     INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // additive migrations for the interactive engine
  const cols = (d.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("waiting_for_input")) d.exec("ALTER TABLE sessions ADD COLUMN waiting_for_input INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("blocked")) d.exec("ALTER TABLE sessions ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("omp_session_id")) d.exec("ALTER TABLE sessions ADD COLUMN omp_session_id TEXT");
}

// ---- sessions ----

type SessionRow = {
  id: string; title: string; prompt: string; status: string; repo: string;
  branch: string; worktree: string | null; session_dir: string; model: string;
  follow_ups: number; last_message: string | null; exit_code: number | null;
  pid: number | null; pr_number: number | null; repo_full_name: string | null;
  cost_usd: number | null; tokens: number | null;
  waiting_for_input: number; blocked: number; omp_session_id: string | null;
  created_at: number; updated_at: number; archived_at: number | null;
};

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id, title: r.title, prompt: r.prompt, status: r.status as SessionStatus,
    repo: r.repo, branch: r.branch, worktree: r.worktree, sessionDir: r.session_dir,
    model: r.model, followUps: r.follow_ups, lastMessage: r.last_message,
    exitCode: r.exit_code, pid: r.pid, prNumber: r.pr_number,
    repoFullName: r.repo_full_name, costUsd: r.cost_usd, tokens: r.tokens,
    waitingForInput: !!r.waiting_for_input, blocked: !!r.blocked,
    ompSessionId: r.omp_session_id,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at,
  };
}

export function insertSession(s: Session) {
  getDb().run(
    `INSERT INTO sessions (id,title,prompt,status,repo,branch,worktree,session_dir,model,follow_ups,last_message,exit_code,pid,pr_number,repo_full_name,cost_usd,tokens,waiting_for_input,blocked,omp_session_id,created_at,updated_at,archived_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.id, s.title, s.prompt, s.status, s.repo, s.branch, s.worktree, s.sessionDir,
     s.model, s.followUps, s.lastMessage, s.exitCode, s.pid, s.prNumber,
     s.repoFullName, s.costUsd, s.tokens, s.waitingForInput ? 1 : 0,
     s.blocked ? 1 : 0, s.ompSessionId, s.createdAt, s.updatedAt, s.archivedAt]
  );
}

export function updateSession(id: string, patch: Partial<Session>) {
  const cur = getSession(id);
  if (!cur) return;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  getDb().run(
    `UPDATE sessions SET title=?,prompt=?,status=?,repo=?,branch=?,worktree=?,session_dir=?,model=?,follow_ups=?,last_message=?,exit_code=?,pid=?,pr_number=?,repo_full_name=?,cost_usd=?,tokens=?,waiting_for_input=?,blocked=?,omp_session_id=?,created_at=?,updated_at=?,archived_at=? WHERE id=?`,
    [next.title, next.prompt, next.status, next.repo, next.branch, next.worktree,
     next.sessionDir, next.model, next.followUps, next.lastMessage, next.exitCode,
     next.pid, next.prNumber, next.repoFullName, next.costUsd, next.tokens,
     next.waitingForInput ? 1 : 0, next.blocked ? 1 : 0, next.ompSessionId,
     next.createdAt, next.updatedAt, next.archivedAt, id]
  );
}

export function getSession(id: string): Session | null {
  const row = getDb()
    .query("SELECT * FROM sessions WHERE id = ?")
    .get(id) as SessionRow | null;
  return row ? rowToSession(row) : null;
}

export function listSessions(includeArchived = false): Session[] {
  const rows = getDb()
    .query(includeArchived ? "SELECT * FROM sessions ORDER BY updated_at DESC"
                          : "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC")
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

export function deleteSession(id: string) {
  getDb().run("DELETE FROM sessions WHERE id = ?", [id]);
}

// ---- repos ----

type RepoRow = { id: string; ref: string; kind: string; display_name: string; added_at: number };

export function insertRepo(r: Repo) {
  getDb().run("INSERT OR IGNORE INTO repos (id,ref,kind,display_name,added_at) VALUES (?,?,?,?,?)",
    [r.id, r.ref, r.kind, r.displayName, r.addedAt]);
}

export function listRepos(): Repo[] {
  const rows = getDb().query("SELECT * FROM repos ORDER BY added_at ASC").all() as RepoRow[];
  return rows.map((r) => ({
    id: r.id, ref: r.ref, kind: r.kind as Repo["kind"],
    displayName: r.display_name, addedAt: r.added_at,
  }));
}

export function deleteRepo(id: string) {
  getDb().run("DELETE FROM repos WHERE id = ?", [id]);
}

// ---- settings ----

export function getSettings(): AgentSettings {
  const defaults: AgentSettings = {
    theme: "system",
    model: "opencode-go/deepseek-v4-flash",
    autoApprove: true,
    maxMinutes: 60,
  };
  const row = getDb().query("SELECT value FROM settings WHERE key = 'agent'").get() as
    | { value: string }
    | null;
  if (!row) return defaults;
  try {
    return { ...defaults, ...(JSON.parse(row.value) as Partial<AgentSettings>) };
  } catch {
    return defaults;
  }
}

export function saveSettings(s: AgentSettings) {
  getDb().run("INSERT OR REPLACE INTO settings (key,value) VALUES ('agent',?)", [
    JSON.stringify(s),
  ]);
}
