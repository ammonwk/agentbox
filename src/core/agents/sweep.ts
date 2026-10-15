/**
 * The daily sweep (issue #39): at the end of each day, each local agent's work
 * sessions that have been idle for `IDLE_MS` are closed, whether or not they
 * look done. Closed is the board's close (`Fleet.close`): the process stops
 * and the session leaves the list, and its transcript stays, so a resume or a
 * message brings it back. Nothing is deleted.
 *
 * It never touches an agent's main chat (current or earlier), or a session no
 * agent owns. It keeps, and says why, a session that still holds something:
 * an armed wait, an open Review card, an open PR it claimed, or a child that
 * is still at work. What one sweep closed and kept goes to the agent's Feed.
 *
 * The time is `AgentSettings.agentSweepAt`, on this machine's clock. A sweep
 * missed by more than `LATE_MS` (the server was down) is not made up: a
 * morning start must not close the day's sessions.
 */
import type { Database } from "bun:sqlite";
import { getKv, getSessionRecord, getSettings, listOpenWaits, listSessionRecords, setKv } from "../db";
import { unfinishedClaims } from "../prclaims";
import { describe as describeWait } from "../waits";
import type { AgentsRuntime } from "./runtime";

/** A session idle this long is closed. */
export const IDLE_MS = 2 * 3_600_000;
/** A sweep is run at most this long after its time. */
export const LATE_MS = 4 * 3_600_000;
/** Sweeps kept for each agent's Feed. */
const KEPT_SWEEPS = 14;
const KV = "agents.sweep";

export type SweepEntry = { id: string; title: string; why?: string };
export type AgentSweep = { id: string; agent: string; at: number; closed: SweepEntry[]; kept: SweepEntry[] };

/** The latest time `at` ("HH:MM") on this machine's clock that is not after `now`. */
export function sweepSlot(now: number, at: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (!m) return null;
  const slot = new Date(now);
  slot.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (slot.getTime() > now) slot.setDate(slot.getDate() - 1);
  return slot.getTime();
}

/** The slot to sweep for now, or null: none set, already done, or too late. */
export function dueSlot(now: number, at: string, done: number | null): number | null {
  const slot = sweepSlot(now, at);
  if (slot === null || (done !== null && done >= slot) || now - slot >= LATE_MS) return null;
  return slot;
}

/** Thrown inside the close's own serialized check; not a failure to report. */
class NoLongerIdle extends Error {}

export class AgentSweeps {
  #running = false;
  constructor(readonly runtime: AgentsRuntime) {}

  private get db(): Database {
    const db = this.runtime.store.db;
    db.exec("CREATE TABLE IF NOT EXISTS agent_sweeps(id TEXT PRIMARY KEY, agent TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL)");
    return db;
  }

  /** Newest first. */
  list(agent: string): AgentSweep[] {
    return (this.db.query("SELECT body FROM agent_sweeps WHERE agent=? ORDER BY at DESC LIMIT ?").all(agent, KEPT_SWEEPS) as { body: string }[]).map(
      (r) => JSON.parse(r.body) as AgentSweep,
    );
  }

