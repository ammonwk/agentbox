/**
 * What a session waits on now, for the list above its composer: the shells
 * and monitors that run under its process, the agents it started inside
 * itself that still work, and its workflows with the agents each runs now.
 * Read on demand, for the one session that is open.
 *
 * Subagents through the subagent MCP and teammates are sessions of their own,
 * on the board already; the page finds those by `parent`.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Session } from "./types";
import { argvOf, runsCli, startedAtOf } from "./providers/procs";
import { transcriptFile } from "./providers/types";
import { describe, isToolShell, sharedProcTable, subtree, type ProcTable } from "./proc";
import { classifyShell, normalCommand, shellCommand, SUBAGENT_QUIET_MS, type ShellKind } from "./park";

export interface WorkShell {
  pid: number;
  /** The command, without the tool-call wrapper. */
  command: string;
  /** What the agent said it is for, else what it runs, in a few words. */
  label: string;
  since: number | null;
  /** A Monitor: each line it prints is a message to the session. */
  monitor: boolean;
  kind: ShellKind;
}

export interface WorkAgent {
  id: string;
  /** What the agent was asked to do, in the caller's words. */
  description: string;
  /** The name the caller gave it, when it gave one. */
  name: string | null;
  /** Started with `run_in_background`: the caller does not wait for it. */
  background: boolean;
  since: number;
}

export interface WorkWorkflow {
  runId: string;
  /** The workflow's `meta.name`. */
  name: string;
  since: number;
  /** Its agents that started and have no result yet. */
  agents: { id: string; label: string; phase: string | null }[];
}

export interface SessionWork {
  shells: WorkShell[];
  agents: WorkAgent[];
  workflows: WorkWorkflow[];
}

const NONE: SessionWork = { shells: [], agents: [], workflows: [] };

/** One transcript scan per session, kept: after the first read a check costs one stat. */
const scans = new Map<string, LaunchScan>();

export async function sessionWork(s: Session): Promise<SessionWork> {
  if (!s.pid || s.host === "none") return NONE;
  const table = await sharedProcTable();
  const agent = agentProcess(table, s.pid, s.provider);
  if (agent === null) return NONE;
  const file = s.transcriptPath ? transcriptFile(s.transcriptPath) : null;
  if (s.provider !== "claude" || !file) return NONE;
  let scan = scans.get(file);
  if (!scan) scans.set(file, (scan = new LaunchScan(file)));
  await scan.read();
  const started = startedAtOf(agent);
  const own = s.agentSessionId && started !== null ? { dir: join(dirname(file), s.agentSessionId), started } : null;
  return {
    shells: shellsUnder(table, agent, scan.launched),
    agents: own ? agentsOf(join(own.dir, "subagents"), own.started) : [],
    workflows: own ? workflowsOf(own.dir, own.started, scan) : [],
  };
}

/** The agent's own process: the pane runs it, or runs a shell that runs it. */
function agentProcess(table: ProcTable, pid: number, cli: string): number | null {
  for (const row of subtree(table, pid)) {
    const argv = argvOf(row.pid);
    if (argv && runsCli(argv, cli)) return row.pid;
  }
  return null;
}

/**
 * The background shells and monitors the agent started, found the way
 * fleet.ts `shellWork` finds tool shells. A shell the transcript did not
 * launch in the background is the step running now, which the timeline
 * shows already.
 */
function shellsUnder(table: ProcTable, agent: number, launched: ReadonlyMap<string, Launch>): WorkShell[] {
  const out: WorkShell[] = [];
  for (const kid of table.children.get(agent) ?? []) {
    const cmd = argvOf(kid)?.join(" ");
    if (!cmd || !isToolShell(cmd)) continue; // an MCP server
    const command = shellCommand(cmd);
    const launch = launched.get(normalCommand(command));
    if (!launch) continue;
    const running = subtree(table, kid)
      .filter((r) => r.pid !== kid)
      .map((r) => argvOf(r.pid)?.join(" ") ?? r.comm)
      .filter((c) => !isToolShell(c));
    out.push({
      pid: kid,
      command,
      label: launch.description || describe({ ...table.byPid.get(kid)!, cmd }),
      since: startedAtOf(kid),
      monitor: launch.monitor,
      kind: classifyShell(command, running),
    });
  }
  return out.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
}

/**
 * The agents a Claude session started inside its process that still work.
 * Claude writes each one's transcript to `<session>/subagents/agent-<id>.jsonl`
 * beside a `.meta.json` that says what it was asked. One is done when its
 * transcript ends on a final answer. One started before this process died
 * with the process before, and one quiet for SUBAGENT_QUIET_MS was stopped.
 */
function agentsOf(dir: string, processStart: number): WorkAgent[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const out: WorkAgent[] = [];
  for (const n of names) {
    const id = /^agent-(.+)\.meta\.json$/.exec(n)?.[1];
    if (!id) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, n), "utf8"));
      const since = statSync(join(dir, n)).mtimeMs;
      const log = join(dir, `agent-${id}.jsonl`);
      const wrote = statSync(log).mtimeMs;
      if (since < processStart || now - wrote > SUBAGENT_QUIET_MS || finished(log)) continue;
      out.push({
        id,
        description: typeof meta.description === "string" ? meta.description : "",
        name: typeof meta.name === "string" ? meta.name : null,
        background: meta.requestShape === "background",
        since,
      });
    } catch {
      /* not written yet, or gone between the listing and the read */
    }
  }
  return out.sort((a, b) => a.since - b.since);
}

