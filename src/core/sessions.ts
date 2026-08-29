import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  statSync, writeFileSync,
} from "node:fs";
import {
  insertSession, updateSession, getSession, listSessions,
  getRepo, getSettings,
} from "./db";
import { join } from "node:path";
import { agentboxBin, hostLogPathFor, logPathFor, sessionDirFor } from "./paths";
import { createWorktree, run } from "./git";
import { messageOf } from "./acp";
import { HostClient } from "./hostproto";
import { forgetSession } from "./supervisor";
import type { Repo, Session, TranscriptEvent } from "./types";

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
 *
 * The in-memory tail is a cache of a file that ANOTHER PROCESS may be writing.
 * A live session's log is written by its host process, and read here by the
 * server; a ring populated once at load would answer every later question with
 * a snapshot of the moment the server happened to start, which reaches the UI
 * as an agent that fell silent. So reads re-read — but only the bytes appended
 * since last time, tracked by `offset`, because a session with a few hundred
 * tool calls has a log too big to re-parse on every poll.
 *
 * Exactly one process may append to a given log. For a live session that is
 * its host: `seq` is a per-instance counter, so two appenders would hand the
 * same number to different events and clients would silently skip one.
 */
export class EventLog {
  private readonly path: string;
  private seq = 0;
  private ring: TranscriptEvent[] = [];
  private loaded = false;
  /** Bytes of `path` already folded into `ring`. Never past a partial line. */
  private offset = 0;

  constructor(path: string) {
    this.path = path;
  }

  /** Recover `seq` and the ring from disk. Without this, a restart would
   *  restart numbering at 1 and clients would silently skip events. */
  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    const { events, skipped } = this.readNew();
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

  /**
   * Fold any bytes appended since the last read into the ring.
   *
   * Stops at the last complete line: a writer mid-`append` leaves a partial
   * JSON object at the end of the file, and consuming it would both lose the
   * event and desynchronise `offset` from the line boundaries forever.
   */
  private readNew(): ReadResult {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return { events: [], skipped: 0 };
    }
    // The file shrank, so it is not the file we were reading — a session
    // resumed onto a fresh log, or the home was swapped under a test. Start over.
    if (size < this.offset) {
      this.offset = 0;
      this.ring = [];
      this.seq = 0;
    }
    if (size === this.offset) return { events: [], skipped: 0 };

    const text = readFrom(this.path, this.offset, size);
    const lastNewline = text.lastIndexOf("\n");
    // Nothing but a partial line so far; leave `offset` where it is and try
    // again on the next read, once the writer has finished it.
    if (lastNewline === -1) return { events: [], skipped: 0 };
    const complete = text.slice(0, lastNewline + 1);
    this.offset += Buffer.byteLength(complete, "utf8");
    return parseLines(complete);
  }

  /** Pick up whatever another process has appended since we last looked. */
  private refresh() {
    this.load();
    const { events } = this.readNew();
    for (const ev of events) {
      if (ev.seq > this.seq) this.seq = ev.seq;
      this.ring.push(ev);
    }
    if (this.ring.length > RING_SIZE) this.ring = this.ring.slice(-RING_SIZE);
  }

  append(body: EventBody, raw?: unknown): TranscriptEvent {
    // Not `refresh`: this instance is the log's only writer, so there is
    // nothing of anyone else's to pick up, and a stat on every assistant delta
    // is a syscall per character of streamed output.
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
    this.offset += Buffer.byteLength(JSON.stringify(line) + "\n", "utf8");
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    return event;
  }

  /**
   * Everything with `since < seq < before`, newest `limit` events last when
   * `limit` is given. Reads the file only when the request reaches back past
   * the ring.
   *
   * `before`/`limit` exist for paging: the websocket backfill caps a frame at
   * the newest few hundred, and a reader scrolling towards the beginning needs
   * the window *below* what it already holds without pulling tens of thousands
   * of events in one response.
   */
  since(since: number, opts: { before?: number; limit?: number } = {}): TranscriptEvent[] {
    this.refresh();
    const { before, limit } = opts;
    const inWindow = (e: TranscriptEvent): boolean =>
      e.seq > since && (before === undefined || e.seq < before);
    const first = this.ring[0];
    const events = !first || first.seq <= since + 1
      ? this.ring.filter(inWindow)
      : readLog(this.path).events.filter(inWindow);
    return limit === undefined || events.length <= limit ? events : events.slice(-limit);
  }

  get lastSeq(): number {
    this.refresh();
    return this.seq;
  }
}

