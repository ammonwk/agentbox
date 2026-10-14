/**
 * What a session is waiting on, and the one way it finds out.
 *
 * A session used to wait with whatever it could write: a background shell
 * loop over `gh`, `gh run watch`, a `pidwait` and a message, a monitor. Each
 * lived in the session's own process tree, so it died when the session was
 * parked, moved or restarted, and each had ways to end that said nothing: a
 * loop whose two conditions were never true in the same poll and whose
 * timeout printed the line success prints; a waker killed with the shell that
 * started it; a job stopped with the idle session that owned it.
 *
 * A wait here is a row the server owns. The server looks (every pull request
 * in one GraphQL request, a run by a conditional GET, a job by its unit, a
 * command by running it), and the wait ends in exactly one of four ways, each
 * typed into its session as agentbox's own note, which resumes a parked one:
 *
 *   happened   what it waited for: the checks concluded (failing ones
 *              named), the PR merged, the run or job ended, the command
 *              said yes, the other session's turn ended
 *   stuck      waiting can no longer bring it: the head moved, a named check
 *              never reported with nothing left running, the PR was closed
 *   timeout    its deadline came first; every wait has one
 *   broken     it could not be watched: every look failed for
 *              `BROKEN_AFTER_MS`, or a job's unit is gone with no result
 *
 * The session's process is not part of it, so it can end its turn, be parked
 * or be moved and still be told. A session stopped by hand, closed, or at a
 * usage limit is told once it runs again (`untold` says why not yet). The
 * server being down ends no wait: they are rows, looked at again when it is
 * back, and one whose deadline passed meanwhile gets a last look first.
 */

import { getWait, insertWait, listOpenWaits, listWaits, updateWait } from "./db";
import { assignedPrHolder, prReleased, prReleaseNotice } from "./prclaims";
import { FleetError, type Fleet } from "./fleet";
import { Held, logTail, prKey, readJob, readPrs, readRun, readUntil, type JobRead, type PrRead, type RunRead } from "./waitreads";
import type { Session, Wait, WaitEnd, WaitSpec } from "./types";

const TICK_MS = 15_000;
/** How often the pull requests waited on are read: one request for all of them. */
const PR_EVERY_MS = 90_000;
const RUN_EVERY_MS = 60_000;
/** Every look failing for this long is a wait that cannot watch: its session is told. */
const BROKEN_AFTER_MS = 20 * 60_000;
/** An `until` command that fails this many times running is broken, however fast it is asked. */
const UNTIL_FAILURES = 5;
/** GitHub shows a pushed head a moment after the push. */
const HEAD_GRACE_MS = 5 * 60_000;
/** A named check missing this long with nothing running or queued will not come by
 *  waiting. Long, because a job behind `needs` is not listed until those finish. */
const ABSENT_AFTER_MS = 30 * 60_000;
/** "Every check concluded" is believed on a second look this much later: workflows register one by one, and a push or a "ready for review" starts its runs some seconds after. */
const READY_TWICE_MS = 80_000;
/** A job with no unit and no result this long is gone, not between states. */
const GONE_AFTER_MS = 30_000;
const TELL_EVERY_MS = 60_000;
/** How long an ended wait keeps trying to tell a session that is stopped or closed. */
export const TELL_FOR_MS = 24 * 3_600_000;
const MAX_PER_SESSION = 20;
export const MIN_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 7 * 24 * 3_600_000;
export const DEFAULT_TIMEOUT_MS: Record<WaitSpec["kind"], number> = {
  pr: 3 * 3_600_000,
  run: 2 * 3_600_000,
  job: 12 * 3_600_000,
  session: 4 * 3_600_000,
  until: 2 * 3_600_000,
  time: 3_600_000,
};

type Ending = { how: Exclude<WaitEnd, "cancelled" | "timeout">; text: string };
/** One look: how it ends the wait, or what it saw and hands the next look. */
export type Look = { end: Ending; memo?: Wait["memo"] } | { seen: string; memo?: Wait["memo"] };

// Merge authorization belongs to the steward, not the owner waiting for CI/review.
const isMergeGate = (name: string): boolean => name.trim().toLowerCase() === "merge gate";

