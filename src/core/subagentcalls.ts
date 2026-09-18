/** omp's subagent tool calls, classified from the shape of their arguments.
 *
 * This lives in core rather than in the UI because both sides need the same
 * answer and they must not drift: the host reads it to know when a subagent's
 * result has been collected, and the transcript view reads it to label rows
 * and to keep a fan-out's structure out of the fold. It is pure — types in,
 * a verdict out — so the browser can import it directly.
 */

import type { ToolCall } from "./types";

/** One entry of a dispatch call's `tasks` array. */
export interface DispatchedSub {
  name: string;
  agent: string;
  task: string;
}

/**
 * omp's subagent surface, classified from the shape of `rawInput`.
 *
 * omp does not put tool names on the wire (see `ToolCall`), and its subagent
 * tools arrive as `kind: "other"` / `kind: "read"` rows indistinguishable
 * from any other call. Three shapes cover the whole surface, confirmed
 * against a live fan-out:
 *
 * - dispatch — `{tasks: [{name, agent, task}], context}`; returns as soon as
 *   the subagents are started ("Spawned 4 background agents…").
 * - wait — `{op: "wait", timeoutMs, to?, message?}`; the long-running poll
 *   where wall-clock time actually passes, optionally carrying a DM to one
 *   named subagent.
 * - collect — `{path: "agent://<id>"}`; reading one subagent's final result.
 */
export type SubagentCall =
  | { kind: "dispatch"; tasks: DispatchedSub[] }
  | { kind: "wait"; to: string | null; message: string | null }
  | { kind: "collect"; name: string };

export function subagentCallOf(call: ToolCall): SubagentCall | null {
  const input = call.input;
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;

  if (Array.isArray(o.tasks)) {
    const tasks: DispatchedSub[] = [];
    for (const entry of o.tasks) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== "string" || !e.name) continue;
      tasks.push({
        name: e.name,
        agent: typeof e.agent === "string" && e.agent ? e.agent : "task",
        task: typeof e.task === "string" ? e.task : "",
      });
    }
    return tasks.length ? { kind: "dispatch", tasks } : null;
  }

  if (o.op === "wait") {
    return {
      kind: "wait",
      to: typeof o.to === "string" && o.to ? o.to : null,
      message: typeof o.message === "string" && o.message ? o.message : null,
    };
  }

  const path = typeof o.path === "string" ? o.path : null;
  if (path?.startsWith("agent://")) {
    // omp allows `agent://<id>?q=…` extraction queries; the id is the path part.
    const name = path.slice("agent://".length).split("?")[0]?.trim();
    return { kind: "collect", name: name || "subagent" };
  }

  return null;
}

