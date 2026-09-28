/** Crash recovery: bringing back what a crash took, and only that.
 *
 * A crash — the machine restarting, the desktop session ending, agentbox's
 * tmux server dying — stops every agent at once, and with them every
 * background command, monitor and subagent they were waiting on. The board
 * then shows all of them stopped, the ones that were mid-task beside the
 * ones that had finished days ago, and nothing says which is which.
 *
 * So the fleet writes down, as it goes, what every running session is doing
 * (`LiveSnapshot`, a small file rewritten every few seconds). After a crash it
 * reads the last one back and decides per session:
 *
 * - **resume** what was working: mid-turn, or its turn over but waiting on
 *   something that the crash killed (a background command, a monitor, a
 *   wakeup, subagents). It is told what happened, so it checks its state and
 *   restarts what it needs rather than waiting on a monitor that is gone.
 * - **park** what was not: its turn over with nothing running, or waiting on
 *   you (a question, a permission). It shows as waiting on you, and your next
 *   message resumes it — the crash cost it nothing, so it costs you nothing.
 * - **revive** a subagent-MCP agent through its caller: the caller's MCP
 *   brings it back under the same name with its own system prompt and
 *   permissions (src/subagents/pool.ts `revive`), where a resume of its own
 *   would lose all three.
 *
 * "Crash" is proven, never guessed from one session being gone: a session
 * that ended on its own (you closed its terminal, it exited) must stay ended.
 * The proof is that something bigger went away since the snapshot — the
 * machine booted, your user's systemd started over, or the tmux server every
 * agentbox session runs in is a different one.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "./paths";
import { startedAtOf } from "./providers/procs";
import type { Launch } from "./launch";
import type { ProviderId, SessionStatus } from "./types";

/** A turn this quiet is over, whatever the CLI says (see park.ts STALE_TURN_MS). */
const STALE_TURN_MS = 2 * 3_600_000;
/** A crash older than this is not acted on by itself: everything is parked
 *  and the report says so. Nobody expects agents to wake up after a week off. */
export const MAX_AUTO_RESUME_MS = 24 * 3_600_000;

export interface LiveEntry {
  id: string;
  provider: ProviderId;
  title: string;
  /** Where it ran: our tmux, some other terminal, or under a caller's subagent MCP. */
  host: "tmux" | "external" | "subagent";
  /** Its own status: running is mid-turn, waiting is your turn. */
  status: SessionStatus;
  /** What it was waiting on you for, while blocked. */
  blockedOn: string | null;
  /** With its turn over: the work it was still waiting on, as a clause
   *  ("a background command is running (…)"). */
  work: string | null;
  parent: string | null;
  /** A subagent-MCP agent: its name there, and whether an answer of its was
   *  waiting for its caller to collect. */
  subagent: { name: string; answerWaiting: boolean } | null;
  lastActivityAt: number;
  /** When the model last answered, where the provider can tell (see TranscriptFacts). */
  lastTurnAt: number | null;
  /** How a session in another terminal was started, so it resumes with the same flags. */
  launch: Launch | null;
}

/** A process that must be the same one for nothing to have happened. */
export interface Incarnation {
  pid: number;
  /** Epoch ms. */
  start: number;
}

export interface LiveSnapshot {
  /** When all of this was last seen true. */
  at: number;
  /** The tmux server every agentbox session runs in; null when none was running. */
  tmux: Incarnation | null;
  /** Your user's systemd: when it starts over, everything under it died. */
  manager: Incarnation | null;
  entries: LiveEntry[];
}

export type Action = "resume" | "park" | "revive" | "leave";

export interface Step {
  id: string;
  title: string;
  provider: ProviderId;
  action: Action;
  why: string;
  /** What happened when it was carried out. */
  outcome?: string;
}

export interface RecoveryReport {
  at: number;
  /** What went away, in words ("the machine restarted"). */
  cause: string;
  /** When everything was last seen running. */
  lastSeen: number;
  dryRun: boolean;
  steps: Step[];
  /** Sessions that came back unable to act, found by the post-start watch. */
  trouble: { id: string; title: string; what: string }[];
}

// ------------------------------------------------------------ the snapshot

const snapshotFile = () => join(agentboxHome(), "live-sessions.json");
const reportDir = () => join(agentboxHome(), "recovery");

