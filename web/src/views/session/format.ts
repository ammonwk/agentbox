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
 * this classifies on `kind` plus whichever argument key is present.
 *
 * Key names confirmed against a live omp run: `command` for execute, `path`
 * for read/search/edit (edit also carries `old_string`/`new_string`). The
 * other spellings are kept as fallbacks — they cost nothing and the observed
 * set is one model's worth of evidence, not the whole surface.
 */
export function toolSummary(call: ToolCall): string | null {
  const summary = rawSummary(call);
  if (summary === null) return null;
  // Live titles are intent strings and rendered commands — "$ node test.js"
  // for a call whose input is {command: "node test.js"}. Repeating that as a
  // subtitle is noise in a row built to be scanned.
  if (call.title.includes(summary)) return null;
  return summary;
}

function rawSummary(call: ToolCall): string | null {
  switch (call.kind) {
    case "execute":
      return str(call.input, ["command", "cmd", "script"]);
    case "fetch":
      return str(call.input, ["url", "uri"]) ?? pathish(call);
    case "search":
      // Observed carrying `path` (a directory listing), not only a pattern.
      return str(call.input, ["pattern", "query", "regex", "glob"]) ?? pathish(call);
    case "read":
    case "edit":
    case "delete":
      return pathish(call);
    case "move":
      return str(call.input, ["source", "from", "old_path"]) ?? pathish(call);
    case "think":
    case "other":
      return null;
  }
}

/** The file or directory a call names, however the tool spelled the key. */
function pathish(call: ToolCall): string | null {
  return str(call.input, ["file_path", "path", "filePath", "file"]) ?? call.locations[0] ?? null;
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

// -------------------------------------------------------------- subagents

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

export const SUBAGENT_KIND_LABEL: Record<SubagentCall["kind"], string> = {
  dispatch: "Subagents",
  wait: "Wait",
  collect: "Subagent result",
};

// ------------------------------------------------------- subagent drilldown

/**
 * Snapshot `recentTools` carry a bare tool name, and for omp's `hub` tool no
 * arguments at all — every spawned agent gets `hub` (its background-job
 * surface: dispatch, wait, jobs, send) and uses it constantly, so an
 * unlabeled row would read as noise repeating every few minutes. Name what
 * the tool is for; the specific op is not on the wire.
 */
export function subagentStepLabel(step: { tool: string; args: string | null }): string {
  if (step.tool === "hub" && !step.args) return "hub — background jobs";
  return step.tool;
}

/** Row tooltip for a `hub` step with no reported arguments. */
export const HUB_STEP_HINT =
  "omp's background-job tool — the agent dispatched, polled, or blocked on one of " +
  "its own background jobs (often a PR-monitor wait, which can hold for minutes). " +
  "omp reports no arguments for these calls, so the specific op is unknown.";

// ---------------------------------------------------------------- PR links

const PR_REF = /#\d{2,7}/g;

/** Base URL for PR links, or null when the repo has no GitHub slug. */
export function prBaseOf(repoFullName: string | null | undefined): string | null {
  return repoFullName ? `https://github.com/${repoFullName}/pull/` : null;
}

export interface PRSegment {
  text: string;
  /** The PR number when this segment is a `#1234` reference, else null. */
  pr: number | null;
}

/**
 * Split text into plain runs and PR references. Two digits minimum, so
 * "#1"-style enumerations stay prose; everything else links, false
 * positives and all — a mislinked number costs a click, a missing link
 * costs a search.
 */
export function splitPRRefs(text: string): PRSegment[] {
  const out: PRSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(PR_REF)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: text.slice(last, idx), pr: null });
    out.push({ text: m[0], pr: Number(m[0].slice(1)) });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), pr: null });
  return out;
}

// ---------------------------------------------------------------- session

export function canInterrupt(s: Session): boolean {
  return s.status === "running" || s.status === "spawning";
}

/**
 * A halted session must be resumable in one click.
 *
 * The three halted states are all resumable, and they resume identically:
 * re-run the original task. `failed` is included because it usually means the
 * session never launched, which is exactly the case a person wants to retry —
 * and because the Inbox already offered Resume on it, so omitting it here made
 * two views of one session disagree about what could be done to it.
 *
 * Closed sessions are resumable too, whatever their status. Closing usually
 * lands on `dead`, but one closed while `done` keeps `done` — and "its PR is
 * open" is no reason to refuse to reopen the conversation. This has to agree
 * with `canResume` in sessions.ts: the server is what actually decides, so a
 * narrower rule here is a button that is missing from a session that would
 * have accepted the click.
 */
export function canResume(s: Session): boolean {
  return (
    s.closedAt !== null ||
    s.status === "flagged" ||
    s.status === "dead" ||
    s.status === "failed"
  );
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
