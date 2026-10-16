/**
 * The memory journal as the API gives it (`/api/superagents/:name/memory…`):
 * what the Agents page's Memory panel shows, and the writes, each with who
 * may make it. A superagent's records are its own: its current main
 * conversation and its program read and write them, a person reads them
 * and sets preferences, and no other session can do either.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { FleetError } from "../fleet";
import { MemoryFile, type FilesStatus } from "./files";
import { journalOf, type MemoryRecord, type Supplied } from "./memory";
import { stateOf, type Checkpoint } from "./state";

/** Who acts on the records (src/server/superagents.ts `actorFor`). */
export type Actor = { kind: "program" } | { kind: "main"; session: string } | { kind: "person" };

export type MemoryView = {
  enabled: boolean;
  rollover: { idleMin: number; contextPct: number } | null;
  /** The handoff request the main has now, if any. */
  checkpoint: Checkpoint | null;
  preferences: MemoryRecord[];
  handoffs: MemoryRecord[];
  notes: MemoryRecord[];
  /** A search's results, when the view was asked with `q`. */
  results: { id: string; kind: string; at: number; session: string; summary: string }[] | null;
  /** What the current main was started from. */
  supplied: Supplied[];
  files: FilesStatus;
};

type Who = { name: string; title: string; dir: string; memory: boolean; rollover: MemoryView["rollover"]; main: string | null };

const files = new Map<string, MemoryFile>();
export function memoryFile(name: string): MemoryFile {
  const j = journalOf(name);
  let f = files.get(name);
  if (!f || f.memory !== j) files.set(name, (f = new MemoryFile(j)));
  return f;
}

/** MEMORY.md after a journal write; the write itself never fails on it. */
export function rebuildMemory(w: { name: string; title: string }): void {
  try {
    memoryFile(w.name).writeMemory(w);
  } catch (e) {
    console.error(`agentbox: ${w.name}: MEMORY.md not rebuilt: ${(e as Error).message}`);
  }
}

export function memoryView(w: Who, q: string | null): MemoryView {
  const j = journalOf(w.name), st = stateOf(w.name);
  return {
    enabled: w.memory,
    rollover: w.rollover,
    checkpoint: st.checkpoint && st.checkpoint.session === w.main ? st.checkpoint : null,
    preferences: j.preferences(w.name),
    handoffs: j.recent(w.name, "handoff", 10),
    notes: j.recent(w.name, "note", 10),
    results: q?.trim() ? j.search(w.name, q, 20) : null,
    supplied: (w.main && st.contexts?.[w.main]) || [],
    files: memoryFile(w.name).status(w),
  };
}

export function memoryRecord(w: Who, id: string): MemoryRecord {
  return journalOf(w.name).get(w.name, id);
}

const Write = z.object({ request: z.string().uuid().optional(), body: z.unknown() }).strict();

/**
 * One write. `handoff` and `note`: its main conversation or its program.
 * `prefer` (and forget, an empty text): a person too. A handoff whose
 * request is the main's checkpoint request answers it (`onHandoff`).
 */
export function remember(w: Who, kind: "handoff" | "note" | "prefer", actor: Actor, value: unknown, onHandoff: (request: string | null, record: string) => void): MemoryRecord | null {
  if (!w.memory) throw new FleetError(409, `${w.name} has no memory journal: its manifest does not say "memory": true`);
  if (kind !== "prefer" && actor.kind === "person") throw new FleetError(403, `a ${kind} comes from ${w.name}'s main conversation or its program; a person sets preferences`);
  const j = journalOf(w.name);
  const session = actor.kind === "main" ? actor.session : actor.kind;
  const by = actor.kind === "main" ? "agent" : actor.kind === "program" ? "program" : "operator";
  let rec: MemoryRecord | null;
  if (kind === "prefer") rec = j.prefer(w.name, actor.kind === "main" ? actor.session : null, value, by);
  else {
    const p = Write.parse(value);
    const id = p.request ?? randomUUID();
    if (kind === "handoff") {
      const c = stateOf(w.name).checkpoint;
      const answers = c && c.request === id && c.session === session ? id : null;
      rec = j.handoff(w.name, id, session, p.body, answers, by);
      onHandoff(answers, rec.id);
    } else rec = j.note(w.name, id, session, p.body, by);
  }
  rebuildMemory(w);
  return rec;
}