export function readSnapshot(): LiveSnapshot | null {
  try {
    const s = JSON.parse(readFileSync(snapshotFile(), "utf8")) as LiveSnapshot;
    return Array.isArray(s?.entries) && typeof s.at === "number" ? s : null;
  } catch {
    return null;
  }
}

/** Written to a sibling and renamed: a crash mid-write must leave the last
 *  good snapshot, since that is the one moment it is needed. */
export function writeSnapshot(s: LiveSnapshot): void {
  const path = snapshotFile();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    // Yours only: a session from another terminal is kept with its shell's variables.
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    console.error("agentbox: writing the live-sessions snapshot failed:", e);
  }
}

export function saveReport(r: RecoveryReport): void {
  try {
    mkdirSync(reportDir(), { recursive: true });
    writeFileSync(join(reportDir(), `${r.at}.json`), JSON.stringify(r, null, 2));
  } catch (e) {
    console.error("agentbox: saving the recovery report failed:", e);
  }
}

/** The newest recovery that was carried out, if any. */
export function lastReport(): RecoveryReport | null {
  try {
    const newest = readdirSync(reportDir())
      .filter((n) => /^\d+\.json$/.test(n))
      .sort((a, b) => Number(b.slice(0, -5)) - Number(a.slice(0, -5)))[0];
    return newest ? (JSON.parse(readFileSync(join(reportDir(), newest), "utf8")) as RecoveryReport) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ was it a crash

/** When the machine booted, epoch ms. */
export function bootTime(now = Date.now()): number {
  try {
    return now - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]) * 1000;
  } catch {
    return 0;
  }
}

/**
 * What went away since `prev` was written, and which sessions it can have
 * taken — or null when nothing did. Each test is a fact about a process that
 * outlives any one session, so a session that simply ended cannot trip it.
 * The tmux server dying alone takes only what ran in it: a session in some
 * other terminal that is gone now was closed there.
 */
export function crashCause(
  prev: LiveSnapshot,
  now: { boot: number; tmux: Incarnation | null; manager: Incarnation | null },
): { cause: string; tookAll: boolean } | null {
  if (now.boot > prev.at) return { cause: "the machine restarted", tookAll: true };
  if (prev.manager && now.manager && !same(prev.manager, now.manager)) {
    return { cause: "your desktop session ended (your user's systemd was stopped)", tookAll: true };
  }
  if (prev.tmux && !(now.tmux && same(prev.tmux, now.tmux))) return { cause: "agentbox's tmux server stopped", tookAll: false };
  return null;
}

/** Could this session have gone with what went? Everything, or — when only
 *  the tmux server went — what ran in it, and the subagents those ran. */
export function tookWith(e: LiveEntry, all: readonly LiveEntry[], tookAll: boolean): boolean {
  if (tookAll || e.host === "tmux") return true;
  return e.host === "subagent" && all.some((c) => c.id === e.parent && c.host === "tmux");
}

/**
 * Your user's systemd (`systemd --user`), the manager every agent, terminal
 * and agentbox itself run under. It is stopped at logout — or by a stray
 * SIGTERM — and everything under it goes with it.
 */
export function managerIncarnation(): Incarnation | null {
  const uid = process.getuid?.();
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pid of pids) {
    try {
      if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "systemd") continue;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      if (uid !== undefined && Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").includes("--user")) continue;
      const start = startedAtOf(Number(pid));
      return start === null ? null : { pid: Number(pid), start };
    } catch {
      /* gone, or not ours to read */
    }
  }
  return null;
}

function same(a: Incarnation, b: Incarnation): boolean {
  // Start times read from /proc wobble by a tick; a pid reused within a second is not a concern here.
  return a.pid === b.pid && Math.abs(a.start - b.start) < 2_000;
}

// ------------------------------------------------------------ what to do

/** Was it doing something the crash interrupted? */
function working(e: LiveEntry, lastSeen: number): boolean {
  return (e.status === "running" && lastSeen - e.lastActivityAt < STALE_TURN_MS) || !!e.work;
}

/**
 * What to do with one session the crash took. `dead` is everything it took,
 * by id, so a caller can see its subagents and a subagent its caller.
 */