/** Parsed events, plus how many lines we could not read — the count is what
 *  tells an unreadable history apart from an empty one. */
interface ReadResult {
  events: TranscriptEvent[];
  skipped: number;
}

/** Bytes `[from, to)` of a file, as text. Used to read only what a host has
 *  appended since the last look, instead of the whole transcript. */
function readFrom(path: string, from: number, to: number): string {
  const length = to - from;
  if (length <= 0) return "";
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, read).toString("utf8");
  } catch (err) {
    console.error(`[agentbox] event log tail read failed (${path}): ${messageOf(err)}`);
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readLog(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`[agentbox] event log read failed (${path}): ${messageOf(err)}`);
    return { events: [], skipped: 0 };
  }
  return parseLines(text);
}

function parseLines(text: string): ReadResult {
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

  /**
   * Turn boundary: the assistant message is complete. Returns the tail of
   * what the agent said this turn, so the host can tell a provider error
   * wearing an `end_turn` apart from the agent actually finishing — the
   * error text is assistant content by the time the turn ends.
   */
  endTurn(): string {
    this.flushText();
    const tail = this.liveText;
    this.liveText = "";
    return tail;
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

/**
 * Record an event against a session.
 *
 * Exported for the host process, which is the only writer of a live session's
 * log — see the note on `EventLog`. The server calls this only for sessions
 * that have no host: a spawn that failed before one existed, and the like.
 */
export function appendEvent(id: string, body: EventBody, raw?: unknown): TranscriptEvent {
  return streamOf(id).emit(body, raw);
}

/** An assistant delta, coalesced by the stream. Host-side. */
export function streamText(id: string, text: string): void {
  streamOf(id).text(text);
}

/** The assistant's message is complete. Host-side. Returns its text tail. */
export function endStreamTurn(id: string): string {
  return streamOf(id).endTurn();
}

/** Push anything held in the batch window to disk and to listeners. Host-side,
 *  on the way out: whatever the agent said last belongs in the transcript even
 *  though the flush timer never fired. */
export function flushStream(id: string): void {
  streamOf(id).flush();
}

/** The newest sequence number this session's log has reached. */
export function lastSeqOf(id: string): number {
  return streamOf(id).log.lastSeq;
}

/** Events this session recorded after `since`, bounded to `seq < before` and
 *  to the newest `limit` of that window when given. */
export function eventsOf(
  id: string,
  since = 0,
  opts: { before?: number; limit?: number } = {},
): TranscriptEvent[] {
  const s = streamOf(id);
  s.flushText(); // a reader should not be short of what has already been said
  return s.log.since(since, opts);
}

// ------------------------------------------------------------- run state

/**
 * Control connections to the host process of each live session.
 *
 * This replaced a `Map<string, AcpRunner>` — the agents themselves, on the
 * server's heap. That map was why restarting the server killed every running
 * turn, and why `reconcile` opened by declaring every live session dead. These
 * are sockets to processes that are still there, so losing them costs a
 * reconnect and nothing else.
 */
const hosts = new Map<string, HostClient>();
/** Sessions between "row inserted" and "host connected". `reconcile` must
 *  not declare these dead — they are mid-launch, not vanished. */
const launching = new Set<string>();
/** Per session, the last seq already forwarded to watching clients. The host
 *  writes the log, so the server learns what is new by re-reading from here. */
const forwarded = new Map<string, number>();

export function ompAvailable(): boolean {
  const r = run(["sh", "-lc", "command -v omp || which omp"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// ---------------------------------------------------------- host plumbing

/** Statuses that imply a live omp process, so losing one means the session is
 *  `dead`. Exported for the host, which is where a process now goes away. */
export const EXPECTS_A_PROCESS = new Set<Session["status"]>(["spawning", "running", "waiting"]);

/** How long a freshly spawned host has to open its socket before we call the
 *  launch failed. Generous: it has a database to open and a prompt to write. */
const HOST_READY_MS = 15_000;

/**
 * Adopt a host connection: wire its pushes into the server's fan-out.
 *
 * A host's `changed` push is the server's cue that the database and the log
 * have moved on. Everything the UI shows is then read back from those, so
 * there is exactly one description of a session and no chance of the socket
 * and the database disagreeing about it.
 */
function adopt(id: string, client: HostClient): HostClient {
  hosts.set(id, client);
  return client;
}

function onHostChanged(id: string, kind: "hot" | "cold") {
  pumpEvents(id);
  broadcast();
  if (kind === "cold") sessionEvents.emit("cold");
}

function onHostGone(id: string) {
  if (hosts.get(id)?.alive === false) hosts.delete(id);
  // Whatever the host wrote on its way out is the truth; the socket closing
  // is just how we find out to go and read it.
  pumpEvents(id);
  broadcast();
}

/**
 * Forward anything the host has appended to watching websocket clients.
 *
 * The events themselves never cross the control socket. The host appends to
 * the session's JSONL, says "changed", and this re-reads from the cursor —
 * which means a server that was not running when the events were written
 * catches up on them the moment it connects, by the same path.
 */
function pumpEvents(id: string) {
  const since = forwarded.get(id) ?? 0;
  const events = eventsOf(id, since);
  if (events.length === 0) return;
  forwarded.set(id, events[events.length - 1]!.seq);
  sessionEvents.emit("events", id, events);
}

/** Start where the log already is, so adopting a long-running host does not
 *  replay its entire transcript at whoever is watching. */
function markForwarded(id: string) {
  forwarded.set(id, lastSeqOf(id));
}

/**
 * Connect to a session's existing host, if it has one.
 *
 * The socket is the authority on whether a session is live. The stored
 * `hostPid` is a hint used to avoid a pointless connect attempt, never a
 * verdict: pids are reused, and a stale one naming some unrelated process
 * would otherwise read as a healthy agent.
 */
async function connectHost(id: string): Promise<HostClient | null> {
  const existing = hosts.get(id);
  if (existing?.alive) return existing;
  try {
    const client = await HostClient.connect(
      id,
      (kind) => onHostChanged(id, kind),
      () => onHostGone(id)
    );
    markForwarded(id);
    return adopt(id, client);
  } catch {
    hosts.delete(id);
    return null;
  }
}

/**
 * Spawn a host for a session and deliver `message` as its first turn.
 *
 * The host is deliberately severed from this process. Its output goes to a
 * file rather than a pipe, so it cannot die of SIGPIPE when our reader goes
 * away; and on Linux it runs under `systemd-run --user --scope` where that is
 * available, because detachment at the session level is not enough. A `setsid`
 * host still sits in the cgroup of whatever terminal launched the server, and
 * when that terminal closes systemd tears the whole scope down — taking every
 * running agent with it in one SIGKILL sweep, which is precisely how a server
 * restart once killed twelve agents mid-run despite `setsid`. A scoped host
 * gets a cgroup of its own and outlives the terminal, the server and this
 * process alike.
 *
 * Every failure path lands on the session record: a session that never started
 * is `failed`, one whose conversation still exists on omp's side is `dead` and
 * can be resumed.
 */

/**
 * Whether `systemd-run --user` is usable here; null until first checked.
 */
let sandboxed: boolean | null = null;

function hostSandbox(id: string): string[] {
  if (sandboxed === null) {
    const bus = join(process.env.XDG_RUNTIME_DIR ?? "", "bus");
    sandboxed =
      process.platform === "linux" && Bun.which("systemd-run") !== null && existsSync(bus);
  }
  return sandboxed
    ? [
        "systemd-run",
        "--user",
        "--scope",
        "--collect",
        `--unit=agentbox-host-${id.slice(0, 8)}`,
        "setsid",
      ]
    : ["setsid"];
}

async function startHost(id: string, message: string): Promise<void> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  if (!s.worktree) throw new Conflict("session has no worktree");

  launching.add(id);
  updateSession(id, { status: "spawning", blocked: false, permission: null });
  broadcast();

  let logFd: number | null = null;
  try {
    mkdirSync(sessionDirFor(id), { recursive: true });
    // On disk before the host exists, so a server that dies in the gap between
    // spawning it and it starting up still delivers the message.
    const messageFile = join(sessionDirFor(id), "first-message.txt");
    writeFileSync(messageFile, message);

    logFd = openSync(hostLogPathFor(id), "a");
    const child = Bun.spawn(
      [
        ...hostSandbox(id),
        process.execPath,
        agentboxBin(),
        "host",
        id,
        "--first-message",
        messageFile,
      ],
      {
        cwd: s.worktree,
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
        env: { ...process.env },
      }
    );
    // We do not wait on it and we do not own it. `unref` is what lets this
    // process exit while the host keeps running.
    child.unref();

    const client = await waitForHost(id);
    if (!client) throw new Error(`host did not come up within ${HOST_READY_MS}ms`);
  } catch (err) {
    const detail = messageOf(err);
    appendEvent(id, { type: "error", message: `failed to start the agent host: ${detail}` });
    updateSession(id, {
      status: s.ompSessionId ? "dead" : "failed",
      exitCode: 1,
      pid: null,
      hostPid: null,
      lastMessage: `Failed to start omp: ${detail.slice(0, 300)}`,
    });
  } finally {
    if (logFd !== null) closeSync(logFd);
    launching.delete(id);
    broadcast();
  }
}

/** Poll for the host's socket. It appears when the host is ready to be told
 *  things, which is a different and later moment than "the process exists". */
async function waitForHost(id: string): Promise<HostClient | null> {
  const deadline = Date.now() + HOST_READY_MS;
  for (;;) {
    const client = await connectHost(id);
    if (client) return client;
    if (Date.now() >= deadline) return null;
    await Bun.sleep(50);
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
    hostPid: null,
    permission: null,
    pid: null,
    prNumber: null,
    repoFullName: null,
    costUsd: null,
    tokens: null,
    blocked: false,
    flagReason: null,
    ompSessionId: null,
    subs: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    closedAt: null,
  };
  insertSession(session);

  // No `launching` bookkeeping here: everything up to `startHost`'s first
  // await is synchronous, and `startHost` claims the flag itself.
  try {
    const { path, fullName } = createWorktree(repo, id, session.branch, adopt ?? undefined);
    updateSession(id, { worktree: path, repoFullName: fullName });
    // The opening prompt is not recorded here. The host owns this session's
    // log the moment it starts, and it writes the prompt when it delivers it —
    // two processes appending would hand out the same sequence number twice.
    void startHost(id, task).catch((err: unknown) => failSetup(id, err));
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
 * process died.
 *
 * This used to take a `from` discriminating human steering from supervisor
 * nudges. The supervisor runs inside the host now and nudges its own agent
 * directly, so everything arriving here is a person.
 */
export async function sendMessage(id: string, text: string): Promise<Session> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  const body = text.trim();
  if (!body) throw new BadRequest("message is empty");
  if (launching.has(id)) throw new Conflict("session is still starting — try again in a moment");

  // The message is NOT recorded here. Whoever ends up delivering it records
  // it: a live host as it sends, or the new host started below. The server
  // appending its own line to a log the host is writing would collide on the
  // sequence number and lose one of the two events.
  const host = await connectHost(id);
  if (host) {
    try {
      await host.send(body);
    } catch (err) {
      // A host that is there but will not take the message: relaunch onto the
      // same omp conversation rather than losing it.
      appendEvent(id, { type: "error", message: `relaunching after send failed: ${messageOf(err)}` });
      await stopHost(id);
      await startHost(id, body);
    }
  } else {
    if (!s.worktree || !existsSync(s.worktree)) throw new Conflict("this session's worktree is gone");
    hosts.delete(id);
    await startHost(id, body);
  }
  broadcast();
  return getSession(id)!;
}

/**
 * Ask a session's host to stop, and stop waiting on it either way.
 *
 * The host answers by killing omp, which lands on its `onExit` and takes the
 * host down with it. A host that does not answer is already broken, and the
 * server must not block on it — dropping the client is enough for this process
 * to move on, and `reconcile` will find any real orphan later.
 */
async function stopHost(id: string): Promise<void> {
  const host = hosts.get(id);
  hosts.delete(id);
  if (!host?.alive) return;
  try {
    await host.kill();
  } catch {
    // It was already gone, or is wedged. Either way we are done with it.
  }
  host.detach();
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

  await stopHost(id);
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
  // `flagReason` is cleared only after the launch, because the system prompt
  // written during it tells the agent why it was halted. The resume
  // instruction itself is recorded by the host that delivers it.
  await startHost(id, text);
  updateSession(id, { flagReason: null });
  broadcast();
  return getSession(id)!;
}

/** Stop the current turn. The queue and the conversation both survive. */
export async function interruptSession(id: string): Promise<Session> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  const host = await connectHost(id);
  if (host) {
    await host.interrupt();
  } else if (s.status === "running" || s.status === "spawning") {
    // Nothing to interrupt: the process is already gone.
    updateSession(id, { status: "dead", pid: null, hostPid: null, blocked: false, permission: null });
  }
  broadcast();
  return getSession(id)!;
}

/**
 * Approve or deny the permission the agent is parked on.
 *
 * The prompt is read from the session row rather than from a connection,
 * because the server may never have seen the request: the host can have raised
 * it, persisted it and gone on waiting while this process was being restarted.
 * The host still holds the promise, so answering it is a message away.
 */
export async function replyPermission(id: string, approved: boolean): Promise<Session> {
  const s = getSession(id);
  if (!s) throw new NotFound(`no session ${id}`);
  const info = s.permission;
  if (!info) throw new Conflict("this session is not waiting on a permission");
  const host = await connectHost(id);
  if (!host) throw new Conflict("this session's agent is no longer running");
  // The host records the answer and clears the prompt; it is the one that
  // knows whether the agent actually accepted it.
  await host.replyPermission(info.id, approved);
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

  // Deliberately not awaited: closing is a UI action and must stay instant.
  // The host tears itself down when omp goes, and `reconcile` catches any that
  // did not hear us.
  void stopHost(id);
  streams.get(id)?.dispose();
  streams.delete(id);
  forwarded.delete(id);
  forgetSession(id);

  updateSession(id, {
    closedAt: Date.now(),
    blocked: false,
    permission: null,
    pid: null,
    hostPid: null,
    // We just killed the process, so a status that implies one is now a lie.
    // `done`, `flagged` and `failed` are verdicts about the work rather than
    // the process and are left to stand — `closedAt` is what "closed" means.
    ...(EXPECTS_A_PROCESS.has(s.status) ? { status: "dead" as const } : {}),
  });
  broadcast();
  return getSession(id);
}

/**
 * Reconcile the database against reality at startup.
 *
 * This function used to open by declaring every live session dead, on the
 * sound reasoning that the processes had died with the previous server. That
 * is no longer true and the inversion is the point of the whole change: a
 * session's agent is its own process, so the first thing to do at boot is go
 * and knock on its door.
 *
 * Only a session whose socket refuses us is genuinely gone. `hostPid` is not
 * consulted as evidence — a pid outlives the process that owned it and can be
 * reissued to something unrelated, so a stale one would resurrect a dead
 * session as convincingly as a live one keeps a real one.
 */
export async function reconcile(): Promise<void> {
  const orphans: Session[] = [];
  for (const s of listSessions(true)) {
    if (launching.has(s.id)) continue;
    if (s.closedAt !== null) continue;
    const host = await connectHost(s.id);
    if (host) continue;
    orphans.push(s);
  }

  for (const s of orphans) {
    if (EXPECTS_A_PROCESS.has(s.status)) {
      updateSession(s.id, {
        status: "dead",
        pid: null,
        hostPid: null,
        blocked: false,
        permission: null,
      });
    } else if (s.blocked || s.permission) {
      // The permission request died with the process holding it open.
      updateSession(s.id, { blocked: false, permission: null });
    } else if (s.hostPid !== null) {
      updateSession(s.id, { hostPid: null });
    }
  }
  broadcast();
}

/** Let go of every host without disturbing it. Called when the server is
 *  shutting down: the agents are not ours to take with us. */
export function detachHosts(): void {
  for (const [, host] of hosts) host.detach();
  hosts.clear();
}

/** Live control connections, for the server's status reporting. */
export function liveHostCount(): number {
  return [...hosts.values()].filter((h) => h.alive).length;
}

// ---------------------------------------------------------------- helpers

function tailText(text: string): string | null {
  const clean = text.trim().replace(/\s+/g, " ").slice(-400);
  return clean || null;
}

function titleFromPrompt(prompt: string): string {
  const one = prompt.trim().replace(/\s+/g, " ").slice(0, 72);
  return one || "Untitled session";
}
