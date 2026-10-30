/** Parking: stopping sessions nobody is using, and what counts as "using".
 *
 * An idle agent process is not free. Measured on this machine with 82 Claude
 * processes idle: 1–2% of a core each (the allocator's scavenger and GC
 * threads, plus a once-a-second poll of the worktree's git HEAD and
 * `.claude.json`) and ~240 MB each — 1.4 cores and 19.6 GB between them; 64
 * idle omp sessions held ~29 GB with their MCP servers. After `parkIdleMin`
 * the prompt cache is cold anyway, so keeping the process costs that and buys
 * nothing: the fleet stops it (`Fleet.parkIdle`), the board keeps showing it
 * as waiting on you, and the next message — from the web, the CLI or the
 * fleet MCP — resumes it with that message as the prompt.
 *
 * The hard part is "idle". A session whose turn is over can still be doing
 * work that will wake it: a background command or job, a subagent, a `/loop`
 * wakeup, a cron job, a teammate. Stopping the process kills all of that, so
 * each is a *hold* — a reason, in words, why the session stays up. This file
 * decides the holds; the fleet gathers the inputs and does the stopping.
 *
 * Not every background process is work. A `tail -f`, an infinite poll loop
 * or a dev server never finishes, so it never wakes the session either; left
 * as holds they would keep a session up until the machine reboots. Followers
 * and endless loops hold nothing; servers hold for `SERVICE_GRACE_MS`, since
 * you may be using one in a browser. Everything else is work and holds for as
 * long as it uses any CPU at all: the first dry run found three `--prod`
 * repair scripts twenty hours in under a session silent for thirteen, and a
 * slow command costing 2% of a core is cheap next to killing one of those. One
 * whose processes have not used a single clock tick in `STUCK_WORK_MS` is hung,
 * not slow: xyiskn7f's `_owed57-observe.ts --prod` stopped writing its log on
 * 2026-10-10 and held its finished session up for six and a half days.
 *
 * A session whose turn ended `STATUS: done` (the last line the fleet's rules
 * ask every turn to end on) is parked after `DONE_IDLE_MS` rather than
 * `parkIdleMin`, warm cache or not. Of 1,303 such turns from 2026-10-10 to
 * 10-17, 69% were never followed by another and 5% by real work (a push, a
 * merge, a production run), mostly a steward finding on a PR already
 * landed; a cold resume for those costs less than a process each for the
 * other 95%. A session you pinned is the exception (an extension pins the
 * conversation it keeps): its next message is coming, and keeping its cache
 * warm is the point.
 *
 * A provider whose cache outlives its process (`ProviderAdapter.parkIdleMs`)
 * is parked after that long instead, warm or not: nothing the process holds
 * is worth keeping it up for once it has cost what a resume does.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Wake } from "./providers/types";

export { endedDone } from "./turnstatus";

/** How often the fleet looks for sessions to park. */
export const PARK_CHECK_MS = 60_000;
/** Nothing is parked this soon after the server starts: the first passes are
 *  still reading transcripts, and a hold not yet seen is a hold missed. */
export const PARK_STARTUP_MS = 5 * 60_000;
/** A dev server or tunnel keeps its session up this long after the
 *  conversation goes quiet. */
export const SERVICE_GRACE_MS = 4 * 3_600_000;
/**
 * A turn this quiet is over, whatever the CLI says. Claude's own status file
 * can say "busy" for a day and more — a lead with teammates, or one parked on
 * a limit dialog — while nothing happens. Real work is never this silent:
 * a foreground tool is a child process (a hold of its own), a subagent writes
 * its transcript, a teammate its own, and a model reply lands in minutes.
 */
export const STALE_TURN_MS = 2 * 3_600_000;
/** A background command that has only been sleeping between checks keeps
 *  its session up this long after the conversation goes quiet. Anything it
 *  was waiting on has had a day; one still polling is taken to be stuck. */
export const POLL_MAX_MS = 24 * 3_600_000;
/** A subagent that wrote to its transcript this recently is still working;
 *  long, because one large generation (a big Write, long thinking) writes
 *  nothing until it ends. */
