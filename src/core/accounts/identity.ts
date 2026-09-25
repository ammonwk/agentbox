/** Who an account is logged in as, and whether that login still works —
 * read from the files the CLI wrote, without refreshing anything.
 *
 * Token VALUES never leave this module except as the one argument to a usage
 * request's Authorization header (usage.ts). Nothing here logs, returns in an
 * error message, or stores a token; the readers hand back the fields they were
 * asked for and drop the rest.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Account, AccountAuth } from "../types";
import { exec as defaultExec, type ExecFn } from "./exec";
import { authEnv, claudeJsonPath, credentialsPath } from "./homes";

export interface Identity {
  email: string | null;
  plan: string | null;
  auth: AccountAuth;
}

type AccountRef = Pick<Account, "provider" | "home" | "isDefault">;

const EXPIRED_REFRESHABLE = "access token expired; refreshes on next use";

// ------------------------------------------------------------------ claude

export interface ClaudeCredentials {
  accessToken: string | null;
  hasRefreshToken: boolean;
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  scopes: string[] | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `<home>/.credentials.json` → `claudeAiOauth`. Null when there is no
 *  subscription login in it (an MCP-only credentials file is not a login). */
export function readClaudeCredentials(home: string): ClaudeCredentials | null {
  const o = rec(rec(readJson(join(home, ".credentials.json")))?.claudeAiOauth);
  if (!o) return null;
  return {
    accessToken: str(o.accessToken),
    hasRefreshToken: !!str(o.refreshToken),
    expiresAt: num(o.expiresAt),
    refreshTokenExpiresAt: num(o.refreshTokenExpiresAt),
    scopes: Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === "string") : null,
    subscriptionType: str(o.subscriptionType),
    rateLimitTier: str(o.rateLimitTier),
  };
}

/**
 * `.claude.json` is ~400 KB on a long-lived install and is parsed for two tiny
 * fields, so parses are cached by (path, mtime, size). The usage poller stats
 * it every ten seconds; without this it would re-parse it every time.
 */
const claudeJsonCache = new Map<string, { mtimeMs: number; size: number; value: Record<string, unknown> | null }>();

export function readClaudeJson(path: string): { value: Record<string, unknown> | null; mtimeMs: number } | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const hit = claudeJsonCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { value: hit.value, mtimeMs: st.mtimeMs };
  const value = rec(readJson(path));
  claudeJsonCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
  return { value, mtimeMs: st.mtimeMs };
}

/** "max" + "default_claude_max_20x" → "max 20x". */
export function claudePlan(subscriptionType: string | null, rateLimitTier: string | null): string | null {
  if (!subscriptionType) return null;
  const mult = rateLimitTier ? /_(\d+x)$/.exec(rateLimitTier)?.[1] : undefined;
  return mult ? `${subscriptionType} ${mult}` : subscriptionType;
}

/**
 * Auth from token timestamps. An expired ACCESS token is not a broken login:
 * the CLI refreshes it the next time it runs on this account, so that is "ok"
 * with a detail. Only an expired or absent REFRESH token needs you.
 */
export function tokenAuth(
  t: { expiresAt: number | null; hasRefreshToken: boolean; refreshTokenExpiresAt?: number | null },
  now: number,
): AccountAuth {
  if (t.refreshTokenExpiresAt != null && t.refreshTokenExpiresAt <= now) {
    return { state: "expired", expiresAt: t.expiresAt, detail: "login expired — log in again" };
  }
  if (t.expiresAt != null && t.expiresAt <= now) {
    return t.hasRefreshToken
      ? { state: "ok", expiresAt: t.expiresAt, detail: EXPIRED_REFRESHABLE }
      : { state: "expired", expiresAt: t.expiresAt, detail: "access token expired and there is no refresh token — log in again" };
  }
  return { state: "ok", expiresAt: t.expiresAt, detail: null };
}

export function identifyClaude(account: AccountRef, now = Date.now()): Identity {
  const cred = readClaudeCredentials(account.home);
  const cj = readClaudeJson(claudeJsonPath(account))?.value;
  const oa = rec(cj?.oauthAccount);
  const email = str(oa?.emailAddress);
  if (!cred) {
    return { email: null, plan: null, auth: { state: "missing", expiresAt: null, detail: "not logged in" } };
  }
  return {
    email,
    plan: claudePlan(cred.subscriptionType, cred.rateLimitTier),
    auth: tokenAuth(cred, now),
  };
}

// ------------------------------------------------------------------- codex

/** The payload of a JWT, unverified. We only read claims we display; nothing
 *  here is trusted for authorization. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    return rec(JSON.parse(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64").toString("utf8")));
  } catch {
    return null;
  }
}

export interface CodexAuth {
  mode: "chatgpt" | "apikey" | "none";
  accessToken: string | null;
  accountId: string | null;
  hasRefreshToken: boolean;
  /** From the access token's `exp`. */
  expiresAt: number | null;
  email: string | null;
  plan: string | null;
  lastRefresh: number | null;
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

export function readCodexAuth(home: string): CodexAuth | null {
  const a = rec(readJson(join(home, "auth.json")));
  if (!a) return null;
  const t = rec(a.tokens);
  const lastRefresh = str(a.last_refresh) ? Date.parse(a.last_refresh as string) : NaN;
  if (!t) {
    return {
      mode: str(a.OPENAI_API_KEY) ? "apikey" : "none",
      accessToken: null, accountId: null, hasRefreshToken: false, expiresAt: null,
      email: null, plan: str(a.OPENAI_API_KEY) ? "api key" : null,
      lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : null,
    };
  }
  const idc = str(t.id_token) ? decodeJwtPayload(t.id_token as string) : null;
  const acc = str(t.access_token) ? decodeJwtPayload(t.access_token as string) : null;
  const authClaim = rec(idc?.[OPENAI_AUTH_CLAIM]) ?? rec(acc?.[OPENAI_AUTH_CLAIM]);
  const exp = num(acc?.exp);
  return {
    mode: "chatgpt",
    accessToken: str(t.access_token),
    accountId: str(t.account_id) ?? str(authClaim?.chatgpt_account_id),
    hasRefreshToken: !!str(t.refresh_token),
    expiresAt: exp != null ? exp * 1000 : null,
    email: str(idc?.email) ?? str(rec(acc?.[OPENAI_PROFILE_CLAIM])?.email),
    plan: str(authClaim?.chatgpt_plan_type),
    lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : null,
  };
}

