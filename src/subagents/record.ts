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
 *   meta.json        identity: name, directory, branch, CLI, model, the brief
 *                    it was given, and the CLI's session id once it has one.
 *   state.json       the live snapshot, rewritten every couple of seconds by
 *                    whoever owns the agent, and once more when it ends.
 *   transcript.jsonl the event log, appended forever. The history.
 *
 * `state.json` is deliberately a republished snapshot rather than something a
 * reader reconstructs by folding the event log: the log records what happened,
 * not what is *still* happening, so only a timestamped snapshot can tell a
 * finished agent from one whose process was killed mid-turn.
 *
 * The one reader in the app is the fleet (`poolAgents`), which shows each
 * agent as a child of the session that asked for it. Everything else here is
 * for a person reading the directory.
 */

import {
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
import type { SubagentProvider } from "./backend";
import type { AgentSnapshot } from "./health";

export interface RecordMeta {
  name: string;
  cwd: string;
  branch: string | null;
  provider: SubagentProvider;
  /** Null when the CLI ran its own configured default. */
  model: string | null;
  readOnly: boolean;
  startedAt: number;
  /** The process that owns the agent, so a reader can say who to blame. */
  pid: number;
  /** The client session that asked for it, when it could be determined. */
  owner: string;
  /**
   * The agentbox session that asked for it (`AGENTBOX_SESSION`, which
   * agentbox sets on every process it starts). Unlike `owner`, the same
   * across that session's resumes: it is how a resumed session's MCP finds
   * the agents its last run left unfinished (`SubagentPool.revive`).
   */
  session?: string;
  /** The brief. Clipped: this is for a person deciding whether they are
   *  looking at the right agent, not for re-reading the whole prompt. */
  prompt: string;
  /**
   * The CLI's id for the conversation, once it has opened one; absent until
   * then, and on an agent whose process never started.
   *
   * The transcript lands in the CLI's own store beside every other session
   * of that CLI, and the fleet lists it as an external session. This is what
   * ties that transcript back to a subagent.
   */
  sessionId?: string;
  /** How MCP servers started before `provider` existed wrote an omp agent's
   *  `sessionId`. They keep running until their client restarts. */
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

/** Name the agentbox session an agent belongs to, on a record written before
 *  `session` was recorded. Never overwrites one that says otherwise. */
export function claimRecord(dir: string, session: string): void {
  const meta = readJson<RecordMeta>(join(dir, "meta.json"));
  if (!meta || meta.session) return;
  writeAtomic(join(dir, "meta.json"), JSON.stringify({ ...meta, session }, null, 2));
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Missing, half-written despite the rename, or from a future version.
    return null;
  }
}

/** How the fleet names a pool agent's session. */
export function poolKey(provider: string, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

/** What the fleet knows of a pool agent, keyed by `poolKey`. */
export interface PoolAgent {
  dir: string;
  name: string;
  /** `RecordMeta.owner`: the asking client's session id, or `pid:<n>`. */
  owner: string;
  /** The MCP server that owns the agent; its agents die with it. */
  serverPid: number;
}

/** Per directory: the agent once meta.json has a session id, and the file's
 *  mtime then (a revived agent's record is rewritten naming its new server);
 *  else when the agent started (it is re-read until it has one, for a while). */
const seen = new Map<string, { key: string; agent: PoolAgent; mtimeMs: number } | number>();

/** Give up on a directory whose CLI never opened a conversation after this. */
const ID_WINDOW_MS = 10 * 60_000;

function keyOf(meta: RecordMeta | null): string | null {
  if (meta?.sessionId) return poolKey(meta.provider, meta.sessionId);
  if (meta?.ompSessionId) return poolKey("omp", meta.ompSessionId);
  return null;
}

/**
 * Every pool agent that has opened a conversation, by `poolKey`.
 *
 * Their transcripts sit in each CLI's own store beside every other session,
 * and nothing inside one says it came from here, so the fleet asks this to
 * tell a pool agent from a session. Cheap on the fleet's clock: one readdir,
 * and a meta.json is read only until it yields an id.
 */
export function poolAgents(now = Date.now()): Map<string, PoolAgent> {
  const root = subagentRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return new Map(); // nothing has ever run
  }
  const agents = new Map<string, PoolAgent>();
  for (const name of entries) {
    const dir = join(root, name);
    const known = seen.get(dir);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(dir, "meta.json")).mtimeMs;
    } catch {
      /* not written yet */
    }
    if (typeof known === "object" && known.mtimeMs === mtimeMs) {
      agents.set(known.key, known.agent);
      continue;
    }
    if (typeof known === "number" && now - known > ID_WINDOW_MS) continue;
    const meta = readJson<RecordMeta>(join(dir, "meta.json"));
    const key = keyOf(meta);
    if (key !== null && meta) {
      const agent = { dir, name: meta.name, owner: meta.owner, serverPid: meta.pid };
      seen.set(dir, { key, agent, mtimeMs });
      agents.set(key, agent);
    } else {
      seen.set(dir, meta?.startedAt ?? now);
    }
  }
  return agents;
}

/** What the agent's owner last published: mid-turn or not, and whether it
 *  holds a finished turn its caller has not collected. Null when unreadable. */
export function poolState(agent: PoolAgent): { running: boolean; answerWaiting: boolean } | null {
  const snap = readJson<{ snapshot?: Pick<AgentSnapshot, "state" | "uncollected"> }>(join(agent.dir, "state.json"))?.snapshot;
  return snap ? { running: snap.state === "running", answerWaiting: snap.uncollected > 0 } : null;
}
