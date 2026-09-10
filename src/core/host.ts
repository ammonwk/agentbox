import { existsSync, readFileSync, rmSync } from "node:fs";
import { getRepo, getSession, getSettings, updateSession } from "./db";
import { currentBranch, findOpenPr, repoFullNameOf } from "./git";
import { AcpRunner, messageOf, type PermissionInfo } from "./acp";
import { serveHost, steerSocketPath, PROTOCOL_VERSION, type HostServer, type HostStatus } from "./hostproto";
import { frameSupervisorMessage, writeSessionPrompt, writeWatchdog } from "./prompts";
import { onToolCall, supervisorEvents } from "./supervisor";
import { isProviderError } from "./provider-error";
import {
  EXPECTS_A_PROCESS,
  appendEvent,
  flushStream,
  sessionEvents,
  streamText,
  endStreamTurn,
} from "./sessions";
import type { Session, SupervisorVerdict, ToolCall } from "./types";

/**
 * One session's host process: the thing that actually owns an agent.
 *
 * agentbox's web server used to spawn `omp acp` itself and hold the ACP
 * connection on its own heap, which made every agent a dependent of a process
 * you restart to ship a change. Editing a file killed live turns. Now the
 * server spawns one of these per session and talks to it over a unix socket:
 * the host owns the omp child, writes the transcript and the session row, and
 * outlives any number of servers.
 *
 * Everything durable is written here rather than sent anywhere. The server is
 * a reader of the same database and the same event log — see hostproto.ts for
 * why the wire carries commands only.
 */

/**
 * How long `omp acp` gets to start and negotiate before the session is failed.
 *
 * Nothing else in this path has a deadline. `AcpRunner.launch` resolves on
 * success and rejects on failure, but never on time, and the ACP SDK has no
 * request timeout of its own — so an omp that starts, holds its stdio open and
 * simply never answers `initialize` parks this await forever.
 *
 * Nothing downstream notices, which is what makes it worth a timer rather than
 * a comment. `HOST_READY_MS` times the control socket appearing, and this host
 * bound that before it got here. `reconcile` asks the socket whether the host
 * is alive, and it answers cheerfully. The supervisor runs off tool calls, and
 * there are none. So the session sits in `spawning` with a "Starting…" row,
 * across restarts, until somebody closes it by hand.
 *
 * Generous, because a cold start that fetches a model config is legitimately
 * slow and a false failure here costs a real session. Finite, because "wedged
 * forever with no error" is not a state a user can act on.
 */
const LAUNCH_TIMEOUT_MS = 120_000;

/** Fail a launch that never finishes, rather than awaiting it forever. */
async function withLaunchDeadline<T>(launch: Promise<T>, model: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      launch,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `omp did not finish starting within ${LAUNCH_TIMEOUT_MS / 1000}s ` +
                  `(model ${model}). Check that \`omp acp\` runs by hand and that its ` +
                  `model is configured.`,
              ),
            ),
          LAUNCH_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // The losing promise stays live; an unhandled rejection from a launch that
    // fails after we stopped waiting would take the host down.
    launch.catch(() => {});
  }
}

/** Floor on how often one session may shell out to `gh` looking for its PR. */
const PR_CHECK_MS = 30_000;

let lastPrCheck = 0;
/** Last PR-lookup failure, so a permanently broken `gh` is reported once
 *  rather than at every turn boundary. */
let lastPrError: string | null = null;

let runner: AcpRunner | null = null;
let control: HostServer | null = null;
/** Resolves when omp has exited and the host may leave. */
let done: (() => void) | null = null;

function note(id: string, message: string) {
  appendEvent(id, { type: "error", message });
}

/**
 * Wire the ACP connection to the database and the event log.
 *
 * These callbacks used to run in the web server. They are unchanged in
 * substance — they write through the same functions to the same places — and
 * that is the point: the transcript, cost, tokens and status were already
 * durable, so moving the connection into its own process changed where the
 * writes happen from, not what a reader sees.
 */
