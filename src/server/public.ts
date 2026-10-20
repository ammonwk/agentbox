/** The public door (docs/hub.md, The public door): this machine at an https
 *  URL, for a team whose browsers are not on its tailnet.
 *
 *  A proxy in front (TLS, the public name) forwards to a loopback port of
 *  its own, `AGENTBOX_PUBLIC_PORT`; nothing that arrives there is this
 *  machine or its owner. A person signs in with an OAuth 2.1 server the team
 *  already has (`AGENTBOX_SIGNIN_ISSUER`, which needs dynamic client
 *  registration and an MCP endpoint with a `whoami` tool, as Plaibook
 *  Internal has): the code comes back here, is exchanged for a token, and
 *  `whoami` says whose it is. The OAuth server decides who may sign in at
 *  all; this machine admits only those in `hub/members.json`. A session is a
 *  random cookie, kept here only as its hash, for twelve hours.
 *
 *  The same CSRF rules as loopback, with the public origin standing in for
 *  it: Host is the public name, Origin (always sent on a WebSocket) is the
 *  public origin, and mutations carry `x-agentbox: 1`. */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMembers } from "../core/hub";
import { agentboxHome } from "../core/paths";
import type { Person } from "../core/types";

export type PublicConfig = { url: URL; port: number; issuer: URL };

/** The door's settings from the environment, or null when it is off. */
export function publicConfig(): PublicConfig | null {
  const { AGENTBOX_PUBLIC_URL: u, AGENTBOX_PUBLIC_PORT: p, AGENTBOX_SIGNIN_ISSUER: i } = process.env;
  if (!u || !p || !i) return null;
  const url = new URL(u);
  const issuer = new URL(i);
  if (url.protocol !== "https:" || issuer.protocol !== "https:") throw new Error("AGENTBOX_PUBLIC_URL and AGENTBOX_SIGNIN_ISSUER must be https");
  return { url: new URL(url.origin), port: Number(p), issuer: new URL(issuer.origin) };
}

const COOKIE = "__Host-agentbox";
const SESSION_MS = 12 * 3_600_000;
const LOGIN_MS = 10 * 60_000;

type Saved = { login: string; name: string; until: number };
type Client = { issuer: string; redirect: string; client_id: string; client_secret?: string };
type Meta = { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; revocation_endpoint?: string };

