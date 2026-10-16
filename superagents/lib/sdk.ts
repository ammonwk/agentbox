/**
 * What a superagent's program needs from agentbox, in one file
 * (docs/superagents.md). Nothing in it is required: it is the public HTTP API
 * with the environment agentbox gives a program it runs, and a superagent in
 * another language talks to the same API.
 *
 * A superagent outside this checkout imports it by path:
 *   import { agentbox, serve } from "/path/to/agentbox/superagents/lib/sdk.ts";
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppState, Card, Session, SuperagentBlock, SuperagentView, TimelinePage, Wait } from "../../src/core/types";
import type { ClaimScope, WorkClaim } from "../../src/core/workclaims";

export type { SuperagentAction, SuperagentBlock, SuperagentField, SuperagentView } from "../../src/core/types";
export type { ClaimHolder, ClaimScope, ClaimState, WorkClaim } from "../../src/core/workclaims";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set: this runs as a superagent's program, started by agentbox (docs/superagents.md)`);
  return v;
};

/** Who and where this program is. */
export const me = {
  get name() {
    return env("AGENTBOX_SUPERAGENT");
  },
  /** Its code: where superagent.json is. */
  get dir() {
    return env("AGENTBOX_SUPERAGENT_DIR");
  },
  /** Its own state, kept across restarts and upgrades: agentbox never reads it. */
  get home() {
    return env("AGENTBOX_SUPERAGENT_HOME");
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

/** One call of agentbox's HTTP API (docs/v2.md, HTTP API). A program agentbox
 *  runs says who it is with its name and token, so that what it claims is its own. */
export async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const base = process.env.AGENTBOX_URL ?? "http://127.0.0.1:4479";
  const name = process.env.AGENTBOX_SUPERAGENT;
  const token = process.env.AGENTBOX_SUPERAGENT_TOKEN;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agentbox": "1", ...(name && token ? { "x-agentbox-superagent": name, "x-agentbox-superagent-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await res.json().catch(() => null)) as { ok: boolean; data: T; error: string | null } | null;
  if (!out) throw new AgentboxError(`agentbox answered ${path} with HTTP ${res.status} and no JSON`, res.status);
  if (!out.ok) throw new AgentboxError(out.error ?? `HTTP ${res.status}`, res.status, out.data);
  return out.data;
}

