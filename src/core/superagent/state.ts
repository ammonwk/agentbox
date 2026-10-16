/**
 * What agentbox keeps for a superagent beside its row in `superagents`: the
 * generic services' state (src/core/superagent/*), one JSON body per name.
 * Its program's own state is in its home, which agentbox does not read.
 */
import { getDb } from "../db";
import type { ProviderId } from "../types";
import type { Supplied } from "./memory";

/** A request for a handoff, sent to the main while it is idle and warm (rollover.ts). */
export interface Checkpoint {
  session: string;
  request: string;
  at: number;
  reason: "idle" | "context";
  pct: number | null;
  state: "requested" | "saved" | "failed";
  handoff?: string;
  error?: string;
}

/** A rollover in progress, journaled before each step so a restart finishes or undoes it. */
export interface RolloverJournal {
  from: string;
  to: string;
  handoff: string;
  why: "cold" | "context";
  at: number;
  phase: "stopping" | "spawning";
  supplied?: Supplied[];
  selection?: Selection;
}

export interface Selection {
  provider: ProviderId;
  why: string;
  at: number;
}

/** A loop's spec when it was set by API, and its clock for every loop (loops.ts). */
export interface LoopState {
  /** Set by API; absent for a manifest loop, whose spec is the manifest's. */
  spec?: { when: string; check: string | null; prompt: string };
  /** The spec this clock was computed for: a changed manifest restarts it. */
  of: string;
  nextAt: number | null;
  due: number | null;
  last: { at: number; result: "sent" | "skipped" | "failed"; detail: string } | null;
}

export interface SweepRecord {
  id: string;
  at: number;
  closed: { id: string; title: string }[];
  kept: { id: string; title: string; why: string }[];
}

export interface SuperagentState {
  avatar?: { file: string; at: number };
  selection?: Selection;
  checkpoint?: Checkpoint;
  rollover?: RolloverJournal;
  /** Each rolled-over main and the one that took over from it. */
  rolled?: Record<string, string>;
  /** What each fresh main was started from (memory records), for its Memory panel. */
  contexts?: Record<string, Supplied[]>;
  /** The SOUL.md a main was started with (its hash), for the Memory panel. */
  files?: { session: string; soul: string | null; at: number };
  loops?: Record<string, LoopState>;
  sweeps?: SweepRecord[];
  /** The last daily sweep slot that ran. */
  sweptAt?: number;
  /** The restricted fields of each project layer the person approved, by digest (layers.ts). */
  approved?: { project?: string; local?: string };
}

export function stateOf(name: string): SuperagentState {
  const row = getDb().query("SELECT body FROM superagent_state WHERE name = ?").get(name) as { body: string } | null;
  if (!row) return {};
  try {
    return JSON.parse(row.body) as SuperagentState;
  } catch {
    return {};
  }
}

/** Change it in one step: `fn` gets the current state and changes it in place. */
export function patchState(name: string, fn: (s: SuperagentState) => void): SuperagentState {
  const db = getDb();
  return db.transaction(() => {
    const s = stateOf(name);
    fn(s);
    db.run("INSERT INTO superagent_state (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body", [name, JSON.stringify(s)]);
    return s;
  })();
}