const short = (sha: string): string => sha.slice(0, 10);
const sameCommit = (a: string, b: string): boolean => a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
const list = (names: string[], max = 8): string => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));

export function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${Math.round(m / 1440)}d`;
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** `PR #8883: Build, Typecheck on 0ab9de7654`: what a wait is for, in a line. */
export function describe(spec: WaitSpec): string {
  switch (spec.kind) {
    case "pr": {
      if (spec.feedback) return `PR #${spec.number}: new review feedback or failed checks on ${short(spec.head!)}`;
      if (spec.merged) return `PR #${spec.number} merging${spec.head ? ` from ${short(spec.head)}` : ""}`;
      const what = oneLine([...(spec.all ? ["every check"] : []), ...spec.checks].join(", "), 120);
      return `PR #${spec.number}: ${what}${spec.head ? ` on ${short(spec.head)}` : ""}`;
    }
    case "run":
      return `run ${spec.run} of ${spec.repo}`;
    case "job":
      return `job ${oneLine(spec.command, 60)}`;
    case "session":
      return `session ${spec.ids.join(", ")}`;
    case "until":
      return `until ${oneLine(spec.cmd, 60)}`;
    case "time":
      return "a time";
  }
}

/** A wait as asked for over HTTP, made whole or refused in words. */
export function parseSpec(raw: unknown): WaitSpec {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (k: string): string => {
    if (typeof o[k] !== "string" || !(o[k] as string).trim()) throw new FleetError(400, `a ${String(o.kind)} wait needs ${k}`);
    return (o[k] as string).trim();
  };
  const whole = (k: string, max: number): number => {
    if (typeof o[k] !== "number" || !Number.isInteger(o[k]) || (o[k] as number) <= 0 || (o[k] as number) > max) throw new FleetError(400, `a ${String(o.kind)} wait needs ${k}, a number`);
    return o[k] as number;
  };
  const repo = (): string => {
    const r = text("repo");
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new FleetError(400, `"${r}" is not a GitHub repo: owner/name`);
    return r;
  };
  switch (o.kind) {
    case "pr": {
      const checks = Array.isArray(o.checks) ? o.checks.filter((c): c is string => typeof c === "string" && !!c.trim()).map((c) => c.trim()) : [];
      if (checks.some(isMergeGate)) throw new FleetError(400, "Merge gate is merge authorization, not a CI/review check; use --merged to wait for the merge");
      const head = typeof o.head === "string" && o.head.trim() ? o.head.trim().toLowerCase() : null;
      if (head && !/^[0-9a-f]{7,40}$/.test(head)) throw new FleetError(400, `--head takes a commit (7 to 40 hex), not "${head}"`);
      const merged = o.merged === true;
      const feedback = o.feedback === true;
      if (feedback && (!head || merged || checks.length || o.all === true)) throw new FleetError(400, "--feedback requires --head and is separate from --merged/--require/--only/every check");
      if (merged && (checks.length || o.all === true)) throw new FleetError(400, "a wait for the merge is its own wait: arm one for the checks and another with --merged");
      return { kind: "pr", repo: repo(), number: whole("number", 1e9), head, all: !feedback && !merged && (o.all === true || checks.length === 0), checks, merged, ...(feedback ? { feedback: true } : {}) };
    }
    case "run":
      return { kind: "run", repo: repo(), run: whole("run", Number.MAX_SAFE_INTEGER) };
    case "job":
      return { kind: "job", unit: text("unit"), command: text("command"), log: text("log"), result: text("result") };
    case "session": {
      const ids = Array.isArray(o.ids) ? [...new Set(o.ids.filter((i): i is string => typeof i === "string" && /^[\w-]{1,64}$/.test(i)))] : [];
      if (ids.length === 0 || ids.length !== (o.ids as unknown[]).length) throw new FleetError(400, "a session wait needs the sessions waited on");
      return { kind: "session", ids };
    }
    case "until": {
      const everyMs = typeof o.everyMs === "number" ? o.everyMs : 120_000;
      if (everyMs < 30_000 || everyMs > 3_600_000) throw new FleetError(400, "--every is between 30s and 1h");
      return { kind: "until", cmd: text("cmd"), cwd: text("cwd"), everyMs };
    }
    case "time":
      return { kind: "time" };
    default:
      throw new FleetError(400, "a wait is for one of: pr, run, job, session, until, time");
  }
}

