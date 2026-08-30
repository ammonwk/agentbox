/** The agentbox HTTP + WebSocket server.
 *
 * This process does NOT own the agents. Each live session runs in its own
 * `agentbox host` process, and the server is a client of those over unix
 * sockets — it can be restarted, and they carry on. The web UI and the MCP
 * server are in turn clients of this API. Two rules shape the whole file:
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
  closeSession,
  eventsOf,
  interruptSession,
  reconcile,
  detachHosts,
  replyPermission,
  resumeSession,
  sendMessage,
  sessionEvents,
  spawnSession,
} from "../core/sessions";
import { diffOf } from "../core/diff";
import {
  metricsEvents,
  metricsSnapshot,
  procDetail,
  setMetricsWatchers,
} from "../core/metrics";
import { reclaimWorktrees, scanWorktrees } from "../core/worktrees";
import {
  demoteSkill,
  listSkills,
  promoteSkill,
  readSkillBody,
  writeSkillBody,
} from "../core/skills";
import {
  containedIn,
  looksLikeSkillFile,
  skillMdPath,
  skillRootDirs,
} from "./guard";
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
import type {
  ColdState,
  MetricsState,
  ServerMessage,
  Session,
  TranscriptEvent,
} from "../core/types";
import { HttpError, Router, fail, json, readBody } from "./router";
import {
  beforeParam,
  limitParam,
  optionalString,
  parseSettingsPatch,
  requireBoolean,
  requireString,
  sinceParam,
} from "./validate";
import { commandSubagent, listSubagents, subagentDetail } from "./subagents";
import { parseClientMessage } from "./protocol";
import { fileResponse, notBuiltPage, resolveStatic } from "./static";

const PORT = Number(process.env.AGENTBOX_PORT ?? DEFAULT_PORT);
const HOST = process.env.AGENTBOX_HOST ?? "127.0.0.1";

/** How long session changes are batched before a `hot` push. */
const HOT_COALESCE_MS = 250;

/**
 * Most events a `watch` backfill will send in one frame. A long run can hold
 * tens of thousands; the newest few hundred are what a person opening the
 * transcript is looking at, and the client pages further back with
 * `GET /api/sessions/:id/events?before=&limit=` as the reader scrolls up.
 */
const MAX_BACKFILL = 500;

// ------------------------------------------------------------- websocket

/** A socket watches at most one session's event stream. */
type SocketState = { watching: string | null };
type Socket = ServerWebSocket<SocketState>;

const clients = new Set<Socket>();

/**
 * The one place a socket leaves the broadcast set.
 *
 * `close` is not the only way clients go away — a socket that dies mid-write is
 * dropped here too, and if that path skipped the watcher count then a browser
 * killed without a clean close would leave the metrics sampler reading /proc
 * every two seconds for nobody, for the life of the process.
 */
function dropClient(ws: Socket): void {
  if (!clients.delete(ws)) return;
  setMetricsWatchers(clients.size);
}

function send(ws: Socket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) {
    dropClient(ws);
    return;
  }
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    // The socket died between the readyState check and the write. Drop it
    // rather than letting a corpse accumulate in the broadcast set.
    dropClient(ws);
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

/**
 * Straight to the wire, uncoalesced and unsuppressed.
 *
 * Both of the other channels are throttled — `hot` coalesces a burst, `cold`
 * drops a push whose fingerprint matches the last one. Neither is right here.
 * The sampler already sets the cadence, and every sample differs by
 * construction, so suppressing one would just be a stale reading wearing a live
 * one's clothes.
 */
