/** The agentbox HTTP + WebSocket server.
 *
 * One process owns every omp session; the web UI and the MCP server are both
 * clients of this API. Two rules from DESIGN.md shape the whole file:
 *
 *   1. `gh` never runs on a broadcast path. State is split into `hot`
 *      (sessions, cheap, pushed on change) and `cold` (repos/prs/skills/
 *      settings, expensive, cached by state.ts and pushed only when it moves).
 *   2. The transcript is never re-read whole on a timer. A client `watch`es
 *      one session and receives increments.
 */

import type { ServerWebSocket } from "bun";
import { DEFAULT_PORT, webDist } from "../core/paths";
import {
  getAppState,
  getColdState,
  getHotState,
  refreshCold,
  startColdRefresh,
  stateEvents,
} from "../core/state";
import {
  BadRequest,
  Conflict,
  NotFound,
  archiveSession,
  destroySession,
  eventsOf,
  interruptSession,
  reconcile,
  replyPermission,
  resumeSession,
  sendMessage,
  sessionEvents,
  spawnSession,
} from "../core/sessions";
import { diffOf } from "../core/diff";
import {
  addRepo,
  deleteRepo,
  getRepoById,
  getSession,
  getSettings,
  listRepos,
  mergeSettings,
  saveSettings,
} from "../core/db";
import { dependencies } from "../deps";
import { VERSION } from "../version";
import type { ColdState, ServerMessage, Session, TranscriptEvent } from "../core/types";
import { HttpError, Router, fail, json, readBody } from "./router";
import {
  optionalString,
  parseSettingsPatch,
  requireBoolean,
  requireString,
  sinceParam,
} from "./validate";
import { parseClientMessage } from "./protocol";
import { fileResponse, notBuiltPage, resolveStatic } from "./static";

const PORT = Number(process.env.AGENTBOX_PORT ?? DEFAULT_PORT);
const HOST = process.env.AGENTBOX_HOST ?? "127.0.0.1";

/** How long session changes are batched before a `hot` push. DESIGN.md. */
const HOT_COALESCE_MS = 250;

/**
 * Most events a `watch` backfill will send in one frame. A long run can hold
 * tens of thousands; the newest few hundred are what a person opening the
 * transcript is looking at, and the client can always widen with
 * `GET /api/sessions/:id/events?since=`.
 */
const MAX_BACKFILL = 500;

// ------------------------------------------------------------- websocket

/** A socket watches at most one session's event stream. */
type SocketState = { watching: string | null };
type Socket = ServerWebSocket<SocketState>;

const clients = new Set<Socket>();

function send(ws: Socket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) {
    clients.delete(ws);
    return;
  }
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    // The socket died between the readyState check and the write. Drop it
    // rather than letting a corpse accumulate in the broadcast set.
    clients.delete(ws);
    console.error(`[ws] dropping a dead socket: ${(e as Error).message}`);
  }
}

function broadcast(msg: ServerMessage): void {
  for (const ws of [...clients]) send(ws, msg);
}

let hotTimer: ReturnType<typeof setTimeout> | null = null;

/** Coalesce a burst of session changes into one push. */
function scheduleHot(): void {
  if (hotTimer) return;
  hotTimer = setTimeout(() => {
    hotTimer = null;
    if (clients.size === 0) return;
    broadcast({ type: "hot", state: getHotState() });
  }, HOT_COALESCE_MS);
}

function onCold(state: ColdState): void {
  broadcast({ type: "cold", state });
}

function onSessionEvents(sessionId: string, events: TranscriptEvent[]): void {
  if (events.length === 0) return;
  for (const ws of [...clients]) {
    if (ws.data.watching === sessionId) send(ws, { type: "events", sessionId, events });
  }
}

function handleClientMessage(ws: Socket, raw: string | Buffer): void {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    send(ws, { type: "error", message: parsed.error });
    return;
  }
  const msg = parsed.message;
  if (msg.type === "ping") return;

  // Watching a new session replaces the old subscription.
  ws.data.watching = msg.sessionId;
  if (msg.sessionId === null) return;

  // Backfill BEFORE streaming: the browser client deliberately does not fetch
  // the backlog over HTTP, so a watch that only subscribes to future events
  // opens every transcript in the app empty — and looks like the engine has
  // stopped logging rather than like a protocol gap.
  try {
    const events = eventsOf(msg.sessionId, msg.since);
    // Bound from the TAIL. A 50k-event session must not go into one frame, and
    // the newest events are the ones a person opening a transcript wants; an
    // oldest-first bound would show the run's first minute forever. The client
    // merges by seq and re-watches from its highest held seq, so a bounded
    // frame self-heals on reconnect.
    send(ws, {
      type: "events",
      sessionId: msg.sessionId,
      events: events.length > MAX_BACKFILL ? events.slice(-MAX_BACKFILL) : events,
    });
  } catch (e) {
    send(ws, { type: "error", message: `cannot watch ${msg.sessionId}: ${(e as Error).message}` });
  }
}

function sessionOr404(id: string): Session {
  const s = getSession(id);
  if (!s) throw new HttpError(404, `session not found: ${id}`);
  return s;
}

/**
 * Map the three failures the engine distinguishes onto statuses. Anything else
 * escaping a handler is a genuine fault and stays a 500.
 */
function mapCoreError(e: unknown): HttpError {
  if (e instanceof NotFound) return new HttpError(404, e.message);
  if (e instanceof Conflict) return new HttpError(409, e.message);
  if (e instanceof BadRequest) return new HttpError(400, e.message);
  return new HttpError(500, e instanceof Error ? e.message : String(e));
}

// ---------------------------------------------------------------- routes

