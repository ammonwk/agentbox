/**
 * The daily sweep (issue #39), for a superagent whose manifest says when
 * (`"sweep": "23:00"`, or `true` for the global setting's time): its work
 * sessions — every open session under its main or an earlier main — that
 * have been idle for `IDLE_MS` are closed, whether or not they look done.
 * Closed is the board's close (`Fleet.close`): the process stops and the
 * session leaves the list, and its transcript stays, so a resume or a
 * message brings it back. Nothing is deleted.
 *
 * It never touches a main conversation (current or earlier), or a session
 * that is not the superagent's. It keeps, and says why, a session that
 * still holds something: an armed wait, an open Review card, an open PR it
 * claimed, or a child that is still at work. What one sweep closed and kept
 * is kept for the Agents page (`GET /api/superagents/:name/sweeps`).
 *
 * A sweep missed by more than `LATE_MS` (the server was down) is not made
 * up: a morning start must not close the day's sessions.
 */
import { getDb, getSessionRecord, listOpenWaits, listSessionRecords } from "../db";
import type { Fleet } from "../fleet";
import { unfinishedClaims } from "../prclaims";
import { describe as describeWait } from "../waits";
import { patchState, stateOf, type SweepRecord } from "./state";

/** A session idle this long is closed. */
export const IDLE_MS = 2 * 3_600_000;
/** A sweep is run at most this long after its time. */
export const LATE_MS = 4 * 3_600_000;
/** Sweeps kept for each superagent. */
const KEPT_SWEEPS = 14;

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

/** What the sweep asks of the hub. */
export interface SweepHost {
  /** Superagents with a sweep time, and their main and earlier mains. */
  swept(): { name: string; at: string; mains: string[] }[];
}

export class Sweeps {
  #running = false;
  constructor(
    private readonly fleet: Fleet,
    private readonly host: SweepHost,
  ) {}

  /** Newest first. */
  list(name: string): SweepRecord[] {
    return [...(stateOf(name).sweeps ?? [])].sort((a, b) => b.at - a.at);
  }

  /** Called on every scheduler pass; sweeps each superagent once its time comes. */
  async tick(now = Date.now()): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (const a of this.host.swept()) {
        const slot = dueSlot(now, a.at, stateOf(a.name).sweptAt ?? null);
        if (slot === null) continue;
        // Marked first: a sweep that fails part-way is not run again every pass.
        patchState(a.name, (s) => void (s.sweptAt = slot));
        try {
          const r = await this.sweep(a.name, a.mains, Date.now());
          if (r.closed.length || r.kept.length) console.log(`agentbox: daily sweep for ${a.name} closed ${r.closed.length} idle sessions, kept ${r.kept.length}`);
        } catch (e) {
          console.error(`agentbox: daily sweep for ${a.name}:`, e);
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
    const card = getDb()
      .query("SELECT id, title FROM cards WHERE (session_id = ?1 OR about = ?1) AND (state IN ('open','later') OR (state = 'answered' AND answer <> '' AND delivered_at IS NULL)) ORDER BY id LIMIT 1")
      .get(id) as { id: number; title: string } | null;
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
    const live = new Map(this.fleet.sessions().map((s) => [s.id, s]));
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

  /** Every open session under one of `mains`, at any depth: its work sessions. */
  private workOf(mains: string[]): string[] {
    const records = listSessionRecords(0).filter((r) => !r.archivedAt && r.parent && r.parent !== r.id);
    const chats = new Set(mains), out: string[] = [], seen = new Set(mains);
    for (let level = mains; level.length; ) {
      const next = records.filter((r) => level.includes(r.parent!) && !seen.has(r.id));
      for (const r of next) {
        seen.add(r.id);
        if (!chats.has(r.id)) out.push(r.id);
      }
      level = next.map((r) => r.id);
    }
    return out;
  }

  /** One superagent's sweep: closes its idle work sessions and records the result. */
  async sweep(name: string, mains: string[], now: number): Promise<SweepRecord> {
    const out: SweepRecord = { id: crypto.randomUUID(), at: now, closed: [], kept: [] };
    const chats = new Set(mains);
    const live = new Map(this.fleet.sessions().map((s) => [s.id, s]));
    const work = this.workOf(mains)
      // Oldest first: a parent closes before the children it takes with it.
      .sort((x, y) => (getSessionRecord(x)?.startedAt ?? 0) - (getSessionRecord(y)?.startedAt ?? 0));
    const done = new Set<string>();
    for (const id of work) {
      const s = live.get(id);
      // Gone from the board, closed already (by a parent's close in this
      // sweep), a subagent its caller runs, or not idle long enough.
      if (!s || s.status === "closed" || done.has(id) || getSessionRecord(id)?.archivedAt || s.host === "subagent") continue;
      if (s.status === "running" || s.lastActivityAt > now - IDLE_MS) continue;
      const entry = { id, title: titleOf(id) };
      const held = this.holds(id, now);
      if (held) {
        out.kept.push({ ...entry, why: `It has ${held}.` });
        continue;
      }
      try {
        const r = await this.fleet.closeIfIdle(
          id,
          s.lastActivityAt,
          () => {
            // As it is now, after the close's own fresh pass.
            const again = getSessionRecord(id);
            if (!again || again.archivedAt || chats.has(id)) throw new NoLongerIdle();
            const why = this.holds(id, Date.now());
            if (why) throw new Error(`It has ${why}.`);
          },
          true,
        );
        out.closed.push(entry);
        for (const c of r.closed) {
          done.add(c);
          if (c !== id) out.closed.push({ id: c, title: titleOf(c) });
        }
        for (const k of r.kept) {
          done.add(k.id);
          out.kept.push({ id: k.id, title: titleOf(k.id), why: `It holds ${k.holds.join(", ")}; “${entry.title}”, which started it, was closed.` });
        }
      } catch (e) {
        if (e instanceof NoLongerIdle || /activity changed/.test((e as Error).message)) continue;
        out.kept.push({ ...entry, why: (e as Error).message });
      }
    }
    if (out.closed.length || out.kept.length)
      patchState(name, (st) => {
        st.sweeps = [out, ...(st.sweeps ?? [])].sort((a, b) => b.at - a.at).slice(0, KEPT_SWEEPS);
      });
    return out;
  }
}

function titleOf(id: string): string {
  const r = getSessionRecord(id), facts = r?.facts as { title?: string } | null;
  return (r?.label || facts?.title || id).slice(0, 200);
}
