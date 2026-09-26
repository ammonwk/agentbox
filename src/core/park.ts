/** Parking: stopping sessions nobody is using, and what counts as "using".
 *
 * An idle Claude process is not free. Measured on this machine with 82 of
 * them idle: 1–2% of a core each (the allocator's scavenger and GC threads,
 * plus a once-a-second poll of the worktree's git HEAD and `.claude.json`)
 * and ~240 MB each — 1.4 cores and 19.6 GB between them. After `parkIdleMin`
 * the prompt cache is cold anyway, so keeping the process costs that and buys
 * nothing: the fleet stops it (`Fleet.parkIdle`), the board keeps showing it
 * as waiting on you, and the next message — from the web, the CLI or the
 * fleet MCP — resumes it with that message as the prompt.
 *
 * The hard part is "idle". A session whose turn is over can still be doing
 * work that will wake it: a background command, a subagent, a `/loop`
 * wakeup, a cron job, a teammate. Stopping the process kills all of that, so
 * each is a *hold* — a reason, in words, why the session stays up. This file
 * decides the holds; the fleet gathers the inputs and does the stopping.
 *
 * Not every background process is work. A `tail -f`, an infinite poll loop
 * or a dev server never finishes, so it never wakes the session either; left
 * as holds they would keep a session up until the machine reboots. Followers
 * and endless loops hold nothing; servers hold for `SERVICE_GRACE_MS`, since
 * you may be using one in a browser. Everything else is work and holds for as
 * long as it runs, with no cap: the first dry run found three `--prod` repair
 * scripts twenty hours in under a session silent for thirteen, and a stuck
 * command costing 2% of a core is cheap next to killing one of those.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

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
/** A subagent that wrote to its transcript this recently is still working;
 *  long, because one large generation (a big Write, long thinking) writes
 *  nothing until it ends. */
export const SUBAGENT_QUIET_MS = 30 * 60_000;
/** A `/loop` wakeup this overdue is taken to have fired (or died). Wakeups
 *  land late on a loaded machine; the turn they start is activity anyway. */
export const WAKE_GRACE_MS = 10 * 60_000;
/** A one-shot cron job whose fire time cannot be read is given this long. */
export const ONE_SHOT_MAX_MS = 24 * 3_600_000;

// ---------------------------------------------------------------- shells

export type ShellKind = "work" | "service" | "follower";

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

/** What may sit downstream of a follower without making it finite. */
const FILTER = /(^|\/)(grep|egrep|rg|awk|sed|cat|tee|jq|cut|tr)\b/;
/** ...unless it quits on a match, which is a completion waiter. */
const QUITS = /\bgrep\b.*\s(-[a-zA-Z]*[mq]|--max-count|--quiet)|\bsed\b.*q['"]?(\s|$)|\bawk\b.*\bexit\b|(^|[\s\/|])head\b|\brg\b.*\s(-m|--max-count)/;

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
  if (SERVICES.some((re) => re.test(command)) || sshTunnel(command)) return "service";
  if (QUITS.test(command)) return "work";
  const live = running.length ? running : [command];
  // An endless loop only waits between rounds; while a round runs anything
  // but sleeps and followers, it is doing something (`while true; do bun
  // backfill.ts --prod; sleep 5; done` mid-batch).
  if (endlessLoop(command)) return live.every(idleProcess) ? "follower" : "work";
  if (live.every(idleProcess) && live.some((c) => FOLLOWERS.some((re) => re.test(c)))) return "follower";
  return "work";
}

/** The hold a background shell puts on its session, or null for none. */
export function shellHold(kind: ShellKind, label: string, quietMs: number): string | null {
  if (kind === "follower") return null;
  if (kind === "service") {
    return quietMs < SERVICE_GRACE_MS ? `a server is running (${label}); it is stopped with the session after ${hours(SERVICE_GRACE_MS)} quiet` : null;
  }
  return `a background command is running (${label})`;
}

/** Collapse whitespace, for matching a live shell to the Monitor call that
 *  started it. */