export const SUBAGENT_QUIET_MS = 30 * 60_000;
/** A background command none of whose processes has used any CPU for this
 *  long is hung (a connection nobody closes, a promise nobody settles) and
 *  holds nothing. Counted from when this server first saw it still, so a
 *  restart starts the count over. */
export const STUCK_WORK_MS = 24 * 3_600_000;
/** How soon a session whose turn ended `STATUS: done` is parked. */
export const DONE_IDLE_MS = 60_000;
/** A wake this overdue is taken to have fired (or died). Wakeups land late
 *  on a loaded machine; the turn they start is activity anyway. */
export const WAKE_GRACE_MS = 10 * 60_000;

// ---------------------------------------------------------------- shells

export type ShellKind = "work" | "poller" | "service" | "follower";

/**
 * The command a shell tool call is running, without the wrapper.
 *
 * Claude Code runs `bash -c source <snapshot> … && eval '<command>' < /dev/null
 * && pwd -P >| <file>`; other shells are `sh -c <command>`. The quoting is
 * undone only as far as `'"'"'`, which is how the wrapper embeds a quote.
 */
export function shellCommand(cmd: string): string {
  const at = cmd.indexOf("eval '");
  if (at !== -1) {
    const body = cmd.slice(at + 6);
    // The wrapper closes with `' < /dev/null && pwd -P >| <file>` (older
    // versions without the redirect); the last such is the end of the command.
    const ends = [...body.matchAll(/'\s*(?:<\s*\/dev\/null\s*)?&& pwd -P/g)];
    const end = ends.at(-1)?.index;
    return (end === undefined ? body.replace(/'\s*$/, "") : body.slice(0, end)).replaceAll(`'"'"'`, "'");
  }
  return /\s-[a-z]*c[a-z]*\s+(.+)$/s.exec(cmd)?.[1] ?? cmd;
}

/**
 * Processes that only ever wait for more output. Deliberately narrow: a
 * follower that is really waiting for something to finish (`tail -f log |
 * grep -m1 done`, `tail --pid`, `watch -g`, `kubectl logs -f job/x`) is work
 * — it ends when the job does, and the session is waiting to hear that.
 */
const FOLLOWERS: RegExp[] = [
  /(^|\/)tail\b(?=.*\s(-[a-zA-Z]*[fF]\b|--follow\b))(?!.*--pid\b)/,
  /(^|\/)journalctl\b(?=.*\s(-f\b|--follow\b))/,
  /\baws logs tail\b(?=.*--follow\b)/,
  /(^|\/)watch\s(?!(.*\s)?-[a-zA-Z]*[ge]\b)(?!.*--(chgexit|errexit)\b)/,
  /(^|\/)sleep (inf|infinity)\b/,
  /(^|\/)less\b.*\s\+F\b/,
];

/** What may sit downstream of a follower without making it finite. (Claude
 *  Code's shell runs `grep` as `ugrep`.) */
const FILTER = /(^|\/)(u?grep|egrep|rg|awk|sed|cat|tee|jq|cut|tr)\b/;
/** ...unless it quits on a match, which is a completion waiter. */
const QUITS = /\bu?grep\b.*\s(-[a-zA-Z]*[mq]|--max-count|--quiet)|\bsed\b.*q['"]?(\s|$)|\bawk\b.*\bexit\b|(^|[\s\/|])head\b|\brg\b.*\s(-m|--max-count)/;

/**
 * Commands that serve until killed: you may be using one, but it never
 * finishes and wakes the session. Judged on the command the agent ran, never
 * on what it started (a test runner's web server is not a dev server), and
 * anchored at argument boundaries (`pnpm run dev:migrate --prod` is work).
 */
const END = "(?=\\s|$|[;&|)])";
const SERVICES: RegExp[] = [
  new RegExp(`(^|[\\s/;&|(])vite${END}(?!.*\\b(build|optimize)\\b)`),
  new RegExp(`\\bnext (dev|start)${END}`),
  /\bnodemon\b/,
  new RegExp(`\\btsx watch${END}`),
  /\b(bun|node|deno)\b[^;&|]*\s--(watch|hot)\b/,
  /\bwebpack(-dev-server\b| serve\b)/,
  new RegExp(`\\b(npm|pnpm|yarn|bun)( run)? (dev|start|serve|watch|preview)${END}`),
  /\btsc\b[^;&|]*\s(-w|--watch)\b/,
  /\b(jest|vitest)\b[^;&|]*\s--watch(All)?\b/,
  /\bngrok\b/,
  /\bcloudflared\b[^;&|]*\btunnel\b/,
  /\bkubectl port-forward\b/,
  /\bhttp\.server\b/,
  /\bdocker compose up\b(?![^;&|]*\s(-d|--detach|--exit-code-from|--abort-on-container-exit)\b)/,
  /\bstripe listen\b/,
];

/** An ssh that only forwards ports: `-N`, or `-L`/`-R`/`-D` with no remote
 *  command. Flags are read only up to the host — `ssh prod 'curl -L …'` is
 *  a remote command, not a tunnel. */
function sshTunnel(command: string): boolean {
  for (const m of command.matchAll(/(?:^|[\s;&|(])ssh\s+([^;&|]*)/g)) {
    const words = m[1]!.trim().split(/\s+/);
    let forwards = false;
    let i = 0;
    for (; i < words.length && words[i]!.startsWith("-"); i++) {
      const w = words[i]!;
      if (/N/.test(w)) return true;
      if (/[LRD]/.test(w)) forwards = true;
      // Flags that take an argument, when it is not glued on.
      if (/^-[a-zA-Z]*[bcDEeFIiJLlmOoPpQRSWw]$/.test(w)) i++;
    }
    // words[i] is the host; anything after it is a remote command.
    if (forwards && i >= words.length - 1) return true;
  }
  return false;
}

/** A loop with no way out: `while true` / `while :` / `for ((;;))` and no
 *  `break`, `exit`, `return` or `kill` anywhere in the command. */
function endlessLoop(command: string): boolean {
  if (!/\bwhile\s+(true|:)\s*;?\s*do\b|\bfor\s*\(\(\s*;\s*;\s*\)\)/.test(command)) return false;
  return !/\b(break|exit|return|p?kill)\b/.test(command);
}

/** Only waiting: a sleep, a follower, or a filter behind one. */
function idleProcess(c: string): boolean {
  return /(^|\/)sleep\s/.test(c) || FOLLOWERS.some((re) => re.test(c)) || (FILTER.test(c) && !QUITS.test(c));
}

/** A narrow, provably stuck waiter seen in real sessions: pgrep -f also
 * matches its parent shell's command line. These literal patterns occur in
 * that command verbatim; dots match themselves too. A sole sleep body has
 * no way out. Do not generalize to regex tricks ([r]un), filtered pgrep,
 * alternate conditions, or loop bodies doing real work. */
function selfMatchingWaiter(command: string): boolean {
  const loop = /^\s*until\s+([^;\n]+);\s*do\s+sleep\s+\d+(?:\.\d+)?\s*;\s*done\b/.exec(command);
  if (!loop) return false;
  return /^(?:\[\s+-[esf]\s+[\w./-]+\s*\]\s*&&\s*)?!\s*pgrep\s+-f\s+(["'])[\w./ :][\w./ :\-]*\1\s*(?:>\s*\/dev\/null\s*(?:2>&1\s*)?)?$/.test(loop[1]!.trim());
}

/**
 * What a background shell is: `work` (it will finish, and the session wants
 * to hear about it), `service` (serves until killed) or `follower` (can only
 * ever wait). `command` is what the agent ran; `running` are the command
 * lines of its live descendants other than bare shells, which say what it is
 * doing *now* — `sleep 1800; ./check.sh` is work while it sleeps.
 *
 * When unsure, work: a wrong "work" costs a session's 2% of a core for a
 * while, a wrong "follower" kills a job.
 */
export function classifyShell(command: string, running: string[]): ShellKind {
  // Only while it is actually waiting: a descendant doing anything else is
  // protected as work, even if it came from a malformed waiter.
  if (selfMatchingWaiter(command) && running.every((c) => /(^|\/)sleep\s/.test(c) || /^(?:\S*\/)?pgrep\s+-f\s/.test(c))) return "follower";
  if (SERVICES.some((re) => re.test(command)) || sshTunnel(command)) return "service";
  // Waiting on something outside it — a PR, a file, a remote job. Work, but
  // a poll whose condition cannot come true (`until ! pgrep -f x` matches
  // its own command line) looks exactly like this forever.
  if (running.length > 0 && running.every((c) => /(^|\/)sleep\s(?!inf)/.test(c)) && !endlessLoop(command)) return "poller";
  if (QUITS.test(command)) return "work";
  const live = running.length ? running : [command];
  // An endless loop only waits between rounds; while a round runs anything
  // but sleeps and followers, it is doing something (`while true; do bun
  // backfill.ts --prod; sleep 5; done` mid-batch).
  if (endlessLoop(command)) return live.every(idleProcess) ? "follower" : "work";
  if (live.every(idleProcess) && live.some((c) => FOLLOWERS.some((re) => re.test(c)))) return "follower";
  return "work";
}

/** The hold a background shell puts on its session, or null for none.
 *  `stillMs` is how long its processes have used no CPU (`ShellStillness`). */
export function shellHold(kind: ShellKind, label: string, quietMs: number, stillMs = 0): string | null {
  if (kind === "follower") return null;
  if (kind === "service") {
    return quietMs < SERVICE_GRACE_MS ? `a server is running (${label}); it is stopped with the session after ${hours(SERVICE_GRACE_MS)} quiet` : null;
  }
  if (kind === "poller") {
    return quietMs < POLL_MAX_MS ? `a background command is waiting (${label})` : null;
  }
  return stillMs < STUCK_WORK_MS ? `a background command is running (${label})` : null;
}

/**
 * When each background shell's processes last used CPU, across the checks
 * that look at them. Keyed by pid and start time, so a recycled pid starts
 * over; the subtree's ticks (`subtreeCpuTicks`) moving at all, either way,
 * counts as use.
 */
export class ShellStillness {
  private seen = new Map<string, { ticks: number; movedAt: number }>();

  /** How long the shell `key` has sat on `ticks`, as of `now`. */
  still(key: string, ticks: number, now: number): number {
    const was = this.seen.get(key);
    if (!was || was.ticks !== ticks) {
      this.seen.set(key, { ticks, movedAt: now });
      return 0;
    }
    return now - was.movedAt;
  }

  /** Forget shells for which `alive` says no. */
  prune(alive: (key: string) => boolean): void {
    for (const key of this.seen.keys()) if (!alive(key)) this.seen.delete(key);
  }
}

/** Collapse whitespace, for matching a live shell to the Monitor call that
 *  started it. */
export function normalCommand(c: string): string {
  return c.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- wakes

/**
 * Why the session must stay up to be woken (TranscriptFacts.wakes), or null.
 * `since` is when the running process started: what was set going before it
 * died with the process that set it, durable cron jobs aside. One that runs
 * until it reports back is given `POLL_MAX_MS`: a transcript cannot show that
 * it was killed.
 */
export function wakeHold(wakes: readonly Wake[] | undefined, now: number, since: number): string | null {
  for (const w of wakes ?? []) {
    if (!w.durable && w.setAt < since) continue;
    if (w.until === null ? now - w.setAt < POLL_MAX_MS : w.until > now - WAKE_GRACE_MS) return `${w.label} will wake it`;
  }
  return null;
}

// ---------------------------------------------------------------- subagents

/** When anything under `dir` (an adapter's `subagentLogDir`) was last
 *  written, or null when there is nothing there. */
export function lastWriteUnder(dir: string): number | null {
  let newest: number | null = null;
  const walk = (d: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) {
          if (depth < 3) walk(p, depth + 1);
        } else if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* gone between the listing and the stat */
      }
    }
  };
  walk(dir, 0);
  return newest;
}

// ---------------------------------------------------------- subagents

/**
 * Is this subagent-MCP status line (src/subagents/pool.ts `renderAgentLine`)
 * an agent at work? The other kind is a finished agent whose answer nobody
 * collected — worth showing, but nothing will come of keeping its caller up;
 * those were holding sessions for twenty hours.
 */
export function subagentWorking(text: string): boolean {
  return !/ · finished\b.*\bUNCOLLECTED\b/.test(text);
}

// ---------------------------------------------------------------- stranded

/** A session sitting on notifications Claude never delivered (TranscriptFacts
 *  `stranded`) is told about them after this long quiet: inside the hour its
 *  prompt cache lasts, and before it would be parked. */
export const STRANDED_NUDGE_MS = 55 * 60_000;
/** ...or this long before parking, where `parkIdleMin` is set shorter. */
const STRANDED_LEAD_MS = 5 * 60_000;

/** How long a session with stranded notifications is left quiet before the
 *  nudge. Never under a minute: a notification is queued a moment before it
 *  is taken. */
export function strandedNudgeAfter(parkIdleMin: number): number {
  if (!parkIdleMin) return STRANDED_NUDGE_MS;
  return Math.max(60_000, Math.min(STRANDED_NUDGE_MS, parkIdleMin * 60_000 - STRANDED_LEAD_MS));
}

/** The limit hit the session's last try at a turn stopped on, with no answer
 *  since, or null. A notification lines up behind the limit like anything
 *  else, and telling the session about it only meets the limit again: Claude
 *  does not retry on its own. The newest model call, not the newest line:
 *  the board's `limitHit`, and so the move off the account
 *  (`Fleet.continueStalled`), read a hit as answered once any line followed
 *  it by a minute, and a session waiting on CI gets a monitor event every few
 *  minutes. Where the provider's transcript does not say when the model last
 *  answered, the hit has to be the session's last word. Whether that limit
 *  still stands is the account's usage to say (`Fleet.limitEnd`). */
export function limitStop<H extends { at: number }>(facts: { rateLimitHits?: H[]; lastTurnAt?: number | null; lastActivityAt?: number | null }): H | null {
  const hit = facts.rateLimitHits?.at(-1);
  if (!hit) return null;
  if (facts.lastTurnAt != null) return hit.at > facts.lastTurnAt ? hit : null;
  return hit.at >= (facts.lastActivityAt ?? 0) - 60_000 ? hit : null;
}

const STRANDED_NUDGE_HEAD = "[agentbox: ";
const STRANDED_NUDGE_MARK = "finished while this session was idle, and the notification never woke it:";

/** Is this prompt the nudge? The transcript is the record that a session was
 *  told: a restarted server reads it there instead of nudging again. */
export function isStrandedNudge(prompt: string): boolean {
  return prompt.startsWith(STRANDED_NUDGE_HEAD) && prompt.includes(STRANDED_NUDGE_MARK);
}

/** The nudge: what finished, and where its output is, since the notification
 *  itself may never arrive. */
export function strandedNudge(notes: { text: string }[]): string {
  const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? null;
  const lines = notes.map((n) => {
    const file = tag(n.text, "output-file");
    return `- ${tag(n.text, "summary") ?? "A background task finished"}${file ? ` (output: ${file})` : ""}`;
  });
  return `${STRANDED_NUDGE_HEAD}${notes.length === 1 ? "a background task" : `${notes.length} background tasks`} ${STRANDED_NUDGE_MARK}\n${lines.join("\n")}\nCarry on with what was waiting on ${notes.length === 1 ? "it" : "them"}; a teammate that started one is still idle and will not act unless you tell it.]`;
}

// ---------------------------------------------------------------- words

export function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function hours(ms: number): string {
  return `${Math.round(ms / 3_600_000)}h`;
}
