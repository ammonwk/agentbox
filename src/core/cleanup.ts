/** A reversible machine-wide pause. The journal stores process identities,
 * never conversations. Only the cleanup session may work until Resume. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentboxHome, userHome } from "./paths";
import { startedAtOf, type ProcessRef } from "./providers/procs";
import type { ProviderId, Session } from "./types";

export interface CleanupState {
  phase: "pausing" | "paused" | "resuming";
  sessionId: string;
  startedAt: number;
  sessions: string[];
  error: string | null;
}
/** `external`: sessions in your own terminals, left running and protected. */
interface Journal extends CleanupState { processes: ProcessRef[]; external?: string[] }
export interface PauseProcess { pid: number; ppid: number; stopped: boolean }
export interface CleanupIO {
  table(): Promise<PauseProcess[]>;
  identity(pid: number): number | null;
  signal(pid: number, signal: "SIGSTOP" | "SIGCONT"): void;
  load(): Journal | null;
  save(journal: Journal | null): void;
  ownPid: number;
}
interface CleanupFleet {
  sessions(): Session[];
  settleActivity(): Promise<void>;
  placement(provider: ProviderId): { accountId: string | null };
  spawn(req: { id: string; provider: ProviderId; cwd: string; prompt: string }): Promise<unknown>;
  stopSession(id: string): Promise<void>;
}

