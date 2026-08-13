/** agentbox MCP server — the interface a conductor agent drives agentbox through.
 *
 * A thin HTTP client over the running agentbox server, deliberately: that one
 * process owns every omp session, and a second owner would be a second source
 * of truth about what is running.
 *
 * The tool descriptions below are this program's prompt. They are the only
 * instructions the conductor ever gets about how to run a team of cheap
 * models, so they say *when* to use a tool and what a good call looks like,
 * not just what the endpoint does.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "../version";
import type {
  Attention,
  PrInfo,
  Repo,
  Session,
  SessionDiff,
  TranscriptEvent,
} from "../core/types";

const API = process.env.AGENTBOX_API ?? "http://127.0.0.1:4479";

type Envelope<T> = { ok: boolean; data: T; error: string | null };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
  } catch (e) {
    throw new Error(
      `agentbox server is not running at ${API} — start it with \`agentbox\` ` +
        `(underlying error: ${(e as Error).message})`,
    );
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `agentbox returned a non-JSON response from ${path} (HTTP ${res.status}): ${text.slice(0, 200)}`,
    );
  }
  if (typeof body !== "object" || body === null || !("ok" in body)) {
    throw new Error(`agentbox returned an unexpected response shape from ${path} (HTTP ${res.status})`);
  }
  const env = body as Envelope<T>;
  if (!env.ok) throw new Error(env.error ?? `agentbox request failed (HTTP ${res.status})`);
  return env.data;
}

function text(value: unknown) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text" as const, text: body }] };
}

// ------------------------------------------------------------- projections

type BoardSession = Session & { attention: Attention };

/**
 * What the conductor needs to decide about a session, and nothing else —
 * every field here is paid for in its context on every board read.
 */
function sessionView(s: BoardSession | Session) {
  const attention = "attention" in s ? s.attention : null;
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    needs: attention ? attention.label : undefined,
    attention: attention ? attention.kind : undefined,
    blocked: s.blocked || undefined,
    permission: s.permission
      ? { title: s.permission.title, tool: s.permission.tool }
      : undefined,
    // The supervisor halted this run; `flagReason` is its sentence, verbatim.
    flagReason: s.flagReason ?? undefined,
    repo: s.repo,
    branch: s.branch,
    model: s.model,
    toolCalls: s.toolCalls,
    followUps: s.followUps,
    lastMessage: s.lastMessage,
    costUsd: s.costUsd,
    tokens: s.tokens,
    prNumber: s.prNumber ?? undefined,
    updatedAt: new Date(s.updatedAt).toISOString(),
  };
}

const MAX_TEXT = 600;

