/**
 * Starts scheduled sessions when their time comes (the rules: schedule.ts).
 *
 * A one-time schedule starts under its own id and is then gone: the session
 * it became is the record. A recurring one starts a new session each time and
 * stays, for Settings to pause, edit or delete.
 *
 * Checked every 15 seconds. A start missed while the server was down happens
 * once when it is back — late rather than never — and a recurring schedule
 * then carries on from now instead of catching up on every run it missed.
 *
 * "When PR 6644 merges" is a one-time one with no time: its PR is looked up in
 * the PR copy (prs.ts, synced from GitHub once a minute) and it starts when
 * that says merged — and, for a new worktree, once the merge is in the
 * `origin/<default>` it will be cut from, so the session has it in its history.
 * GitHub is asked directly only once, when the rule is made.
 *
 * "Whenever CD on staging is red" is recurring with no time either: the
 * workflow's runs are read every two minutes, and a session starts for each
 * red streak (redwatch.ts), told which runs failed.
 *
 * A timed recurring one may have a note command and may keep to one session
 * (`Schedule.noteCmd`, `sameSession`; `come` below). The command runs each
 * time it comes due and what it prints goes before the prompt; when it prints
 * nothing, nothing happens. Keeping to one session, the note is typed into the
 * session the schedule started last, so its prompt cache stays warm between
 * notes, until that one is gone or has grown past `freshOver`: then a new one
 * takes over and the old one is closed, so it never becomes one huge cold
 * context. A session mid-turn is never typed into or closed: that time is
 * skipped, and the command says what is still true the next time.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { deleteSchedule, getPr, getRepoById, getSchedule, getSessionRecord, insertSchedule, listSchedules, updateSchedule } from "./db";
import { FleetError, newSessionId, type Fleet } from "./fleet";
import { isGitRepo, repoCheckoutPath, repoFullNameOf } from "./git";
import { defaultBranch, findWorkflow, readRuns, redNote, redStreak } from "./redwatch";
import { describeRule, FRESH_OVER, isRecurring, nextRun, onEvent, parseWhen, type ScheduleRule } from "./schedule";
import { scheduleSentMark } from "./sent";
import type { Schedule, ScheduleSpec, Session } from "./types";

const TICK_MS = 15_000;
/** How often a PR waited on is looked at: the copy it reads syncs once a
 *  minute, and a merge not yet in origin costs a `git fetch` each time. */
const MERGE_CHECK_MS = 60_000;
/** How often a workflow waited on to go red is read: a `gh run list` each. */
const RED_CHECK_MS = 2 * 60_000;
/** No account had room: try again this much later. */
const RETRY_MS = 10 * 60_000;
/** Below this a session is over the size at its first prompt, and every note
 *  would start another. */
const FRESH_OVER_MIN = 20_000;
/** How long a note command may take. */
const NOTE_TIMEOUT_S = 120;
/** How much of what it prints is said: it is typed into a session. */
const NOTE_MAX = 16_000;

/** What a note command or a one-session schedule did when it came due: the
 *  session spoken to or started, or why there is none this time. */
type Came = { sessionId: string } | { quiet: string };

export interface ScheduleEdit {
  /** Plain words, as for a new one. */
  when?: string;
  prompt?: string;
  label?: string | null;
  enabled?: boolean;
  /** Run in this registered repo instead. */
  repoId?: string;
  /** Null or "" takes it away. */
  noteCmd?: string | null;
  sameSession?: boolean;
  freshOver?: number | null;
}

/** What a new schedule may say beyond when and what. */
export interface ScheduleExtras {
  noteCmd?: string | null;
  sameSession?: boolean;
  freshOver?: number | null;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private mergesCheckedAt = 0;
  private redsCheckedAt = 0;
  /** A red one whose session did not start: not tried again before this. */
  private redHeldUntil = new Map<string, number>();
  /** Schedules whose note command is running, or whose note is being said. */
  private coming = new Set<string>();

