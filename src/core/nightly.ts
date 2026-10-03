import { readdirSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { getKv, getSettings, setKv } from "./db";
import { diskBytesOf, headMovedAt, isDirty, removeWorktreeIdly } from "./git";
import { cwdOf } from "./providers/procs";
import type { NightlyReclaim, Session } from "./types";
import { repoCheckoutPathFor, scanWorktrees } from "./worktrees";

/**
 * The safe reclaim, every night at 3am, for the human who turned it on
 * (`reclaimNightly`).
 *
 * It removes what the Disk card's "Delete safe" would (`verdictFor`), less
 * anything that moved in the last day or that a process is sitting in: a
 * worktree an agent cut an hour ago is clean and holds nothing its base branch
 * lacks, and the board only knows about the sessions agentbox can see.
 *
 * Paced, because a few hundred removals at once floor the machine: the scan
 * runs two directories at a time, each removal runs alone at idle CPU and disk
 * priority with a pause after it, and the sweep waits while the machine is
 * busy. It gives up at `DEADLINE_MS` rather than run into the working day; the
 * next night carries on.
 */

const HOUR = 3;
/** A worktree whose HEAD moved more recently than this is somebody's. */
const QUIET_MS = 24 * 3_600_000;
const PAUSE_MS = 3_000;
const BUSY_WAIT_MS = 15_000;
const DEADLINE_MS = 4 * 3_600_000;
const KV = "nightly.reclaim";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Busy is more runnable work than twice the cores: the agents' own test runs
 *  hold this machine near that all day, so anything lower never finds a gap. */
const busy = () => loadavg()[0]! > 2 * cpus().length;

/** The working directory of every process, for "is anything sitting in here". */
function processCwds(): string[] {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((e) => /^\d+$/.test(e));
  } catch {
    return [];
  }
  return pids.flatMap((pid) => cwdOf(Number(pid)) ?? []);
}

const inside = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

export function lastNightlyReclaim(): NightlyReclaim | null {
  return getKv<NightlyReclaim>(KV);
}

/** One sweep. `sessions` is asked again before every removal: a session may
 *  have started in a worktree since the scan. */
export async function reclaimNightly(sessions: () => Session[]): Promise<NightlyReclaim> {
  const startedAt = Date.now();
  const out: NightlyReclaim = { startedAt, finishedAt: 0, removed: 0, bytesFreed: 0, kept: 0, failed: [], cutShort: false };
  const scan = await scanWorktrees("all", sessions(), { sizes: false, concurrency: 2 });
  const safe = scan.items.filter((w) => w.verdict.safe && !w.missing);

  for (const item of safe) {
    while (busy() && Date.now() - startedAt < DEADLINE_MS) await sleep(BUSY_WAIT_MS);
    if (Date.now() - startedAt >= DEADLINE_MS) {
      out.cutShort = true;
      break;
    }

    const moved = await headMovedAt(item.path);
    const inUse =
      sessions().some((s) => (s.cwd === item.path || s.worktree === item.path) && (s.host !== "none" || s.parkedAt !== null)) ||
      processCwds().some((cwd) => inside(item.path, cwd)) ||
      // An orphan may not be a git checkout at all: nothing to read is not "recent".
      (moved !== null && Date.now() - moved < QUIET_MS) ||
      (await isDirty(item.path));
    if (inUse) {
      out.kept++;
      continue;
    }

    const bytes = await diskBytesOf(item.path);
    const r = await removeWorktreeIdly(item.repoId ? (repoCheckoutPathFor(item.repoId) ?? item.path) : item.path, item.path);
    if ((await diskBytesOf(item.path)) > 0) {
      out.failed.push({ path: item.path, error: r.stderr.split("\n")[0]?.trim() || `git exited with code ${r.code}` });
    } else {
      out.removed++;
      out.bytesFreed += bytes;
    }
    await sleep(PAUSE_MS);
  }

  out.finishedAt = Date.now();
  setKv(KV, out);
  return out;
}

/** The next 3am on this machine's clock. */
function nextRun(now = new Date()): Date {
  const at = new Date(now);
  at.setHours(HOUR, 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

/** Sweep at every 3am the server is up for. A night it was down for is not made up. */
export function startNightlyReclaim(sessions: () => Session[]): void {
  const arm = () => {
    setTimeout(async () => {
      try {
        if (getSettings().reclaimNightly) {
          const r = await reclaimNightly(sessions);
          console.log(
            `agentbox: nightly reclaim removed ${r.removed} worktrees (${Math.round(r.bytesFreed / 2 ** 30)} GB), kept ${r.kept} in use, ${r.failed.length} failed${r.cutShort ? ", cut short at the deadline" : ""}`,
          );
        }
      } catch (e) {
        console.error("agentbox: nightly reclaim failed:", e);
      }
      arm();
    }, nextRun().getTime() - Date.now()).unref?.();
  };
  arm();
}
