/** The agentbox HTTP + WebSocket server.
 *
 * This process owns no agents. Every session runs in agentbox's tmux server
 * (or in some terminal of yours), so this server can be restarted at any time
 * and nothing it shows is lost: the fleet rebuilds the board from transcripts,
 * processes and tmux on its first tick.
 *
 * Three pushes over `/ws`, on three clocks:
 *   - `hot`: sessions, coalesced to one push per 250ms of changes.
 *   - `cold`: accounts, logins, repos, PRs, skills, settings — recomputed when
 *     something they depend on moves, pushed only when the result differs.
 *   - `metrics`: machine and per-session load, every two seconds while anyone
 *     is connected, never suppressed.
 * Plus `timeline`, only to the socket watching that session.
 *
 * `/ws/term/:id` is a live terminal: a PTY running `tmux attach` on the
 * session, bytes both ways. Closing it detaches; the agent keeps running.
 */

import type { ServerWebSocket } from "bun";
import { DEFAULT_PORT, webDist } from "../core/paths";
import { Fleet, FleetError } from "../core/fleet";
import * as tmux from "../core/tmux";
import { attentionOf, byAttention } from "../core/attention";
import { calibrate } from "../core/calibration";
import { diffOf } from "../core/diff";
import { metricsEvents, metricsSnapshot, procDetail, setMetricsSource, setMetricsWatchers } from "../core/metrics";
import { reclaimWorktrees, scanWorktrees } from "../core/worktrees";
import { demoteSkill, listSkills, promoteSkill, readSkillBody, skillRoots, writeSkillBody } from "../core/skills";
import { containedIn, looksLikeSkillFile, skillMdPath } from "./guard";
import { addRepo, deleteRepo, getSettings, listRepos, mergeSettings, saveSettings } from "../core/db";
import { listPrs } from "../core/prs";
import { checkRequest } from "./csrf";
import { HttpError, Router, fail, json, readBody } from "./router";
import { optionalString, parseSettingsPatch, requireBoolean, requireString } from "./validate";
import { parseClientMessage } from "./protocol";
import { fileResponse, notBuiltPage, resolveStatic } from "./static";
import { adapters } from "../core/providers";
import { AccountsService } from "../core/accounts";
import { dependencies } from "../deps";
import { VERSION } from "../version";
import type {
  AccountView,
  ColdState,
  HotState,
  MetricsState,
  PrInfo,
  ProviderId,
  ServerMessage,
  SkillInfo,
} from "../core/types";

const PORT = Number(process.env.AGENTBOX_PORT ?? DEFAULT_PORT);
const HOST = process.env.AGENTBOX_HOST ?? "127.0.0.1";
const HOT_COALESCE_MS = 250;
const COLD_DEBOUNCE_MS = 500;
const SLOW_REFRESH_MS = 60_000;
const TIMELINE_PAGE = 200;
const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp"];

// ------------------------------------------------------------- the pieces

export const accounts = new AccountsService();
export const fleet = new Fleet({
  adapters: adapters(),
  runtime: tmux,
  usage: {
    usageOf: (id) => accounts.usageOf(id),
    ingestRollout: (id, reading) => accounts.ingestRollout(id, reading),
  },
});
setMetricsSource(() => fleet.sessions());

// --------------------------------------------------------------- state

function hotState(): HotState {
  const sessions = fleet
    .sessions()
    .map((s) => ({ ...s, attention: attentionOf(s, fleet.blockedReason(s.id)) }))
    .sort(byAttention);
  return { sessions, serverTime: Date.now() };
}

/** Slow-changing inputs to cold state, refreshed off the request path. */
const slow = {
  prs: [] as PrInfo[],
  skills: [] as SkillInfo[],
  warnings: [] as string[],
  providers: [] as ColdState["providers"],
};

