/** Pure formatting + classification helpers for the sessions screen.
 *
 * Everything here is deliberately dependency-free so it can be unit tested
 * without a DOM. Nothing in this file may reach for `Date.now()` implicitly —
 * callers pass `now`, so tests are not clock-dependent.
 */

import type { Session, SessionStatus, ToolCall, ToolKind } from "../../../../src/core/types";

export function shortModel(model: string): string {
  return model.split("/").pop() || model;
}

/**
 * How long a tool call took, in ms; null while it is still running.
 * Rendering is the caller's job — `fmtDuration` lives in api.ts and this file
 * stays importable without pulling the whole client in.
 */
export function callDurationMs(call: ToolCall): number | null {
  if (call.endedAt == null) return null;
  return Math.max(0, call.endedAt - call.startedAt);
}

// ------------------------------------------------------------ tool summary

/** Read a string field off ACP `rawInput`, which is `unknown` by contract. */
function str(input: unknown, keys: string[]): string | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * A one-line subtitle for a tool row, derived from the shape of `rawInput`.
 *
 * omp does not put the tool's name on the wire (see ToolCall in types.ts), so
 * this classifies on `kind` plus whichever argument key is present. Returning
 * null is fine — the row still has `title`.
 */
export function toolSummary(call: ToolCall): string | null {
  switch (call.kind) {
    case "execute":
      return str(call.input, ["command", "cmd", "script"]);
    case "search":
      return str(call.input, ["pattern", "query", "regex", "glob"]);
    case "fetch":
      return str(call.input, ["url", "uri"]);
    case "read":
    case "edit":
    case "delete":
      return str(call.input, ["file_path", "path", "filePath", "file"]) ?? call.locations[0] ?? null;
    case "move":
      return str(call.input, ["source", "from", "old_path"]);
    case "think":
    case "other":
      return null;
  }
}

export const KIND_LABEL: Record<ToolKind, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  execute: "Run",
  search: "Search",
  fetch: "Fetch",
  think: "Think",
  other: "Tool",
};

/** ACP `rawInput` rendered for the expanded view. Objects pretty-print. */
export function formatInput(input: unknown): string {
  if (input == null) return "(no input recorded)";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    // Circular or otherwise unserialisable input: say so rather than blank.
    return String(input);
  }
}

// ---------------------------------------------------------------- session

export function canInterrupt(s: Session): boolean {
  return s.status === "running" || s.status === "spawning";
}

/** A halted session must be resumable in one click — DESIGN.md, Behaviour rules. */
/**
 * The three halted states are all resumable, and they resume identically:
 * re-run the original task. `failed` is included because it usually means the
 * session never launched, which is exactly the case a person wants to retry —
 * and because the Inbox already offered Resume on it, so omitting it here made
 * two views of one session disagree about what could be done to it.
 */
export function canResume(s: Session): boolean {
  return s.status === "flagged" || s.status === "dead" || s.status === "failed";
}

/** One wording for the action, so the Inbox and the board cannot drift. */
export const RESUME_HINT = "Resume runs it again from the original task.";

/**
 * What the steer composer promises. The two cases genuinely differ and the
 * difference is the whole reason the placeholder exists: a message to a
 * running agent waits for the current agentic turn to end, which can be long.
 */
export function steerPlaceholder(status: SessionStatus): string {
  switch (status) {
    case "running":
    case "spawning":
      return "Steer the agent — queued, delivered when the current turn ends";
    case "waiting":
    case "done":
      return "Tell the agent what's next — delivered immediately";
    case "flagged":
    case "dead":
    case "failed":
      // Saying a halted session "cannot take messages" would be half true at
      // best: resuming is how you send it one.
      return "Resume first, then this message is delivered";
  }
}

export function canSteer(status: SessionStatus): boolean {
  return !HALTED.has(status);
}

const HALTED = new Set<SessionStatus>(["flagged", "dead", "failed"]);
