/** Machine-local bindings and side-effect journal. No conversations. A row
 * marked attempting is never replayed blindly after a process interruption. */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentboxHome } from "../paths";
import { getSessionRecord } from "../db";
import { FleetError } from "../fleet";
import { AgentRun } from "../../cloud/agents";

export const AgentBinding = z
  .object({
    agent: z.string().uuid(),
    url: z.string().url(),
    workspace: z.string().uuid(),
    provider: z.enum(["claude", "codex", "devin", "omp", "opencode", "muse"]),
    model: z.string().max(100).default(""),
    repos: z
      .record(z.string().regex(/^[\w.-]+\/[\w.-]+$/), z.string().min(1))
      .default({}),
    appKeyPath: z.string().default(""),
    noteCmd: z.string().max(4000).default(""),
  })
  .strict();
export type AgentBinding = z.infer<typeof AgentBinding>;
export interface LocalRun {
  run: AgentRun;
  session: string;
  phase: "claiming" | "starting" | "attached" | "stopping" | "done";
  finish: boolean;
}
export interface ActionRecord {
  id: string;
  run: string;
  fingerprint: string;
  body: unknown;
  state:
    "prepared" | "attempting" | "pending" | "sent" | "refused" | "uncertain";
  receipt?: string;
  publication?: {
    work: string;
    base: string;
    head: string;
    tree: string;
    remoteHead: string;
  };
  card: number | null;
  result: string;
}
export class AgentStore {
  readonly db: Database;
  constructor(path = join(agentboxHome(), "agents", "runtime.db")) {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake (id TEXT PRIMARY KEY, agent TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, rule TEXT NOT NULL, next_at INTEGER);
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, run TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_sessions (id TEXT PRIMARY KEY, run TEXT NOT NULL, work TEXT NOT NULL, cwd TEXT NOT NULL);
    `);
    this.db
      .query("SELECT id,body FROM actions")
      .all()
      .forEach((v) => {
        const row = v as { id: string; body: string },
          a = JSON.parse(row.body) as ActionRecord;
        if (a.state === "attempting")
          this.action({
            ...a,
            state: "uncertain",
            result:
              "The server stopped during dispatch. Reconcile the external result before another action.",
          });
      });
  }
  bindings(): AgentBinding[] {
    return this.all("bindings").map((x) => AgentBinding.parse(x));
  }
  bind(b: AgentBinding) {
    this.put("bindings", b.agent, AgentBinding.parse(b));
  }
  runs(): LocalRun[] {
    return this.all("runs") as LocalRun[];
  }
  run(r: LocalRun) {
    this.db.transaction(() => {
      this.put("runs", r.run.id, r);
      for (const id of [r.session, r.run.session_id, r.run.previous_session_id])
        if (id)
          this.db.run("INSERT OR IGNORE INTO sessions(id,run) VALUES (?,?)", [
            id,
            r.run.id,
          ]);
    })();
  }
  ownsSession(id: string) {
    return !!this.db
      .query(
        "SELECT 1 FROM sessions WHERE id=? UNION SELECT 1 FROM review_sessions WHERE id=?",
      )
      .get(id, id);
  }
  sessionRun(id: string): string | null {
    return (
      (
        this.db.query("SELECT run FROM sessions WHERE id=?").get(id) as {
          run: string;
        } | null
      )?.run ?? null
    );
  }
  reserveReviewer(id: string, run: string, work: string, cwd: string) {
    if (
      getSessionRecord(id) ||
      this.db.query("SELECT 1 FROM review_sessions WHERE id=?").get(id)
    )
      throw new FleetError(409, "Reviewer ID is already in use");
    this.db.run(
      "INSERT INTO review_sessions(id,run,work,cwd) VALUES (?,?,?,?)",
      [id, run, work, cwd],
    );
  }
  adoptReviewer(id: string, run: string, work: string, cwd: string) {
    const known = this.db
      .query("SELECT cwd,work FROM review_sessions WHERE id=?")
      .get(id) as { cwd: string; work: string } | null;
    const record = getSessionRecord(id);
    if (
      !known ||
      known.cwd !== cwd ||
      known.work !== work ||
      (record &&
        (record.cwd !== cwd ||
          record.provider !== "codex" ||
          record.origin !== "agentbox" ||
          !record.launch?.args.includes("read-only")))
    )
      throw new FleetError(
        409,
        "Reviewer lacks a proven reservation on this installation",
      );
    this.db.run("UPDATE review_sessions SET run=? WHERE id=?", [run, id]);
  }
  reviewers(run: string) {
    return (
      this.db
        .query("SELECT id,cwd FROM review_sessions WHERE run=?")
        .all(run) as { id: string; cwd: string }[]
    )
      .filter((x) => {
        const r = getSessionRecord(x.id);
        return (
          r?.cwd === x.cwd &&
          r.provider === "codex" &&
          r.origin === "agentbox" &&
          r.launch?.args.includes("read-only")
        );
      })
      .map((x) => x.id);
  }
  discardUnclaimed(id: string) {
    this.db.run("DELETE FROM runs WHERE id=?", [id]);
  }
  actions(): ActionRecord[] {
    return this.all("actions") as ActionRecord[];
  }
  action(a: ActionRecord) {
    this.put("actions", a.id, a);
  }
  private all(table: "bindings" | "runs" | "actions") {
    return (
      this.db.query(`SELECT body FROM ${table}`).all() as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  private put(
    table: "bindings" | "runs" | "actions",
    id: string,
    body: unknown,
  ) {
    this.db.run(
      `INSERT INTO ${table}(id,body) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`,
      [id, JSON.stringify(body)],
    );
  }
  queue(
    agent: string,
    items: { source: string; title: string; acceptance: string }[],
  ) {
    this.db.transaction(() => {
      for (const item of items)
        this.db.run(
          "INSERT OR IGNORE INTO intake(id,agent,body) VALUES (?,?,?)",
          [`${agent}:${item.source}`, agent, JSON.stringify(item)],
        );
    })();
  }
  pending(agent: string) {
    return this.db
      .query("SELECT id,body FROM intake WHERE agent=?")
      .all(agent) as { id: string; body: string }[];
  }
  accepted(id: string) {
    this.db.run("DELETE FROM intake WHERE id=?", [id]);
  }
  schedule(id: string) {
    return this.db
      .query("SELECT revision,rule,next_at FROM schedules WHERE id=?")
      .get(id) as {
      revision: number;
      rule: string;
      next_at: number | null;
    } | null;
  }
  scheduled(id: string, revision: number, rule: unknown, next: number | null) {
    this.db.run(
      "INSERT INTO schedules(id,revision,rule,next_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,rule=excluded.rule,next_at=excluded.next_at",
      [id, revision, JSON.stringify(rule), next],
    );
  }
}