export function identifyCodex(account: AccountRef, now = Date.now()): Identity {
  const a = readCodexAuth(account.home);
  if (!a || a.mode === "none") {
    return { email: null, plan: null, auth: { state: "missing", expiresAt: null, detail: "not logged in" } };
  }
  if (a.mode === "apikey") {
    return { email: null, plan: a.plan, auth: { state: "ok", expiresAt: null, detail: "API key login (no subscription windows)" } };
  }
  return { email: a.email, plan: a.plan, auth: tokenAuth(a, now) };
}

// ------------------------------------------------------------------- devin

/** `<home>/devin/credentials.toml`: flat `key = "value"` lines. */
export function readDevinCredentials(home: string): { apiKey: string | null; apiServerUrl: string | null } | null {
  let raw: string;
  try {
    raw = readFileSync(join(home, "devin", "credentials.toml"), "utf8");
  } catch {
    return null;
  }
  const get = (k: string) => new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, "m").exec(raw)?.[1] ?? null;
  return { apiKey: get("windsurf_api_key"), apiServerUrl: get("api_server_url") };
}

/**
 * `devin auth status` prints aligned `Label:   value` lines:
 *
 *     Logged in (via Devin).
 *     User:
 *       Email:             someone@example.com
 *     Account:
 *       Tier:              Devin Max
 *       Plan:              Max
 */
export function parseDevinAuthStatus(text: string): { loggedIn: boolean; email: string | null; plan: string | null } {
  const field = (k: string) => new RegExp(`^\\s*${k}:\\s+(.+?)\\s*$`, "m").exec(text)?.[1] ?? null;
  const loggedIn = /^\s*Logged in\b/m.test(text) && !/not logged in/i.test(text);
  return { loggedIn, email: field("Email"), plan: field("Tier") ?? field("Plan") };
}

export async function identifyDevin(account: AccountRef, execFn: ExecFn = defaultExec): Promise<Identity> {
  if (!existsSync(credentialsPath("devin", account.home)!)) {
    return { email: null, plan: null, auth: { state: "missing", expiresAt: null, detail: "not logged in" } };
  }
  const { env, unset } = authEnv({ ...account, provider: "devin" });
  // For the default account we also drop any XDG overrides the server
  // inherited, so devin reads the same files a plain `devin` in your shell does.
  const r = await execFn(["devin", "auth", "status"], { env, unset, timeoutMs: 20_000 });
  const parsed = parseDevinAuthStatus(`${r.stdout}\n${r.stderr}`);
  if (r.code !== 0 && !parsed.loggedIn) {
    return {
      email: parsed.email, plan: parsed.plan,
      auth: r.timedOut
        ? { state: "unknown", expiresAt: null, detail: "devin auth status timed out" }
        : { state: "expired", expiresAt: null, detail: "devin reports this login is not valid — log in again" },
    };
  }
  return { email: parsed.email, plan: parsed.plan, auth: { state: parsed.loggedIn ? "ok" : "unknown", expiresAt: null, detail: null } };
}

// ---------------------------------------------------------------- dispatch

export async function identify(account: AccountRef, opts: { exec?: ExecFn; now?: number } = {}): Promise<Identity> {
  const now = opts.now ?? Date.now();
  switch (account.provider) {
    case "claude": return identifyClaude(account, now);
    case "codex": return identifyCodex(account, now);
    case "devin": return identifyDevin(account, opts.exec);
    case "omp":
      // omp balances a pool of logins of its own; there is no one email or
      // plan. Auth is inferred from whether `omp usage` answers (usage.ts).
      return { email: null, plan: null, auth: { state: "unknown", expiresAt: null, detail: null } };
  }
}

/**
 * Identity rarely changes, and for devin it costs a subprocess and a network
 * round trip, so results are cached. Claude and codex are two small file reads
 * and their auth state moves with the clock (token expiry), so they are
 * re-read far more often than devin.
 */
export class IdentityCache {
  private cache = new Map<string, { at: number; value: Identity }>();
  private inflight = new Map<string, Promise<Identity>>();

  constructor(private opts: { exec?: ExecFn; now?: () => number } = {}) {}

  static ttlMs(provider: Account["provider"]): number {
    return provider === "devin" ? 30 * 60_000 : 60_000;
  }

  peek(accountId: string): Identity | null {
    return this.cache.get(accountId)?.value ?? null;
  }

  async get(account: Account, force = false): Promise<Identity> {
    const now = this.opts.now?.() ?? Date.now();
    const hit = this.cache.get(account.id);
    if (!force && hit && now - hit.at < IdentityCache.ttlMs(account.provider)) return hit.value;
    const running = this.inflight.get(account.id);
    if (running) return running;
    const p = identify(account, { exec: this.opts.exec, now })
      .then((value) => {
        this.cache.set(account.id, { at: now, value });
        return value;
      })
      .finally(() => this.inflight.delete(account.id));
    this.inflight.set(account.id, p);
    return p;
  }

  forget(accountId: string): void {
    this.cache.delete(accountId);
  }
}
