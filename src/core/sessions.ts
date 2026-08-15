import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import {
  insertSession, updateSession, getSession, listSessions,
  getRepo, getSettings,
} from "./db";
import { logPathFor } from "./paths";
import { createWorktree, run, findOpenPr, repoFullNameOf, currentBranch } from "./git";
import { AcpRunner, messageOf, type PermissionInfo } from "./acp";
import { writeSessionPrompt, writeWatchdog, frameSupervisorMessage } from "./prompts";
import { forgetSession, onToolCall, supervisorEvents } from "./supervisor";
import type { Repo, Session, SupervisorVerdict, ToolCall, TranscriptEvent } from "./types";

/** "hot" → a session changed · "cold" → repos/prs/skills/settings changed ·
 *  "events" → (sessionId, TranscriptEvent[]) for a session's watchers. */
export const sessionEvents = new EventEmitter();
sessionEvents.setMaxListeners(0);

export function broadcast() {
  sessionEvents.emit("hot");
}

/**
 * Failures the HTTP layer has to tell apart. Anything else escaping this
 * module is a genuine fault and should be a 500 — these three are not.
 */
export class NotFound extends Error {}
/** The action is valid but the session is in the wrong state for it. */
export class Conflict extends Error {}
/** The caller's input is unusable. */
export class BadRequest extends Error {}

/** How long assistant deltas and fresh events are held before being emitted.
 *  One delta per WebSocket frame drowns the client; this is the coalescer. */
const FLUSH_MS = 200;
/** Events kept in memory per session, so the common `since` request never
 *  touches the JSONL. */
const RING_SIZE = 2000;
/** Assistant tail kept for the list row. */
const TAIL_CHARS = 4000;
/** Floor on how often one session may shell out to `gh` looking for its PR. */
const PR_CHECK_MS = 30_000;

const RESUME_MESSAGE =
  "Continue from where you left off. If the work was already finished, say so instead of redoing it.";

// -------------------------------------------------------------- event log

/** `Omit` over a union keeps only the shared keys, so it has to distribute. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A `TranscriptEvent` before the log stamps it with `seq` and `ts`. */
export type EventBody = DistributiveOmit<TranscriptEvent, "seq" | "ts">;

/** One JSONL line. `raw` holds what did not fit in the bounded event. */
interface LogLine {
  event: TranscriptEvent;
  raw?: unknown;
}

/**
 * A session's append-only event log: JSONL on disk so it survives a restart,
 * with the tail mirrored in memory so the usual "what happened since seq N"
 * question costs nothing.
 */
export class EventLog {
  private readonly path: string;
  private seq = 0;
  private ring: TranscriptEvent[] = [];
  private loaded = false;

  constructor(path: string) {
    this.path = path;
  }

  /** Recover `seq` and the ring from disk. Without this, a restart would
   *  restart numbering at 1 and clients would silently skip events. */
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    const { events, skipped } = readLog(this.path);
    for (const ev of events) {
      if (ev.seq > this.seq) this.seq = ev.seq;
      this.ring.push(ev);
    }
    if (this.ring.length > RING_SIZE) this.ring = this.ring.slice(-RING_SIZE);

    // A log with content but nothing readable is a session recorded by the old
    // build. Returning [] would reach the user as "nothing happened" — the
    // silent failure wearing the costume of an empty session. Record the fact
    // as a real event instead: it gets a seq and a cursor like any other, and
    // it is written once, because the next load then parses it and this branch
    // no longer fires.
    if (events.length === 0 && skipped > 0) {
      this.append({
        type: "error",
        message:
          `This session's history predates agentbox's structured transcript ` +
          `(${skipped} unreadable ${skipped === 1 ? "line" : "lines"}), so it cannot be replayed here. ` +
          `The task, the diff and the session's own state are unaffected.`,
      });
    }
  }

  append(body: EventBody, raw?: unknown): TranscriptEvent {
    this.load();
    const event = { seq: ++this.seq, ts: Date.now(), ...body } as TranscriptEvent;
    const line: LogLine = raw === undefined ? { event } : { event, raw };
    // A log write that fails must not take the turn down, but it does mean the
    // transcript on disk is now short of the one in memory — say so.
    try {
      appendFileSync(this.path, JSON.stringify(line) + "\n");
    } catch (err) {
      console.error(`[agentbox] event log write failed (${this.path}): ${messageOf(err)}`);
    }
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    return event;
  }

  /** Everything with `seq > since`. Reads the file only when the request
   *  reaches back past the ring. */
  since(since: number): TranscriptEvent[] {
    this.load();
    const first = this.ring[0];
    if (!first || first.seq <= since + 1) {
      return since <= 0 ? [...this.ring] : this.ring.filter((e) => e.seq > since);
    }
    return readLog(this.path).events.filter((e) => e.seq > since);
  }

  get lastSeq(): number {
    this.load();
    return this.seq;
  }
}

