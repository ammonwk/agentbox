/** Vulcan's state: one SQLite file in its home (`store()` from the SDK), four
 *  tables of JSON bodies. "One writer per issue" is agentbox's claims now
 *  (work.ts); `issue_claims` is what held it before, read once to move it. */
import type { Database } from "bun:sqlite";
import { ActionError } from "../../lib/sdk";
import type { Grant, Proposal, Work } from "./types";

export class Store {
  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issue_claims (source TEXT PRIMARY KEY, work TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    `);
  }

  private all<T>(table: string): T[] {
    return (this.db.query(`SELECT body FROM ${table}`).all() as { body: string }[]).map((r) => JSON.parse(r.body) as T);
  }
  private one<T>(table: string, id: string): T | null {
    const row = this.db.query(`SELECT body FROM ${table} WHERE id = ?`).get(id) as { body: string } | null;
    return row ? (JSON.parse(row.body) as T) : null;
  }
  private put(table: string, id: string, body: unknown): void {
    this.db.run(`INSERT INTO ${table} (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body`, [id, JSON.stringify(body)]);
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  grants(): Grant[] {
    return this.all<Grant>("grants").sort((a, b) => b.createdAt - a.createdAt);
  }
  grant(id: string): Grant | null {
    return this.one<Grant>("grants", id);
  }
  saveGrant(g: Grant): void {
    this.put("grants", g.id, g);
  }

  works(): Work[] {
    return this.all<Work>("works").sort((a, b) => b.createdAt - a.createdAt);
  }
  work(id: string): Work {
    const w = this.one<Work>("works", id);
    if (!w) throw new ActionError("Work family not found", 404);
    return w;
  }
  saveWork(w: Work): void {
    this.put("works", w.id, w);
  }
  /** Issue claims kept here before agentbox kept them, by family. */
  legacyClaims(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const r of this.db.query("SELECT source, work FROM issue_claims ORDER BY source").all() as { source: string; work: string }[]) out.set(r.work, [...(out.get(r.work) ?? []), r.source]);
    return out;
  }
  dropLegacyClaims(work: string): void {
    this.db.run("DELETE FROM issue_claims WHERE work = ?", [work]);
  }

  proposals(): Proposal[] {
    return this.all<Proposal>("proposals").sort((a, b) => b.createdAt - a.createdAt);
  }
  proposal(id: string): Proposal | null {
    return this.one<Proposal>("proposals", id);
  }
  saveProposal(p: Proposal): void {
    this.put("proposals", p.id, p);
  }
}
