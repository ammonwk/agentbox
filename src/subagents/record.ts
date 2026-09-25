/** An agent's record on disk: what it was, what it is doing, what it did.
 *
 * Every subagent writes its whole life to
 * `$AGENTBOX_HOME/subagents/<id>/transcript.jsonl` -- every message, every
 * tool call with inputs and outputs, permissions, errors, turn reports,
 * deaths. The process that owns an agent is a short-lived MCP server nobody
 * can address, so anything that wants to watch an agent -- a status line, a
 * terminal, a person the next morning -- has to work from the record rather
 * than from the object.
 *
 * So the record is self-describing, in three files per agent:
 *
 *   meta.json        identity: name, directory, branch, model, the brief it
 *                    was given, and omp's session id once omp has one.
 *   state.json       the live snapshot, rewritten every couple of seconds by
 *                    whoever owns the agent, and once more when it ends.
 *   transcript.jsonl the event log, appended forever. The history.
 *
 * `state.json` is deliberately a republished snapshot rather than something a
 * reader reconstructs by folding the event log. Folding would work, and would
 * be slower, more code, and wrong in one specific way that matters: the log
 * records what happened, not what is *still* happening, so a reader could not
 * tell a finished agent from one whose process was killed mid-turn. A snapshot
 * with a timestamp can: if nobody has refreshed it, nobody is there.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { subagentRoot } from "../core/paths";
import type { AgentSnapshot } from "./health";

/**
 * How long a `state.json` is believed.
 *
 * Owners refresh on the same couple-of-seconds beat as the status line, so
 * anything older is not a slow agent -- it is a dead writer. A reader that
 * believed it would show a fan-out that has not existed since Tuesday as
 * still running, which is worse than showing nothing.
 */
export const STALE_AFTER_MS = 15_000;

export interface RecordMeta {
  name: string;
  cwd: string;
  branch: string | null;
  model: string;
  readOnly: boolean;
  startedAt: number;
  /** The process that owns the agent, so a reader can say who to blame. */
  pid: number;
  /** The client session that asked for it, when it could be determined. */
  owner: string;
  /** The brief. Clipped: this is for a person deciding whether they are
   *  looking at the right agent, not for re-reading the whole prompt. */
  prompt: string;
  /**
   * omp's id for the conversation, once omp has opened one; absent until
   * then, and on an agent whose omp never started.
   *
   * The agent's omp runs without `--session-dir`, so its transcript lands in
   * omp's own store beside every other omp session, and the fleet lists it as
   * an external omp session. This is what ties that transcript back to a
   * subagent.
   */
  ompSessionId?: string;
}

/** One transcript line. The shape is whatever `Subagent.log` wrote; readers
 *  switch on `type` and are expected to ignore what they do not know. */
export interface RecordEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export interface AgentRecord {
  /** Directory name under the subagent root -- the stable id for a spawn. */
  id: string;
  dir: string;
  meta: RecordMeta;
  /** Last published snapshot, or null when none was ever written. */
  snapshot: AgentSnapshot | null;
  /** True when nobody has refreshed the snapshot recently, which means the
   *  owning process is gone however busy the snapshot claims the agent is. */
  stale: boolean;
}

const MAX_PROMPT = 4000;

/** Written to a sibling and renamed, so a reader polling on its own clock
 *  cannot catch a half-written file. Same reasoning as `live.ts`. */
function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  } catch {
    // The record is an observability aid. It must never be the reason an
    // agent fails, and there is nobody to tell: this process's stdout is a
    // JSON-RPC stream.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing left to try.
    }
  }
}

export function writeMeta(dir: string, meta: RecordMeta): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  writeAtomic(
    join(dir, "meta.json"),
    JSON.stringify({ ...meta, prompt: meta.prompt.slice(0, MAX_PROMPT) }, null, 2),
  );
}

export function writeState(dir: string, snapshot: AgentSnapshot): void {
  writeAtomic(join(dir, "state.json"), JSON.stringify({ at: Date.now(), snapshot }));
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Missing, half-written despite the rename, or from a future version.
    return null;
  }
}

export function readRecord(id: string, now = Date.now()): AgentRecord | null {
  const dir = join(subagentRoot(), id);
  const meta = readJson<RecordMeta>(join(dir, "meta.json"));
  if (meta === null) return null;
  const state = readJson<{ at: number; snapshot: AgentSnapshot }>(join(dir, "state.json"));
  return {
    id,
    dir,
    meta,
    snapshot: state?.snapshot ?? null,
    stale: state === null ? true : now - state.at > STALE_AFTER_MS,
  };
}

/**
 * Every agent with a record, newest first.
 *
 * Includes finished and abandoned ones on purpose. "Why did that agent produce
 * nonsense" is a question asked afterwards, and the answer is already on disk;
 * dropping everything that is not running would throw away the only part of
 * this that survives the process.
 */
export function listRecords(now = Date.now()): AgentRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(subagentRoot());
  } catch {
    return []; // nothing has ever run
  }
  const out: AgentRecord[] = [];
  for (const id of entries) {
    const rec = readRecord(id, now);
    if (rec !== null) out.push(rec);
  }
  return out.sort((a, b) => b.meta.startedAt - a.meta.startedAt);
}

/**
 * The tail of an agent's event log.
 *
 * Tail rather than head because the question is nearly always "what is it
 * doing", and because a long agent's log is unbounded while a reader's
 * patience is not. Unparseable lines are skipped rather than fatal: the file
 * is appended to by a live process and the last line can be half-written.
 */
export function readEvents(dir: string, limit = 200): RecordEvent[] {
  let text: string;
  try {
    text = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  // Backwards until we have enough, rather than slicing the last `limit` lines
  // and parsing those: a live process is appending to this file, so the last
  // line is routinely half-written, and slicing first would silently return
  // one event fewer than asked for whenever a reader landed mid-write.
  const out: RecordEvent[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as RecordEvent;
      if (parsed && typeof parsed.type === "string") out.push(parsed);
    } catch {
      // See above.
    }
  }
  return out.reverse();
}

/** The system prompt an agent was launched with, for a reader trying to work
 *  out why it behaved the way it did. */
export function readSystemPrompt(dir: string): string | null {
  const path = join(dir, "system.md");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Ask the owning process to interrupt or stop an agent.
 *
 * A reader is in a different process from the agent it is watching, and there
 * is no socket between them -- the owner is an MCP server on somebody's stdio.
 * A file in a directory the owner already sweeps is the cheapest thing that
 * works, and it degrades honestly: if nobody is there to read it, nothing
 * happens, which is exactly what "nobody is there" should mean. Watching
 * without being able to act is half a tool, and this is the other half.
 */
export type Command = "interrupt" | "stop";

export function requestCommand(dir: string, command: Command): void {
  writeAtomic(join(dir, `${command}.request`), String(Date.now()));
}

/** Take a pending command, if there is one. Removing it is the acknowledgement,
 *  so a command is acted on exactly once however often the owner sweeps. */
export function takeCommand(dir: string): Command | null {
  for (const command of ["interrupt", "stop"] as Command[]) {
    const path = join(dir, `${command}.request`);
    try {
      if (!existsSync(path)) continue;
      rmSync(path, { force: true });
      return command;
    } catch {
      // Gone between the check and the removal: somebody else took it.
    }
  }
  return null;
}

/** How long ago a record was last touched. Records are pruned on the
 *  transcript TTL in `pool.ts`; they are the same directory. */
export function recordAgeMs(rec: AgentRecord, now = Date.now()): number {
  try {
    return now - statSync(rec.dir).mtimeMs;
  } catch {
    return 0;
  }
}