/** The parts of the API superagents use most, by name. Anything else: `call`. */
export const agentbox = {
  state: (open = true) => call<AppState>("GET", `/api/state${open ? "?open=1" : ""}`),
  session: async (id: string): Promise<Session | null> => (await agentbox.state(false)).sessions.find((s) => s.id === id) ?? null,
  /** Start a session: a `POST /api/sessions` body. `parent` puts it under that session on the board. */
  start: (spec: {
    provider: string;
    prompt?: string;
    cwd?: string;
    repoId?: string;
    worktree?: boolean;
    branch?: string;
    model?: string;
    effort?: string;
    accountId?: string;
    parent?: string;
    claim?: string;
    /** Reads, never writes (codex): for a reviewer. */
    readOnly?: boolean;
    /** False: its stops are not pushed to the phone; its page shows them instead. */
    notify?: boolean;
  }) => call<{ session: Session }>("POST", "/api/sessions", spec).then((r) => r.session),
  /** Type into a session as an agent: the send guard applies (docs/v2.md, Messages between sessions). */
  send: (id: string, text: string, opts: { wake?: boolean; from?: string } = {}) =>
    call<{ to?: string } | null>("POST", `/api/sessions/${id}/send`, { text, from: "agent", wake: opts.wake, fromSession: opts.from }),
  timeline: (id: string, before?: string, limit = 200) =>
    call<TimelinePage>("GET", `/api/sessions/${id}/timeline?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`),
  stop: (id: string) => call("POST", `/api/sessions/${id}/stop`),
  close: (id: string) => call("POST", `/api/sessions/${id}/close`, { closed: true }),
  /** What `from` holds goes to `to`: its children, cards, PRs and their waits, and messages to it. */
  handover: (from: string, to: string, close = false) => call("POST", `/api/sessions/${from}/handover`, { to, close }),
  card: (c: { kind: "decision" | "note" | "merged"; title: string; short: string; long?: string; pr?: string; recommend?: string; default?: string; defaultAt?: number; key?: string; session?: string; about?: string; notify?: boolean }) =>
    call<Card>("POST", "/api/cards", c),
  cards: (q = "") => call<Card[]>("GET", `/api/cards${q}`),
  /** A wait told to `session` (docs/v2.md, Waits): `{pr: {...}}`, `{run: ...}`, `{session: ...}`, `{until: ...}`, `{time: ...}`. */
  wait: (session: string, spec: Record<string, unknown>, opts: { pr?: string; cwd?: string; timeoutMs?: number } = {}) =>
    call<{ wait: Wait; already: boolean }>("POST", "/api/waits", { spec, session, ...opts }),
  claimPr: (pr: string, session: string, cwd?: string) => call("POST", "/api/prs/claim", { pr, session, cwd }),
  prWho: (pr: string, cwd?: string) => call<{ repo: string; number: number; claim: { sessionId: string } | null }>("POST", "/api/prs/who", { pr, cwd }),
  /** Claim work by its sources (docs/superagents.md, Claims): every one or none.
   *  A held source is refused with 409, and the error's `data` is `{key, holder, state}`. */
  claim: (sources: string[], opts: { scope?: ClaimScope; session?: string; note?: string } = {}) =>
    call<{ claims: WorkClaim[] }>("POST", "/api/claims", { sources, ...opts }).then((r) => r.claims),
  /** The session that does the claimed work, once started: the fence grows by one. */
  attachClaim: (key: string, fence: number, session: string, scope?: ClaimScope) => call<WorkClaim>("POST", "/api/claims/attach", { key, fence, session, scope }),
  releaseClaim: (key: string, fence: number, scope?: ClaimScope) => call<WorkClaim>("POST", "/api/claims/release", { key, fence, scope }),
  /** Agentbox stops the holder session and moves the key only once the stop is proven; 409 while it is not. */
  takeoverClaim: (key: string, to?: string, scope?: ClaimScope) => call<WorkClaim>("POST", "/api/claims/takeover", { key, to, scope }),
  /** Claims held now: this superagent's unless the query says otherwise. */
  claims: (q: { superagent?: string; session?: string; key?: string } = { superagent: me.name }) =>
    call<WorkClaim[]>("GET", `/api/claims?${new URLSearchParams(Object.entries(q).filter((e): e is [string, string] => !!e[1]))}`),
  /** This superagent, as the Agents page shows it. */
  self: () => call<{ main: string | null; previous: string[] }>("GET", `/api/superagents/${me.name}`),
  /** Say which session is this superagent's main conversation. */
  setMain: (id: string | null) => call("PATCH", `/api/superagents/${me.name}`, { main: id }),
  /** Its memory journal (manifest `"memory": true`; docs/superagents.md): the
   *  view the Memory panel shows, with search results for `q`. */
  memory: (q?: string) => call<{ preferences: unknown[]; handoffs: unknown[]; notes: unknown[]; results: unknown[] | null }>("GET", `/api/superagents/${me.name}/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  /** Record a decision in its journal; `request` makes a retry the same record. */
  note: (body: { decision: string; why?: string; refs?: { label: string; ref: string }[] }, request?: string) =>
    call("POST", `/api/superagents/${me.name}/memory/note`, { body, ...(request ? { request } : {}) }),
  /** Set a durable preference; empty text forgets it. */
  prefer: (key: string, text: string) => call("POST", `/api/superagents/${me.name}/memory/prefer`, { key, text }),
  /** A prompt said to its main conversation on a schedule (removed with `unloop`). */
  loop: (id: string, spec: { when: string; prompt: string; check?: string }) => call("PUT", `/api/superagents/${me.name}/loops/${id}`, spec),
  unloop: (id: string) => call("DELETE", `/api/superagents/${me.name}/loops/${id}`),
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

/** A SQLite file in this superagent's home, for whatever it keeps. */
export function store(file = "state.db"): Database {
  mkdirSync(me.home, { recursive: true });
  const db = new Database(join(me.home, file), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return db;
}

/** Who an action came from, as agentbox saw it. */
export type Caller = { session: string | null; via: "app" | "api" | "team"; user?: { id: string; name: string } };
export type ActionRequest = { action: string; values: Record<string, unknown>; tab: string | null; caller: Caller };
/** What an action answers: words for the page, a page to show, or where to go. */
export type ActionReply = { message?: string; view?: SuperagentView; open?: string } & Record<string, unknown>;

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Answer agentbox: `GET /agentbox/view` is the page, `POST /agentbox/action`
 * an action on it or a session's call. Other paths are the program's own
 * (`routes`). Every request must carry the token agentbox gave this program.
 */
export function serve(handlers: {
  view: (tab: string | null) => SuperagentView | Promise<SuperagentView>;
  action?: (req: ActionRequest) => ActionReply | Promise<ActionReply>;
  routes?: (req: Request, url: URL) => Response | Promise<Response> | null;
}) {
  const token = env("AGENTBOX_SUPERAGENT_TOKEN");
  const port = Number(env("PORT"));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      if (req.headers.get("x-agentbox-superagent-token") !== token) return reply(403, { error: "not from agentbox" });
      const url = new URL(req.url);
      try {
        if (req.method === "GET" && url.pathname === "/agentbox/view") return reply(200, await handlers.view(url.searchParams.get("tab")));
        if (req.method === "POST" && url.pathname === "/agentbox/action") {
          if (!handlers.action) return reply(404, { error: "this superagent takes no actions" });
          const body = (await req.json()) as ActionRequest;
          return reply(200, await handlers.action({ ...body, values: body.values ?? {} }));
        }
        const own = await handlers.routes?.(req, url);
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
  heading: (text: string): SuperagentBlock => ({ type: "heading", text }),
  markdown: (text: string): SuperagentBlock => ({ type: "markdown", text }),
  divider: (): SuperagentBlock => ({ type: "divider" }),
};