  constructor(
    private readonly fleet: Fleet,
    /** Something changed that the app state shows. */
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async create(input: { when: string; spec: ScheduleSpec; label?: string | null } & ScheduleExtras): Promise<Schedule> {
    checkSpec(input.spec);
    const now = this.now();
    const rule = await settle(parse(input.when, now), input.spec);
    const extras = { noteCmd: input.noteCmd?.trim() || null, sameSession: input.sameSession === true, freshOver: input.freshOver ?? null };
    checkExtras(rule, input.spec, extras);
    const s: Schedule = {
      id: freshId(),
      rule,
      spec: input.spec,
      label: input.label?.trim() || null,
      enabled: true,
      nextAt: nextRun(rule, now),
      createdAt: now,
      lastRunAt: null,
      lastSessionId: null,
      lastError: null,
      ...extras,
    };
    insertSchedule(s);
    this.changed();
    return s;
  }

  async update(id: string, edit: ScheduleEdit): Promise<Schedule> {
    const s = this.get(id);
    const now = this.now();
    const patch: Partial<Schedule> = {};
    let spec = s.spec;
    if (edit.prompt !== undefined) spec = { ...spec, prompt: edit.prompt.trim() || undefined };
    if (edit.repoId !== undefined && edit.repoId !== spec.repoId) {
      // The same kind of checkout there: a worktree stays a worktree. A branch
      // or PR named for the old repo means nothing in the new one.
      spec = { ...spec, repoId: edit.repoId, cwd: undefined, branch: undefined, pr: undefined, worktree: spec.worktree || !!spec.branch };
      checkSpec(spec);
    }
    if (spec !== s.spec) patch.spec = spec;
    if (edit.when !== undefined) patch.rule = await settle(parse(edit.when, now), spec);
    if (edit.label !== undefined) patch.label = edit.label?.trim() || null;
    if (edit.noteCmd !== undefined) patch.noteCmd = edit.noteCmd?.trim() || null;
    if (edit.sameSession !== undefined) patch.sameSession = edit.sameSession;
    if (edit.freshOver !== undefined) patch.freshOver = edit.freshOver;
    const enabled = edit.enabled ?? s.enabled;
    const rule = patch.rule ?? s.rule;
    checkExtras(rule, spec, { ...s, ...patch });
    // A new time, or switching it back on, is a fresh start: the last
    // failure is behind it.
    if (edit.when !== undefined || (edit.enabled === true && !s.enabled)) {
      patch.lastError = null;
      patch.enabled = enabled;
    } else if (edit.enabled !== undefined) patch.enabled = enabled;
    if (patch.rule || patch.enabled !== undefined) {
      const next = enabled ? nextRun(rule, now) : null;
      if (enabled && next === null && !onEvent(rule)) throw new FleetError(400, "That time has passed: give it a new one.");
      patch.nextAt = next;
    }
    updateSchedule(id, patch);
    this.changed();
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    deleteSchedule(id);
    this.changed();
  }

  /** Start it now. A one-time one is then done; a recurring one keeps its times. */
  async runNow(id: string): Promise<string> {
    const s = this.get(id);
    if (s.noteCmd || s.sameSession) {
      if (this.coming.has(id)) throw new FleetError(409, "it is at it right now: its note command is running");
      const came = await this.come(s, this.now(), true);
      if ("quiet" in came) throw new FleetError(409, came.quiet);
      return came.sessionId;
    }
    let note: string | undefined;
    if (s.rule.kind === "red") {
      // Told what it would have been told, red or not; unread, it finds out.
      note = await readRuns(s.rule).then(
        (runs) => redNote(s.rule as Extract<ScheduleRule, { kind: "red" }>, redStreak(runs, null), s.lastSessionId),
        () => undefined,
      );
    }
    const sid = await this.fire(s, this.now(), true, note);
    if (!sid) throw new FleetError(409, this.get(id).lastError ?? "it did not start");
    return sid;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const s of listSchedules()) {
        if (!s.enabled || s.nextAt === null || s.nextAt > now) continue;
        // Not waited for: its command may take a while, and the rest are due too.
        if (s.noteCmd || s.sameSession) void this.come(s, now, false).catch((e) => console.error(`agentbox: schedule ${s.id}:`, e));
        else await this.fire(s, now, false);
      }
      if (now - this.mergesCheckedAt >= MERGE_CHECK_MS) {
        this.mergesCheckedAt = now;
        await this.checkMerges(now);
      }
      if (now - this.redsCheckedAt >= RED_CHECK_MS) {
        this.redsCheckedAt = now;
        await this.checkReds(now);
      }
    } catch (e) {
      console.error("agentbox: scheduler:", e);
    } finally {
      this.ticking = false;
    }
  }

  /** Each PR waited on, looked up once. A retry already set (no account had
   *  room when it merged) is left to the clock. */
  private async checkMerges(now: number): Promise<void> {
    for (const s of listSchedules()) {
      if (!s.enabled || s.rule.kind !== "merge" || s.nextAt !== null) continue;
      const { pr, repo } = s.rule;
      if (!repo) continue;
      // Not in the copy yet: a repo only a merge rule tracks is loaded on the
      // next sync, and one GitHub will not show says so in the warnings.
      const got = getPr(repo, pr);
      if (!got) continue;
      const state: PrState = {
        state: got.state,
        title: got.title,
        baseRefName: got.baseRef,
        mergeCommit: got.mergeCommit ? { oid: got.mergeCommit } : null,
      };
      if (state.state === "MERGED") {
        const missing = await notYetIn(s.spec, state);
        if (missing) {
          if (s.lastError !== missing) {
            updateSchedule(s.id, { lastError: missing });
            this.changed();
          }
          continue;
        }
        await this.fire(s, now, false);
      } else if (state.state === "CLOSED") {
        updateSchedule(s.id, { enabled: false, lastError: `PR #${pr} was closed without merging` });
        this.changed();
      } else if (s.lastError) {
        updateSchedule(s.id, { lastError: null });
        this.changed();
      }
    }
  }

  /** Each workflow waited on, read once: a session for a new red streak. */
  private async checkReds(now: number): Promise<void> {
    for (const s of listSchedules()) {
      const rule = s.rule;
      if (!s.enabled || rule.kind !== "red" || !rule.repo || !rule.branch) continue;
      if ((this.redHeldUntil.get(s.id) ?? 0) > now) continue;
      let runs;
      try {
        runs = await readRuns(rule);
      } catch (e) {
        const message = `could not read the runs of ${rule.workflow} on ${rule.branch}: ${(e as Error).message}`;
        if (s.lastError !== message) {
          updateSchedule(s.id, { lastError: message });
          this.changed();
        }
        continue;
      }
      const streak = redStreak(runs, s.lastRunAt);
      // The last one still at it owns this streak too: green came and went
      // under it, and it watches the deploy itself. Another starts once it
      // stops, if it is still red.
      if (streak && s.lastSessionId && this.atWork(s.lastSessionId)) continue;
      if (streak) await this.fire(s, now, false, redNote(rule, streak, s.lastSessionId));
      else if (s.lastError) {
        updateSchedule(s.id, { lastError: null });
        this.changed();
      }
    }
  }

  /** Mid-turn, or showing a prompt it needs answered. */
  private atWork(sessionId: string): boolean {
    try {
      const { status } = this.fleet.get(sessionId);
      return status === "running" || status === "blocked";
    } catch {
      return false;
    }
  }

  private get(id: string): Schedule {
    const s = getSchedule(id);
    if (!s) throw new FleetError(404, `no scheduled session ${id}`);
    return s;
  }

  /**
   * A schedule with a note command, or one that keeps to a session, has come
   * due (or is run by hand: `early`). Its next time is set first, so a slow
   * command is not started twice.
   */
  private async come(due: Schedule, now: number, early: boolean): Promise<Came> {
    if (this.coming.has(due.id)) return { quiet: "its note command is still running from last time" };
    this.coming.add(due.id);
    try {
      if (!early) updateSchedule(due.id, { nextAt: nextRun(due.rule, now) });
      const came = await this.say(due, now, early);
      this.changed();
      return came;
    } finally {
      this.coming.delete(due.id);
    }
  }

  private async say(due: Schedule, now: number, early: boolean): Promise<Came> {
    const busy = { quiet: "the session it keeps to is mid-turn or showing a prompt, so this time was skipped; its next time says what is still true" };
    // Before the command is run: nothing it prints could be said.
    if (due.sameSession && due.lastSessionId && this.atWork(due.lastSessionId)) return busy;
    let note: string | undefined;
    if (due.noteCmd) {
      try {
        note = await runNote(due);
      } catch (e) {
        const message = `its note command failed: ${(e as Error).message}`;
        console.error(`agentbox: schedule ${due.id}: ${message}`);
        updateSchedule(due.id, { lastError: message });
        return { quiet: message };
      }
      if (!note) {
        // Nothing to say is not a run, and not a failure: the last one is behind it.
        if (due.lastError) updateSchedule(due.id, { lastError: null });
        return { quiet: "its note command printed nothing, so there is nothing to say" };
      }
    }
    // As it is now: the command took a while, and it may have been deleted or paused under it.
    const s = getSchedule(due.id);
    if (!s || (!s.enabled && !early)) return { quiet: "it was deleted or paused meanwhile" };
    const last = s.sameSession && s.lastSessionId ? this.session(s.lastSessionId) : null;
    if (last && (last.status === "running" || last.status === "blocked")) return busy;
    const over = last ? pastIt(last, s.freshOver ?? FRESH_OVER) : null;
    if (last && !over) {
      const text = note ?? s.spec.prompt;
      if (!text) return { quiet: "it has neither a note nor a prompt to say" };
      try {
        await this.fleet.note(last.id, `${scheduleSentMark(s.id)} ${text}`);
      } catch (e) {
        const message = `could not say it to ${last.id}: ${(e as Error).message}`;
        console.error(`agentbox: schedule ${s.id}: ${message}`);
        updateSchedule(s.id, { lastError: message });
        return { quiet: message };
      }
      updateSchedule(s.id, { lastRunAt: now, lastError: null });
      console.log(`agentbox: schedule ${s.id} spoke to its session ${last.id}`);
      return { sessionId: last.id };
    }
    // A new one, told who it follows; the old one is closed once it is up.
    const follows = s.sameSession && s.lastSessionId
      ? `[agentbox: you take over from ${s.lastSessionId}, the session this schedule spoke to until now (${over ?? "it is gone"}). What it did is in \`agentbox log ${s.lastSessionId} | tail -60\`; it will not be spoken to again.]`
      : undefined;
    const sid = await this.fire(s, now, early, note, follows);
    if (!sid) return { quiet: this.get(s.id).lastError ?? "it did not start" };
    if (last && last.status !== "closed" && !this.atWork(last.id)) {
      await this.fleet.close(last.id, true).catch((e) => console.error(`agentbox: schedule ${s.id}: closing ${last.id}:`, e));
    }
    return { sessionId: sid };
  }

  private session(id: string): Session | null {
    try {
      return this.fleet.get(id);
    } catch {
      return null;
    }
  }

  /** The session it started, or null when it could not (said on the schedule).
   *  `note` goes before what it was asked, `after` behind it. */
  private async fire(s: Schedule, now: number, early: boolean, note?: string, after?: string): Promise<string | null> {
    const once = !isRecurring(s.rule);
    const { accountId, ...spec } = s.spec;
    try {
      const { session } = await this.fleet.spawn({
        ...spec,
        // What set it off, before what it was asked.
        ...(note || after ? { prompt: [note, spec.prompt, after].filter(Boolean).join("\n\n") } : {}),
        accountId: accountId && accountId !== "auto" ? accountId : null,
        ...(once ? { id: s.id } : {}),
      });
      // Its first prompt is the note, which makes a poor title.
      if (note && s.label) await this.fleet.patch(session.id, { label: s.label }).catch(() => {});
      if (once) deleteSchedule(s.id);
      else {
        updateSchedule(s.id, {
          lastRunAt: now,
          lastSessionId: session.id,
          lastError: null,
          ...(early ? {} : { nextAt: nextRun(s.rule, now) }),
        });
      }
      console.log(`agentbox: started scheduled session ${session.id} (${describeRule(s.rule, now)})`);
      this.changed();
      return session.id;
    } catch (e) {
      const message = (e as Error).message;
      console.error(`agentbox: scheduled session ${s.id} did not start: ${message}`);
      if (once && getSessionRecord(s.id)) {
        // It got as far as a session, which now says what went wrong itself.
        deleteSchedule(s.id);
      } else if (early) {
        updateSchedule(s.id, { lastError: message });
      } else if (s.rule.kind === "red") {
        // Still red, so it is tried again once the hold is over; its last
        // start stays the last one that worked, which is what tells a streak
        // with a session from one without.
        this.redHeldUntil.set(s.id, now + RETRY_MS);
        updateSchedule(s.id, { lastError: message });
      } else {
        // No account with room is a moment, not a mistake: try again soon —
        // for a recurring one, not past its next time.
        const retry = e instanceof FleetError && !!e.placement ? now + RETRY_MS : null;
        const next = once ? null : nextRun(s.rule, now);
        const nextAt = retry !== null ? Math.min(retry, next ?? retry) : next;
        updateSchedule(s.id, {
          lastError: message,
          lastRunAt: once ? s.lastRunAt : now,
          nextAt,
          ...(nextAt === null ? { enabled: false } : {}),
        });
      }
      this.changed();
      return null;
    }
  }
}