function localIO(): CleanupIO {
  const path = join(agentboxHome(), "cleanup.json");
  return {
    ownPid: process.pid,
    identity: startedAtOf,
    signal: (pid, signal) => { process.kill(pid, signal); },
    async table() {
      const p = Bun.spawn(["ps", "-axo", "pid=,ppid=,state="], { stdout: "pipe", stderr: "pipe" });
      const text = await new Response(p.stdout).text();
      if (await p.exited) throw new Error("Could not read the process table; nothing was paused.");
      return text.trim().split("\n").filter(Boolean).map(line => {
        const [pid, ppid, state] = line.trim().split(/\s+/);
        // A zombie (Z) cannot run either: a child that exited after its
        // parent stopped stays one until the parent resumes and reaps it.
        return { pid: Number(pid), ppid: Number(ppid), stopped: /[TZ]/.test(state!) };
      });
    },
    load: () => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Journal | null : null,
    save(journal) {
      mkdirSync(agentboxHome(), { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(journal), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}

/** Parent first: stop writers before their tools. Never include the server or
 * an ancestor (including tmux), even if a bad session record names one. */
export function pauseTree(table: PauseProcess[], roots: number[], ownPid: number): PauseProcess[] {
  const byPid = new Map(table.map(p => [p.pid, p]));
  const protectedPids = new Set([1]);
  for (let pid = ownPid; pid > 1 && !protectedPids.has(pid); pid = byPid.get(pid)?.ppid ?? 0) protectedPids.add(pid);
  if (roots.some(pid => protectedPids.has(pid))) throw new Error("Cannot pause a session that contains the Agentbox server.");
  const children = new Map<number, PauseProcess[]>();
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const result: PauseProcess[] = [], seen = new Set<number>();
  const visit = (pid: number) => {
    if (seen.has(pid)) return;
    if (protectedPids.has(pid)) throw new Error("The session process tree contains the Agentbox server.");
    seen.add(pid);
    const p = byPid.get(pid);
    if (!p) return;
    result.push(p);
    for (const c of children.get(pid) ?? []) visit(c.pid);
  };
  const rootSet = new Set(roots);
  for (const pid of roots) {
    const ancestors = new Set<number>();
    let parent = byPid.get(pid)?.ppid ?? 0;
    while (parent > 1 && !rootSet.has(parent) && !ancestors.has(parent)) {
      ancestors.add(parent);
      parent = byPid.get(parent)?.ppid ?? 0;
    }
    if (!rootSet.has(parent)) visit(pid);
  }
  return result;
}

export class ResourceCleanup {
  private journal: Journal | null;
  private operation: Promise<CleanupState | null> | null = null;
  constructor(
    private readonly fleet: CleanupFleet,
    private readonly changed: () => void,
    private readonly io: CleanupIO = localIO(),
    private readonly installed: (provider: ProviderId) => boolean = p => !!Bun.which(p),
  ) {
    this.journal = io.load();
    if (this.journal && this.journal.phase !== "paused") {
      this.journal.phase = "paused";
      this.journal.error = "Cleanup was interrupted. Resume sessions to release the pause.";
      this.io.save(this.journal);
    }
  }

  state(): CleanupState | null {
    if (!this.journal) return null;
    const { processes: _, external: __, ...state } = this.journal;
    return { ...state, sessions: [...state.sessions] };
  }
  allows(id?: string): boolean { return !this.journal || id === this.journal.sessionId; }
  private save(): void { this.io.save(this.journal); this.changed(); }

  start(): Promise<CleanupState | null> {
    if (this.operation) return this.operation;
    if (this.journal) return Promise.resolve(this.state());
    this.operation = this.begin().finally(() => { this.operation = null; });
    return this.operation;
  }

  private async begin(): Promise<CleanupState | null> {
    // Resolve an available provider before suspending anyone.
    const providers: ProviderId[] = ["claude", "codex", "omp", "muse", "devin", "opencode"];
    const provider = providers.find(p => this.installed(p) && this.fleet.placement(p).accountId);
    if (!provider) throw new Error("No agent account is available for cleanup. Sessions were left running.");
    this.journal = {
      phase: "pausing", sessionId: randomUUID().slice(0, 8), startedAt: Date.now(),
      sessions: [], processes: [], error: null,
    };
    try {
      this.save();
      // Close the activity gate before awaiting anything. Let already-started
      // Fleet actions finish, then take a fresh inventory of all live agents.
      await this.fleet.settleActivity();
      // Only agentbox's own panes: an agent in your terminal runs under a
      // job-control shell, which takes the terminal back on SIGSTOP and leaves
      // the agent in the background after SIGCONT.
      const all = this.fleet.sessions();
      const live = all.filter(s => s.pid && s.host === "tmux");
      this.journal.external = all.filter(s => s.pid && s.host === "external").map(s => s.id);
      const roots = live.map(s => ({ pid: s.pid!, startedAt: this.io.identity(s.pid!) }));
      const initial = await this.io.table();
      pauseTree(initial, roots.map(r => r.pid), this.io.ownPid);
      if (roots.some(r => r.startedAt === null && initial.some(p => p.pid === r.pid))) throw new Error("Cannot verify the identity of a live agent process.");
      this.journal.sessions = live.map(s => s.id);
      this.save();
      // A process can fork while the first table is read. Once each parent is
      // stopped, a fresh sweep catches its children. Fail closed if it will
      // not settle; never silently leave part of an agent running.
      let settled = false;
      for (let pass = 0; pass < 5; pass++) {
        const rows = pauseTree(await this.io.table(), roots.filter(r => r.startedAt !== null && this.io.identity(r.pid) === r.startedAt).map(r => r.pid), this.io.ownPid);
        const pending = rows.filter(p => !p.stopped);
        if (!pending.length) { settled = true; break; }
        const identified = pending.map(p => ({ ...p, startedAt: this.io.identity(p.pid) }));
        for (const p of identified) {
          const { startedAt } = p;
          if (startedAt === null) continue; // exited between snapshots
          if (!this.journal.processes.some(r => r.pid === p.pid && r.startedAt === startedAt)) {
            // Write ahead so a server crash after SIGSTOP is recoverable.
            this.journal.processes.push({ pid: p.pid, startedAt });
            this.save();
          }
          if (this.io.identity(p.pid) === startedAt) {
            try { this.io.signal(p.pid, "SIGSTOP"); }
            catch (error) {
              // A denied signal did not pause it. Do not resume a process
              // another program might stop after our failed attempt.
              this.journal.processes = this.journal.processes.filter(r => r.pid !== p.pid || r.startedAt !== startedAt);
              this.save();
              if (this.io.identity(p.pid) === startedAt) throw error;
            }
          }
        }
      }
      if (!settled) throw new Error("Some session processes could not be paused.");
      await this.fleet.spawn({ id: this.journal.sessionId, provider, cwd: userHome(), prompt: cleanupPrompt(this.journal) });
      this.journal.phase = "paused";
      this.save();
      return this.state();
    } catch (error) {
      const message = (error as Error).message;
      // A failed spawn may still have made its tmux process. Stop that one
      // before releasing the pause, never launch a second helper on retry.
      if (this.fleet.sessions().some(s => s.id === this.journal?.sessionId)) {
        try { await this.stopHelper(); }
        catch (stopError) { this.journal.error = `${message}; cleanup could not be stopped: ${(stopError as Error).message}`; this.journal.phase = "paused"; this.save(); return this.state(); }
      }
      this.release();
      if (this.journal) { this.journal.error = message; this.save(); return this.state(); }
      throw new Error(`${message} Sessions were resumed.`);
    }
  }

  resume(): Promise<CleanupState | null> {
    // Do not let a concurrent Resume race the helper's creation.
    if (this.operation) return this.operation.then(() => this.resume());
    this.operation = this.finish().finally(() => { this.operation = null; });
    return this.operation;
  }
  private async finish(): Promise<CleanupState | null> {
    if (!this.journal) return null;
    this.journal.phase = "resuming";
    this.save();
    try {
      await this.stopHelper();
      this.release();
    } catch (error) {
      if (this.journal) { this.journal.phase = "paused"; this.journal.error = (error as Error).message; this.save(); }
    }
    return this.state();
  }
  private async stopHelper(): Promise<void> {
    const helper = this.fleet.sessions().find(s => s.id === this.journal?.sessionId);
    if (!helper) return;
    const startedAt = helper.pid ? this.io.identity(helper.pid) : null;
    await this.fleet.stopSession(helper.id);
    if (!helper.pid || startedAt === null) return;
    const deadline = Date.now() + 5_000;
    while (this.io.identity(helper.pid) === startedAt) {
      if (Date.now() >= deadline) throw new Error("The cleanup agent has not stopped yet. Try Resume again.");
      await Bun.sleep(100);
    }
  }
  private release(): void {
    if (!this.journal) return;
    const failed: ProcessRef[] = [];
    // Children first, then their agent. Never signal a reused PID or resume a
    // process that was already stopped before this cleanup.
    for (const ref of [...this.journal.processes].reverse()) {
      if (this.io.identity(ref.pid) !== ref.startedAt) continue;
      try { this.io.signal(ref.pid, "SIGCONT"); }
      catch { failed.unshift(ref); }
    }
    if (failed.length) {
      this.journal.processes = failed;
      this.journal.phase = "paused";
      this.journal.error = `Could not resume ${failed.length} process(es). Try Resume again.`;
    } else this.journal = null;
    this.save();
  }
}

function cleanupPrompt(state: Journal): string {
  return `Find and clean up wasted CPU and memory on this machine.

The user pressed Pause sessions and clean up in Agentbox. You are the single cleanup agent. Other agent sessions and their process trees are temporarily suspended, NOT abandoned. They retain their context and allocated memory. The user will resume them using the system bar when ready. Do not spawn helpers, resume sessions, or stop, kill, alter, or signal the protected sessions/processes below. Do not stop Agentbox, tmux, essential OS services, or your own process tree.

Protected session IDs: ${state.sessions.join(", ") || "none"}
Sessions running in the user's own terminals (not paused, also protected, with their process trees): ${state.external?.join(", ") || "none"}
Protected process identities (PID and start time): ${state.processes.map(p => `${p.pid}@${p.startedAt}`).join(", ") || "none"}

Measure CPU, memory pressure, swap, and disk first. Inspect process ownership, age, open connections, Agentbox status, active waits/jobs, PR ownership, and container workloads to distinguish unused leftovers from useful services. Detached jobs may still belong to paused sessions even when their parent PID is 1. Investigate orphaned dev/preview servers, failing container restart loops, duplicate workers, and heavy applications. Use the machine's actual OS and installed tools.

You may gracefully stop clearly abandoned processes and unused broken containers, keeping their files, databases, volumes, and session history. Verify process identity immediately before acting. If a stale service restarts itself, use its service manager to stop only that service. Do not delete data, prune Docker volumes, change credentials, kill user applications with unsaved work, or stop a shared service merely because it is large. Ask the user before an ambiguous or destructive action. Do not assume suspended sessions are dead or that their dependencies are unused.

Check resource usage again and report what you stopped, the measured improvement, and any remaining candidates. Pause does not free the agents' memory, so account for that in your report. Leave the other sessions paused for the user's Resume control. Finish your turn after the report; no recurring monitoring.`;
}