/** Parsed events, plus how many lines we could not read — the count is what
 *  tells an unreadable history apart from an empty one. */
interface ReadResult {
  events: TranscriptEvent[];
  skipped: number;
}

function readLog(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`[agentbox] event log read failed (${path}): ${messageOf(err)}`);
    return { events: [], skipped: 0 };
  }
  const events: TranscriptEvent[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      // A torn last line after a crash. The rest of the log is still good.
      skipped++;
      continue;
    }
    const event = (rec as LogLine | null)?.event;
    // Logs written before the event-stream format have a bare string here.
    if (event && typeof event === "object" && typeof event.seq === "number") events.push(event);
    else skipped++;
  }
  return { events, skipped };
}

/**
 * The live side of one session's stream: the log plus the batching that keeps
 * assistant deltas off the wire one character at a time.
 */
class SessionStream {
  readonly id: string;
  readonly log: EventLog;
  private pendingText = "";
  private batch: TranscriptEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Tail of the assistant's current message, for the session list row. */
  private liveText = "";

  constructor(id: string) {
    this.id = id;
    this.log = new EventLog(logPathFor(id));
  }

  /** An assistant delta. Coalesced into one event per flush window. */
  text(chunk: string) {
    if (!chunk) return;
    this.pendingText += chunk;
    this.liveText = (this.liveText + chunk).slice(-TAIL_CHARS);
    this.arm();
  }

  /** Any non-text event. Text pending before it is flushed first so the
   *  transcript keeps the order things actually happened in. */
  emit(body: EventBody, raw?: unknown): TranscriptEvent {
    this.flushText();
    const event = this.log.append(body, raw);
    this.batch.push(event);
    this.arm();
    return event;
  }

  /** Turn boundary: the assistant message is complete. */
  endTurn() {
    this.flushText();
    this.liveText = "";
  }

  flushText() {
    if (!this.pendingText) return;
    const text = this.pendingText;
    this.pendingText = "";
    this.batch.push(this.log.append({ type: "assistant", text }));
    updateSession(this.id, { lastMessage: tailText(this.liveText) });
  }

