/** The subagents the board can see, which is all of them.
 *
 * Subagents deliberately have no row in the database, no worktree and no
 * supervisor — they are function calls that happen to be language models, and
 * putting them on the board next to real work would be a category error. That
 * argument is about the *data model*, and it was right. It is not an argument
 * for them being invisible, which is what they were.
 *
 * So this reads the record on disk and shapes it for a browser. Nothing here
 * touches the database or the session machinery, and nothing here can reach
 * the process that owns an agent: the owner is an MCP server on some client's
 * stdio, and by the time you are looking at a finished agent it has usually
 * exited. The record outlives it, which is the point.
 *
 * One consequence worth stating: this shows agents from *every* client session
 * on the machine, not just this one. That is a feature and the main thing this
 * view has over anything built into a client — when you have four windows open
 * and something is chewing through money, the question "which window is that"
 * has no answer inside any one of them.
 */

import { budget, healthWord, verdict, type Budget, type Verdict } from "../core/health";
import {
  listRecords,
  readEvents,
  readRecord,
  readSystemPrompt,
  requestCommand,
  type AgentRecord,
  type Command,
} from "../core/record";

export interface SubagentRow {
  id: string;
  name: string;
  cwd: string;
  branch: string | null;
  model: string;
  readOnly: boolean;
  owner: string;
  pid: number;
  startedAt: number;
  /** As last published. `abandoned` is ours, not the agent's — see `stale`. */
  state: "running" | "idle" | "dead" | "abandoned" | "unknown";
  /** One word for a badge; the findings carry the sentences. */
  health: string;
  concern: string | null;
  findings: Verdict["findings"];
  budget: Budget | null;
  lastAction: string;
  turnToolCalls: number;
  totalToolCalls: number;
  uncollected: number;
  /** First line of the brief, so a list is scannable without opening rows. */
  summary: string;
}

/**
 * A published state nobody has refreshed means the writer is gone, whatever
 * the state claims. Distinguishing that from "finished" matters: one is an
 * answer waiting to be read and the other is work that will never arrive.
 */
function stateOf(rec: AgentRecord): SubagentRow["state"] {
  if (rec.snapshot === null) return "unknown";
  if (!rec.stale) return rec.snapshot.state;
  return rec.snapshot.state === "running" ? "abandoned" : rec.snapshot.state;
}

function rowOf(rec: AgentRecord, now: number): SubagentRow {
  const snap = rec.snapshot;
  const v = snap === null ? null : verdict(snap, now);
  const state = stateOf(rec);
  return {
    id: rec.id,
    name: rec.meta.name,
    cwd: rec.meta.cwd,
    branch: rec.meta.branch,
    model: rec.meta.model,
    readOnly: rec.meta.readOnly,
    owner: rec.meta.owner,
    pid: rec.meta.pid,
    startedAt: rec.meta.startedAt,
    state,
    health:
      state === "abandoned" || state === "unknown"
        ? state
        : v === null
          ? state
          : healthWord(v, snap!),
    concern: v?.concern ?? null,
    findings: v?.findings ?? [],
    budget: snap === null ? null : budget(snap, now),
    lastAction: snap?.lastAction ?? "",
    turnToolCalls: snap?.turnToolCalls ?? 0,
    totalToolCalls: snap?.totalToolCalls ?? 0,
    uncollected: snap?.uncollected ?? 0,
    summary: rec.meta.prompt.split("\n").find((l) => l.trim().length > 0)?.slice(0, 160) ?? "",
  };
}

export function listSubagents(now = Date.now()): SubagentRow[] {
  // Trouble first, then running, then everything else newest-first. A list
  // read top-down should start with the thing you would want to act on.
  const rank = (r: SubagentRow) =>
    r.concern !== null || r.state === "abandoned"
      ? 0
      : r.state === "running"
        ? 1
        : r.uncollected > 0
          ? 2
          : 3;
  return listRecords(now)
    .map((rec) => rowOf(rec, now))
    .sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
}

export interface SubagentDetail extends SubagentRow {
  prompt: string;
  systemPrompt: string | null;
  partial: string;
  /** Tool calls, oldest first — the evidence behind whatever it claims. */
  calls: {
    at: number;
    kind: string;
    title: string;
    status: string;
    ms: number | null;
    input: string | null;
    output: string | null;
  }[];
  /** Finished turns, oldest first. */
  turns: { at: number; turn: number; stopReason: string; report: string; errors: string[] }[];
  errors: { at: number; message: string }[];
}

export function subagentDetail(id: string, now = Date.now()): SubagentDetail | null {
  const rec = readRecord(id, now);
  if (rec === null) return null;
  const events = readEvents(rec.dir, 1000);
  // A tool call is logged when it starts and again when it ends, because the
  // record is updated in place and the log is append-only. Keyed by `seq` and
  // last-write-wins, so a reader sees one row per call carrying its outcome
  // rather than two rows, the first of which is always unfinished.
  const byCall = new Map<number, SubagentDetail["calls"][number]>();
  const turns: SubagentDetail["turns"] = [];
  const errors: SubagentDetail["errors"] = [];
  for (const e of events) {
    if (e.type === "tool") {
      const c = e.call as Record<string, unknown> | undefined;
      if (!c) continue;
      byCall.set(Number(c.seq ?? byCall.size), {
        at: e.ts,
        kind: String(c.kind ?? ""),
        title: String(c.title ?? ""),
        status: String(c.status ?? ""),
        ms: typeof c.ms === "number" ? c.ms : null,
        input: typeof c.input === "string" ? c.input : null,
        output: typeof c.output === "string" ? c.output : null,
      });
    } else if (e.type === "turn") {
      const r = e.report as Record<string, unknown> | undefined;
      if (!r) continue;
      turns.push({
        at: e.ts,
        turn: Number(r.turn ?? 0),
        stopReason: String(r.stopReason ?? ""),
        report: String(r.report ?? ""),
        errors: Array.isArray(r.errors) ? (r.errors as string[]) : [],
      });
    } else if (e.type === "error" || e.type === "dead") {
      errors.push({ at: e.ts, message: String(e.message ?? e.reason ?? e.type) });
    }
  }
  return {
    ...rowOf(rec, now),
    prompt: rec.meta.prompt,
    systemPrompt: readSystemPrompt(rec.dir),
    partial: rec.snapshot?.partial ?? "",
    calls: [...byCall.values()].sort((a, b) => a.at - b.at),
    turns,
    errors,
  };
}

/**
 * Ask an agent's owner to interrupt or stop it.
 *
 * Returns false when there is no record to leave the request in. It cannot
 * return whether anything happened — the owner may have exited — and pretending
 * otherwise would be the worst kind of lie for a control that people press
 * when something is already going wrong.
 */
export function commandSubagent(id: string, command: Command): boolean {
  const rec = readRecord(id);
  if (rec === null) return false;
  requestCommand(rec.dir, command);
  return true;
}
