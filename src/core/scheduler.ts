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
 * "When PR 6644 merges" is a one-time one with no time: its PR is asked about
 * (`gh pr view`) once a minute, and it starts when GitHub says merged — and,
 * for a new worktree, once the merge is in the `origin/<default>` it will be
 * cut from, so the session has it in its history.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { deleteSchedule, getRepoById, getSchedule, getSessionRecord, insertSchedule, listSchedules, updateSchedule } from "./db";
import { FleetError, newSessionId, type Fleet } from "./fleet";
import { isGitRepo, repoCheckoutPath, repoFullNameOf } from "./git";
import { describeRule, isRecurring, nextRun, parseWhen, type ScheduleRule } from "./schedule";
import type { Schedule, ScheduleSpec } from "./types";

const TICK_MS = 15_000;
/** How often a PR waited on is asked about: GitHub's rate limit is shared. */
const MERGE_CHECK_MS = 60_000;
/** No account had room: try again this much later. */
const RETRY_MS = 10 * 60_000;

export interface ScheduleEdit {
  /** Plain words, as for a new one. */
  when?: string;
  prompt?: string;
  label?: string | null;
  enabled?: boolean;
  /** Run in this registered repo instead. */
  repoId?: string;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private mergesCheckedAt = 0;

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

  async create(input: { when: string; spec: ScheduleSpec; label?: string | null }): Promise<Schedule> {
    checkSpec(input.spec);
    const now = this.now();
    const rule = await settle(parse(input.when, now), input.spec);
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
    const enabled = edit.enabled ?? s.enabled;
    const rule = patch.rule ?? s.rule;
    // A new time, or switching it back on, is a fresh start: the last
    // failure is behind it.
    if (edit.when !== undefined || (edit.enabled === true && !s.enabled)) {
      patch.lastError = null;
      patch.enabled = enabled;
    } else if (edit.enabled !== undefined) patch.enabled = enabled;
    if (patch.rule || patch.enabled !== undefined) {
      const next = enabled ? nextRun(rule, now) : null;
      if (enabled && next === null && rule.kind !== "merge") throw new FleetError(400, "That time has passed: give it a new one.");
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
    const sid = await this.fire(s, this.now(), true);
    if (!sid) throw new FleetError(409, this.get(id).lastError ?? "it did not start");
    return sid;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const s of listSchedules()) {
        if (s.enabled && s.nextAt !== null && s.nextAt <= now) await this.fire(s, now, false);
      }
      if (now - this.mergesCheckedAt >= MERGE_CHECK_MS) {
        this.mergesCheckedAt = now;
        await this.checkMerges(now);
      }
    } catch (e) {
      console.error("agentbox: scheduler:", e);
    } finally {
      this.ticking = false;
    }
  }

  /** Each PR waited on, asked about once. A retry already set (no account had
   *  room when it merged) is left to the clock. */
  private async checkMerges(now: number): Promise<void> {
    for (const s of listSchedules()) {
      if (!s.enabled || s.rule.kind !== "merge" || s.nextAt !== null) continue;
      const { pr, repo } = s.rule;
      if (!repo) continue;
      let state: PrState;
      try {
        state = await prState(repo, pr);
      } catch (e) {
        // GitHub unreachable or gh logged out: say so, keep asking.
        const message = (e as Error).message;
        if (s.lastError !== message) {
          updateSchedule(s.id, { lastError: message });
          this.changed();
        }
        continue;
      }
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

  private get(id: string): Schedule {
    const s = getSchedule(id);
    if (!s) throw new FleetError(404, `no scheduled session ${id}`);
    return s;
  }

  /** The session it started, or null when it could not (said on the schedule). */
  private async fire(s: Schedule, now: number, early: boolean): Promise<string | null> {
    const once = !isRecurring(s.rule);
    const { accountId, ...spec } = s.spec;
    try {
      const { session } = await this.fleet.spawn({
        ...spec,
        accountId: accountId && accountId !== "auto" ? accountId : null,
        ...(once ? { id: s.id } : {}),
      });
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
  if (rule.kind !== "merge") return rule;
  let repo = rule.repo;
  if (!repo) {
    const reg = spec.repoId ? getRepoById(spec.repoId) : null;
    const dir = reg ? reg.ref : spec.cwd?.replace(/^~(?=$|\/)/, homedir());
    repo = reg?.fullName ?? (dir && existsSync(dir) && isGitRepo(dir) ? repoFullNameOf(dir) : null);
    if (!repo) throw new FleetError(400, `cannot tell which GitHub repo PR #${rule.pr} is in: name it, as in “when owner/repo#${rule.pr} merges”`);
  }
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