  private arm() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, FLUSH_MS);
  }

  flush() {
    this.flushText();
    if (!this.batch.length) return;
    const batch = this.batch;
    this.batch = [];
    sessionEvents.emit("events", this.id, batch);
    broadcast();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const streams = new Map<string, SessionStream>();

function streamOf(id: string): SessionStream {
  let s = streams.get(id);
  if (!s) {
    s = new SessionStream(id);
    streams.set(id, s);
  }
  return s;
}

function appendEvent(id: string, body: EventBody, raw?: unknown): TranscriptEvent {
  return streamOf(id).emit(body, raw);
}

/** Everything this session recorded after `since`. */
export function eventsOf(id: string, since = 0): TranscriptEvent[] {
  const s = streamOf(id);
  s.flushText(); // a reader should not be short of what has already been said
  return s.log.since(since);
}

// ------------------------------------------------------------- run state

const running = new Map<string, AcpRunner>();
/** Sessions between "row inserted" and "runner registered". `reconcile` must
 *  not declare these dead — they are mid-launch, not vanished. */
const launching = new Set<string>();
const lastPrCheck = new Map<string, number>();
/** Last PR-lookup failure reported per session, so a permanently broken `gh`
 *  is said once rather than at every turn boundary. */
const prLookupError = new Map<string, string>();

/** Live permission detail, if this session is parked on an approval. Only ever
 *  set while a runner is holding the request open: after a restart the session
 *  is `dead` and there is nothing to approve, so this correctly reads null. */
export function pendingPermissionOf(id: string): PermissionInfo | null {
  return running.get(id)?.permission ?? null;
}

export function ompAvailable(): boolean {
  const r = run(["sh", "-lc", "command -v omp || which omp"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// -------------------------------------------------------- runner plumbing

/** Statuses that imply a live omp process, so losing one means the session is
 *  `dead`. See the note in `onExit`. */
const EXPECTS_A_PROCESS = new Set<Session["status"]>(["spawning", "running", "waiting"]);

function makeRunner(id: string): AcpRunner {
  return new AcpRunner(
    id,
    {
      onText: (sid, text) => streamOf(sid).text(text),

      onToolStart: (sid, call) => {
        const s = getSession(sid);
        if (s) updateSession(sid, { toolCalls: s.toolCalls + 1 });
        appendEvent(sid, { type: "tool", call });
      },

      // Same `call.id` as the start event: consumers upsert on it rather than
      // rendering the call twice.
      onToolEnd: (sid, call, raw) => {
        appendEvent(sid, { type: "tool", call }, raw);
        supervise(sid, call);
      },

      onAdvisory: (sid, severity, text) => appendEvent(sid, { type: "advisory", severity, text }),

      onTurnEnd: (sid, stopReason, tokens) => {
        streamOf(sid).endTurn();
        appendEvent(sid, { type: "turn", stopReason });
        const s = getSession(sid);
        // omp reports tokens per turn, so the session total is a running sum.
        if (s && tokens > 0) updateSession(sid, { tokens: (s.tokens ?? 0) + tokens });
        // A supervisor flag raised during the turn outranks "the turn ended".
        if (s && s.status !== "flagged") updateSession(sid, { status: "waiting", blocked: false });
        maybeLinkPr(sid);
        broadcast();
      },

      // Already cumulative for the session, and it keeps climbing across a
      // resume into a new process — so it is set, not added.
      onUsage: (sid, costUsd) => {
        updateSession(sid, { costUsd });
        broadcast();
      },

      onPermission: (sid, info) => {
        appendEvent(sid, { type: "permission", title: info.title, approved: null });
        updateSession(sid, { status: "waiting", blocked: true });
        broadcast();
      },

      onError: (sid, message) => appendEvent(sid, { type: "error", message }),

      onExit: (sid, code) => {
        running.delete(sid);
        const s = getSession(sid);
        if (!s) return;
        updateSession(sid, {
          pid: null,
          blocked: false,
          exitCode: code,
          // The process is gone but the omp conversation is on disk, so this is
          // resumable rather than terminal.
          //
          // `waiting` belongs here as much as `running` does: an idle session
          // still has a live process behind it, and when that process goes away
          // the session looked untouched — still "waiting", so still no Resume
          // button, since RESUMABLE does not include it. The only way out was to
          // send a message and rely on `sendMessage`'s relaunch path.
          //
          // `flagged` and `done` are left alone deliberately. Both are verdicts
          // about the work rather than the process, and both outrank "the
          // process exited": flagged carries the reason `resumeSession` replays,
          // and done means the PR is already open.
          ...(EXPECTS_A_PROCESS.has(s.status) ? { status: "dead" as const } : {}),
        });
        broadcast();
      },
    },
    () => getSettings().autoApprove
  );
}

/**
 * Launch omp for a session and deliver `message` as its first turn.
 *
 * Every failure path lands on the session record: a session that never started
 * is `failed`, one whose conversation still exists on omp's side is `dead` and
 * can be resumed.
 */
async function startRunner(id: string, message: string): Promise<void> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  if (!s.worktree) throw new Conflict("session has no worktree");

  launching.add(id);
  const acp = makeRunner(id);
  running.set(id, acp);
  updateSession(id, { status: "spawning", blocked: false });
  broadcast();

  try {
    const repo = getRepo(s.repo);
    if (!repo) throw new Conflict(`repo is no longer registered: ${s.repo}`);
    const settings = getSettings();
    const promptFile = writeSessionPrompt(s, repo, settings);
    if (settings.advisor.enabled) writeWatchdog(s, settings);

    const ompSessionId = await acp.launch({
      worktree: s.worktree,
      model: s.model,
      promptFile,
      advisor: settings.advisor.enabled,
      resumeSessionId: s.ompSessionId,
    });
    updateSession(id, {
      ompSessionId,
      pid: acp.pid,
      status: "running",
      startedAt: s.startedAt ?? Date.now(),
    });
    acp.send(message);
  } catch (err) {
    running.delete(id);
    acp.kill();
    const detail = messageOf(err);
    appendEvent(id, { type: "error", message: `failed to start omp: ${detail}` });
    updateSession(id, {
      status: s.ompSessionId ? "dead" : "failed",
      exitCode: 1,
      pid: null,
      lastMessage: `Failed to start omp: ${detail.slice(0, 300)}`,
    });
  } finally {
    launching.delete(id);
    broadcast();
  }
}

// ------------------------------------------------------------- public API

export interface SpawnOptions {
  model?: string;
  /** Work on this existing branch instead of cutting a fresh one — how a
   *  session is attached to a PR that has none. */
  branch?: string;
}

/** Create a session: worktree, record, and a first turn carrying the task. */
export function spawnSession(repo: Repo, prompt: string, opts: SpawnOptions = {}): Session {
  const task = prompt.trim();
  if (!task) throw new BadRequest("prompt is empty");
  const settings = getSettings();
  const id = randomUUID();
  const adopt = opts.branch?.trim() || null;
  const session: Session = {
    id,
    title: titleFromPrompt(task),
    prompt: task,
    status: "spawning",
    repo: repo.ref,
    branch: adopt ?? `vk/ab-${id.slice(0, 8)}`,
    worktree: null,
    model: opts.model ?? settings.model,
    followUps: 0,
    lastMessage: null,
    toolCalls: 0,
    exitCode: null,
    pid: null,
    prNumber: null,
    repoFullName: null,
    costUsd: null,
    tokens: null,
    blocked: false,
    flagReason: null,
    ompSessionId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    closedAt: null,
  };
  insertSession(session);

  // No `launching` bookkeeping here: everything up to `startRunner`'s first
  // await is synchronous, and `startRunner` claims the flag itself.
  try {
    const { path, fullName } = createWorktree(repo, id, session.branch, adopt ?? undefined);
    updateSession(id, { worktree: path, repoFullName: fullName });
    appendEvent(id, { type: "user", text: task, from: "human" });
    void startRunner(id, task).catch((err: unknown) => failSetup(id, err));
  } catch (err) {
    failSetup(id, err);
  }
  return getSession(id)!;
}

/**
 * Cut the worktree again for a session that lost it — or never got one,
 * because the spawn is what failed. `createWorktree` already falls back to
 * adopting the branch when it exists from the first attempt.
 */
function restoreWorktree(s: Session) {
  const repo = getRepo(s.repo);
  if (!repo) throw new Conflict(`the repo this session came from is no longer registered: ${s.repo}`);
  const { path, fullName } = createWorktree(repo, s.id, s.branch);
  updateSession(s.id, { worktree: path, repoFullName: fullName });
  s.worktree = path;
}

function failSetup(id: string, err: unknown) {
  const detail = messageOf(err);
  appendEvent(id, { type: "error", message: `setup failed: ${detail}` });
  updateSession(id, {
    // `failed` means no conversation was ever opened, which is what lets the UI
    // promise that Resume re-runs the original task. Only reachable at spawn
    // today, where `ompSessionId` is always null — the guard keeps that true by
    // construction if this is ever called from a later point in the lifecycle.
    status: getSession(id)?.ompSessionId ? "dead" : "failed",
    exitCode: 1,
    lastMessage: `Setup failed: ${detail.slice(0, 300)}`,
  });
  broadcast();
}

/**
 * Steer a session. Delivered now if it is idle, queued until the turn ends if
 * it is mid-turn; either way the conversation is restarted first if the
 * process died. `from` separates human steering from supervisor nudges.
 */
export async function sendMessage(
  id: string,
  text: string,
  from: "human" | "supervisor" = "human"
): Promise<Session> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  const body = text.trim();
  if (!body) throw new BadRequest("message is empty");
  if (launching.has(id)) throw new Conflict("session is still starting — try again in a moment");

  appendEvent(id, { type: "user", text: body, from });
  if (from === "human") updateSession(id, { followUps: s.followUps + 1 });

  const acp = running.get(id);
  if (acp?.alive) {
    try {
      acp.send(body);
      updateSession(id, { status: "running", blocked: false });
    } catch (err) {
      // A runner that is present but not connected: relaunch onto the same omp
      // conversation rather than losing the message.
      appendEvent(id, { type: "error", message: `relaunching after send failed: ${messageOf(err)}` });
      acp.kill();
      running.delete(id);
      await startRunner(id, body);
    }
  } else {
    if (!s.worktree || !existsSync(s.worktree)) throw new Conflict("this session's worktree is gone");
    running.delete(id);
    await startRunner(id, body);
  }
  broadcast();
  return getSession(id)!;
}

/** Statuses Resume is offered for. `failed` is here deliberately: see the note
 *  on `resumeSession`. */
const RESUMABLE = new Set<Session["status"]>(["flagged", "dead", "failed"]);

/**
 * Resume is offered for any halted status, and separately for anything closed.
 *
 * Closing is orthogonal to status: it usually lands on `dead`, but a session
 * closed while `done` keeps `done`, and "the PR is open" is no reason to refuse
 * to reopen the conversation that produced it.
 */
export function canResume(s: Session): boolean {
  return RESUMABLE.has(s.status) || s.closedAt !== null;
}

/**
 * Bring a halted session back. This is the only route back from a restart:
 * the runner map is in-memory, so every live session is `dead` afterwards.
 *
 * It also takes `failed`, which `types.ts` calls terminal. Nothing about a
 * failed session is actually unrepeatable — a bad model id, omp missing from
 * PATH, a worktree that could not be cut — and without this the only way to
 * retry is to retype the task. That contradicts "a session that halts must be
 * resumable in one click" harder than it contradicts the word "terminal".
 */
export async function resumeSession(id: string): Promise<Session> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  if (!canResume(s)) throw new Conflict(`a ${s.status} session cannot be resumed`);

  const stale = running.get(id);
  if (stale) {
    stale.kill();
    running.delete(id);
  }
  if (!s.worktree || !existsSync(s.worktree)) restoreWorktree(s);
  // Resuming a closed session brings it back onto the board. Leaving it hidden
  // would start a run nothing lists.
  updateSession(id, { blocked: false, closedAt: null });

  // With an omp session id the conversation is intact and we only need to say
  // "carry on". Without one the agent never got as far as a conversation, so
  // the original task is the only thing worth sending.
  let text = s.prompt;
  if (s.ompSessionId) {
    text = s.flagReason ? `${RESUME_MESSAGE}\n\nYou were halted because: ${s.flagReason}` : RESUME_MESSAGE;
  }
  appendEvent(id, { type: "user", text, from: "human" });
  // `flagReason` is cleared only after the launch, because the system prompt
  // written during it tells the agent why it was halted.
  await startRunner(id, text);
  updateSession(id, { flagReason: null });
  broadcast();
  return getSession(id)!;
}

/** Stop the current turn. The queue and the conversation both survive. */
export async function interruptSession(id: string): Promise<Session> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  const acp = running.get(id);
  if (acp?.alive) {
    acp.interrupt();
  } else if (s.status === "running" || s.status === "spawning") {
    // Nothing to interrupt: the process is already gone.
    updateSession(id, { status: "dead", pid: null, blocked: false });
  }
  broadcast();
  return getSession(id)!;
}