const dir = (): string => join(agentboxHome(), "public");
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const b64 = (b: Buffer): string => b.toString("base64url");

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dir(), name), "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(name: string, v: unknown): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = join(dir(), `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  renameSync(tmp, join(dir(), name));
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#222}a{color:#0b62d6}</style>
<h1 style="font-size:1.3rem">${esc(title)}</h1>${body}`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

const apiError = (status: number, error: string): Response =>
  Response.json({ ok: false, data: null, error }, { status, headers: { "cache-control": "no-store" } });

export class PublicDoor {
  private sessions = new Map<string, Saved>(readJson<[string, Saved][]>("sessions.json") ?? []);
  private logins = new Map<string, { verifier: string; next: string; at: number }>();
  private meta: Meta | null = null;

  constructor(readonly cfg: PublicConfig) {}

  private get redirect(): string {
    return new URL("/auth/callback", this.cfg.url).href;
  }

  private async metadata(): Promise<Meta> {
    if (this.meta) return this.meta;
    const r = await fetch(new URL("/.well-known/oauth-authorization-server", this.cfg.issuer), { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`the sign-in server's metadata: HTTP ${r.status}`);
    this.meta = (await r.json()) as Meta;
    return this.meta;
  }

  /** This door's client at the sign-in server, registered the first time. */
  private async client(): Promise<Client> {
    const saved = readJson<Client>("client.json");
    if (saved && saved.issuer === this.cfg.issuer.href && saved.redirect === this.redirect) return saved;
    const m = await this.metadata();
    const r = await fetch(m.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `agentbox (${this.cfg.url.host})`,
        redirect_uris: [this.redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`registering with the sign-in server: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const c = (await r.json()) as { client_id: string; client_secret?: string };
    const client: Client = { issuer: this.cfg.issuer.href, redirect: this.redirect, client_id: c.client_id, client_secret: c.client_secret };
    writeJson("client.json", client);
    return client;
  }

  private save(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (s.until < now) this.sessions.delete(k);
    writeJson("sessions.json", [...this.sessions]);
  }

  private session(req: Request): Saved | null {
    const raw = req.headers.get("cookie") ?? "";
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[-]/g, "\\-")}=([A-Za-z0-9_-]{20,100})`));
    const s = m ? this.sessions.get(hash(m[1]!)) : undefined;
    return s && s.until > Date.now() ? s : null;
  }

  private async login(url: URL): Promise<Response> {
    const next = url.searchParams.get("next") ?? "/";
    const verifier = b64(randomBytes(32));
    const state = b64(randomBytes(24));
    const now = Date.now();
    for (const [k, v] of this.logins) if (v.at < now - LOGIN_MS) this.logins.delete(k);
    if (this.logins.size > 500) return page(429, "Too many sign-ins at once", "<p>Try again in a few minutes.</p>");
    this.logins.set(state, { verifier, next: next.startsWith("/") && !next.startsWith("//") ? next : "/", at: now });
    const [m, c] = await Promise.all([this.metadata(), this.client()]);
    const to = new URL(m.authorization_endpoint);
    to.search = new URLSearchParams({
      response_type: "code",
      client_id: c.client_id,
      redirect_uri: this.redirect,
      code_challenge: b64(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
      scope: "mcp",
      resource: new URL("/mcp", this.cfg.issuer).href,
    }).toString();
    return new Response(null, { status: 302, headers: { location: to.href, "cache-control": "no-store" } });
  }

  private async callback(url: URL): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const pending = this.logins.get(state);
    this.logins.delete(state);
    const code = url.searchParams.get("code");
    if (!pending || pending.at < Date.now() - LOGIN_MS || !code) {
      return page(400, "That sign-in link has expired", `<p><a href="/auth/login">Sign in again</a>.</p>`);
    }
    const [m, c] = await Promise.all([this.metadata(), this.client()]);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirect,
      client_id: c.client_id,
      code_verifier: pending.verifier,
      resource: new URL("/mcp", this.cfg.issuer).href,
      ...(c.client_secret ? { client_secret: c.client_secret } : {}),
    });
    const t = await fetch(m.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(15_000) });
    if (!t.ok) return page(403, "Sign-in was refused", `<p>${esc(this.cfg.issuer.host)} said: ${esc((await t.text()).slice(0, 300))}</p><p><a href="/auth/login">Try again</a>.</p>`);
    const tokens = (await t.json()) as { access_token: string; refresh_token?: string };
    const who = await this.whoami(tokens.access_token);
    // Only who they are is kept; the grant itself goes back.
    if (tokens.refresh_token && m.revocation_endpoint) {
      const rev = new URLSearchParams({ token: tokens.refresh_token, client_id: c.client_id, ...(c.client_secret ? { client_secret: c.client_secret } : {}) });
      void fetch(m.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: rev }).catch(() => {});
    }
    if (!who) return page(502, "Could not tell who you are", `<p>${esc(this.cfg.issuer.host)} did not say. <a href="/auth/login">Try again</a>.</p>`);
    if (!this.member(who.login)) return this.notMember(who.login);
    const token = b64(randomBytes(32));
    this.sessions.set(hash(token), { login: who.login, name: who.name, until: Date.now() + SESSION_MS });
    this.save();
    console.log(`agentbox: public: ${who.login} signed in`);
    return new Response(null, {
      status: 302,
      headers: {
        location: pending.next,
        "set-cookie": `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
        "cache-control": "no-store",
      },
    });
  }

  /** Whose token it is, from the MCP endpoint's `whoami` tool. */
  private async whoami(token: string): Promise<{ login: string; name: string } | null> {
    try {
      const r = await fetch(new URL("/mcp", this.cfg.issuer), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return null;
      const out = (await r.json()) as { result?: { content?: { text?: string }[] } };
      const who = JSON.parse(out.result?.content?.[0]?.text ?? "null") as { email?: string; name?: string } | null;
      const login = who?.email?.trim().toLowerCase();
      return login ? { login, name: who?.name?.trim() || login } : null;
    } catch {
      return null;
    }
  }

  private member(login: string) {
    return readMembers()?.find((m) => m.login === login) ?? null;
  }

  private notMember(login: string): Response {
    return page(
      403,
      "Not on this box's list",
      `<p>You are signed in as <b>${esc(login)}</b>, but only the people on this agentbox's member list may use it. Ask one of them to add you on the Team page.</p>`,
    );
  }

  private logout(req: Request): Response {
    const raw = req.headers.get("cookie") ?? "";
    const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE.replace(/[-]/g, "\\-")}=([A-Za-z0-9_-]+)`));
    if (m && this.sessions.delete(hash(m[1]!))) this.save();
    return page(200, "Signed out", `<p><a href="/auth/login">Sign in again</a>.</p>`, { "set-cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
  }

  /** Every request at the door: its own pages, else the person it is, else
   *  the answer that turns it away. */
  async gate(req: Request, upgrade: boolean): Promise<Person | Response> {
    const url = new URL(req.url);
    if (req.headers.get("host") !== this.cfg.url.host) return apiError(403, "unexpected Host header");
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== this.cfg.url.origin) return apiError(403, "cross-origin requests are not allowed");
    try {
      if (url.pathname === "/auth/login" && req.method === "GET") return await this.login(url);
      if (url.pathname === "/auth/callback" && req.method === "GET") return await this.callback(url);
      if (url.pathname === "/auth/logout" && req.method === "GET") return this.logout(req);
    } catch (e) {
      console.error(`agentbox: public: ${url.pathname}: ${(e as Error).message}`);
      return page(502, "Sign-in is not working", `<p>${esc((e as Error).message)}</p>`);
    }
    const s = this.session(req);
    if (!s) {
      const api = url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws");
      if (api || req.method !== "GET") return apiError(401, "sign in first");
      return new Response(null, { status: 302, headers: { location: `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
    }
    const member = this.member(s.login);
    if (!member) return this.notMember(s.login);
    const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    if (!safe && !upgrade && req.headers.get("x-agentbox") !== "1") return apiError(403, "missing x-agentbox header");
    return { login: s.login, name: member.name ?? s.name, role: member.role, via: "web" };
  }
}