/** Why a schedule that keeps to one session leaves this one for a new one, or
 *  null when it still speaks to it. */
function pastIt(s: Session, freshOver: number): string | null {
  if (s.status === "closed") return "it was closed";
  if (s.limitHit) return "it stopped at a usage limit";
  if ((s.contextUsed ?? 0) > freshOver) return `it held ${Math.round(s.contextUsed! / 1000)}k tokens of context, over the ${Math.round(freshOver / 1000)}k this schedule keeps one session to`;
  return null;
}

/** Where a schedule's sessions run, and so its note command. */
function dirOf(spec: ScheduleSpec): string | null {
  const repo = spec.repoId ? getRepoById(spec.repoId) : null;
  return repo ? repoCheckoutPath(repo) : (spec.cwd?.replace(/^~(?=$|\/)/, homedir()) ?? null);
}

/**
 * What the schedule's note command prints, trimmed: "" when it has nothing to
 * say. Run by `sh -c` in the schedule's directory at the lowest priority, and
 * killed with everything it started after `NOTE_TIMEOUT_S`. It is told which
 * schedule it speaks for and the session that one spoke to last
 * (`AGENTBOX_SCHEDULE`, `AGENTBOX_SCHEDULE_SESSION`). Throws when it fails.
 */
async function runNote(s: Schedule): Promise<string> {
  const cwd = dirOf(s.spec);
  if (!cwd || !existsSync(cwd)) throw new Error(`its directory is gone: ${cwd}`);
  const p = Bun.spawn(["nice", "-n", "19", "timeout", "--kill-after=5", String(NOTE_TIMEOUT_S), "sh", "-c", s.noteCmd!], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENTBOX_SCHEDULE: s.id, AGENTBOX_SCHEDULE_SESSION: s.lastSessionId ?? "" },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code === 124 || code === 137) throw new Error(`it did not finish in ${NOTE_TIMEOUT_S}s`);
  if (code !== 0) throw new Error(`exit ${code}${err.trim() ? `: ${err.trim().split("\n").pop()!.slice(0, 300)}` : ""}`);
  const note = out.trim();
  return note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX)}\n[agentbox: the note was cut here, at ${NOTE_MAX} characters.]` : note;
}

/** A note command and keeping to one session are for a schedule that repeats
 *  at a time: an event has its own note, and a one-time one has no next time. */
function checkExtras(rule: ScheduleRule, spec: ScheduleSpec, x: { noteCmd?: string | null; sameSession?: boolean; freshOver?: number | null }): void {
  if (!x.noteCmd && !x.sameSession && (x.freshOver === null || x.freshOver === undefined)) return;
  if (rule.kind !== "every" && rule.kind !== "weekly") {
    throw new FleetError(400, "a note command and keeping to one session are for a schedule that repeats at a time: “every 10 minutes”, “every weekday at 9am”");
  }
  if (x.freshOver !== null && x.freshOver !== undefined) {
    if (!x.sameSession) throw new FleetError(400, "a context size to start afresh over means something only with the same session");
    if (!Number.isInteger(x.freshOver) || x.freshOver < FRESH_OVER_MIN) throw new FleetError(400, `the context size to start afresh over must be at least ${FRESH_OVER_MIN / 1000}k tokens`);
  }
  if (!x.noteCmd && !spec.prompt) throw new FleetError(400, "with no note command it needs a prompt: that is what it says each time");
}

function parse(when: string, now: number): ScheduleRule {
  const p = parseWhen(when, now);
  if ("error" in p) throw new FleetError(400, p.error);
  return p.rule;
}

interface PrState {
  state: "OPEN" | "MERGED" | "CLOSED";
  title: string;
  baseRefName: string;
  mergeCommit: { oid: string } | null;
}

/** The repo a new worktree will be cut from, when it will be cut from its default branch. */
function worktreeRepo(spec: ScheduleSpec) {
  if (!spec.repoId || !spec.worktree || spec.branch) return null;
  return getRepoById(spec.repoId);
}

async function git(args: string[], cwd: string): Promise<number> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return p.exited;
}

/**
 * Why a merged PR is not in the new worktree's starting point yet, or null
 * when it is. The worktree is cut from `origin/<default>` as fetched at the
 * start, and that fetch is best-effort: fetched and checked here first, so a
 * failed fetch waits a minute rather than starting the session without it.
 */
async function notYetIn(spec: ScheduleSpec, pr: PrState): Promise<string | null> {
  const repo = worktreeRepo(spec);
  if (!repo || !pr.mergeCommit) return null;
  const dir = repoCheckoutPath(repo);
  if (!existsSync(dir)) return null;
  await git(["fetch", "--quiet", "origin", repo.defaultBranch], dir);
  const code = await git(["merge-base", "--is-ancestor", pr.mergeCommit.oid, `origin/${repo.defaultBranch}`], dir);
  return code === 0 ? null : `merged, but not yet in origin/${repo.defaultBranch} here; checking again in a minute`;
}

async function prState(repo: string, pr: number): Promise<PrState> {
  const p = Bun.spawn(["gh", "pr", "view", String(pr), "-R", repo, "--json", "state,title,baseRefName,mergeCommit"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new FleetError(400, `could not read PR #${pr} of ${repo}: ${err.trim().split("\n")[0] || `gh exited ${code}`}`);
  return JSON.parse(out) as PrState;
}