/** Approve or deny the permission the agent is parked on. */
export async function replyPermission(id: string, approved: boolean): Promise<Session> {
  const acp = running.get(id);
  const info = acp?.permission;
  if (!acp || !info) throw new Conflict("this session is not waiting on a permission");
  acp.replyPermission(info.id, approved);
  appendEvent(id, { type: "permission", title: info.title, approved });
  updateSession(id, { status: approved ? "running" : "waiting", blocked: false });
  broadcast();
  return getSession(id)!;
}

/** Halt a session for a human to look at. Called by the supervisor. */
export function flagSession(id: string, reason: string): void {
  // The session can have been deleted while the judge was thinking.
  if (!getSession(id)) return;
  updateSession(id, { status: "flagged", flagReason: reason });
  broadcast();
}

/**
 * Put a session away: stop its process, drop its in-memory state, hide it from
 * the board. Everything durable survives — the record, the log, the branch and
 * the worktree — so a closed session resumes like any other halted one.
 *
 * This replaced a pair of actions, Archive (a flag and nothing else) and Delete
 * (which also destroyed the worktree, the branch and the log). The pair asked
 * the wrong question. "I am done looking at this" is the common case and it was
 * only served by the option that leaked a checkout per session — a gigabyte
 * each on a real repo — while the option that reclaimed the disk also threw
 * away the branch, which is the one thing that makes a session resumable.
 * Reclaiming disk is now its own deliberate act, in Settings, over worktrees
 * rather than sessions.
 */
