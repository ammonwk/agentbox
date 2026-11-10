/**
 * Pausing the fleet: every agent, and everything agents started, stopped by
 * the kernel's cgroup freezer, for when the machine is needed for something
 * else (a video call that would otherwise cut out).
 *
 * A frozen process is not told anything: its threads stop where they are and
 * resume from there when thawed, so a resumed session carries on with its turn
 * without a message. What a provider was streaming in the meantime may have
 * timed out; the CLIs retry that themselves.
 *
 * What counts as agent work is every unit in the user's `app.slice` that an
 * agent's launch or command lands in: the tmux panes of agentbox's own tmux
 * server, the scopes and services agents' commands and `agentbox wait job` run
 * in, anonymous `systemd-run` scopes (test harnesses start their runs in one),
 * agent-browser's Chromium, and the disk reclaim job. The tmux server itself is
 * never frozen: the board talks to it on every tick. Desktop programs (the rest
 * of `app-*`) and your own services are never touched, nor is a scope agentbox
 * starts to hold your clipboard, which is named so as not to be anonymous.
 *
 * The cgroup's own `cgroup.freeze` is written rather than going through
 * `systemctl freeze`: it is one write per unit with no round trip, and a unit
 * that ended between the listing and the write is one failed write rather than
 * a failed batch. Systemd's own `FreezerState` does not see it; nothing here
 * reads that.
 *
 * Pausing is a state, not a one-off sweep: what starts while paused (a
 * session launched, a scheduled one, a command a thawing agent was about to
 * run) is frozen on the fleet's next tick, and the state outlives a restart of
 * the server. While paused the fleet parks and nudges nothing: a frozen session
 * looks exactly like a hung one.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getKv, setKv } from "./db";
import { tmuxSocket } from "./paths";

const KEY = "pausedSince";

const AGENT_UNIT = /^(?:tmux-spawn-.+\.scope|agentbox-(?:command|job|tool)-.+\.(?:scope|service)|run-.+\.scope|app-org\.chromium\.Chromium-.+\.scope|disk-reclaim\.service)$/;

let since: number | null | undefined;

/** When the fleet was paused, or null while it runs. */
export function pausedSince(): number | null {
  if (since === undefined) since = getKv<number>(KEY);
  return since;
}

/** Pause or resume every agent. Returns the new state. */
export function setPaused(on: boolean): number | null {
  since = on ? (pausedSince() ?? Date.now()) : null;
  setKv(KEY, since);
  freezeAll(on);
  return since;
}

/** While paused, freeze what started since the last pass. */
export function holdPaused(): void {
  if (pausedSince() !== null) freezeAll(true);
}

/** The user's `app.slice`, the parent of the server's own unit. */
function appSlice(): string | null {
  if (process.platform !== "linux") return null;
  const own = readFileSync("/proc/self/cgroup", "utf8").trim().split("\n").find((l) => l.startsWith("0::"));
  if (!own) return null;
  const dir = dirname(join("/sys/fs/cgroup", own.slice(3)));
  return dir.endsWith("/app.slice") && existsSync(dir) ? dir : null;
}

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Whether a unit holds agent work, by its name and, where the name is not
 *  enough, what runs in it. */
function isAgentWork(dir: string, unit: string): boolean {
  if (!AGENT_UNIT.test(unit)) return false;
  const pids = read(join(dir, "cgroup.procs")).split("\n").filter(Boolean);
  // A pane of some other tmux server than agentbox's is yours.
  if (unit.startsWith("tmux-spawn-")) {
    const tmux = read(`/proc/${pids[0]}/environ`).split("\0").find((v) => v.startsWith("TMUX="));
    return !!tmux && tmux.includes(`/${tmuxSocket()},`);
  }
  // A tmux server started after another was killed lands in an anonymous scope.
  if (unit.startsWith("run-")) return !pids.some((p) => read(`/proc/${p}/comm`).startsWith("tmux"));
  return true;
}

function freezeAll(on: boolean): void {
  const slice = appSlice();
  if (!slice) return;
  const want = on ? "1" : "0";
  for (const unit of readdirSync(slice)) {
    const file = join(slice, unit, "cgroup.freeze");
    const now = read(file).trim();
    if (!now || now === want) continue;
    if (on && !isAgentWork(join(slice, unit), unit)) continue;
    // Resuming thaws only what this would have frozen, whoever froze it.
    if (!on && !AGENT_UNIT.test(unit)) continue;
    try {
      writeFileSync(file, want);
    } catch {}
  }
}