/**
 * A merge rule made whole: the repo its PR is in (the one it runs in, unless
 * named), and proof the PR is there and still open — "when 6644 merges" on a
 * PR that already has would otherwise wait forever.
 */
async function settle(rule: ScheduleRule, spec: ScheduleSpec): Promise<ScheduleRule> {
  if (rule.kind === "red") return settleRed(rule, spec);
  if (rule.kind !== "merge") return rule;
  const repo = rule.repo ?? repoOf(spec);
  if (!repo) throw new FleetError(400, `cannot tell which GitHub repo PR #${rule.pr} is in: name it, as in “when owner/repo#${rule.pr} merges”`);
  const { state, title, baseRefName } = await prState(repo, rule.pr);
  if (state === "MERGED") throw new FleetError(400, `PR #${rule.pr} of ${repo} has already merged: use Start instead`);
  if (state === "CLOSED") throw new FleetError(400, `PR #${rule.pr} of ${repo} is closed`);
  // Waiting for it is waiting to build on it: a PR into some other branch
  // never reaches the branch a new worktree is cut from.
  const into = worktreeRepo(spec);
  if (into && into.fullName === repo && baseRefName !== into.defaultBranch) {
    throw new FleetError(400, `PR #${rule.pr} merges into ${baseRefName}, not ${into.defaultBranch}: a new worktree is cut from ${into.defaultBranch}, so it would not have it`);
  }
  return { kind: "merge", pr: rule.pr, repo, title };
}