/** A check name asked for takes the checks it names and their shards: `API Tests (shard 1/3)`. */
const named = (check: string, asked: string): boolean => check.toLowerCase() === asked.toLowerCase() || check.toLowerCase().startsWith(`${asked.toLowerCase()} `);

export function lookPr(spec: Extract<WaitSpec, { kind: "pr" }>, memo: Wait["memo"], pr: PrRead, createdAt: number, now: number): Look {
  const name = `PR #${spec.number}`;
  if (pr.state === "MERGED") return { end: { how: "happened", text: `${name} merged.` } };
  if (pr.state === "CLOSED") return { end: { how: "stuck", text: `${name} was closed without merging.` } };

  const want = spec.merged ? (spec.head ?? pr.head) : (spec.head ?? memo.head ?? pr.head);
  if (!sameCommit(pr.head, want)) {
    if (spec.head && !memo.head && now - createdAt < HEAD_GRACE_MS) return { seen: `GitHub still shows head ${short(pr.head)}, not ${short(want)}`, memo };
    return {
      end: {
        how: "stuck",
        text: spec.merged
          ? `${name}'s head moved to ${short(pr.head)} before it merged; this wait was for ${short(want)}. Arm it again with --head ${short(pr.head)}.`
          : memo.head
            ? `${name}'s head moved to ${short(pr.head)}; this wait was for ${short(want)}, whose checks no longer decide anything. Arm it again for the new head.`
            : `${name}'s head is ${short(pr.head)}, and ${short(want)} never became it. Check the push went to this PR's branch.`,
      },
    };
  }
  if (spec.merged) return { seen: `open on ${short(pr.head)}, not merged`, memo: spec.head ? { head: pr.head } : {} };
  const base = { head: pr.head };

  // Apply the policy here so already-armed waits and every diagnostic use the same scope.
  if (spec.checks.some(isMergeGate)) return { end: { how: "stuck", text: "This wait explicitly requires merge authorization. Arm a CI/review wait, or use --merged for the merge." } };
  const checks = pr.checks.filter((c) => !isMergeGate(c.name));
  if (spec.feedback) {
    const failed = checks.filter(c => c.done && !c.ok);
    const keys = failed.map(c => c.key ?? `${c.name}:${c.how}`).sort();
    const freshFailures = failed.filter(c => !memo.failedChecks?.includes(c.key ?? `${c.name}:${c.how}`));
    const feedback = pr.feedback;
    const readable = feedback && !(feedback instanceof Error) ? feedback : null;
    const changed = readable && (memo.feedback ? memo.feedback !== readable.fingerprint : readable.count > 0);
    const next = { ...base, failedChecks: keys, feedback: readable?.fingerprint ?? memo.feedback };
    if (freshFailures.length || changed) return {
      end: { how: "happened", text: `${name} has actionable updates on ${short(pr.head)}: ${[...(changed ? ["review/comment feedback changed"] : []), ...freshFailures.map(c => `${c.name} (${c.how})`)].join(", ")}. Read and disposition the actual review/comment/check evidence now; queued CI does not delay this notice. This is not a clean verdict or readiness. Keep the full-check wait. After disposition, rearm with agentbox wait pr ${spec.repo}#${spec.number} --feedback --head ${pr.head}; its durable cursor skips already observed feedback. Existing owner, consent and merge policy still apply.` }, memo: next,
    };
    if (!readable) throw feedback instanceof Error ? feedback : new Error("PR feedback was not read");
    if (pr.checksError) throw pr.checksError;
    return { seen: `no new review feedback or failed checks on ${short(pr.head)}`, memo: next };
  }
  if (pr.checksError) throw pr.checksError;
  const asked = spec.checks.map((n) => ({ n, found: checks.filter((c) => named(c.name, n)) }));
  const scope = spec.all ? checks : [...new Set(asked.flatMap((a) => a.found))];
  const failed = scope.filter((c) => c.done && !c.ok);
  const running = checks.filter((c) => !c.done);
  const absent = asked.filter((a) => a.found.length === 0).map((a) => a.n);
  const passed = scope.filter((c) => c.done && c.ok).length;
  if (failed.length) {
    return {
      end: {
        how: "happened",
        text: `${name}, FAILED on ${short(pr.head)}: ${list(failed.map((c) => `${c.name} (${c.how})`))}. ${running.length ? `Still running: ${list(running.map((c) => c.name))}.` : "Nothing else is running."}`,
      },
    };
  }
  // A conflicting PR starts no pull_request workflows, even when an external check reports.
  if (spec.all || absent.length) {
    if (pr.mergeable === "CONFLICTING") {
      return {
        end: {
          how: "stuck",
          text: `${name} on ${short(pr.head)} conflicts with ${pr.base}. GitHub does not start pull_request workflows while a PR has merge conflicts; external checks can still report. Resolve the conflicts with the base branch and push the resolution, then arm a wait for the new head. An empty commit will not resolve the conflicts.`,
        },
      };
    }
    if (pr.mergeable === "UNKNOWN") return { seen: `GitHub is still determining whether ${name} on ${short(pr.head)} merges with ${pr.base}`, memo: base };
  }
  const owed = [...(spec.all ? running : scope.filter((c) => !c.done)).map((c) => c.name), ...absent.map((n) => `${n} (not reported yet)`)];
  const none = spec.all && checks.length === 0;
  if (owed.length === 0 && !none) {
    if (spec.all && !(memo.readyAt && now - memo.readyAt >= READY_TWICE_MS)) {
      return { seen: `every check has concluded on ${short(pr.head)}; looking once more before saying so`, memo: { ...base, readyAt: memo.readyAt ?? now } };
    }
    const other = running.length ? ` Other checks still running: ${list(running.map((c) => c.name))}.` : "";
    return { end: { how: "happened", text: `${name}: ${spec.all ? `all ${checks.length} checks` : list(scope.map((c) => c.name))} concluded on ${short(pr.head)}, ${passed} passed and none failed.${other}` } };
  }
  // Nothing is running that could report what is missing.
  if ((absent.length || none) && running.length === 0) {
    const absentAt = memo.absentAt ?? now;
    if (now - absentAt >= ABSENT_AFTER_MS) {
      return {
        end: {
          how: "stuck",
          text: none
            ? `${name}: no check has reported on ${short(pr.head)} in ${span(now - absentAt)}. Check the workflow event filters and run history; an empty check list does not prove whether a workflow started.`
            : `${name}: ${list(absent)} has not reported on ${short(pr.head)}, and nothing has been running or queued there for ${span(now - absentAt)}. Nothing in sight will report it, so this wait ends here instead of waiting blind: look at the workflow that should report it, and arm again if it is in fact still coming.`,
        },
      };
    }
    return { seen: none ? `no check reported yet on ${short(pr.head)}` : `waiting on ${list(owed)}; nothing is running`, memo: { ...base, absentAt } };
  }
  return { seen: `waiting on ${list(owed)} on ${short(pr.head)}`, memo: base };
}