/**
 * The workflows a Claude session launched in this process that have not
 * ended, each with the agents it runs now. A run's agents write under
 * `<session>/subagents/workflows/<run>/`, and its `journal.jsonl` says which
 * started and which gave a result. A run that ended has a
 * `<session>/workflows/<run>.json`, or a task notification said so.
 */
function workflowsOf(dir: string, processStart: number, scan: LaunchScan): WorkWorkflow[] {
  const out: WorkWorkflow[] = [];
  for (const [runId, w] of scan.workflows) {
    if (w.since < processStart || scan.ended.has(w.taskId) || exists(join(dir, "workflows", `${runId}.json`))) continue;
    const running = new Map<string, { id: string; label: string; phase: string | null }>();
    try {
      for (const line of readFileSync(join(dir, "subagents", "workflows", runId, "journal.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (typeof r?.agentId !== "string") continue;
        if (r.type === "started") running.set(r.agentId, { id: r.agentId, label: String(r.label ?? ""), phase: typeof r.phase === "string" ? r.phase : null });
        else if (r.type === "result" || r.type === "failed") running.delete(r.agentId);
      }
    } catch {
      /* no agent started yet, or a line still being written */
    }
    out.push({ runId, name: w.name, since: w.since, agents: [...running.values()] });
  }
  return out.sort((a, b) => a.since - b.since);
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The transcript's last record is the agent's final answer. */
function finished(log: string): boolean {
  const last = lastLine(log);
  if (!last) return false;
  try {
    const r = JSON.parse(last);
    return r?.type === "assistant" && r.message?.stop_reason === "end_turn";
  } catch {
    // A last line longer than the tail read: an answer is long, a step is not.
    return true;
  }
}

/** The last line of a file, from a read of its tail. */
function lastLine(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(size, 256 << 10);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
    return lines.at(-1) ?? null;
  } finally {
    closeSync(fd);
  }
}

interface Launch {
  description: string | null;
  monitor: boolean;
}

/**
 * The commands a Claude session started in the background — a Bash call with
 * `run_in_background`, or a Monitor — by command, whitespace-collapsed, with
 * what the agent said each is for. Read incrementally, like park.ts
 * `WakeScan`: only lines that mention one are parsed.
 */
class LaunchScan {
  private offset = 0;
  readonly launched = new Map<string, Launch>();
  /** Workflows launched, by run id. */
  readonly workflows = new Map<string, { name: string; taskId: string; since: number }>();
  /** Background tasks a notification or a TaskStop ended, by task id. */
  readonly ended = new Set<string>();

  constructor(private readonly path: string) {}

  async read(): Promise<void> {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.launched.clear();
      this.workflows.clear();
      this.ended.clear();
    }
    if (size === this.offset) return;
    const fd = openSync(this.path, "r");
    try {
      const chunk = Buffer.alloc(4 << 20);
      let carry = "";
      while (this.offset < size) {
        const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        const text = carry + chunk.toString("utf8", 0, n);
        const cut = text.lastIndexOf("\n");
        carry = cut === -1 ? text : text.slice(cut + 1);
        if (cut !== -1) for (const line of text.slice(0, cut).split("\n")) this.line(line);
        await Bun.sleep(0);
      }
      // An unfinished last line is read again next time.
      this.offset -= Buffer.byteLength(carry);
    } finally {
      closeSync(fd);
    }
  }

  private line(line: string): void {
    // A task notification ends its task unless it only reports progress.
    // Read from the raw line: it comes in a queued message as often as in a record.
    if (line.includes("<task-notification>")) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(line)?.[1];
      const status = /<status>([^<]+)<\/status>/.exec(line)?.[1];
      if (id && status !== "running" && status !== "progress") this.ended.add(id.trim());
    }
    if (!line.includes('"run_in_background":true') && !line.includes('"name":"Monitor"') && !line.includes('"local_workflow"') && !line.includes('"name":"TaskStop"')) return;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const launched = r?.toolUseResult;
    if (launched?.status === "async_launched" && launched.taskType === "local_workflow" && typeof launched.runId === "string") {
      const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      this.workflows.set(launched.runId, { name: String(launched.workflowName ?? "workflow"), taskId: String(launched.taskId ?? ""), since: Number.isFinite(at) ? at : 0 });
    }
    const content = r?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use" && b.name === "TaskStop") this.ended.add(String(b.input?.task_id ?? b.input?.shell_id ?? ""));
      if (b?.type !== "tool_use" || typeof b.input?.command !== "string") continue;
      const monitor = b.name === "Monitor";
      if (!monitor && !(b.name === "Bash" && b.input.run_in_background === true)) continue;
      const description = typeof b.input.description === "string" ? b.input.description : null;
      this.launched.set(normalCommand(b.input.command), { description, monitor });
    }
  }
}
