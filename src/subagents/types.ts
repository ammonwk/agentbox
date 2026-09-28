/** Types the subagent pool shares between its modules and its tests. */

/** ACP's coarse tool classification. `other` covers anything unmapped. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "execute"
  | "search"
  | "fetch"
  | "think"
  | "other";

export type ToolStatus = "pending" | "running" | "ok" | "error";

export type SubagentStatus = "pending" | "running" | "completed" | "failed";

/**
 * One of omp's own in-process subagents, as its progress stream describes it
 * (`rawOutput.details.progress[]` on a task call's updates). omp runs these
 * inside the agent's process, not as ACP sessions of their own, so this stream
 * is the only visibility the protocol gives into them while a turn is running.
 */
export interface SubagentProgress {
  id: string;
  /** The subagent type omp ran this one as ("scout", "reviewer", …). */
  agent: string;
  status: SubagentStatus;
  /** The task text the subagent was dispatched with. */
  task: string;
  /** The tool the subagent is inside right now, when one is. */
  currentTool?: string;
  currentToolArgs?: string;
  /** omp's intent string for the current or last tool call. */
  lastIntent?: string;
  toolCount: number;
  tokens: number;
  cost: number;
  durationMs: number;
  recentTools?: { tool: string; args?: string }[];
}

/**
 * One tool call, assembled from ACP's `tool_call` + `tool_call_update` pair.
 *
 * NOTE: omp does not put the tool's name on the wire — `title` is built from
 * an `intent` string when the call carries one, and falls back to the name
 * otherwise. Classify on `kind` + the shape of `input`, never on a name.
 */
export interface ToolCall {
  /** ACP toolCallId. Stable across the call's updates. */
  id: string;
  kind: ToolKind;
  title: string;
  /** ACP `rawInput` — the tool's arguments, verbatim. */
  input: unknown;
  status: ToolStatus;
  /** Absolute paths this call touched, when ACP reported any. */
  locations: string[];
  /** Compacted text of ACP `rawOutput`. Truncated. */
  output: string | null;
  /** omp's subagent progress snapshot, when this call is one of its subagent
   *  tools (dispatch / wait / hub) and omp streamed one. Replaced whole on
   *  every update — it is a snapshot, not a delta. */
  subs?: SubagentProgress[];
  startedAt: number;
  endedAt: number | null;
}

/** One tool call as a subagent keeps it, for `transcript` and the loop
 *  detector: the fields clipped, the timing on our own clock. */
export interface ToolRecord {
  seq: number;
  kind: string;
  title: string;
  status: string;
  /** Our own wall clock for when this call was first seen. omp's timestamps
   *  are its own; this one is comparable with everything else a reader has,
   *  and it is what says how long an unfinished call has been unfinished. */
  startedAtMs: number;
  ms: number | null;
  input: string | null;
  output: string | null;
}

/**
 * Why an agent is gone, when the answer is "because we were finished with it".
 *
 * Every agent ends up dead -- the caller stops it, or the server shuts down --
 * so `dead` alone says almost nothing, and a reader that renders a clean
 * finish and a crashed process identically is hiding the only part anyone
 * cares about. Recorded rather than inferred, because the process that killed
 * it is the only thing that actually knows.
 */
export const STOPPED_BY_CALLER = "stopped by the caller";
/**
 * Why every agent of an MCP server ends when the server itself is shut down —
 * its client exited, or was stopped with everything else. Not the caller
 * being done with them: an agent that ends this way mid-turn, or holding an
 * answer nobody read, is brought back when that session resumes
 * (`SubagentPool.revive`).
 */
export const CALLER_GONE = "its caller's session ended";