export const router = new Router(mapCoreError)
  .add("GET", "/api/state", () => json(getAppState()))

  .add("GET", "/api/health", ({ url }) => {
    // Cached: every probe runs its program. Nothing polls this route, and
    // `?refresh=1` is for the Re-check button — the user who has just fixed
    // their auth is the one who needs a fresh answer. Never on a broadcast path.
    const deps = dependencies(url.searchParams.get("refresh") === "1");

    // Each dependency is reported ONLY as its tri-state. There is deliberately
    // no per-dependency boolean: `gh: true` for an installed-but-logged-out
    // `gh` is precisely the ambiguity the tri-state exists to remove, and
    // shipping both leaves the imprecise field there to be reached for. A
    // caller that wants a boolean derives it from `state === "ok"`.
    return json({
      // The one exception, because it is a summary rather than a second
      // representation of any single dependency.
      ok: deps.omp.state === "ok" && deps.gh.state === "ok" && deps.git.state === "ok",
      ompState: deps.omp.state,
      ghState: deps.gh.state,
      gitState: deps.git.state,
      ompDetail: deps.omp.detail,
      ghDetail: deps.gh.detail,
      gitDetail: deps.git.detail,
      checkedAt: deps.at,
      version: VERSION,
    });
  })

  .add("POST", "/api/sessions", async ({ req }) => {
    const body = await readBody(req);
    const repoId = requireString(body, "repoId");
    const repo = getRepoById(repoId);
    if (!repo) throw new HttpError(404, `repo not found: ${repoId}`);
    const session = spawnSession(repo, requireString(body, "prompt"), {
      model: optionalString(body, "model"),
      branch: optionalString(body, "branch"),
    });
    return json(session, 201);
  })

  .add("DELETE", "/api/sessions/:id", ({ params }) => {
    destroySession(sessionOr404(params.id!).id);
    return json({ ok: true });
  })

  .add("POST", "/api/sessions/:id/message", async ({ req, params }) => {
    const body = await readBody(req);
    return json(await sendMessage(params.id!, requireString(body, "text"), "human"));
  })

  .add("POST", "/api/sessions/:id/interrupt", async ({ params }) =>
    json(await interruptSession(params.id!)),
  )

  .add("POST", "/api/sessions/:id/resume", async ({ params }) =>
    json(await resumeSession(params.id!)),
  )

  .add("POST", "/api/sessions/:id/permission", async ({ req, params }) => {
    const body = await readBody(req);
    return json(await replyPermission(params.id!, requireBoolean(body, "approved")));
  })

  .add("POST", "/api/sessions/:id/archive", ({ params }) => {
    const s = archiveSession(params.id!);
    if (!s) throw new HttpError(404, `session not found: ${params.id}`);
    return json(s);
  })

  .add("GET", "/api/sessions/:id/events", ({ params, url }) =>
    json(eventsOf(sessionOr404(params.id!).id, sinceParam(url))),
  )

  // `diffOf` resolves its own base from the session's repo (data's `baseFor`).
  // Which branch a session was cut from is data's knowledge, not the transport's.
  .add("GET", "/api/sessions/:id/diff", ({ params }) =>
    json(diffOf(sessionOr404(params.id!))),
  )

  .add("GET", "/api/repos", () => json(listRepos()))

  .add("POST", "/api/repos", async ({ req }) => {
    const body = await readBody(req);
    // Registration resolves the default branch and GitHub slug, so it can be
    // slow and can fail with a real message; both belong to data, not here.
    const repo = await addRepo(requireString(body, "ref"));
    // No rescan: repos come from sqlite, and `gh` must not run on this path.
    refreshCold();
    return json(repo, 201);
  })

  .add("DELETE", "/api/repos/:id", ({ params }) => {
    deleteRepo(params.id!);
    refreshCold();
    return json({ ok: true });
  })

  .add("GET", "/api/settings", () => json(getSettings()))

  .add("PUT", "/api/settings", async ({ req }) => {
    const next = mergeSettings(getSettings(), parseSettingsPatch(await readBody(req)));
    saveSettings(next);
    refreshCold();
    return json(next);
  })

  .otherwise(({ req, url }) => {
    if (url.pathname.startsWith("/api/")) {
      return fail(`no route for ${req.method} ${url.pathname}`, 404);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return fail(`${req.method} is not allowed on ${url.pathname} — try GET`, 405, { allow: "GET, HEAD" });
    }
    const found = resolveStatic(webDist, url.pathname);
    if (found.kind === "notBuilt") return notBuiltPage();
    if (found.kind === "notFound") return new Response("not found", { status: 404 });
    return fileResponse(webDist, found.path, req);
  });

// ----------------------------------------------------------------- boot

export function startServer(): void {
  // Processes do not survive a restart; mark the orphans dead once, at boot,
  // so they show up as resumable instead of pretending to still be running.
  reconcile();
  // The only place `gh` and the skills filesystem walk are allowed to run.
  startColdRefresh();

  sessionEvents.on("hot", scheduleHot);
  sessionEvents.on("events", onSessionEvents);
  stateEvents.on("cold", onCold);

  Bun.serve<SocketState>({
    port: PORT,
    hostname: HOST,
    websocket: {
      open(ws) {
        clients.add(ws);
        send(ws, { type: "hot", state: getHotState() });
        send(ws, { type: "cold", state: getColdState() });
      },
      message(ws, raw) {
        handleClientMessage(ws, raw);
      },
      close(ws) {
        clients.delete(ws);
      },
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return fail("/ws requires a WebSocket upgrade", 426);
        }
        return srv.upgrade(req, { data: { watching: null } })
          ? undefined
          : fail("websocket upgrade failed", 500);
      }
      return router.handle(req);
    },
  });

  console.log(`agentbox listening on http://${HOST}:${PORT}`);
}

if (import.meta.main) startServer();