export function lookRun(spec: Extract<WaitSpec, { kind: "run" }>, run: RunRead): Look {
  if (run.status !== "completed") return { seen: `${run.name || "run"} is ${run.status || "not started"}` };
  return { end: { how: "happened", text: `Run ${spec.run} (${run.name}, on ${short(run.head)}) concluded: ${(run.conclusion || "no conclusion").toUpperCase()}. ${run.url}` } };
}

export function lookJob(spec: Extract<WaitSpec, { kind: "job" }>, memo: Wait["memo"], job: JobRead, now: number): Look {
  const log = `Its output: ${spec.log}`;
  if (job.result) {
    const { result, code, status } = job.result;
    const how = result === "success" ? "finished (exit 0)" : `FAILED: ${result}${code ? `, ${code} ${status}` : ""}`.trim();
    const tail = logTail(spec.log);
    return { end: { how: "happened", text: `The job ${how}. ${log}${tail ? `, which ends:\n${tail}` : " (empty)"}` } };
  }
  if (job.running) return { seen: "running" };
  const goneAt = memo.goneAt ?? now;
  if (now - goneAt < GONE_AFTER_MS) return { seen: "its unit is not running and has left no result yet", memo: { goneAt } };
  return { end: { how: "broken", text: `The job's unit (${spec.unit}) is gone and left no result: the machine or your systemd restarted under it, or it was stopped by hand. It did not finish. ${log}` } };
}