export function decide(e: LiveEntry, dead: ReadonlyMap<string, LiveEntry>, lastSeen: number): { action: Action; why: string } {
  if (e.host === "subagent") {
    const caller = e.parent ? dead.get(e.parent) : undefined;
    const unread = !!e.subagent?.answerWaiting;
    if (caller && (working(e, lastSeen) || unread)) {
      return { action: "revive", why: `${unread && !working(e, lastSeen) ? "its answer was never collected" : "it was mid-turn"}; its caller brings it back under the same name` };
    }
    if (!caller && working(e, lastSeen)) return { action: "resume", why: "it was mid-turn and its caller is not coming back, so it finishes on its own" };
    return { action: "leave", why: "it had finished, and its caller had its answer" };
  }
  if (e.status === "blocked") return { action: "park", why: `it was waiting on you (${e.blockedOn ?? "a prompt"})` };
  if (e.status === "running" && lastSeen - e.lastActivityAt < STALE_TURN_MS) return { action: "resume", why: "it was mid-turn" };
  if (e.work) return { action: "resume", why: `its turn was over but ${e.work}` };
  const kids = [...dead.values()].filter((c) => c.parent === e.id && c.host === "subagent" && working(c, lastSeen));
  if (kids.length) return { action: "resume", why: `its subagents were working (${kids.map((k) => k.subagent?.name ?? k.id).join(", ")})` };
  return { action: "park", why: "its turn was over and nothing was running" };
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** What a resumed session is told, first thing. */
export function resumePrompt(
  e: LiveEntry,
  why: string,
  cause: string,
  lastSeen: number,
  revived: LiveEntry[],
): string {
  const parts = [
    `[agentbox: this session was stopped at ${clock(lastSeen)} when ${cause}, along with every other agent, and agentbox has resumed it because ${why}.`,
    "Anything you had running in the background — shells, monitors, waits — is gone, and a command that was mid-flight never finished.",
    "Other sessions were resumed too, so any address you had for another session (a socket, a pid) is stale; look it up again.",
  ];
  if (revived.length) {
    const names = revived.map((r) => `"${r.subagent?.name ?? r.id}"${r.status === "running" ? " (mid-turn)" : " (an answer you had not collected)"}`).join(", ");
    parts.push(
      `Your subagents ${names} were stopped with you. They are back under the same names in your subagent tools, parked with their conversations intact: send_message each one to carry on, then collect as usual.`,
    );
  }
  if (e.host === "subagent") {
    parts.push("You were a subagent, and your caller is not coming back, so nobody will collect your answer: finish your task and end with your report here.");
  }
  parts.push("Check the state of your work, restart what you need, and carry on where you left off.]");
  return parts.join(" ");
}

/** What a parked session is told when your next message wakes it, if anything. */
export function parkedWhy(e: LiveEntry, cause: string, lastSeen: number): string | null {
  if (e.status !== "blocked") return null;
  return (
    `this session's process was stopped at ${clock(lastSeen)} when ${cause}, while it was waiting on you (${e.blockedOn ?? "a prompt"}). ` +
    "That prompt is gone: read the message below as your answer, or ask again."
  );
}

/** A report in a few lines, for a log or a phone. */
export function summarize(r: RecoveryReport): string {
  const by = (a: Action) => r.steps.filter((s) => s.action === a);
  const names = (xs: Step[]) => xs.map((s) => s.title).join("; ");
  const failed = r.steps.filter((s) => s.outcome?.startsWith("could not"));
  const lines = [`agentbox recovered after ${r.cause} (last seen ${clock(r.lastSeen)}).`];
  const resumed = by("resume").filter((s) => !failed.includes(s));
  if (resumed.length) lines.push(`Resumed ${resumed.length}: ${names(resumed)}.`);
  if (by("revive").length) lines.push(`${by("revive").length} subagents come back with their callers.`);
  if (by("park").length) lines.push(`Parked ${by("park").length} that were idle or waiting on you; a message resumes any of them.`);
  if (failed.length) lines.push(`Could not resume ${failed.length}: ${failed.map((s) => `${s.title} (${s.outcome!.replace(/^could not resume: /, "")})`).join("; ")}.`);
  if (!failed.length) lines.push("Nothing needed from you.");
  return lines.join(" ");
}
