import { existsSync, readFileSync, rmSync } from "node:fs";
import { getRepo, getSession, getSettings, updateSession } from "./db";
import { currentBranch, findOpenPr, repoFullNameOf } from "./git";
import { AcpRunner, messageOf, type PermissionInfo } from "./acp";
import { serveHost, PROTOCOL_VERSION, type HostServer, type HostStatus } from "./hostproto";
import { frameSupervisorMessage, writeSessionPrompt, writeWatchdog } from "./prompts";
import { onToolCall, supervisorEvents } from "./supervisor";
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
        endStreamTurn(sid);
        appendEvent(sid, { type: "turn", stopReason });
        const s = getSession(sid);
        // omp reports tokens per turn, so the session total is a running sum.
        if (s && tokens > 0) updateSession(sid, { tokens: (s.tokens ?? 0) + tokens });
        // A supervisor flag raised during the turn outranks "the turn ended".
        if (s && s.status !== "flagged") updateSession(sid, { status: "waiting", blocked: false });
        maybeLinkPr(sid);
        changed();
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
    if (verdict.state === "adrift") {
      deliver(sessionId, frameSupervisorMessage(verdict.nudge ?? verdict.reason), "supervisor");
      return;
    }
    runner?.interrupt();
    updateSession(sessionId, { status: "flagged", flagReason: verdict.reason, blocked: false });
    changed();
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
 */
function deliver(id: string, text: string, from: "human" | "supervisor"): void {
  appendEvent(id, { type: "user", text, from });
  if (from === "human") {
    const s = getSession(id);
    if (s) updateSession(id, { followUps: s.followUps + 1 });
  }
  if (!runner?.alive) throw new Error("the agent is not connected");
  runner.send(text);
  updateSession(id, { status: "running", blocked: false });
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

    const ompSessionId = await acp.launch({
      worktree: s.worktree,
      model: s.model,
      promptFile,
      advisor: settings.advisor.enabled,
      resumeSessionId: s.ompSessionId,
    });
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