  /** Called on every scheduler pass; sweeps every agent once its time comes. */
  async tick(now = Date.now()): Promise<void> {
    if (this.#running) return;
    const slot = dueSlot(now, getSettings().agentSweepAt, getKv<number>(KV));
    if (slot === null) return;
    this.#running = true;
    // Marked first: a sweep that fails part-way is not run again every pass.
    setKv(KV, slot);
    try {
      for (const a of this.runtime.conversations.local()) {
        try {
          const r = await this.sweep(a.id, Date.now());
          if (r.closed.length || r.kept.length)
            console.log(`agentbox: daily sweep for ${a.name} closed ${r.closed.length} idle sessions, kept ${r.kept.length}`);
        } catch (e) {
          console.error(`agentbox: daily sweep for ${a.id}:`, e);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** What `id` still holds that a close must not drop, in words; null when nothing. */
  private holds(id: string, now: number): string | null {
    const wait = listOpenWaits(0).find((w) => w.sessionId === id);
    if (wait) return `an armed wait (${describeWait(wait.spec)})`;
    const card = this.runtime.cards
      .list()
      .find((c) => (c.sessionId === id || c.about === id) && (c.state === "open" || c.state === "later" || c.unread));
    if (card) return `an open Review card (card ${card.id} “${card.title}”)`;
    const prs = unfinishedClaims().get(id);
    if (prs?.length) return `an open PR it owns (${prs.join(", ")})`;
    const child = this.workingChild(id, now);
    if (child) return `a child session still at work (${child})`;
    return null;
  }

  /** A session `id` started, at any depth, that is running or was active
   *  within `IDLE_MS`: closing `id` would stop it too. */
  private workingChild(id: string, now: number): string | null {
    const records = listSessionRecords(0).filter((r) => !r.archivedAt && r.parent && r.parent !== r.id);
    const live = new Map(this.runtime.fleet.sessions().map((s) => [s.id, s]));
    const seen = new Set([id]);
    for (let level = [id]; level.length; ) {
      const next = records.filter((r) => level.includes(r.parent!) && !seen.has(r.id));
      for (const r of next) {
        const s = live.get(r.id);
        if (s?.status === "running" || (s?.lastActivityAt ?? r.lastActivityAt) > now - IDLE_MS) return r.id;
        seen.add(r.id);
      }
      level = next.map((r) => r.id);
    }
    return null;
  }

  /** One agent's sweep: closes its idle work sessions and records the result. */
  async sweep(agent: string, now: number): Promise<AgentSweep> {
    const a = this.runtime.conversations.local().find((x) => x.id === agent);
    const out: AgentSweep = { id: crypto.randomUUID(), agent, at: now, closed: [], kept: [] };
    if (!a) return out;
    const chats = new Set([a.session, ...a.previous].filter((x): x is string => !!x));
    const live = new Map(this.runtime.fleet.sessions().map((s) => [s.id, s]));
    const work = this.runtime.conversations
      .threads(agent)
      .filter((t) => t.kind === "work" && !chats.has(t.id) && t.status !== "closed")
      // Oldest first: a parent closes before the children it takes with it.
      .sort((x, y) => (getSessionRecord(x.id)?.startedAt ?? 0) - (getSessionRecord(y.id)?.startedAt ?? 0));
    const done = new Set<string>();
    for (const t of work) {
      const s = live.get(t.id);
      // Gone from the board, closed already (by a parent's close in this
      // sweep), a subagent its caller runs, or not idle long enough.
      if (!s || done.has(t.id) || getSessionRecord(t.id)?.archivedAt || s.host === "subagent") continue;
      if (s.status === "running" || s.lastActivityAt > now - IDLE_MS) continue;
      const entry = { id: t.id, title: t.title };
      const held = this.holds(t.id, now);
      if (held) {
        out.kept.push({ ...entry, why: `It has ${held}.` });
        continue;
      }
      try {
        const r = await this.runtime.fleet.closeIfIdle(
          t.id,
          s.lastActivityAt,
          () => {
            // As it is now, after the close's own fresh pass.
            const again = getSessionRecord(t.id);
            if (!again || again.archivedAt || chats.has(t.id)) throw new NoLongerIdle();
            const why = this.holds(t.id, Date.now());
            if (why) throw new Error(`It has ${why}.`);
          },
          true,
        );
        out.closed.push(entry);
        for (const id of r.closed) {
          done.add(id);
          if (id !== t.id) out.closed.push({ id, title: titleOf(id), why: `Closed with “${t.title}”, which started it.` });
        }
        for (const k of r.kept) {
          done.add(k.id);
          out.kept.push({ id: k.id, title: titleOf(k.id), why: `It holds ${k.holds.join(", ")}; “${t.title}”, which started it, was closed.` });
        }
      } catch (e) {
        if (e instanceof NoLongerIdle || /activity changed/.test((e as Error).message)) continue;
        out.kept.push({ ...entry, why: (e as Error).message });
      }
    }
    if (out.closed.length || out.kept.length)
      this.db.transaction(() => {
        this.db.run("INSERT INTO agent_sweeps(id,agent,at,body) VALUES (?,?,?,?)", [out.id, agent, out.at, JSON.stringify(out)]);
        this.db.run("DELETE FROM agent_sweeps WHERE agent=? AND id NOT IN (SELECT id FROM agent_sweeps WHERE agent=? ORDER BY at DESC LIMIT ?)", [agent, agent, KEPT_SWEEPS]);
      })();
    return out;
  }
}

function titleOf(id: string): string {
  const r = getSessionRecord(id), facts = r?.facts as { title?: string } | null;
  return (r?.label || facts?.title || id).slice(0, 200);
}