async function refreshSlow(): Promise<void> {
  const repos = listRepos();
  const localDirs = repos.filter((r) => r.kind === "local").map((r) => r.ref);
  const skills = listSkills(skillRoots(localDirs));
  slow.skills = skills.skills;
  const providers = await Promise.all(
    PROVIDERS.map(async (id) => {
      const a = fleet.providers().find((p) => p.id === id);
      const d = a ? await a.detect().catch(() => ({ installed: false, version: null })) : { installed: false, version: null };
      return { id, installed: d.installed, version: d.version };
    }),
  );
  slow.providers = providers;
  // `gh` runs here and nowhere else: one call per repo, once a minute.
  const prs = listPrs(repos, fleet.sessions());
  slow.prs = prs.prs;
  const warnings = [...skills.warnings, ...prs.warnings];
  if (!tmux.tmuxVersion()) warnings.unshift("tmux is not installed — agentbox runs every session in tmux, so nothing can be started.");
  slow.warnings = warnings;
  scheduleCold();
}

function accountViews(): AccountView[] {
  const claims = fleet.claims();
  const placements = new Map<string, ReturnType<Fleet["placement"]>>();
  return accounts.list().map((a) => {
    let p = placements.get(a.provider);
    if (!p) {
      try {
        p = fleet.placement(a.provider, false);
      } catch {
        p = undefined;
      }
      if (p) placements.set(a.provider, p);
    }
    return {
      ...a,
      claims: claims.get(a.id) ?? [],
      placement: p?.candidates.find((c) => c.accountId === a.id) ?? null,
    };
  });
}

function coldState(): ColdState {
  return {
    accounts: accountViews(),
    logins: accounts.logins(),
    repos: listRepos(),
    prs: slow.prs,
    skills: slow.skills,
    settings: getSettings(),
    providers: slow.providers,
    warnings: slow.warnings,
  };
}

// ------------------------------------------------------------- websocket

type SocketData =
  | { kind: "app"; watching: string | null; cursor: string | null; busy: boolean; again: boolean }
  | { kind: "term"; sessionId: string; cols: number; rows: number; proc?: ReturnType<typeof Bun.spawn> };
type Socket = ServerWebSocket<SocketData>;

const clients = new Set<Socket>();

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
  } catch {
    dropClient(ws);
  }
}

function broadcast(msg: ServerMessage): void {
  for (const ws of [...clients]) send(ws, msg);
}

let hotTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHot(): void {
  if (hotTimer) return;
  hotTimer = setTimeout(() => {
    hotTimer = null;
    if (clients.size > 0) broadcast({ type: "hot", state: hotState() });
  }, HOT_COALESCE_MS);
}

let coldTimer: ReturnType<typeof setTimeout> | null = null;
let lastCold = "";
function scheduleCold(): void {
  if (coldTimer) return;
  coldTimer = setTimeout(() => {
    coldTimer = null;
    if (clients.size === 0) return;
    const state = coldState();
    const fp = JSON.stringify(state);
    if (fp === lastCold) return;
    lastCold = fp;
    broadcast({ type: "cold", state });
  }, COLD_DEBOUNCE_MS);
}

/**
 * Bring one watching socket up to date. First call sends the newest page with
 * `reset`; later calls send what was appended since the socket's cursor.
 * Serialised per socket — two overlapping reads would send the same events
 * twice and leave the cursor at whichever finished last.
 */
async function pumpTimeline(ws: Socket): Promise<void> {
  const d = ws.data;
  if (d.kind !== "app" || !d.watching) return;
  if (d.busy) {
    d.again = true;
    return;
  }
  d.busy = true;
  try {
    do {
      d.again = false;
      const id: string | null = d.watching;
      if (!id || !fleet.hasTranscript(id)) {
        if (id && d.cursor === null) send(ws, { type: "timeline", sessionId: id, events: [], cursor: "", reset: true });
        break;
      }
      if (d.cursor === null || d.cursor === "") {
        const page = await fleet.timeline(id, null, TIMELINE_PAGE);
        if (d.watching !== id) continue;
        d.cursor = page.cursor;
        send(ws, { type: "timeline", sessionId: id, events: page.events, cursor: page.cursor, reset: true });
      } else {
        const next = await fleet.since(id, d.cursor);
        if (d.watching !== id) continue;
        d.cursor = next.cursor;
        if (next.events.length > 0 || next.reset) {
          send(ws, { type: "timeline", sessionId: id, events: next.events, cursor: next.cursor, reset: next.reset });
        }
      }
    } while (d.again);
  } catch (e) {
    send(ws, { type: "error", message: `timeline: ${(e as Error).message}` });
  } finally {
    d.busy = false;
  }
}

