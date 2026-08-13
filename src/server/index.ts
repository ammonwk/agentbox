import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, webDist } from "../core/paths";
import { getAppState } from "../core/state";
import {
  spawnSession, sendMessage, interruptSession, replyPermission,
  killSession, archiveSession, destroySession,
  transcriptOf, reconcile, sessionEvents, ompAvailable,
} from "../core/sessions";
import { listRepos, insertRepo, deleteRepo as dbDeleteRepo, getSettings, saveSettings } from "../core/db";
import { isGitRepo } from "../core/git";
import type { Repo, AgentSettings } from "../core/types";

const PORT = Number(process.env.AGENTBOX_PORT ?? DEFAULT_PORT);
const HOST = process.env.AGENTBOX_HOST ?? "127.0.0.1";

const clients = new Set<import("bun").ServerWebSocket>();
let lastBroadcast = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function scheduleBroadcast() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    lastBroadcast = Date.now();
    const state = getAppState();
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "state", state }));
      }
    }
  }, 400);
}

sessionEvents.on("change", scheduleBroadcast);

// Periodic refresh: reconcile dead sessions and re-derive PR/skills state.
setInterval(() => {
  reconcile();
  scheduleBroadcast();
}, 5000);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: status < 400, data, error: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(msg: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, data: null, error: msg }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readBody(req: Request): Promise<any> {
  const text = await req.text();
  return text ? JSON.parse(text) : {};
}

function resolveRepo(ref: string): Repo {
  const trimmed = ref.trim();
  if (!trimmed) throw new Error("repo reference is required");
  const isLocal = trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed.startsWith(".");
  if (isLocal) {
    const p = trimmed.startsWith("~/") ? join(process.env.HOME ?? "", trimmed.slice(2)) : trimmed;
    if (!isGitRepo(p)) throw new Error(`not a git repository: ${p}`);
    return {
      id: randomUUID(),
      ref: p,
      kind: "local",
      displayName: basename(p),
      addedAt: Date.now(),
    };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error("use a local path or an owner/repo GitHub slug");
  }
  return { id: randomUUID(), ref: trimmed, kind: "github", displayName: trimmed, addedAt: Date.now() };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify({ type: "state", state: getAppState() }));
    },
    message(_ws) {},
    close(ws) {
      clients.delete(ws);
    },
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.headers.get("upgrade") === "websocket") {
      if (path === "/ws") return srv.upgrade(req) ? undefined : fail("upgrade failed", 500);
    }
    if (path === "/api/state") return json(getAppState());

    // sessions
    if (path === "/api/sessions" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const repo = listRepos().find((r) => r.id === body.repo_id);
        if (!repo) return fail("unknown repo_id");
        const session = spawnSession(
          repo,
          String(body.prompt ?? ""),
          body.model ?? undefined,
          body.branch ? String(body.branch) : undefined
        );
        return json(session, 201);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const sm = path.match(/^\/api\/sessions\/([^/]+)\/(continue|message|interrupt|permission|kill|archive|transcript|log)$/);
    if (sm) {
      const [, id, action] = sm;
      if (action === "continue" || action === "message") {
        const body = await readBody(req);
        try {
          const s = await sendMessage(id, String(body.prompt ?? body.text ?? ""));
          return s ? json(s) : fail("session not found", 404);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      if (action === "interrupt") {
        try {
          const s = await interruptSession(id);
          return json(s);
        } catch (e) {
          return fail((e as Error).message, 404);
        }
      }
      if (action === "permission") {
        const body = await readBody(req);
        try {
          const s = await replyPermission(id, body.approved !== false);
          return json(s);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      if (action === "kill") {
        const s = killSession(id);
        return s ? json(s) : fail("session not found", 404);
      }
      if (action === "archive") {
        const s = archiveSession(id);
        return s ? json(s) : fail("session not found", 404);
      }
      if (action === "transcript") {
        const s = transcriptOf(id);
        return json(s);
      }
      if (action === "log") {
        return json(transcriptOf(id).slice(-200));
      }
    }

    const dsm = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (dsm && req.method === "DELETE") {
      destroySession(dsm[1]);
      return json({ ok: true });
    }

    // repos
    if (path === "/api/repos" && req.method === "GET") return json(listRepos());
    if (path === "/api/repos" && req.method === "POST") {
      const body = await readBody(req);
      try {
        const repo = resolveRepo(String(body.ref ?? ""));
        insertRepo(repo);
        return json(repo, 201);
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    const rm = path.match(/^\/api\/repos\/([^/]+)$/);
    if (rm && req.method === "DELETE") {
      dbDeleteRepo(rm[1]);
      return json({ ok: true });
    }

    // settings
    if (path === "/api/settings" && req.method === "GET") return json(getSettings());
    if (path === "/api/settings" && req.method === "PUT") {
      const body = (await readBody(req)) as Partial<AgentSettings>;
      const next = { ...getSettings(), ...body };
      saveSettings(next);
      scheduleBroadcast();
      return json(next);
    }

    // health / info
    if (path === "/api/health") return json({ ok: true, omp: ompAvailable(), version: "0.1.0" });

    // static frontend (production single-server mode)
    if (path.startsWith("/api/")) return fail("not found", 404);
    return serveStatic(path);
  },
});

function serveStatic(path: string): Response {
  const candidates = [
    path === "/" ? "index.html" : path.replace(/^\/+/, ""),
    "index.html",
  ];
  for (const rel of candidates) {
    const file = join(webDist, rel);
    if (existsSync(file) && file.startsWith(webDist)) {
      const ext = file.split(".").pop() ?? "";
      const types: Record<string, string> = {
        html: "text/html", js: "text/javascript", css: "text/css",
        svg: "image/svg+xml", png: "image/png", json: "application/json",
        ico: "image/x-icon", map: "application/json",
      };
      return new Response(readFileSync(file), {
        headers: { "content-type": types[ext] ?? "application/octet-stream" },
      });
    }
  }
  return new Response("agentbox: web app not built — run `bun run web:build`", { status: 200 });
}

console.log(`agentbox listening on http://${HOST}:${PORT}`);
void server;
void lastBroadcast;
