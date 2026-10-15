/** Salus's state: one SQLite file in its home (`store()` from the SDK). */
import type { Database } from "bun:sqlite";
import { ActionError } from "../../lib/sdk";
import type { Crash } from "./types";

export class Store {
  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crashes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  crashes(): Crash[] {
    return (this.db.query("SELECT body FROM crashes").all() as { body: string }[]).map((r) => JSON.parse(r.body) as Crash).sort((a, b) => b.lastSeen - a.lastSeen);
  }
  find(id: string): Crash | null {
    const row = this.db.query("SELECT body FROM crashes WHERE id = ?").get(id) as { body: string } | null;
    return row ? (JSON.parse(row.body) as Crash) : null;
  }
  crash(id: string): Crash {
    const c = this.find(id);
    if (!c) throw new ActionError("No such crash", 404);
    return c;
  }
  save(c: Crash, now = Date.now()): Crash {
    const out = { ...c, updatedAt: now };
    this.db.run("INSERT INTO crashes (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body", [c.id, JSON.stringify(out)]);
    return out;
  }

  get<T>(k: string): T | null {
    const row = this.db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null;
    return row ? (JSON.parse(row.v) as T) : null;
  }
  set(k: string, v: unknown): void {
    this.db.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, JSON.stringify(v)]);
  }
}