const IDLE: Session["status"][] = ["waiting", "blocked", "stopped", "closed"];

export function lookSessions(spec: Extract<WaitSpec, { kind: "session" }>, memo: Wait["memo"], of: (id: string) => Session | null, now: number): Look {
  const states = spec.ids.map((id) => ({ id, s: of(id) }));
  const idle = states.filter(({ s }) => !s || IDLE.includes(s.status));
  if (idle.length === 0) return { seen: `${spec.ids.join(", ")} ${spec.ids.length === 1 ? "is" : "are"} mid-turn`, memo: {} };
  // Twice, a tick apart: a session just sent a message is idle for a moment before its turn starts.
  const since = Object.fromEntries(idle.map((x) => [x.id, memo.idle?.[x.id] ?? now]));
  const settled = idle.filter((x) => now - since[x.id]! >= TICK_MS - 1_000);
  if (settled.length === 0) return { seen: `${idle.map((x) => x.id).join(", ")} looks idle; looking once more`, memo: { idle: since } };
  const said = settled.map(({ id, s }) =>
    !s ? `${id} is gone` : s.status === "blocked" ? `${id} is asking something` : s.status === "waiting" ? `${id} finished its turn${s.parkedAt ? " (and was parked since)" : ""}` : `${id} is ${s.status}`,
  );
  const rest = states.filter((x) => !settled.includes(x)).map((x) => x.id);
  return { end: { how: "happened", text: `${said.join("; ")}. Read it with \`agentbox log ${settled[0]!.id} -n 1\`.${rest.length ? ` Not yet: ${rest.join(", ")}; arm another wait for those.` : ""}` } };
}

/** What the session is told: one note, whole, so it reads as agentbox's own. */
export function message(w: Wait, now: number): string {
  const head = { happened: "HAPPENED", stuck: "CANNOT HAPPEN", timeout: "TIMED OUT", broken: "THE WAIT FAILED", cancelled: "CANCELLED" }[w.ended!];
  const late = w.endedAt && now - w.endedAt > 2 * 60_000 ? ` (It ended ${span(now - w.endedAt)} ago; you could not be told until now.)` : "";
  // `]` then a newline would end the note early for whoever reads it as one.
  const body = `wait ${w.id} (${describe(w.spec)}) ended: ${head}. ${w.outcome ?? ""}${late}`.replace(/\]\n/g, "] \n").trim();
  return `[agentbox: ${body}]`;
}

export class Waits {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private prsReadAt = 0;
  private githubHeldUntil = 0;
  /** `until` commands still running. */
  private asking = new Set<number>();
  /** When each ended wait may next be typed, and how long the last pause was. */
  private tellAfter = new Map<number, { at: number; pause: number }>();
  /** Waits whose note was typed and left in the input box, and when: not typed again until the conversation has moved. */
  private draftLeft = new Map<number, number>();
  private telling = new Set<number>();

