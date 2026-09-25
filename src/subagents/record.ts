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
 * reader reconstructs by folding the event log: the log records what happened,
 * not what is *still* happening, so only a timestamped snapshot can tell a
 * finished agent from one whose process was killed mid-turn.
 *
 * The one reader in the app is the fleet, which needs `meta.json`'s
 * `ompSessionId` to keep pool agents off the board (`poolSessionIds`).
 * Everything else here is for a person reading the directory.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { subagentRoot } from "../core/paths";
import type { AgentSnapshot } from "./health";

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

/** Per directory: omp's session id once meta.json has one, else when the
 *  agent started (it is re-read until it has one, for a while). */
const seen = new Map<string, string | number>();

/** Give up on a directory whose omp never opened a conversation after this. */
const ID_WINDOW_MS = 10 * 60_000;

/**
 * omp session ids that belong to pool agents.
 *
 * Their transcripts sit in omp's own store beside every other omp session, and
 * nothing inside one says it came from here, so the fleet asks this before
 * showing an omp session on the board. Cheap on the fleet's clock: one readdir,
 * and a meta.json is read only until it yields an id.
 */
export function poolSessionIds(now = Date.now()): Set<string> {
  const root = subagentRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return new Set(); // nothing has ever run
  }
  const ids = new Set<string>();
  for (const name of entries) {
    const dir = join(root, name);
    const known = seen.get(dir);
    if (typeof known === "string") {
      ids.add(known);
      continue;
    }
    if (typeof known === "number" && now - known > ID_WINDOW_MS) continue;
    const meta = readJson<RecordMeta>(join(dir, "meta.json"));
    if (meta?.ompSessionId) {
      seen.set(dir, meta.ompSessionId);
      ids.add(meta.ompSessionId);
    } else {
      seen.set(dir, meta?.startedAt ?? now);
    }
  }
  return ids;
}
