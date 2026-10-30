/**
 * What an extension's program may want, in one file (docs/extensions.md).
 * None of it is required: it is the public HTTP API, the environment agentbox
 * gives a program it runs, and a few things built on them. An extension in
 * another language uses the same HTTP calls.
 *
 * An extension imports it by path from the agentbox checkout:
 *   import { agentbox, serve } from "/path/to/agentbox/sdk/extension.ts";
 * A conversation of its own that runs for months is sdk/conversation.ts.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppState, Card, Session, TimelinePage, Wait } from "../src/core/types";
import type { ActionReply, Block, View } from "../web/src/blocks/types";

export type { Action, ActionReply, Block, Field, View } from "../web/src/blocks/types";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: this runs as an extension's program, started by agentbox (docs/extensions.md)`);
  return v;
};

/** Who and where this program is. */
export const me = {
  get name() {
    return env("AGENTBOX_EXT");
  },
  /** Its code: where extension.json is. */
  get dir() {
    return env("AGENTBOX_EXT_DIR");
  },
  /** Its own state, kept across restarts and upgrades: agentbox never reads it. */
  get home() {
    return env("AGENTBOX_EXT_HOME");
  },
  /** The `agentbox` command, for prompts that tell sessions how to call back. */
  get bin() {
    return process.env.AGENTBOX_BIN ?? "agentbox";
  },
};

export class AgentboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

/** One call of agentbox's HTTP API (docs/v2.md, HTTP API). */
export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const base = process.env.AGENTBOX_URL ?? "http://127.0.0.1:4479";
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agentbox": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await res.json().catch(() => null)) as { ok: boolean; data: T; error: string | null } | null;
  if (!out) throw new AgentboxError(`agentbox answered ${path} with HTTP ${res.status} and no JSON`, res.status);
  if (!out.ok) throw new AgentboxError(out.error ?? `HTTP ${res.status}`, res.status, out.data);
  return out.data;
}

/** A `POST /api/sessions` body. */
export type Start = {
  provider: string;
  prompt?: string;
  cwd?: string;
  repoId?: string;
  /** A registered repo by its `owner/name` (or, on this machine, its id). */
  repo?: string;
  /** With `repo`: a branch, tag or commit, checked out detached in a new worktree. */
  ref?: string;
  worktree?: boolean;
  branch?: string;
  model?: string;
  effort?: string;
  accountId?: string;
  /** Other providers, in order, when its own has no account with room. */
  fallbacks?: string[];
  /** Puts it under that session on the board. */
  parent?: string;
  /** A pull request it has from its first moment. */
  claim?: string;
  /** Reads, never writes (codex): for a reviewer. */
  readOnly?: boolean;
  /** False: its stops are not pushed to the phone; your page shows them instead. */
  notify?: boolean;
};