function onTranscript(sessionId: string): void {
  for (const ws of clients) {
    if (ws.data.kind === "app" && ws.data.watching === sessionId) void pumpTimeline(ws);
  }
}

function handleAppMessage(ws: Socket, raw: string | Buffer): void {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    send(ws, { type: "error", message: parsed.error });
    return;
  }
  const msg = parsed.message;
  if (msg.type === "ping" || ws.data.kind !== "app") return;
  ws.data.watching = msg.sessionId;
  ws.data.cursor = null;
  void pumpTimeline(ws);
}

// ------------------------------------------------------------- terminal

function openTerminal(ws: Socket): void {
  const d = ws.data;
  if (d.kind !== "term") return;
  let name: string;
  try {
    name = fleet.tmuxOf(d.sessionId);
  } catch (e) {
    ws.send(`\r\n\x1b[2m${(e as Error).message}\x1b[0m\r\n`);
    ws.close(4000, "not in tmux");
    return;
  }
  // TMUX set in our environment (a server started from inside tmux) makes
  // `tmux attach` refuse to nest; the attach is to a different server anyway.
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>;
  delete env.TMUX;
  delete env.TMUX_PANE;
  d.proc = Bun.spawn(tmux.attachArgv(name), {
    env,
    terminal: {
      cols: d.cols,
      rows: d.rows,
      data(_term: unknown, bytes: Uint8Array) {
        if (ws.readyState === WebSocket.OPEN) ws.sendBinary(bytes);
      },
    },
  } as Parameters<typeof Bun.spawn>[1]);
  void d.proc.exited.then(() => {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000, "detached");
  });
}

function termOf(d: SocketData): { write(s: string): void; resize(c: number, r: number): void; close(): void } | null {
  if (d.kind !== "term" || !d.proc) return null;
  return (d.proc as unknown as { terminal?: { write(s: string): void; resize(c: number, r: number): void; close(): void } }).terminal ?? null;
}

function handleTermMessage(ws: Socket, raw: string | Buffer): void {
  const t = termOf(ws.data);
  if (!t) return;
  let msg: unknown;
  try {
    msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return;
  }
  const m = msg as { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
  if (m.type === "input" && typeof m.data === "string") t.write(m.data);
  else if (m.type === "resize" && typeof m.cols === "number" && typeof m.rows === "number") {
    const cols = Math.max(20, Math.min(500, Math.floor(m.cols)));
    const rows = Math.max(5, Math.min(200, Math.floor(m.rows)));
    t.resize(cols, rows);
  }
}

function closeTerminal(ws: Socket): void {
  const d = ws.data;
  if (d.kind !== "term") return;
  termOf(d)?.close();
  d.proc?.kill();
}

// --------------------------------------------------------------- routes

function mapError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof FleetError) return new HttpError(e.status, e.message);
  return new HttpError(500, e instanceof Error ? e.message : String(e));
}

const provider = (v: unknown): ProviderId => {
  if (typeof v !== "string" || !PROVIDERS.includes(v as ProviderId)) {
    throw new HttpError(400, `provider must be one of ${PROVIDERS.join(", ")}`);
  }
  return v as ProviderId;
};