export function closeSession(id: string): Session | null {
  const s = getSession(id);
  if (!s) return null;

  const acp = running.get(id);
  if (acp) acp.kill();
  running.delete(id);
  streams.get(id)?.dispose();
  streams.delete(id);
  lastPrCheck.delete(id);
  prLookupError.delete(id);
  forgetSession(id);

  updateSession(id, {
    closedAt: Date.now(),
    blocked: false,
    pid: null,
    // We just killed the process, so a status that implies one is now a lie.
    // `done`, `flagged` and `failed` are verdicts about the work rather than
    // the process and are left to stand — `closedAt` is what "closed" means.
    ...(EXPECTS_A_PROCESS.has(s.status) ? { status: "dead" as const } : {}),
  });
  broadcast();
  return getSession(id);
}

/**
 * Reconcile the database against reality at startup: anything the record calls
 * live that we are not actually running died with the previous process.
 */
export function reconcile() {
  for (const s of listSessions(true)) {
    if (running.has(s.id) || launching.has(s.id)) continue;
    if (s.status === "running" || s.status === "spawning") {
      updateSession(s.id, { status: "dead", pid: null, blocked: false });
    } else if (s.blocked) {
      // The permission request died with the process holding it open.
      updateSession(s.id, { blocked: false });
    }
  }
}