/** The parts of the API extensions use most, by name. Anything else: `call`. */
export const agentbox = {
  state: (open = true) => call<AppState>("GET", `/api/state${open ? "?open=1" : ""}`),
  session: (id: string) => call<Session>("GET", `/api/sessions/${id}`).catch((e) => (e instanceof AgentboxError && e.status === 404 ? null : Promise.reject(e))),
  start: (spec: Start): Promise<Session> => call<{ session: Session }>("POST", "/api/sessions", spec).then((r) => r.session),
  /** Type into a session as another session would: the send guard applies (docs/v2.md, Messages between sessions). */
  send: (id: string, text: string, opts: { wake?: boolean; from?: string } = {}) =>
    call<{ to?: string } | null>("POST", `/api/sessions/${id}/send`, { text, from: "agent", wake: opts.wake, fromSession: opts.from }),
  /** Type into a session as this extension, outside the send guard: for a
   *  conversation of its own. A parked one is woken with it. `sendId` makes a retry safe. */
  say: (id: string, text: string, sendId?: string) =>
    call("POST", `/api/sessions/${id}/send`, { text: `[via agentbox ext ${me.name}] ${text}`, ...(sendId ? { sendId } : {}) }),
  /** Resume a stopped session with `text`, as this extension. */
  resume: (id: string, text: string) =>
    call("POST", `/api/sessions/${id}/submissions`, { sendId: crypto.randomUUID(), kind: "resume", text: `[via agentbox ext ${me.name}] ${text}` }),
  timeline: (id: string, before?: string, limit = 200) =>
    call<TimelinePage>("GET", `/api/sessions/${id}/timeline?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  stop: (id: string) => call("POST", `/api/sessions/${id}/stop`),
  /** Close it. `removeWorktree`: and remove the worktree a `ref` start cut
   *  for it, when nothing in it would be lost. */
  close: (id: string, opts: { removeWorktree?: boolean } = {}) => call("POST", `/api/sessions/${id}/close`, { closed: true, ...(opts.removeWorktree ? { removeWorktree: true } : {}) }),
  /** Pin it (on the board's top, and never parked the moment its turn ends), or unpin it with null. */
  pin: (id: string, order: number | null = Date.now()) => call("PATCH", `/api/sessions/${id}`, { pinOrder: order }),
  /** What `from` holds goes to `to`: its children, cards, PRs and their waits, and messages to it. */
  handover: (from: string, to: string, close = false) => call("POST", `/api/sessions/${from}/handover`, { to, close }),
  card: (c: { kind: "decision" | "note" | "merged"; title: string; short: string; long?: string; pr?: string; recommend?: string; default?: string; defaultAt?: number; key?: string; session?: string; about?: string; notify?: boolean }) =>
    call<Card>("POST", "/api/cards", c),
  /** Withdraw a card. */
  closeCard: (id: number, why: string) => call<Card>("POST", `/api/cards/${id}/close`, { why }),
  cards: (q = "") => call<Card[]>("GET", `/api/cards${q}`),
  /** A wait told to `session` (docs/v2.md, Waits): `{pr: {...}}`, `{run: ...}`, `{session: ...}`, `{until: ...}`, `{time: ...}`. */
  wait: (session: string, spec: Record<string, unknown>, opts: { pr?: string; cwd?: string; timeoutMs?: number } = {}) =>
    call<{ wait: Wait; already: boolean }>("POST", "/api/waits", { spec, session, ...opts }),
  claimPr: (pr: string, session: string, cwd?: string) => call("POST", "/api/prs/claim", { pr, session, cwd }),
  prWho: (pr: string, cwd?: string) => call<{ repo: string; number: number; claim: { sessionId: string } | null }>("POST", "/api/prs/who", { pr, cwd }),
  /** Whether `provider` has an account with room now. */
  hasRoom: (provider: string, model?: string) => call<{ accountId: string | null }>("POST", "/api/placement", { provider, model }).then((p) => !!p.accountId),
};

/** Everything a session said, oldest first: the provider's transcript, read through agentbox. */
export async function transcript(id: string): Promise<TimelinePage["events"]> {
  const pages: TimelinePage["events"][] = [];
  let before: string | undefined;
  for (let n = 0; n < 50; n++) {
    const page = await agentbox.timeline(id, before, 500);
    pages.unshift(page.events);
    if (!page.before) break;
    before = page.before;
  }
  return pages.flat();
}

/** The last thing the agent of a session said, as text. */
export async function lastReply(id: string): Promise<string> {
  const events = await transcript(id);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { kind?: string; text?: string };
    if (e.kind === "assistant" && e.text?.trim()) return e.text;
  }
  return "";
}

/** A SQLite file in this extension's home, for whatever it keeps. */
export function store(file = "state.db"): Database {
  mkdirSync(me.home, { recursive: true });
  const db = new Database(join(me.home, file), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

// ------------------------------------------------------------------ its page

/** Who asked, as agentbox saw it: a session that proved itself, a browser, or anything else on this machine. */
export type Caller = { session: string | null; via: "app" | "api" };
export type ActionRequest = { action: string; values: Record<string, unknown>; tab: string | null; caller: Caller };

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const callerOf = (req: Request): Caller => {
  const c = req.headers.get("x-agentbox-caller") ?? "api";
  return c.startsWith("session:") ? { session: c.slice(8), via: "api" } : { session: null, via: c === "app" ? "app" : "api" };
};

/**
 * Answer agentbox. Its page is `/`: with `view`, the app's block page draws
 * what `view` returns (`GET /view`) and sends its buttons to `action`
 * (`POST /action`); with `routes` alone, the program answers `/` itself, with
 * HTML of its own. Other paths are `routes`'. Every request must carry the
 * token agentbox gave this program, which only agentbox's `/x/<name>/` adds.
 */
export function serve(handlers: {
  view?: (tab: string | null, caller: Caller) => View | Promise<View>;
  action?: (req: ActionRequest) => ActionReply | Promise<ActionReply>;
  routes?: (req: Request, url: URL, caller: Caller) => Response | Promise<Response> | null;
}) {
  const token = env("AGENTBOX_EXT_TOKEN");
  const port = Number(env("PORT"));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      if (req.headers.get("x-agentbox-ext-token") !== token) return reply(403, { error: "not from agentbox" });
      const url = new URL(req.url);
      const caller = callerOf(req);
      try {
        if (handlers.view) {
          if (req.method === "GET" && url.pathname === "/") return Response.redirect(`/blocks.html?src=/x/${me.name}`, 302);
          if (req.method === "GET" && url.pathname === "/view") return reply(200, await handlers.view(url.searchParams.get("tab"), caller));
          if (req.method === "POST" && url.pathname === "/action") {
            if (!handlers.action) return reply(404, { error: "this extension takes no actions" });
            const body = (await req.json()) as ActionRequest;
            return reply(200, await handlers.action({ ...body, values: body.values ?? {}, caller }));
          }
        }
        const own = await handlers.routes?.(req, url, caller);
        return own ?? reply(404, { error: `no ${req.method} ${url.pathname}` });
      } catch (e) {
        const status = e instanceof ActionError ? e.status : e instanceof AgentboxError ? (e.status >= 400 && e.status < 500 ? e.status : 502) : 500;
        if (status >= 500) console.error(e);
        return reply(status, { error: (e as Error).message });
      }
    },
  });
}

/** Run `fn` every `ms`, never two at once; a throw is logged and the next one runs. */
export function every(ms: number, fn: () => Promise<void> | void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      console.error(e);
    } finally {
      running = false;
    }
  };
  void tick();
  const t = setInterval(tick, ms);
  return () => clearInterval(t);
}

/** Markdown-safe text: for putting what someone else wrote into a block. */
export const md = (s: string): string => s.replace(/([\\`*_[\]<>#|])/g, "\\$1");

/** Shorthands for blocks. */
export const block = {
  heading: (text: string): Block => ({ type: "heading", text }),
  markdown: (text: string): Block => ({ type: "markdown", text }),
  divider: (): Block => ({ type: "divider" }),
};