export function normalCommand(c: string): string {
  return c.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- timers

/**
 * What a Claude session set up to wake itself, read from its transcript:
 * `ScheduleWakeup` (dynamic `/loop`) and `CronCreate` are timers inside the
 * process with no child to find, and `Monitor` commands are shells whose
 * every line of output is a message to the session — the one kind of
 * never-ending loop that is work.
 *
 * Read incrementally, in chunks with a yield between them (a first read can
 * be tens of megabytes), and only the lines that mention one of the tools are
 * parsed. An idle session's transcript does not grow, so after the first
 * read a check costs one stat.
 */
export class WakeScan {
  private offset = 0;
  private wakeDue: number | null = null;
  private crons = new Map<string, { until: number }>();
  /** Every command a Monitor call started, whitespace-collapsed. */
  readonly monitors = new Set<string>();

  constructor(private readonly path: string) {}

  /** Why the session must stay up to be woken, or null. */
  async hold(now: number): Promise<string | null> {
    await this.read();
    if (this.wakeDue !== null && this.wakeDue > now - WAKE_GRACE_MS) {
      return `a /loop wakeup is due ${this.wakeDue > now ? `in ${minutes(this.wakeDue - now)}` : "now"}`;
    }
    for (const [id, c] of this.crons) if (c.until > now) return `cron job ${id} is scheduled`;
    return null;
  }

  private async read(): Promise<void> {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // Rewritten from scratch: start over.
      this.offset = 0;
      this.wakeDue = null;
      this.crons.clear();
      this.monitors.clear();
    }
    if (size === this.offset) return;
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return;
    }
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
        if (cut !== -1) this.scan(text.slice(0, cut));
        await Bun.sleep(0);
      }
      // An unfinished last line is read again next time.
      this.offset -= Buffer.byteLength(carry);
    } finally {
      closeSync(fd);
    }
  }

  /** Parse the lines of `text` that mention a tool of interest, in order. */
  private scan(text: string): void {
    const starts = new Set<number>();
    for (const marker of MARKERS) {
      for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + marker.length)) {
        starts.add(text.lastIndexOf("\n", i) + 1);
      }
    }
    for (const start of [...starts].sort((a, b) => a - b)) {
      const end = text.indexOf("\n", start);
      this.line(text.slice(start, end === -1 ? undefined : end));
    }
  }

  private line(line: string): void {
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    const at = typeof r?.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    // The CronCreate result: `toolUseResult: {id, humanSchedule, recurring}`,
    // and the text says how long a recurring job lives.
    const tur = r?.toolUseResult;
    if (tur && typeof tur.id === "string" && typeof tur.humanSchedule === "string" && Number.isFinite(at)) {
      const text = JSON.stringify(r.message?.content ?? "");
      if (tur.recurring) {
        const days = Number(/expires after (\d+) days?/i.exec(text)?.[1] ?? 7);
        this.crons.set(tur.id, { until: at + days * 86_400_000 });
      } else {
        this.crons.set(tur.id, { until: oneShotFire(tur.humanSchedule, at) + WAKE_GRACE_MS });
      }
      return;
    }
    const content = r?.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "ScheduleWakeup") {
        const delay = Number(b.input?.delaySeconds);
        this.wakeDue = b.input?.stop || !Number.isFinite(at) || !Number.isFinite(delay) ? null : at + delay * 1000;
      } else if (b.name === "CronDelete") {
        this.crons.delete(String(b.input?.id ?? ""));
      } else if (b.name === "Monitor" && typeof b.input?.command === "string") {
        this.monitors.add(normalCommand(b.input.command));
      }
    }
  }
}

const MARKERS = ['"ScheduleWakeup"', '"humanSchedule"', '"CronDelete"', '"name":"Monitor"'];

/**
 * When a one-shot cron job fires: its minute, hour, day and month are fixed
 * numbers (that is how Claude writes "tomorrow at 9"), in local time, at the
 * first such moment after it was set. Anything else is given a day.
 */
export function oneShotFire(cron: string, setAt: number): number {
  const f = cron.trim().split(/\s+/);
  const [min, hour, dom, mon] = f.map(Number);
  if (f.length < 5 || ![min, hour, dom, mon].every((x) => Number.isInteger(x))) return setAt + ONE_SHOT_MAX_MS;
  const set = new Date(setAt);
  for (const year of [set.getFullYear(), set.getFullYear() + 1]) {
    const t = new Date(year, mon! - 1, dom!, hour!, min!).getTime();
    if (t >= setAt - 60_000) return t;
  }
  return setAt + ONE_SHOT_MAX_MS;
}

// ---------------------------------------------------------------- subagents

/**
 * When a Claude session's in-process subagents last wrote anything:
 * `<transcript dir>/<session id>/subagents/**.jsonl`. Background agents and
 * workflows run inside the session's process and leave no child to find, but
 * they write as they work. Null when it has none.
 */
export function subagentsLastWrite(transcriptPath: string, agentSessionId: string): number | null {
  const root = join(transcriptPath.slice(0, transcriptPath.lastIndexOf("/")), agentSessionId, "subagents");
  let newest: number | null = null;
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
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
  walk(root, 0);
  return newest;
}

// ---------------------------------------------------------------- omp

/**
 * Is this subagent-MCP status line (src/subagents/pool.ts `renderAgentLine`)
 * an agent at work? The other kind is a finished agent whose answer nobody
 * collected — worth showing, but nothing will come of keeping its caller up;
 * those were holding sessions for twenty hours.
 */
export function ompWorking(text: string): boolean {
  return !/ · finished\b.*\bUNCOLLECTED\b/.test(text);
}

// ---------------------------------------------------------------- words

export function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 120 ? `${m}m` : `${Math.round(m / 60)}h`;
}

function hours(ms: number): string {
  return `${Math.round(ms / 3_600_000)}h`;
}