/** A red rule made whole: its repo, its branch, and its workflow as GitHub names it. */
async function settleRed(rule: Extract<ScheduleRule, { kind: "red" }>, spec: ScheduleSpec): Promise<ScheduleRule> {
  const repo = rule.repo ?? repoOf(spec);
  if (!repo) throw new FleetError(400, `cannot tell which GitHub repo ${rule.workflow} is in: name it, as in “whenever owner/repo's ${rule.workflow} is red”`);
  try {
    const { name, file } = await findWorkflow(repo, rule.workflow);
    return { kind: "red", workflow: name, file, repo, branch: rule.branch ?? (await defaultBranch(repo)) };
  } catch (e) {
    throw new FleetError(400, (e as Error).message);
  }
}

/** The GitHub repo (`owner/name`) the session runs in, when it is one. */
function repoOf(spec: ScheduleSpec): string | null {
  const reg = spec.repoId ? getRepoById(spec.repoId) : null;
  const dir = reg ? reg.ref : spec.cwd?.replace(/^~(?=$|\/)/, homedir());
  return reg?.fullName ?? (dir && existsSync(dir) && isGitRepo(dir) ? repoFullNameOf(dir) : null);
}

/** Wrong now is wrong later: say so while you are still here to fix it. */
function checkSpec(spec: ScheduleSpec): void {
  if (spec.repoId) {
    if (!getRepoById(spec.repoId)) throw new FleetError(404, `no repo ${spec.repoId}`);
  } else if (spec.cwd) {
    const dir = spec.cwd.replace(/^~(?=$|\/)/, homedir());
    if (!existsSync(dir)) throw new FleetError(400, `no such directory: ${dir}`);
  } else {
    throw new FleetError(400, "say where the session should run: a repo or a directory");
  }
}

/** A session id no session or schedule has: a one-time one starts under it. */
function freshId(): string {
  for (;;) {
    const id = newSessionId();
    if (!getSessionRecord(id) && !getSchedule(id)) return id;
  }
}