  constructor(
    private readonly fleet: Pick<Fleet, "get" | "heir" | "note">,
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

  /** A new wait for `sessionId`, or the one it already has for the same thing. */
  arm(sessionId: string, spec: WaitSpec, timeoutMs?: number): { wait: Wait; already: boolean } {
    const s = this.fleet.get(sessionId);
    if (s.closedAt) throw new FleetError(409, `${sessionId} is closed: there is no one to tell`);
    if (s.host === "external" || s.host === "subagent") {
      throw new FleetError(409, `${sessionId} ${s.host === "subagent" ? "is a subagent" : "runs in a terminal of the user's own"}: agentbox cannot type into it, so it could never be told how the wait ended. A subagent hands the waiting to its parent session or to a session of its own (agentbox claude --detach).`);
    }
    if (spec.kind === "pr" && prReleased(sessionId, spec)) throw new FleetError(409, prReleaseNotice(sessionId));
    const ms = timeoutMs ?? DEFAULT_TIMEOUT_MS[spec.kind];
    if (!Number.isFinite(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) throw new FleetError(400, `a wait's timeout is between ${span(MIN_TIMEOUT_MS)} and ${span(MAX_TIMEOUT_MS)}`);
    const going = listOpenWaits(0).filter((w) => w.sessionId === sessionId && !w.ended);
    // One wait per thing waited on; asked again with a timeout, it takes the new deadline. Every timer is its own.
    const same = spec.kind === "time" ? undefined : going.find((w) => JSON.stringify(w.spec) === JSON.stringify(spec));
    if (same) {
      if (timeoutMs !== undefined) updateWait(same.id, { deadline: this.now() + ms });
      return { wait: getWait(same.id)!, already: true };
    }
    if (going.length >= MAX_PER_SESSION) throw new FleetError(409, `${sessionId} already has ${going.length} waits going (\`agentbox waits\`): cancel some with \`agentbox unwait\``);
    const now = this.now();
    // A feedback wait rearmed for the same head carries its cursor: the
    // feedback already dispositioned does not wake it again, across a restart
    // of the server too. A released or cancelled one has nothing to carry.
    let memo: Wait["memo"] = {};
    if (spec.kind === "pr" && spec.feedback) {
      const prior = listWaits(0, sessionId).reverse().find(w => w.ended && w.ended !== "cancelled" && w.spec.kind === "pr" && w.spec.feedback && w.spec.repo.toLowerCase() === spec.repo.toLowerCase() && w.spec.number === spec.number && (w.memo.head ? w.memo.head.startsWith(spec.head!) : w.spec.head === spec.head));
      if (prior) memo = { head: prior.memo.head, feedback: prior.memo.feedback, failedChecks: prior.memo.failedChecks };
    }
    const wait = insertWait({ sessionId, spec, createdAt: now, deadline: now + ms, memo });
    console.log(`agentbox: wait ${wait.id} for ${sessionId}: ${describe(spec)}, until ${new Date(wait.deadline).toISOString()}`);
    // Not waited for: the first look may be a request to GitHub.
    void this.tick();
    return { wait, already: false };
  }

  cancel(id: number): Wait {
    const w = getWait(id);
    if (!w) throw new FleetError(404, `no wait ${id}`);
    if (w.ended) throw new FleetError(409, `wait ${id} already ended (${w.ended})`);
    updateWait(id, { ended: "cancelled", endedAt: this.now(), outcome: "cancelled by hand" });
    return getWait(id)!;
  }

  /** Still going, untold, or ended in the last day; one session's when named. */
  list(sessionId?: string, all = false): Wait[] {
    return listWaits(all ? 0 : this.now() - TELL_FOR_MS, sessionId);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const open = listOpenWaits(now - TELL_FOR_MS);
      const going = open.filter((w) => !w.ended);
      for (const w of going) if (this.sessionOf(w)?.closedAt) updateWait(w.id, { ended: "cancelled", endedAt: now, outcome: "its session was closed" });
      await this.lookAtPrs(going.filter((w) => w.spec.kind === "pr"), now);
      for (const w of going) {
        if (w.spec.kind === "pr") continue;
        try {
          await this.lookAt(w, now);
        } catch (e) {
          this.failed(w, e, now);
        }
      }
      for (const w of listOpenWaits(now - TELL_FOR_MS)) {
        if (w.ended || w.deadline > now || this.asking.has(w.id)) continue;
        if (w.spec.kind === "time") this.end(w, "happened", `The ${span(now - w.createdAt)} you asked for ${now - w.deadline > 2 * 60_000 ? "ended a while ago" : "is up"}.`);
        else this.end(w, "timeout", timedOut(w, now));
      }
      // Not waited for: typing into one session may take its time, and the rest are due too.
      for (const w of listOpenWaits(now - TELL_FOR_MS)) {
        if (!w.ended || this.telling.has(w.id)) continue;
        this.telling.add(w.id);
        void this.tell(w)
          .catch((e) => console.error(`agentbox: wait ${w.id}: telling:`, e))
          .finally(() => this.telling.delete(w.id));
      }
    } catch (e) {
      console.error("agentbox: waits:", e);
    } finally {
      this.ticking = false;
    }
  }

  private sessionOf(w: Wait): Session | null {
    try {
      return this.fleet.get(this.fleet.heir(w.sessionId));
    } catch {
      return null;
    }
  }

  private async lookAtPrs(waits: Wait[], now: number): Promise<void> {
    // A new wait is looked at now; the rest keep the one request's pace.
    // And one at its deadline gets a last look before it is called a timeout.
    const due = waits.some((w) => w.checkedAt === null || w.deadline <= now) || now - this.prsReadAt >= PR_EVERY_MS;
    if (waits.length === 0 || !due) return;
    if (now < this.githubHeldUntil) {
      for (const w of waits) updateWait(w.id, { seen: new Held(this.githubHeldUntil).message });
      return;
    }
    this.prsReadAt = now;
    let reads: Awaited<ReturnType<typeof readPrs>>;
    try {
      reads = await readPrs(waits.map((w) => w.spec as Extract<WaitSpec, { kind: "pr" }>));
    } catch (e) {
      if (e instanceof Held) this.githubHeldUntil = e.until;
      for (const w of waits) this.failed(w, e, now);
      return;
    }
    for (const w of waits) {
      const spec = w.spec as Extract<WaitSpec, { kind: "pr" }>;
      const read = reads.get(prKey(spec)) ?? new Error("GitHub returned nothing for it");
      if (read instanceof Error) this.failed(w, read, now);
      else {
        // `lookPr` throws what it could not read: the checks past 100, or the
        // feedback read itself. That is a failed look, not a look that answers.
        try { this.looked(w, lookPr(spec, w.memo, read, w.createdAt, now), now); }
        catch (e) { this.failed(w, e, now); }
      }
    }
  }

  private async lookAt(w: Wait, now: number): Promise<void> {
    const spec = w.spec;
    switch (spec.kind) {
      case "run":
        if (now < this.githubHeldUntil || (w.checkedAt !== null && now - w.checkedAt < RUN_EVERY_MS && w.deadline > now)) return;
        return this.looked(w, lookRun(spec, await readRun(spec.repo, spec.run)), now);
      case "job":
        return this.looked(w, lookJob(spec, w.memo, readJob(spec), now), now);
      case "session":
        return this.looked(w, lookSessions(spec, w.memo, (id) => this.sessionOf({ ...w, sessionId: id }), now), now);
      case "until":
        if (this.asking.has(w.id) || (w.checkedAt !== null && now - w.checkedAt < spec.everyMs)) return;
        this.asking.add(w.id);
        // Not waited for: the command may take two minutes, and the rest are due too.
        void readUntil(spec, w.id, w.sessionId)
          .then(
            (r) => this.looked(w, r.yes ? { end: { how: "happened", text: r.said || "The command exited 0 and printed nothing." } } : { seen: r.said ? `not yet: ${r.said}` : "not yet", memo: {} }, this.now()),
            (e) => this.failed(w, e, this.now()),
          )
          .finally(() => this.asking.delete(w.id));
        return;
      case "time":
      case "pr":
        return;
    }
  }

  private looked(w: Wait, look: Look, now: number): void {
    if (getWait(w.id)?.ended) return;
    if ("end" in look) return this.end(w, look.end.how, look.end.text, look.memo);
    updateWait(w.id, { checkedAt: now, seen: look.seen, failingSince: null, memo: { ...(look.memo ?? w.memo), failures: undefined } });
  }

  /** A look that could not be made. GitHub's limit being spent is a pause with a known end, not a failure. */
  private failed(w: Wait, e: unknown, now: number): void {
    if (getWait(w.id)?.ended) return;
    const why = (e as Error).message;
    if (e instanceof Held) {
      this.githubHeldUntil = e.until;
      return updateWait(w.id, { seen: why });
    }
    const since = w.failingSince ?? now;
    const failures = (w.memo.failures ?? 0) + 1;
    // A count as well as a span: one failure each side of a server outage is not twenty minutes of them.
    const broken = w.spec.kind === "until" ? failures >= UNTIL_FAILURES : failures >= 3 && now - since >= BROKEN_AFTER_MS;
    if (broken) return this.end(w, "broken", `It could not be watched: ${failures} looks in a row failed over ${span(now - since)}, the last with: ${why}. Nothing is known about what it waited for since ${w.failingSince ? new Date(w.failingSince).toLocaleTimeString() : "it was made"}: look for yourself, then arm it again.`);
    updateWait(w.id, { checkedAt: now, seen: `could not look (${failures} in a row): ${why}`, failingSince: since, memo: { ...w.memo, failures } });
  }

  private end(w: Wait, how: Exclude<WaitEnd, "cancelled">, text: string, memo?: Wait["memo"]): void {
    // The ending and the cursor it leaves commit together: a crash must never
    // consume feedback without leaving the owner a durable notification.
    updateWait(w.id, { ended: how, outcome: text, endedAt: this.now(), ...(memo ? { memo, checkedAt: this.now(), failingSince: null } : {}) });
    console.log(`agentbox: wait ${w.id} for ${w.sessionId} (${describe(w.spec)}) ended: ${how}`);
  }

  /**
   * Type the ending into its session; one that is closed, stopped by hand or
   * at a limit hears it when it runs again. A try that failed is tried again
   * after a pause that doubles (a minute, to half an hour). One that was
   * typed and left in the input box is not typed again until the
   * conversation has moved: a draft goes out with the next message submitted,
   * and a second copy typed after it would go out twice.
   */
  private async tell(w: Wait): Promise<void> {
    const now = this.now();
    w = getWait(w.id)!;
    if (w.ended === "cancelled" || w.toldAt !== null) return;
    const s = this.sessionOf(w);
    if (w.spec.kind === "pr" && prReleased(s?.id ?? w.sessionId, w.spec)) {
      updateWait(w.id, { ended: "cancelled", endedAt: now, outcome: prReleaseNotice(s?.id ?? w.sessionId), untold: null });
      return;
    }
    const hold = !s
      ? "its session is gone"
      : s.closedAt
        ? "its session is closed; it is told if it is reopened and runs again"
        : s.host === "none" && !s.parkedAt
          ? "its session was stopped by hand; it is told when it runs again"
          : s.limitHit?.until && s.limitHit.until > now
            ? `its session is stopped at a usage limit until ${new Date(s.limitHit.until).toLocaleTimeString()}`
            : null;
    if (hold || !s) {
      if (w.untold !== hold) updateWait(w.id, { untold: hold });
      return;
    }
    if (now < (this.tellAfter.get(w.id)?.at ?? 0)) return;
    const drafted = this.draftLeft.get(w.id);
    if (drafted !== undefined && s.lastActivityAt <= drafted) return;
    try {
      const holder = w.spec.kind === "pr" ? assignedPrHolder(w.spec) : null;
      const notice = holder && holder !== s.id
        ? `[agentbox: This PR is assigned to ${holder}, not you (${s.id}). This wait is observation only; it does not authorize edits, merges, pushes or use of the holder's worktree.]\n\n`
        : "";
      await this.fleet.note(s.id, notice + message(w, now));
      updateWait(w.id, { toldAt: this.now(), untold: null });
      this.tellAfter.delete(w.id);
      this.draftLeft.delete(w.id);
      console.log(`agentbox: wait ${w.id}: told ${s.id}`);
    } catch (e) {
      const said = (e as Error).message;
      const pause = Math.min((this.tellAfter.get(w.id)?.pause ?? TELL_EVERY_MS / 2) * 2, 30 * 60_000);
      this.tellAfter.set(w.id, { at: this.now() + pause, pause });
      if (said.startsWith("not sent:")) this.draftLeft.set(w.id, this.now());
      const why = `could not type it into ${s.id}: ${said}`;
      console.error(`agentbox: wait ${w.id}: ${why}`);
      updateWait(w.id, { untold: why });
    }
  }
}

function timedOut(w: Wait, now: number): string {
  const last = w.checkedAt ? `The last look, ${span(now - w.checkedAt)} ago, found: ${w.seen ?? "nothing"}.` : "It was never looked at.";
  return `Nothing ended it in ${span(now - w.createdAt)}. ${last} If it is still worth waiting for, find out why it is taking this long before arming it again.`;
}