const router = new Router(mapError)
  .add("GET", "/api/state", () => json({ ...hotState(), ...coldState() }))
  .add("GET", "/api/health", async () =>
    json({ version: VERSION, tmux: tmux.tmuxVersion(), providers: slow.providers, deps: await dependencies() }),
  )

  // ---- sessions
  .add("POST", "/api/placement", async ({ req }) => {
    const b = await readBody(req);
    return json(fleet.placement(provider(b.provider), b.big === true, optionalString(b, "model") ?? null, optionalString(b, "accountId") ?? null));
  })
  .add("POST", "/api/sessions", async ({ req }) => {
    const b = await readBody(req);
    try {
      const out = await fleet.spawn({
        provider: provider(b.provider),
        cwd: optionalString(b, "cwd"),
        repoId: optionalString(b, "repoId"),
        worktree: b.worktree === true,
        prompt: typeof b.prompt === "string" ? b.prompt : undefined,
        model: optionalString(b, "model"),
        big: b.big === true,
        accountId: optionalString(b, "accountId") ?? null,
      });
      scheduleHot();
      scheduleCold();
      return json(out, 201);
    } catch (e) {
      // A refusal carries the placement, so the dialog can show why.
      if (e instanceof FleetError && e.placement) {
        return new Response(JSON.stringify({ ok: false, data: { placement: e.placement }, error: e.message }), {
          status: e.status,
          headers: { "content-type": "application/json" },
        });
      }
      throw e;
    }
  })
  .add("PATCH", "/api/sessions/:id", async ({ req, params }) => {
    const b = await readBody(req);
    const label = b.label === null ? null : typeof b.label === "string" ? b.label : undefined;
    const big = typeof b.big === "boolean" ? b.big : undefined;
    const s = await fleet.patch(params.id!, { label, big });
    scheduleHot();
    scheduleCold();
    return json(s);
  })
  .add("POST", "/api/sessions/:id/send", async ({ req, params }) => {
    const b = await readBody(req);
    await fleet.send(params.id!, requireString(b, "text"));
    return json(null);
  })
  .add("POST", "/api/sessions/:id/keys", async ({ req, params }) => {
    const b = await readBody(req);
    if (!Array.isArray(b.keys) || !b.keys.every((k) => typeof k === "string" && k.length > 0 && k.length < 64)) {
      throw new HttpError(400, "keys must be a list of tmux key names");
    }
    fleet.keys(params.id!, b.keys as string[]);
    return json(null);
  })
  .add("POST", "/api/sessions/:id/interrupt", ({ params }) => {
    fleet.interrupt(params.id!);
    return json(null);
  })
  .add("POST", "/api/sessions/:id/resume", async ({ req, params }) => {
    const b = await readBody(req);
    const s = await fleet.resume(params.id!, typeof b.prompt === "string" ? b.prompt : undefined);
    scheduleHot();
    return json(s);
  })
  .add("POST", "/api/sessions/:id/adopt", async ({ params }) => {
    const s = await fleet.adopt(params.id!);
    scheduleHot();
    return json(s);
  })
  .add("POST", "/api/sessions/:id/stop", async ({ params }) => {
    await fleet.stopSession(params.id!);
    scheduleHot();
    return json(null);
  })
  .add("POST", "/api/sessions/:id/archive", async ({ req, params }) => {
    const b = await readBody(req);
    await fleet.archive(params.id!, requireBoolean(b, "archived"));
    scheduleHot();
    return json(null);
  })
  .add("GET", "/api/sessions/:id/timeline", async ({ params, url }) => {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? TIMELINE_PAGE) || TIMELINE_PAGE));
    return json(await fleet.timeline(params.id!, url.searchParams.get("before"), limit));
  })
  .add("GET", "/api/sessions/:id/diff", ({ params }) => json(diffOf(fleet.get(params.id!))))
  .add("GET", "/api/sessions/:id/load", async ({ params }) => {
    const s = fleet.get(params.id!);
    if (!s.pid) throw new HttpError(409, "session has no running process");
    return json(await procDetail(s.pid));
  })
  .add("GET", "/api/sessions/:id/attach", ({ params }) => json({ argv: fleet.attachCommand(params.id!) }))

  // ---- accounts
  .add("GET", "/api/accounts", () => json(accountViews()))
  .add("POST", "/api/accounts", async ({ req }) => {
    const b = await readBody(req);
    const out = await accounts.create(provider(b.provider), optionalString(b, "label"));
    scheduleCold();
    return json(out, 201);
  })
  .add("POST", "/api/accounts/import", async ({ req }) => {
    const b = await readBody(req);
    const a = await accounts.importHome(provider(b.provider), requireString(b, "home"));
    scheduleCold();
    return json(a, 201);
  })
  .add("PATCH", "/api/accounts/:id", async ({ req, params }) => {
    const b = await readBody(req);
    const a = accounts.update(params.id!, {
      label: optionalString(b, "label"),
      enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
    });
    scheduleCold();
    return json(a);
  })
  .add("DELETE", "/api/accounts/:id", ({ params }) => {
    accounts.remove(params.id!);
    scheduleCold();
    return json(null);
  })
  .add("POST", "/api/accounts/:id/login", async ({ params }) => {
    const flow = await accounts.login(params.id!);
    scheduleCold();
    return json(flow);
  })
  .add("POST", "/api/accounts/:id/usage", async ({ params }) => {
    const u = await accounts.refreshUsage(params.id!);
    scheduleCold();
    return json(u);
  })
  .add("POST", "/api/logins/:id/paste", async ({ req, params }) => {
    const b = await readBody(req);
    const flow = accounts.paste(params.id!, requireString(b, "text"));
    scheduleCold();
    return json(flow);
  })
  .add("POST", "/api/logins/:id/cancel", ({ params }) => {
    accounts.cancel(params.id!);
    scheduleCold();
    return json(null);
  })
  .add("GET", "/api/calibration", ({ url }) => {
    const days = Math.min(60, Math.max(1, Number(url.searchParams.get("days") ?? 7) || 7));
    return json(calibrate(days));
  })

  // ---- settings, repos, worktrees, skills
  .add("GET", "/api/settings", () => json(getSettings()))
  .add("PUT", "/api/settings", async ({ req }) => {
    const patch = parseSettingsPatch(await readBody(req));
    const next = mergeSettings(getSettings(), patch);
    saveSettings(next);
    scheduleCold();
    void fleet.tick().then(scheduleHot);
    return json(next);
  })
  .add("GET", "/api/repos", () => json(listRepos()))
  .add("POST", "/api/repos", async ({ req }) => {
    const b = await readBody(req);
    const repo = await addRepo(requireString(b, "ref")).catch((e: Error) => {
      throw new HttpError(400, e.message);
    });
    void refreshSlow();
    return json(repo, 201);
  })
  .add("DELETE", "/api/repos/:id", ({ params }) => {
    deleteRepo(params.id!);
    void refreshSlow();
    return json(null);
  })
  .add("POST", "/api/worktrees/scan", async () => json(await scanWorktrees("all", fleet.sessions())))
  .add("POST", "/api/worktrees/reclaim", async ({ req }) => {
    const b = await readBody(req);
    if (!Array.isArray(b.paths) || !b.paths.every((p) => typeof p === "string")) {
      throw new HttpError(400, "paths must be a list of worktree paths");
    }
    return json(await reclaimWorktrees(b.paths as string[], { force: b.force === true, sessions: fleet.sessions() }));
  })
  .add("GET", "/api/skill/body", ({ url }) => {
    const raw = url.searchParams.get("path") ?? "";
    const dir = containedIn(raw, skillRootDirs());
    if (!dir) throw new HttpError(403, "not a skill directory agentbox manages");
    const file = skillMdPath(dir);
    if (!looksLikeSkillFile(file)) throw new HttpError(403, "not a skill file");
    return json({ body: readSkillBody(file) });
  })
  .add("POST", "/api/skill/body", async ({ req }) => {
    const b = await readBody(req);
    const dir = containedIn(requireString(b, "path"), skillRootDirs());
    if (!dir) throw new HttpError(403, "not a skill directory agentbox manages");
    const file = skillMdPath(dir);
    if (!looksLikeSkillFile(file)) throw new HttpError(403, "not a skill file");
    if (typeof b.body !== "string") throw new HttpError(400, "body must be a string");
    const ok = writeSkillBody(file, b.body);
    void refreshSlow();
    return json({ ok });
  })
  .add("POST", "/api/skill/promote", async ({ req }) => {
    const b = await readBody(req);
    const name = requireString(b, "name");
    const skill = slow.skills.find((s) => s.name === name && s.source === "project");
    if (!skill) throw new HttpError(404, `no project skill named ${name}`);
    const r = promoteSkill(skill);
    void refreshSlow();
    return json(r);
  })
  .add("POST", "/api/skill/demote", async ({ req }) => {
    const b = await readBody(req);
    const r = demoteSkill(requireString(b, "name"));
    void refreshSlow();
    return json(r);
  })
  .otherwise(({ req, url }) => {
    if (req.method !== "GET" && req.method !== "HEAD") return fail(`no route for ${req.method} ${url.pathname}`, 404);
    const found = resolveStatic(webDist, url.pathname);
    if (found.kind === "notBuilt") return notBuiltPage();
    if (found.kind === "notFound") return new Response("not found", { status: 404 });
    return fileResponse(webDist, found.path, req);
  });