function onMetrics(state: MetricsState): void {
  broadcast({ type: "metrics", state });
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

  .add("POST", "/api/sessions/:id/message", async ({ req, params }) => {
    const body = await readBody(req);
    return json(await sendMessage(params.id!, requireString(body, "text")));
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

  .add("POST", "/api/sessions/:id/close", ({ params }) => {
    const s = closeSession(params.id!);
    if (!s) throw new HttpError(404, `session not found: ${params.id}`);
    return json(s);
  })

  .add("GET", "/api/sessions/:id/events", ({ params, url }) =>
    json(
      eventsOf(sessionOr404(params.id!).id, sinceParam(url), {
        before: beforeParam(url),
        limit: limitParam(url),
      }),
    ),
  )

  // `diffOf` resolves its own base from the session's repo (data's `baseFor`).
  // Which branch a session was cut from is data's knowledge, not the transport's.
  .add("GET", "/api/sessions/:id/diff", ({ params }) =>
    json(diffOf(sessionOr404(params.id!))),
  )

  /**
   * The per-process breakdown behind one session's load figure.
   *
   * On demand and never polled by the board: this is the only caller that reads
   * per-process PSS, and `smaps_rollup` makes the kernel walk every VMA — the
   * single most expensive read in the product. A session with no live process
   * returns an empty list rather than an error; "not running" is an answer.
   */
  .add("GET", "/api/sessions/:id/load", async ({ params }) => {
    const s = sessionOr404(params.id!);
    return json({ procs: s.pid === null ? [] : await procDetail(s.pid) });
  })

  // Subagents are off the board by design -- no rows, no worktrees, no
  // supervisor -- so these read the record on disk rather than any session
  // state, and show agents from every client session on the machine.
  .add("GET", "/api/subagents", () => json(listSubagents()))

  .add("GET", "/api/subagents/:id", ({ params }) => {
    const detail = subagentDetail(params.id!);
    if (!detail) throw new HttpError(404, `no subagent record: ${params.id}`);
    return json(detail);
  })

  .add("POST", "/api/subagents/:id/:command", ({ params }) => {
    const command = params.command;
    if (command !== "interrupt" && command !== "stop") {
      throw new HttpError(400, `unknown command: ${command}`);
    }
    if (!commandSubagent(params.id!, command)) {
      throw new HttpError(404, `no subagent record: ${params.id}`);
    }
    // Deliberately not "stopped": the owner sweeps for this on its own beat
    // and may have exited. A control that reports success it cannot verify is
    // worse than one that says what it actually did.
    return json({ requested: command });
  })

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

  // Both of these shell out to git and gh many times over, so neither is on a
  // broadcast path and neither is cached — they run when the human asks.
  .add("POST", "/api/worktrees/scan", async ({ req }) => {
    const body = await readBody(req);
    const scope = optionalString(body, "scope") ?? "all";
    if (scope !== "all" && scope !== "agentbox") {
      throw new HttpError(400, "scope must be all or agentbox");
    }
    return json(await scanWorktrees(scope));
  })

  .add("POST", "/api/worktrees/reclaim", async ({ req }) => {
    const body = await readBody(req);
    const paths = body.paths;
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
      throw new HttpError(400, "paths must be an array of strings");
    }
    if (paths.length === 0) throw new HttpError(400, "paths is empty — nothing to reclaim");
    const force = body.force === undefined ? false : requireBoolean(body, "force");
    const result = await reclaimWorktrees(paths as string[], { force });
    // A reclaimed worktree changes what the session detail can show, so the
    // board has to hear about it.
    broadcast({ type: "hot", state: getHotState() });
    return json(result);
  })

  .add("GET", "/api/settings", () => json(getSettings()))

  // ── Skills ───────────────────────────────────────────────────────────────
  // The list itself travels in cold state; these routes are the mutations and
  // the body. Every path is caller-supplied, so it is confined to the known
  // skill roots and required to look like a skill file.

  /**
   * Read a skill file's body.
   *
   * The path is the skill *directory* (as listed in cold state); this resolves
   * SKILL.md inside it. Without the containment check this is an
   * arbitrary-file-read primitive.
   */
  .add("GET", "/api/skill/body", ({ url }) => {
    const raw = url.searchParams.get("path");
    if (!raw) throw new HttpError(400, "path required");
    const confined = containedIn(raw, skillRootDirs());
    const md = confined ? skillMdPath(confined) : null;
    if (!confined || !md || !looksLikeSkillFile(md)) {
      throw new HttpError(403, "path is not inside a skills directory");
    }
    return json({ body: readSkillBody(md) });
  })

  /** Same confinement, and rather more important: this one writes. */
  .add("POST", "/api/skill/body", async ({ req }) => {
    const b = await readBody(req);
    const raw = requireString(b, "path");
    const confined = containedIn(raw, skillRootDirs());
    const md = confined ? skillMdPath(confined) : null;
    if (!confined || !md || !looksLikeSkillFile(md)) {
      throw new HttpError(403, "path is not inside a skills directory");
    }
    const body = b.body;
    if (typeof body !== "string") throw new HttpError(400, "body must be a string");
    const ok = writeSkillBody(md, body);
    // The body may have changed name/description/lines, so the inventory is
    // stale until the cold refresh re-reads it.
    refreshCold(true);
    return json({ ok });
  })

  .add("POST", "/api/skill/promote", async ({ req }) => {
    const b = await readBody(req);
    const name = requireString(b, "name");
    const skill = listSkills().skills.find((s) => s.name === name && s.source === "project");
    if (!skill) throw new HttpError(404, `no such project skill: ${name}`);
    const r = promoteSkill(skill);
    refreshCold(true);
    return json(r, r.ok ? 200 : 409);
  })

  .add("POST", "/api/skill/demote", async ({ req }) => {
    const b = await readBody(req);
    const r = demoteSkill(requireString(b, "name"));
    refreshCold(true);
    return json(r, r.ok ? 200 : 409);
  })

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

export async function startServer(): Promise<void> {
  // Reattach to the agents that were already running before this process
  // existed, and mark dead only the ones that really are. Awaited, because
  // serving a board that says every session died — a second before reconnecting
  // to them — is worse than starting a moment later.
  await reconcile();
  // The only place `gh` and the skills filesystem walk are allowed to run.
  startColdRefresh();

  // Agents are not ours to take with us. Without this the sockets close hard
  // on exit and every host logs a control-channel error on its way to
  // discovering it does not matter.
  const letGo = () => {
    detachHosts();
    process.exit(0);
  };
  process.on("SIGINT", letGo);
  process.on("SIGTERM", letGo);

  sessionEvents.on("hot", scheduleHot);
  sessionEvents.on("events", onSessionEvents);
  stateEvents.on("cold", onCold);
  // Note there is no `startMetrics()` beside `startColdRefresh()`: the sampler
  // is driven entirely by whether anyone is connected. An agentbox left running
  // with no tab open reads /proc exactly never.
  metricsEvents.on("metrics", onMetrics);

  Bun.serve<SocketState>({
    port: PORT,
    hostname: HOST,
    // Bun's default is 10s. `resume` waits for the agent host to come up —
    // up to HOST_READY_MS, and longer in practice on a cold cache — so a
    // successful resume was being reported to the caller as a timeout.
    idleTimeout: 60,
    websocket: {
      open(ws) {
        clients.add(ws);
        send(ws, { type: "hot", state: getHotState() });
        send(ws, { type: "cold", state: getColdState() });
        // The last sweep, so a tab that opens between polls paints something
        // real immediately instead of an empty bar for two seconds. It carries
        // its own `at`, so the client can tell a replayed reading from a live
        // one rather than trusting it because it arrived on connect.
        send(ws, { type: "metrics", state: metricsSnapshot() });
        setMetricsWatchers(clients.size);
      },
      message(ws, raw) {
        handleClientMessage(ws, raw);
      },
      close(ws) {
        dropClient(ws);
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

if (import.meta.main) await startServer();