function makeRunner(id: string): AcpRunner {
  return new AcpRunner(
    id,
    {
      onText: (sid, text) => streamText(sid, text),

      onToolStart: (sid, call) => {
        const s = getSession(sid);
        if (s) updateSession(sid, { toolCalls: s.toolCalls + 1 });
        // The dispatch call's own start event lands below; the board row reads
        // the session's snapshot, so it is updated alongside.
        if (call.subs) updateSession(sid, { subs: call.subs });
        appendEvent(sid, { type: "tool", call });
      },

      // Same `call.id` as the start event: consumers upsert on it rather than
      // rendering the call twice.
      onToolEnd: (sid, call, raw) => {
        if (call.subs) {
          updateSession(sid, { subs: call.subs });
          subsForwarded.delete(subsKey(sid, call.id));
        }
        appendEvent(sid, { type: "tool", call }, raw);
        supervise(sid, call);
      },

      // Live subagent progress, throttled: omp emits a snapshot per subagent
      // tool execution, which on a wide fan-out is many per minute. The
      // transcript needs the rhythm of the fan-out, not every heartbeat —
      // but a changed snapshot always lands eventually, because the next one
      // after the quiet window carries it.
      onToolUpdate: (sid, call) => forwardSubs(sid, call),

      onAdvisory: (sid, severity, text) => appendEvent(sid, { type: "advisory", severity, text }),

      onTurnEnd: (sid, stopReason) => {
        // The tail of what the agent just said — a provider error is the
        // turn's assistant message by the time `end_turn` arrives, so this
        // is where an interrupted turn is recognisable.
        const turnText = endStreamTurn(sid);
        appendEvent(sid, { type: "turn", stopReason });
        const s = getSession(sid);
        // A supervisor flag raised during the turn outranks "the turn ended".
        if (s && s.status !== "flagged") updateSession(sid, { status: "waiting", blocked: false });
        onTurnSettled(sid, stopReason, turnText);
        maybeLinkPr(sid);
        changed();
      },

      // A message sent mid-turn has reached the agent; the transcript showed
      // it as queued until now.
      onDelivered: (sid, refs) => {
        appendEvent(sid, { type: "delivered", refs });
        changed();
      },

      // Context occupancy, not work done: `used` is what is in the window right
      // now, so it is set rather than added, and it falls after a resume into a
      // new process as soon as omp reports again.
      onContext: (sid, used) => {
        if (used > 0) updateSession(sid, { tokens: used });
      },

      // Already cumulative for the session, and it keeps climbing across a
      // resume into a new process — so it is set, not added.
      onUsage: (sid, costUsd) => {
        updateSession(sid, { costUsd });
        changed();
      },

      onPermission: (sid, info) => {
        appendEvent(sid, { type: "permission", title: info.title, approved: null });
        // The prompt is persisted, not just held on the connection. A server
        // restarted while an agent sits on an approval must be able to show
        // the question it is blocked on — the host is still holding the
        // promise that answers it, and without this the only record of what
        // was asked died with the previous server.
        updateSession(sid, { status: "waiting", blocked: true, permission: info });
        changed();
      },

      onError: (sid, message) => appendEvent(sid, { type: "error", message }),

      onExit: (sid, code) => {
        cancelAutoContinue(sid);
        const s = getSession(sid);
        if (s) {
          updateSession(sid, {
            pid: null,
            hostPid: null,
            blocked: false,
            permission: null,
            exitCode: code,
            // The process is gone but the omp conversation is on disk, so this
            // is resumable rather than terminal.
            //
            // `flagged` and `done` are left alone deliberately. Both are
            // verdicts about the work rather than the process, and both
            // outrank "the process exited": flagged carries the reason
            // `resumeSession` replays, and done means the PR is already open.
            ...(EXPECTS_A_PROCESS.has(s.status) ? { status: "dead" as const } : {}),
          });
        }
        changed();
        // The host exists to hold this one connection. With omp gone there is
        // nothing left to own, and lingering would leave a socket that answers
        // for an agent that is not there.
        done?.();
      },
    },
    () => getSettings().autoApprove
  );
}

/** Tell every connected server that the database and log have moved on. */
function changed() {
  control?.broadcastChanged();
}

// ------------------------------------------------------------- subagents

/** How often one call's live subagent snapshot may reach the transcript. */
const SUBS_MIN_INTERVAL_MS = 2_000;
/** Per call, the snapshot last appended and when — the throttle's memory. */
const subsForwarded = new Map<string, { sig: string; at: number }>();

function subsKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`;
}

/**
 * Append a still-running call's subagent snapshot, at most one per
 * `SUBS_MIN_INTERVAL_MS` and only when it actually changed. The session row
 * is updated with it, so the board's subagent line moves with the same
 * rhythm as the transcript.
 */
function forwardSubs(sessionId: string, call: ToolCall) {
  if (!call.subs) return;
  const key = subsKey(sessionId, call.id);
  const sig = JSON.stringify(call.subs);
  const last = subsForwarded.get(key);
  if (last && (last.sig === sig || Date.now() - last.at < SUBS_MIN_INTERVAL_MS)) return;
  subsForwarded.set(key, { sig, at: Date.now() });
  updateSession(sessionId, { subs: call.subs });
  appendEvent(sessionId, { type: "tool", call });
}

// ------------------------------------------------------------- supervisor

function supervise(id: string, call: ToolCall) {
  const s = getSession(id);
  if (!s) return;
  try {
    onToolCall(s, call);
  } catch (err) {
    // Supervision is advisory. It may never take a session down.
    note(id, `supervisor failed: ${messageOf(err)}`);
  }
}

/**
 * The supervisor's verdicts, acted on locally.
 *
 * Every verdict the judge can produce keeps the run going: `ok` does nothing,
 * `nudge` sends one corrective message. There used to be a third state that
 * interrupted the agent and flagged the session for a human; it is gone —
 * the watcher's only lever now is a message, so it can steer but never stop.
 *
 * This listener used to live in the server and reach for the session API to
 * steer or halt an agent. In the host there is no indirection to go through:
 * the runner is right here, and routing a nudge back out through a socket to
 * the server so it could send it back would be a round trip through a process
 * that may not currently exist.
 */
supervisorEvents.on("verdict", (sessionId: string, verdict: SupervisorVerdict) => {
  try {
    appendEvent(sessionId, { type: "supervisor", verdict });
    if (verdict.state === "ok") return;
    deliver(sessionId, frameSupervisorMessage(verdict.nudge ?? verdict.reason), "supervisor");
  } catch (err) {
    console.error(`[agentbox host] verdict handling failed for ${sessionId}: ${messageOf(err)}`);
  }
});

// --------------------------------------------------------------- pull request

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
  if (Date.now() - lastPrCheck < PR_CHECK_MS) return;
  lastPrCheck = Date.now();

  const fullName = s.repoFullName ?? repoFullNameOf(s.worktree);
  if (!fullName) return; // no GitHub remote — there is no PR to find

  const pr = findOpenPr(fullName, currentBranch(s.worktree) || s.branch);
  if (!pr.ok) {
    // `gh` is missing or unauthenticated. Without this the session just never
    // reaches `done` and nothing says why. Reported once per distinct error,
    // because the check runs at every turn boundary and a broken `gh` stays
    // broken — a transcript of the same line forever is not legibility.
    if (lastPrError !== pr.error) {
      lastPrError = pr.error;
      note(id, `Could not check for a pull request: ${pr.error}`);
    }
    return;
  }
  lastPrError = null;
  if (pr.number === null) return; // no open PR on this branch yet

  updateSession(id, {
    prNumber: pr.number,
    repoFullName: fullName,
    // An open PR is the one "it finished the job" signal we get — but not at
    // the cost of hiding a session that is flagged or failed.
    ...(s.status === "waiting" ? { status: "done" as const } : {}),
  });
  // Discovery only — never per turn or per lookup attempt. The server rescans
  // its PR list on this, and that scan shells out to `gh`.
  control?.broadcastCold();
}

// ---------------------------------------------------------------- messages

/**
 * Put a message to the agent, recording it first.
 *
 * The event is appended here rather than by the caller because the host is the
 * event log's only writer: a server that appended its own "user" line would be
 * handing out sequence numbers from a counter the host knows nothing about,
 * and one of the two events would silently take the other's place.
 *
 * Mid-turn the message is not in the agent's context yet: it arrives at the
 * agent's next tool call (`AcpRunner.steer`), and the event says it is queued
 * until the runner reports it delivered. Without that, a message the agent
 * has not seen reads exactly like one it saw and ignored.
 */
function deliver(id: string, text: string, from: "human" | "supervisor" | "auto"): void {
  // A human message is the human taking over; a scheduled continue would only
  // double-steer five minutes later.
  if (from === "human") cancelAutoContinue(id);
  const queued = !!runner?.midTurn;
  const event = appendEvent(id, { type: "user", text, from, ...(queued ? { queued } : {}) });
  if (from === "human") {
    const s = getSession(id);
    if (s) updateSession(id, { followUps: s.followUps + 1 });
  }
  if (!runner?.alive) throw new Error("the agent is not connected");
  runner.steer(text, event.seq);
  updateSession(id, { status: "running", blocked: false });
  changed();
}

// ------------------------------------------------------------ auto-continue

/**
 * A provider error (rate limit, 429, overloaded) ends an omp turn as a normal
 * `end_turn` — the error text is the turn's assistant message — so the session
 * lands on `waiting` looking finished when it died mid-task. Left alone it sits
 * there until a human notices and types "Continue", which the logs show
 * happening again and again. This is that "Continue", on a delay: long enough
 * for a rate-limit window to cool off, short enough that the session is not
 * abandoned for the night.
 */
const CONTINUE_DELAY_MS = 5 * 60_000;
/** Consecutive interrupted turns auto-continued before giving up and saying
 *  so. A provider that stays down must not be polled forever. */
const MAX_AUTO_CONTINUES = 5;

// The one definition lives in its own module: the web client imports the same
// function to decide when a prompt gets a Retry button, and importing host.ts
// from the browser bundle would drag the server's database with it.
export { isProviderError } from "./provider-error";

interface ContinueState {
  /** Pending timer, when a continue is scheduled. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Interrupted turns continued in a row; reset by any genuine turn end or a
   *  human message. */
  streak: number;
}

const continues = new Map<string, ContinueState>();

function continueStateFor(id: string): ContinueState {
  let st = continues.get(id);
  if (!st) {
    st = { timer: null, streak: 0 };
    continues.set(id, st);
  }
  return st;
}

function cancelAutoContinue(id: string): void {
  const st = continues.get(id);
  if (st?.timer) clearTimeout(st.timer);
  continues.delete(id);
}

/**
 * A turn ended. If it was cut short by a provider error, schedule one
 * "Continue." after the cooldown; anything else — a genuine end, a human
 * taking over — tears the watch down and starts the streak over.
 */
function onTurnSettled(id: string, stopReason: string, turnText: string): void {
  const interrupted = stopReason === "error" || isProviderError(turnText);
  const s = getSession(id);
  if (!interrupted || !s || s.closedAt !== null || s.status !== "waiting") {
    cancelAutoContinue(id);
    return;
  }

  const st = continueStateFor(id);
  if (st.timer) clearTimeout(st.timer);
  if (st.streak >= MAX_AUTO_CONTINUES) {
    appendEvent(id, {
      type: "error",
      message:
        `Interrupted by a provider error ${st.streak} times in a row and auto-continued ` +
        `each time; not continuing again on its own. Send it a message when you are ready.`,
    });
    continues.delete(id);
    return;
  }
  st.timer = setTimeout(() => {
    st.timer = null;
    fireAutoContinue(id);
  }, CONTINUE_DELAY_MS);
  st.timer.unref?.();
}

function fireAutoContinue(id: string): void {
  const st = continues.get(id);
  if (!st) return;
  const s = getSession(id);
  // The five minutes are a window, not a claim: the human may have steered,
  // resumed or closed the session, or another turn may have started and
  // genuinely finished. Only an untouched `waiting` session is still the one
  // that was interrupted.
  if (!s || s.closedAt !== null || s.status !== "waiting" || s.blocked) {
    continues.delete(id);
    return;
  }
  if (!runner?.alive) {
    continues.delete(id);
    return;
  }
  st.streak += 1;
  try {
    deliver(id, "Continue.", "auto");
  } catch (err) {
    appendEvent(id, { type: "error", message: `auto-continue failed: ${messageOf(err)}` });
    continues.delete(id);
    return;
  }
  appendEvent(id, {
    type: "error",
    message:
      `Its last turn was cut short by a provider error; "Continue." was sent ` +
      `automatically after a 5-minute cooldown (attempt ${st.streak} of ${MAX_AUTO_CONTINUES}).`,
  });
  changed();
}

// -------------------------------------------------------------------- main

/**
 * Run a session's agent to completion. Resolves with a process exit code.
 *
 * `firstMessagePath` is a file rather than an argument: it carries the opening
 * prompt (or a resume instruction), and passing it out of band means the
 * message is on disk before the host starts. A server that dies in the gap
 * between spawning the host and telling it what to do therefore loses nothing.
 */
export async function runHost(sessionId: string, firstMessagePath: string | null): Promise<number> {
  const s = getSession(sessionId);
  if (!s) {
    console.error(`[agentbox host] no session ${sessionId}`);
    return 1;
  }
  if (!s.worktree) {
    console.error(`[agentbox host] session ${sessionId} has no worktree`);
    return 1;
  }

  const acp = makeRunner(sessionId);
  runner = acp;

  // Claim the session before launching. A server reconnecting mid-launch has
  // to find a host here, or it will conclude the session died and mark a
  // perfectly healthy agent dead underneath itself.
  updateSession(sessionId, {
    hostPid: process.pid,
    status: "spawning",
    blocked: false,
    permission: null,
  });

  control = serveHost(
    sessionId,
    {
      status: (): HostStatus => ({
        protocol: PROTOCOL_VERSION,
        sessionId,
        hostPid: process.pid,
        agentPid: acp.pid,
        ompSessionId: acp.ompSession,
        alive: acp.alive,
        permission: acp.permission,
      }),
      send: (text) => deliver(sessionId, text, "human"),
      interrupt: () => {
        acp.interrupt();
        updateSession(sessionId, { blocked: false, permission: null });
        changed();
      },
      permission: (permId, approved) => {
        const info: PermissionInfo | null = acp.permission;
        if (!info || info.id !== permId) throw new Error("that permission is no longer pending");
        acp.replyPermission(permId, approved);
        appendEvent(sessionId, { type: "permission", title: info.title, approved });
        updateSession(sessionId, {
          status: approved ? "running" : "waiting",
          blocked: false,
          permission: null,
        });
        changed();
      },
      kill: () => {
        acp.kill();
        // Normally the exit arrives on its own and takes the host down with
        // it. These are the two ways it might not: there was never a process
        // to exit, or omp is refusing to die. Neither may leave a host running
        // for an agent that is gone, answering a socket on its behalf.
        if (!acp.alive) done?.();
        else setTimeout(() => done?.(), 5000).unref();
      },
    },
    (message) => note(sessionId, message)
  );

  // The stream batches assistant deltas and emits locally when it flushes;
  // forwarding that to connected servers is what turns a write here into a
  // repaint there. Coalescing is already done upstream, so this is one small
  // frame per flush window rather than one per token.
  sessionEvents.on("events", () => changed());

  const exited = new Promise<void>((resolve) => {
    done = resolve;
  });

  try {
    const repo = getRepo(s.repo);
    if (!repo) throw new Error(`repo is no longer registered: ${s.repo}`);
    const settings = getSettings();
    const promptFile = writeSessionPrompt(s, repo, settings);
    if (settings.advisor.enabled) writeWatchdog(s, settings);

    const ompSessionId = await withLaunchDeadline(
      acp.launch({
        worktree: s.worktree,
        model: s.model,
        promptFile,
        advisor: settings.advisor.enabled,
        resumeSessionId: s.ompSessionId,
        steerSocket: steerSocketPath(sessionId),
      }),
      s.model,
    );
    updateSession(sessionId, {
      ompSessionId,
      pid: acp.pid,
      status: "running",
      startedAt: s.startedAt ?? Date.now(),
    });
    changed();

    const first = takeFirstMessage(firstMessagePath);
    if (first) {
      // Not `deliver`: the opening prompt and a resume instruction are not
      // follow-ups, and counting them as steering would make every session
      // read as having been corrected once before it started.
      appendEvent(sessionId, { type: "user", text: first, from: "human" });
      acp.send(first);
    }
  } catch (err) {
    const detail = messageOf(err);
    note(sessionId, `failed to start omp: ${detail}`);
    updateSession(sessionId, {
      status: s.ompSessionId ? "dead" : "failed",
      exitCode: 1,
      pid: null,
      hostPid: null,
      lastMessage: `Failed to start omp: ${detail.slice(0, 300)}`,
    });
    acp.kill();
    shutdown(sessionId);
    return 1;
  }

  await exited;
  shutdown(sessionId);
  return 0;
}

function shutdown(sessionId: string) {
  // Anything the stream was holding back belongs in the log before we go.
  try {
    flushStream(sessionId);
  } catch {
    // Nothing left to save it for.
  }
  control?.shutdown();
  control = null;
}

/** Read the opening message and remove it, so a resumed session does not
 *  replay the prompt it already answered. */
function takeFirstMessage(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    rmSync(path, { force: true });
    return text.trim() ? text : null;
  } catch (err) {
    console.error(`[agentbox host] could not read first message: ${messageOf(err)}`);
    return null;
  }
}

/** Exposed for the CLI's benefit: a session the host cannot serve. */
export function hostPreflight(sessionId: string): Session | null {
  return getSession(sessionId);
}