function skillRootDirs(): string[] {
  const local = listRepos().filter((r) => r.kind === "local").map((r) => r.ref);
  return skillRoots(local).map((r) => r.dir);
}

// ------------------------------------------------------------------ boot

export async function startServer(): Promise<void> {
  accounts.start();
  fleet.start();
  await fleet.ready;
  void refreshSlow();
  setInterval(() => void refreshSlow(), SLOW_REFRESH_MS).unref?.();

  fleet.on("sessions", () => {
    scheduleHot();
    // Claims move with sessions, and claims are on the Accounts page.
    scheduleCold();
  });
  fleet.on("transcript", onTranscript);
  accounts.on("change", scheduleCold);
  metricsEvents.on("metrics", (state: MetricsState) => broadcast({ type: "metrics", state }));

  const stop = () => {
    fleet.stop();
    accounts.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  Bun.serve<SocketData>({
    port: PORT,
    hostname: HOST,
    idleTimeout: 60,
    websocket: {
      open(ws) {
        if (ws.data.kind === "term") {
          openTerminal(ws);
          return;
        }
        clients.add(ws);
        send(ws, { type: "hot", state: hotState() });
        const cold = coldState();
        lastCold = JSON.stringify(cold);
        send(ws, { type: "cold", state: cold });
        send(ws, { type: "metrics", state: metricsSnapshot() });
        setMetricsWatchers(clients.size);
      },
      message(ws, raw) {
        if (ws.data.kind === "term") handleTermMessage(ws, raw);
        else handleAppMessage(ws, raw);
      },
      close(ws) {
        if (ws.data.kind === "term") closeTerminal(ws);
        else dropClient(ws);
      },
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const verdict = checkRequest(req, PORT, { upgrade });
      if (!verdict.ok) return fail(verdict.reason, 403);

      if (url.pathname === "/ws") {
        if (!upgrade) return fail("/ws requires a WebSocket upgrade", 426);
        return srv.upgrade(req, { data: { kind: "app", watching: null, cursor: null, busy: false, again: false } })
          ? undefined
          : fail("websocket upgrade failed", 500);
      }
      const term = url.pathname.match(/^\/ws\/term\/([a-z0-9]+)$/);
      if (term) {
        if (!upgrade) return fail("terminal requires a WebSocket upgrade", 426);
        const cols = Math.max(20, Math.min(500, Number(url.searchParams.get("cols")) || 120));
        const rows = Math.max(5, Math.min(200, Number(url.searchParams.get("rows")) || 40));
        return srv.upgrade(req, { data: { kind: "term", sessionId: term[1]!, cols, rows } })
          ? undefined
          : fail("websocket upgrade failed", 500);
      }
      return router.handle(req);
    },
  });

  console.log(`agentbox listening on http://${HOST}:${PORT}`);
}

if (import.meta.main) await startServer();
