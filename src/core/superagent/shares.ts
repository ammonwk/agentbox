/** The superagents this machine shares with its cloud workspace: the
 *  instance the cloud gave each (docs/cloud.md, "Shared superagents"). The
 *  share route writes a row and the team tick reads it back from the cloud
 *  (src/core/superagent/team.ts); the cloud is the record. The hub shows it
 *  as `SuperagentInfo.team`, and claims of a shared superagent go to the
 *  cloud by it. */
import { getDb } from "../db";
import type { SuperagentTeam } from "../types";

export type Share = SuperagentTeam & { name: string; installation: string; updatedAt: number };

type Row = { name: string; instance: string; workspace: string; installation: string; visibility: string; maintainers: string; source: string | null; updated_at: number };

const toShare = (r: Row): Share => ({
  name: r.name,
  instance: r.instance,
  workspace: r.workspace,
  installation: r.installation,
  visibility: r.visibility === "workspace" ? "workspace" : "private",
  maintainers: JSON.parse(r.maintainers) as string[],
  source: r.source ? (JSON.parse(r.source) as Share["source"]) : null,
  updatedAt: r.updated_at,
});

export function shares(): Share[] {
  return (getDb().query("SELECT * FROM superagent_shares ORDER BY name").all() as Row[]).map(toShare);
}

export function shareOf(name: string): Share | null {
  const r = getDb().query("SELECT * FROM superagent_shares WHERE name = ?").get(name) as Row | null;
  return r ? toShare(r) : null;
}

/** What the hub shows of it. */
export function teamOf(name: string): SuperagentTeam | null {
  const s = shareOf(name);
  return s ? { workspace: s.workspace, instance: s.instance, visibility: s.visibility, maintainers: s.maintainers, source: s.source } : null;
}

export function saveShare(s: Omit<Share, "updatedAt">, now = Date.now()): void {
  const db = getDb();
  db.transaction(() => {
    // An instance id names one superagent: a renamed row gives way.
    db.run("DELETE FROM superagent_shares WHERE instance = ? AND name != ?", [s.instance, s.name]);
    db.run(
      `INSERT INTO superagent_shares (name, instance, workspace, installation, visibility, maintainers, source, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET instance = excluded.instance, workspace = excluded.workspace, installation = excluded.installation,
         visibility = excluded.visibility, maintainers = excluded.maintainers, source = excluded.source, updated_at = excluded.updated_at`,
      [s.name, s.instance, s.workspace, s.installation, s.visibility, JSON.stringify(s.maintainers), s.source ? JSON.stringify(s.source) : null, now],
    );
  })();
}

export function dropShare(name: string): void {
  getDb().run("DELETE FROM superagent_shares WHERE name = ?", [name]);
}