function clip(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} more chars]`;
}

/** Compact one transcript event. Tool output is the bulk; it gets clipped hardest. */
function eventView(e: TranscriptEvent): Record<string, unknown> {
  const base = { seq: e.seq, at: new Date(e.ts).toISOString() };
  switch (e.type) {
    case "user":
      return { ...base, type: `user:${e.from}`, text: clip(e.text) };
    case "assistant":
      return { ...base, type: "assistant", text: clip(e.text) };
    case "tool":
      return {
        ...base,
        type: "tool",
        kind: e.call.kind,
        title: e.call.title,
        status: e.call.status,
        ms: e.call.endedAt === null ? null : e.call.endedAt - e.call.startedAt,
        input: clip(JSON.stringify(e.call.input ?? null), 300),
        output: e.call.output === null ? null : clip(e.call.output, 400),
      };
    case "advisory":
      return { ...base, type: "advisory", severity: e.severity, text: clip(e.text) };
    case "permission":
      return { ...base, type: "permission", title: e.title, approved: e.approved };
    case "supervisor":
      return {
        ...base,
        type: "supervisor",
        state: e.verdict.state,
        reason: e.verdict.reason,
        source: e.verdict.source,
      };
    case "turn":
      return { ...base, type: "turn", stopReason: e.stopReason };
    case "error":
      return { ...base, type: "error", message: clip(e.message) };
  }
}

async function board() {
  return api<{
    sessions: BoardSession[];
    prs: PrInfo[];
    repos: Repo[];
    warnings: string[];
  }>("/api/state");
}

async function sessionById(id: string): Promise<BoardSession> {
  const state = await board();
  const s = state.sessions.find((x) => x.id === id);
  if (!s) throw new Error(`session not found: ${id}`);
  return s;
}

// ------------------------------------------------------------------ tools

const server = new McpServer({ name: "agentbox", version: VERSION });

server.registerTool(
  "board",
  {
    title: "The whole board in one call",
    description:
      "Read this first, and again after anything you do. Returns every live session with " +
      "the one thing it needs from you (`needs`), every open pull request, and the repos " +
      "you can spawn into.\n\n" +
      "Work the board in `attention` order — `approval` and `failed` before `flagged`, " +
      "`flagged` before `review`, `idle` last — and finish one session before starting the " +
      "next. Sessions that need nothing are working; leave them alone. If `warnings` is " +
      "non-empty a dependency is missing and some of what you see is incomplete; say so " +
      "rather than working around it silently.",
  },
  async () => {
    const st = await board();
    return text({
      // Archived sessions ride along in `HotState` so the UI can offer a
      // "show archived" toggle. They are finished work by definition, and a
      // conductor paying context for them would be paying for noise.
      sessions: st.sessions.filter((s) => s.archivedAt === null).map(sessionView),
      openPrs: st.prs
        .filter((p) => p.state === "OPEN")
        .map((p) => ({
          number: p.number,
          repo: p.repo,
          title: p.title,
          draft: p.isDraft || undefined,
          url: p.url,
          sessionId: p.sessionId,
        })),
      repos: st.repos.map((r) => ({ id: r.id, ref: r.ref, defaultBranch: r.defaultBranch })),
      warnings: st.warnings,
    });
  },
);

server.registerTool(
  "spawn_session",
  {
    title: "Start an agent on a task",
    description:
      "Cuts a fresh git worktree and starts a coding agent on `prompt`. Returns immediately; " +
      "the agent works in the background.\n\n" +
      "The prompt is the single biggest determinant of whether the run succeeds — the model " +
      "is cheap and capable but not stable, and it fails by wandering, not by refusing. A " +
      "good prompt is:\n" +
      "  • one deliverable, not a project. If you would split it into two PRs, spawn two sessions.\n" +
      "  • concrete about where: name the files, directories or symbols to change.\n" +
      "  • explicit about the acceptance criterion — the command that must pass, the output " +
      "that must change, the behaviour a human will check. Without one the agent decides for " +
      "itself when it is done, and it decides badly.\n" +
      "  • honest about what is out of scope, so it does not 'improve' adjacent code.\n\n" +
      "Bad: \"clean up the auth module\". Good: \"In src/auth/session.ts, make refreshToken() " +
      "return null instead of throwing when the token is expired, update its two callers in " +
      "src/api/, and add a test in src/auth/__tests__/session.test.ts. `bun test src/auth` must " +
      "pass. Do not touch the login flow.\"\n\n" +
      "After spawning, `wait` on it rather than polling `board` in a tight loop.",
    inputSchema: {
      repo: z
        .string()
        .describe(
          "A registered repo id, a local absolute path, or an owner/repo GitHub slug. " +
            "An unregistered path or slug is registered automatically.",
        ),
      prompt: z.string().describe("The task, written per the guidance in this tool's description."),
      model: z
        .string()
        .optional()
        .describe("omp model id. Omit to use the configured default, which is the right choice unless the task is unusually hard."),
      branch: z
        .string()
        .optional()
        .describe(
          "Work on this existing branch instead of cutting a new one — use it to send an " +
            "agent back at an open PR's head branch to address review.",
        ),
    },
  },
  async ({ repo, prompt, model, branch }) => {
    const repos = await api<Repo[]>("/api/repos");
    let target = repos.find((r) => r.id === repo || r.ref === repo);
    if (!target) {
      target = await api<Repo>("/api/repos", { method: "POST", body: JSON.stringify({ ref: repo }) });
    }
    const s = await api<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ repoId: target.id, prompt, model, branch }),
    });
    return text(sessionView(s));
  },
);

server.registerTool(
  "wait",
  {
    title: "Block until a session needs you",
    description:
      "The centre of the babysitting loop. Blocks until the session stops working — it " +
      "finished a turn, hit a permission prompt, was flagged by the supervisor, or died — " +
      "then returns its state and the tail of its transcript so you can judge what happened " +
      "without a second call.\n\n" +
      "The loop is: spawn → wait → read what it did → correct, approve, or accept → wait " +
      "again. Do not sleep-poll `board` instead; this returns the moment something changes.\n\n" +
      "On return, decide from `status`:\n" +
      "  • `blocked` — it wants permission. Read the request, then `reply_permission`.\n" +
      "  • `waiting` — the turn ended. Check `get_diff` before you believe it is done; if the " +
      "work is wrong or partial, `send_message` with a specific correction.\n" +
      "  • `flagged` — the supervisor stopped it and `flagReason` says why. Read the events, " +
      "then either `send_message` a correction and `resume_session`, or accept that it is off " +
      "the rails and delete it.\n" +
      "  • `dead` — the process vanished. `resume_session` restores the conversation.\n" +
      "  • `done` — its branch has an open PR. Review the PR.\n" +
      "  • `failed` — terminal. Read the events for the reason; a fresh session with a better " +
      "prompt usually beats trying to revive it.\n\n" +
      "A timeout is not a verdict: it means the agent is still working. Wait again, or look " +
      "at `get_events` if you suspect it is stuck in a loop.",
    inputSchema: {
      session_id: z.string(),
      timeout_seconds: z
        .number()
        .int()
        .min(1)
        .max(1800)
        .optional()
        .describe("Default 300. Long-running tasks are normal; a timeout only means 'still working'."),
    },
  },
  async ({ session_id, timeout_seconds }) => {
    const deadline = Date.now() + (timeout_seconds ?? 300) * 1000;
    // Read the transcript once up front so the poll loop only asks for what
    // arrives after it — the whole transcript is never re-read on a timer.
    const before = await api<TranscriptEvent[]>(`/api/sessions/${session_id}/events`);
    const startSeq = before.length > 0 ? before[before.length - 1]!.seq : 0;

    for (;;) {
      const s = await sessionById(session_id);
      const settled = s.blocked || (s.status !== "running" && s.status !== "spawning");
      const timedOut = Date.now() >= deadline;
      if (settled || timedOut) {
        const during = await api<TranscriptEvent[]>(`/api/sessions/${session_id}/events?since=${startSeq}`);
        // Nothing new means it settled before we started watching; the tail of
        // what was already there is the useful thing to show.
        const shown = during.length > 0 ? during : before;
        return text({
          ...sessionView(s),
          stillWorking: settled ? undefined : true,
          nextSince: shown.length > 0 ? shown[shown.length - 1]!.seq : startSeq,
          recentEvents: shown.slice(-12).map(eventView),
        });
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  },
);

server.registerTool(
  "get_events",
  {
    title: "Read what a session actually did",
    description:
      "The transcript with tool calls: what it read, what it ran, what it edited, what the " +
      "supervisor said. This is how you tell real progress from a model convincing itself it " +
      "is making progress.\n\n" +
      "Reach for it when a session is flagged, when `wait` returned something you did not " +
      "expect, or before sending a correction — a correction written without reading the tool " +
      "calls usually tells the agent to do what it already did.\n\n" +
      "Pass `since` with the last `nextSince` you were given to read only what is new. Reading " +
      "from the start every time is how you burn your own context.",
    inputSchema: {
      session_id: z.string(),
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Return only events after this seq. Use the `nextSince` from your last call."),
    },
  },
  async ({ session_id, since }) => {
    const qs = since === undefined ? "" : `?since=${since}`;
    const events = await api<TranscriptEvent[]>(`/api/sessions/${session_id}/events${qs}`);
    return text({
      count: events.length,
      nextSince: events.length > 0 ? events[events.length - 1]!.seq : (since ?? 0),
      events: events.map(eventView),
    });
  },
);

server.registerTool(
  "get_diff",
  {
    title: "The code the session has written",
    description:
      "Per-file diff of the session's worktree against the branch it was cut from. Read this " +
      "before you accept that a session is finished — an agent reporting success and an agent " +
      "having changed the right lines are different claims, and only this one is evidence.\n\n" +
      "`unavailable` means the worktree is gone or the repo could not be read; that is a real " +
      "problem to report, not an empty diff.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    const d = await api<SessionDiff>(`/api/sessions/${session_id}/diff`);
    if (d.unavailable) {
      return text({ unavailable: true, base: d.base, note: "worktree missing or unreadable" });
    }
    return text({
      base: d.base,
      additions: d.additions,
      deletions: d.deletions,
      files: d.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch === null ? "[binary]" : clip(f.patch, 4000),
      })),
    });
  },
);

server.registerTool(
  "send_message",
  {
    title: "Steer a running or waiting session",
    description:
      "Send the agent a correction, an answer, or the next step. If it is mid-turn the message " +
      "is queued and delivered when the turn ends; if it is waiting it lands now.\n\n" +
      "Correct early and specifically — a cheap model recovers from \"you edited the wrong file, " +
      "the router is in src/server/router.ts\" and does not recover from \"that's not right\". " +
      "Quote what you saw in the events or the diff.\n\n" +
      "If it is spiraling and you need it to stop *now*, `interrupt` first: a queued message " +
      "will not reach it until the current turn ends, which may be a long way off.",
    inputSchema: {
      session_id: z.string(),
      text: z.string().describe("The correction or instruction. Specific beats polite."),
    },
  },
  async ({ session_id, text: body }) => {
    const s = await api<Session>(`/api/sessions/${session_id}/message`, {
      method: "POST",
      body: JSON.stringify({ text: body }),
    });
    return text(sessionView(s));
  },
);

server.registerTool(
  "interrupt",
  {
    title: "Stop the current turn",
    description:
      "Cancels what the agent is doing right now. Reversible and cheap: the conversation, the " +
      "worktree and any queued messages all survive, and the session returns to `waiting`.\n\n" +
      "Use it the moment you see a loop — the same command three times, edits thrashing one " +
      "file — rather than letting the turn burn to its end. Follow it with `send_message` to " +
      "say what to do instead.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => text(sessionView(await api<Session>(`/api/sessions/${session_id}/interrupt`, { method: "POST" }))),
);

server.registerTool(
  "resume_session",
  {
    title: "Restart a halted session",
    description:
      "Brings a `flagged` or `dead` session back to `running` with its conversation and " +
      "worktree intact. A supervisor stop is a pause, not a verdict, and a server restart " +
      "leaves every live session `dead` — both are resumable.\n\n" +
      "Send the correction *before* you resume a flagged session. Resuming without saying what " +
      "was wrong usually resumes the same mistake.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => text(sessionView(await api<Session>(`/api/sessions/${session_id}/resume`, { method: "POST" }))),
);

server.registerTool(
  "reply_permission",
  {
    title: "Approve or deny a tool the agent asked for",
    description:
      "Answers a session that is `blocked` on a permission request and unparks it. Until you " +
      "answer, it does nothing at all.\n\n" +
      "Read the request first: the agent is asking because the action is consequential. Denying " +
      "is safe — the agent is told no and continues — so deny anything you would not do " +
      "yourself, and say why with `send_message` so it does not simply ask again.",
    inputSchema: { session_id: z.string(), approved: z.boolean() },
  },
  async ({ session_id, approved }) =>
    text(
      sessionView(
        await api<Session>(`/api/sessions/${session_id}/permission`, {
          method: "POST",
          body: JSON.stringify({ approved }),
        }),
      ),
    ),
);

server.registerTool(
  "archive_session",
  {
    title: "File a finished session off the board",
    description:
      "Hides a session you are done with. Nothing is destroyed — the transcript, the worktree " +
      "and the branch all remain, and the session can still be read by id.\n\n" +
      "Archive as soon as a session's PR is open or its work is abandoned. A board full of " +
      "finished sessions is how a real one gets missed.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    await api<Session>(`/api/sessions/${session_id}/archive`, { method: "POST" });
    return text(`archived ${session_id}`);
  },
);

server.registerTool(
  "delete_session",
  {
    title: "Destroy a session and its work",
    description:
      "UNRECOVERABLE. Kills the process, then deletes the worktree and its branch — every " +
      "uncommitted change and every commit that was never pushed is gone, and there is no undo.\n\n" +
      "Use `archive_session` unless you specifically want the code destroyed. Before deleting, " +
      "check `get_diff`: if there is work worth keeping, have the agent commit and push it " +
      "first. Deleting a session whose PR is already open is safe — the PR lives on GitHub.",
    inputSchema: { session_id: z.string() },
  },
  async ({ session_id }) => {
    await api<{ ok: true }>(`/api/sessions/${session_id}`, { method: "DELETE" });
    return text(`deleted ${session_id} — worktree and branch destroyed`);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`agentbox MCP server ${VERSION} ready (api: ${API})`);