// ------------------------------------------------------------- supervisor

function supervise(id: string, call: ToolCall) {
  const s = getSession(id);
  if (!s) return;
  try {
    onToolCall(s, call);
  } catch (err) {
    // Supervision is advisory. It may never take a session down.
    appendEvent(id, { type: "error", message: `supervisor failed: ${messageOf(err)}` });
  }
}

supervisorEvents.on("verdict", (sessionId: string, verdict: SupervisorVerdict) => {
  try {
    appendEvent(sessionId, { type: "supervisor", verdict });
    if (verdict.state === "ok") return;
    void (async () => {
      if (verdict.state === "adrift") {
        await sendMessage(sessionId, frameSupervisorMessage(verdict.nudge ?? verdict.reason), "supervisor");
      } else {
        await interruptSession(sessionId);
        flagSession(sessionId, verdict.reason);
      }
    })().catch((err: unknown) => {
      appendEvent(sessionId, { type: "error", message: `supervisor action failed: ${messageOf(err)}` });
    });
  } catch (err) {
    console.error(`[agentbox] verdict handling failed for ${sessionId}: ${messageOf(err)}`);
  }
});

// ---------------------------------------------------------------- helpers

/**
 * Look for an open PR on this session's branch, at most once per
 * `PR_CHECK_MS`. `gh` is a subprocess, so this deliberately never runs on a
 * broadcast path — only at a turn boundary, and only for a session that has
 * done enough to have opened something.
 */
function maybeLinkPr(id: string) {
  const s = getSession(id);
  if (!s || s.prNumber !== null || s.toolCalls === 0) return;
  if (!s.worktree || !existsSync(s.worktree)) return;
  const last = lastPrCheck.get(id) ?? 0;
  if (Date.now() - last < PR_CHECK_MS) return;
  lastPrCheck.set(id, Date.now());

  const fullName = s.repoFullName ?? repoFullNameOf(s.worktree);
  if (!fullName) return; // no GitHub remote — there is no PR to find

  const pr = findOpenPr(fullName, currentBranch(s.worktree) || s.branch);
  if (!pr.ok) {
    // `gh` is missing or unauthenticated. Without this the session just never
    // reaches `done` and nothing says why. Reported once per distinct error,
    // because the check runs at every turn boundary and a broken `gh` stays
    // broken — a transcript of the same line forever is not legibility.
    if (prLookupError.get(id) !== pr.error) {
      prLookupError.set(id, pr.error);
      appendEvent(id, { type: "error", message: `Could not check for a pull request: ${pr.error}` });
    }
    return;
  }
  prLookupError.delete(id);
  if (pr.number === null) return; // no open PR on this branch yet

  updateSession(id, {
    prNumber: pr.number,
    repoFullName: fullName,
    // An open PR is the one "it finished the job" signal we get — but not at
    // the cost of hiding a session that is flagged or failed.
    ...(s.status === "waiting" ? { status: "done" as const } : {}),
  });
  broadcast();
  // Discovery only — never per turn or per lookup attempt. state.ts rescans
  // the PR list on this, and that scan shells out to `gh`.
  sessionEvents.emit("cold");
}

function tailText(text: string): string | null {
  const clean = text.trim().replace(/\s+/g, " ").slice(-400);
  return clean || null;
}

function titleFromPrompt(prompt: string): string {
  const one = prompt.trim().replace(/\s+/g, " ").slice(0, 72);
  return one || "Untitled session";
}
