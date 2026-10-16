/** How much of each account's rate limits is used, per window.
 *
 * One `UsageService` keeps the latest `AccountUsage` per account, emits
 * `change` when it moves, persists it (so the Accounts page has numbers the
 * moment the server boots) and writes the calibration samples.
 *
 * Sources, freshest wins:
 * - claude: `GET /api/oauth/usage` every 3 min, plus the free copy the CLI
 *   itself caches in `.claude.json` (`cachedUsageUtilization`) whenever that
 *   file changes. A fresh cache pushes the next endpoint call back.
 * - codex: `GET /backend-api/wham/usage` every 5 min, plus `ingestRollout`
 *   readings the fleet parses from rollout `token_count` events. A recent
 *   rollout reading likewise pushes the endpoint back.
 * - devin: Connect-JSON `GetUserStatus`, every 10 min, best effort.
 * - omp (OpenCode Go): Go's usage report, `GET …/go/v1/usage`, every 3 min,
 *   through the bridge, which holds the credentials.
 *
 * agentbox never refreshes a token (docs/v2.md). An expired access token
 * means we do not call the endpoint at all — a request would 401 — and the
 * card shows the last good reading marked stale until a CLI run on that
 * account refreshes the credentials, which we notice by the credentials
 * file's mtime and poll straight away.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { getKv, insertUsageSample, lastUsageSample, setKv, type UsageSampleRow } from "../db";
import type { Account, AccountProvider, AccountUsage, ProviderId, ResetConsumeResult, ResetCredit, ResetCredits, ResetOutcome, UsageWindow, WindowKind } from "../types";
import { exec as defaultExec, type ExecFn } from "./exec";
import { AccountError, claudeJsonPath, credentialsPath, detectCli } from "./homes";
import { bridgeUrl } from "../../bridge/models";
import { hasGoCredential } from "./gocred";
import { readClaudeCredentials, readClaudeJson, readCodexAuth, readDevinCredentials } from "./identity";

const MIN = 60_000;
const HOUR = 60 * MIN;
const FIVE_HOURS = 5 * HOUR;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const POLL_MS: Record<AccountProvider, number> = {
  claude: 3 * MIN,
  codex: 5 * MIN,
  devin: 10 * MIN,
  omp: 3 * MIN,
  muse: 10 * MIN,
};

const TICK_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
/** A reading is sampled at least this often even when nothing moved, so the
 *  calibration series has no holes that look like missing data. */
const SAMPLE_EVERY_MS = HOUR;

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CONSUME_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const DEVIN_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

export type Reading =
  | { kind: "ok"; at: number; windows: UsageWindow[]; notes: string[]; source: AccountUsage["source"]; resets?: ResetCredits | null }
  /** We chose not to ask (token expired, scope missing, not logged in). */
  | { kind: "skip"; stale: string }
  | { kind: "error"; stale: string; rateLimited?: boolean; retryAfterMs?: number | null; unauthorized?: boolean };

export interface UsageDeps {
  fetch: typeof fetch;
  exec: ExecFn;
  now: () => number;
  /** Installed CLI version, for a User-Agent that looks like the CLI's own. */
  version: (p: ProviderId) => Promise<string | null>;
}

export const defaultDeps = (): UsageDeps => ({
  fetch: globalThis.fetch.bind(globalThis),
  exec: defaultExec,
  now: Date.now,
  version: async (p) => (await detectCli(p)).version,
});

export function emptyUsage(accountId: string): AccountUsage {
  return { accountId, at: null, windows: [], stale: null, source: "none", notes: [] };
}

// ---------------------------------------------------------------- helpers

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function isoMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

export function kindForDuration(ms: number): WindowKind {
  if (ms <= 12 * HOUR) return "short";
  if (ms <= 2 * DAY) return "daily";
  if (ms <= 8 * DAY) return "weekly";
  return "monthly";
}

/** "14:02" in local time, for stale messages a human reads. */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Retry-After as delta-seconds or an HTTP date. */
export function parseRetryAfter(v: string | null, now: number): number | null {
  if (!v?.trim()) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

async function httpError(res: Response, what: string, now: number): Promise<Reading> {
  // Drain the body so the connection is released; never echo it — an auth
  // error body could quote the header back.
  await res.arrayBuffer().catch(() => undefined);
  if (res.status === 429) {
    return { kind: "error", stale: "rate limited", rateLimited: true, retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), now) };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "error", stale: "token expired — refreshes next time this account runs", unauthorized: true };
  }
  return { kind: "error", stale: `${what}: HTTP ${res.status}` };
}

function networkError(err: unknown, what: string): Reading {
  const name = (err as Error)?.name;
  return { kind: "error", stale: name === "TimeoutError" || name === "AbortError" ? `${what} timed out` : `${what} unreachable` };
}

// ------------------------------------------------------------------ claude

/**
 * Map an `/api/oauth/usage` body (or the CLI's cached copy of one) to windows.
 *
 * `five_hour` and `seven_day` are the account-wide windows; per-model weekly
 * caps arrive as `limits[kind=weekly_scoped]` named by
 * `scope.model.display_name`. `seven_day_opus`/`seven_day_sonnet` are the
 * legacy per-model buckets (null since mid-2026) and are used only when no
 * scoped limit names the same model. `is_active` is ignored: it marks the one
 * limit currently binding, not which limits exist.
 */
export function mapClaudeUsage(body: unknown): { windows: UsageWindow[]; notes: string[] } {
  const b = rec(body) ?? {};
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  const limits = Array.isArray(b.limits) ? b.limits.map(rec).filter((x): x is Record<string, unknown> => !!x) : [];

  const bucket = (v: unknown) => {
    const o = rec(v);
    if (!o) return null;
    const used = toNum(o.utilization);
    if (used === null) return null;
    if (typeof o.locked_reason === "string" && o.locked_reason) notes.push(`locked: ${o.locked_reason}`);
    return { usedPct: clampPct(used), resetsAt: isoMs(o.resets_at) };
  };
  const fromLimit = (kind: string) => {
    const l = limits.find((x) => x.kind === kind);
    const used = l ? toNum(l.percent) : null;
    return l && used !== null ? { usedPct: clampPct(used), resetsAt: isoMs(l.resets_at) } : null;
  };

  const five = bucket(b.five_hour) ?? fromLimit("session");
  if (five) windows.push({ id: "five_hour", kind: "short", label: "5-hour", windowMs: FIVE_HOURS, ...five });
  const week = bucket(b.seven_day) ?? fromLimit("weekly_all");
  if (week) windows.push({ id: "seven_day", kind: "weekly", label: "Weekly", windowMs: WEEK, ...week });

  const seen = new Set<string>();
  const scoped = (model: string, v: { usedPct: number; resetsAt: number | null }) => {
    if (seen.has(model.toLowerCase())) return;
    seen.add(model.toLowerCase());
    windows.push({ id: `seven_day:${model}`, kind: "weekly", label: `Weekly (${model})`, windowMs: WEEK, scope: { model }, ...v });
  };
  for (const l of limits) {
    if (l.kind !== "weekly_scoped") continue;
    const model = rec(rec(l.scope)?.model)?.display_name;
    const used = toNum(l.percent);
    if (typeof model !== "string" || !model.trim() || used === null) continue;
    scoped(model.trim(), { usedPct: clampPct(used), resetsAt: isoMs(l.resets_at) });
  }
  const opus = bucket(b.seven_day_opus);
  if (opus) scoped("Opus", opus);
  const sonnet = bucket(b.seven_day_sonnet);
  if (sonnet) scoped("Sonnet", sonnet);

  const extra = rec(b.extra_usage);
  const spend = rec(b.spend);
  if (spend?.enabled === true || extra?.is_enabled === true) {
    const pct = toNum(spend?.percent) ?? toNum(extra?.utilization);
    notes.push(pct !== null ? `extra usage on (${Math.round(pct)}% of cap)` : "extra usage on");
  }
  if (extra?.spend_limit_reached === true) notes.push("extra usage spend limit reached");
  return { windows, notes };
}

function claudeUA(version: string | null): string {
  // The CLI's own format (`claude-cli/<v> (external, <entrypoint>)`); the
  // endpoint is not strict about it but a recognisable UA is the polite thing.
  return `claude-cli/${version ?? "2.1.0"} (external, cli)`;
}

export async function fetchClaudeUsage(account: Pick<Account, "home">, deps: UsageDeps): Promise<Reading> {
  const cred = readClaudeCredentials(account.home);
  if (!cred?.accessToken) return { kind: "skip", stale: "No readable usage token; Claude's login may be in the system credential store" };
  const now = deps.now();
  // Refresh is the CLI's job. Calling with an expired token would only 401,
  // and doing it every three minutes looks like abuse.
  if (cred.expiresAt !== null && cred.expiresAt <= now + 30_000) {
    return { kind: "skip", stale: "token expired — refreshes next time this account runs" };
  }
  // The usage endpoint needs user:profile. Tokens minted by
  // `claude setup-token` carry only user:inference; the CLI's own cache is
  // then the only source.
  if (cred.scopes && !cred.scopes.includes("user:profile")) {
    return { kind: "skip", stale: "this login's token cannot read usage (no user:profile scope)" };
  }
  let res: Response;
  try {
    res = await deps.fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": claudeUA(await deps.version("claude")),
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return networkError(err, "usage endpoint");
  }
  if (!res.ok) return httpError(res, "usage endpoint", now);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "error", stale: "usage endpoint returned something that is not JSON" };
  }
  const { windows, notes } = mapClaudeUsage(body);
  if (windows.length === 0) return { kind: "error", stale: "usage endpoint returned no windows" };
  return { kind: "ok", at: deps.now(), windows, notes, source: "endpoint" };
}

/**
 * The CLI caches its own last `/api/oauth/usage` answer in `.claude.json`.
 * Free to read, and fresh whenever a session on this account is active. The
 * `accountUuid` check stops a cache written before a re-login to a different
 * account being attributed to the new one.
 */
export function readClaudeUsageCache(account: Pick<Account, "home" | "isDefault">): Reading | null {
  const cj = readClaudeJson(claudeJsonPath(account))?.value;
  const c = rec(cj?.cachedUsageUtilization);
  if (!c) return null;
  const at = toNum(c.fetchedAtMs);
  if (at === null) return null;
  const who = rec(cj?.oauthAccount)?.accountUuid;
  if (typeof c.accountUuid === "string" && typeof who === "string" && c.accountUuid !== who) return null;
  const { windows, notes } = mapClaudeUsage(c.utilization);
  if (windows.length === 0) return null;
  return { kind: "ok", at, windows, notes, source: "cache" };
}

// ------------------------------------------------------------------- codex

function codexWindow(w: unknown, now: number, prefix?: { id: string; label: string; model: string }): UsageWindow | null {
  const o = rec(w);
  if (!o) return null;
  const used = toNum(o.used_percent);
  const secs = toNum(o.limit_window_seconds);
  if (used === null || secs === null || secs <= 0) return null;
  const minutes = Math.round(secs / 60);
  const windowMs = secs * 1000;
  let id: string;
  let label: string;
  if (minutes === 10080) [id, label] = ["weekly", "Weekly"];
  else if (minutes === 300) [id, label] = ["five_hour", "5-hour"];
  else if (minutes === 1440) [id, label] = ["daily", "Daily"];
  else [id, label] = [`${minutes}m`, minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`];
  const resetAt = toNum(o.reset_at);
  const resetAfter = toNum(o.reset_after_seconds);
  const resetsAt =
    resetAt !== null ? (resetAt > 1e12 ? resetAt : resetAt * 1000) : resetAfter !== null ? now + resetAfter * 1000 : null;
  const out: UsageWindow = {
    id: prefix ? `${prefix.id}:${id}` : id,
    kind: kindForDuration(windowMs),
    label: prefix ? `${prefix.label} ${label}` : label,
    usedPct: clampPct(used),
    resetsAt,
    windowMs,
  };
  if (prefix) out.scope = { model: prefix.model };
  return out;
}

/**
 * `wham/usage` → windows, by window LENGTH rather than primary/secondary
 * position: since August 2026 some plans have only a weekly window and it
 * arrives as `primary_window`. `additional_rate_limits` are per-model meters
 * (e.g. a Spark model) and become model-scoped windows. The same body carries
 * the reset-credit count (`rate_limit_reset_credits`).
 */
export function mapCodexUsage(body: unknown, now: number): { windows: UsageWindow[]; notes: string[]; plan: string | null; resets: ResetCredits | null } {
  const b = rec(body) ?? {};
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  const rl = rec(b.rate_limit);
  for (const key of ["primary_window", "secondary_window"]) {
    const w = codexWindow(rl?.[key], now);
    if (w && !windows.some((x) => x.id === w.id)) windows.push(w);
  }
  if (rl?.limit_reached === true) notes.push("limit reached");
  for (const extra of Array.isArray(b.additional_rate_limits) ? b.additional_rate_limits : []) {
    const e = rec(extra);
    const erl = rec(e?.rate_limit);
    if (!e || !erl) continue;
    const name = typeof e.limit_name === "string" && e.limit_name ? e.limit_name : typeof e.metered_feature === "string" ? e.metered_feature : "extra";
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "extra";
    for (const key of ["primary_window", "secondary_window"]) {
      const w = codexWindow(erl[key], now, { id: slug, label: name, model: name });
      if (w && !windows.some((x) => x.id === w.id)) windows.push(w);
    }
    if (erl.limit_reached === true) notes.push(`${name}: limit reached`);
  }
  const credits = rec(b.credits);
  if (credits?.unlimited === true) notes.push("credits: unlimited");
  else if (credits?.has_credits === true && credits.balance != null) notes.push(`credits: ${String(credits.balance)}`);
  const rc = rec(b.rate_limit_reset_credits);
  const availableCount = toNum(rc?.available_count);
  const applicableCount = toNum(rc?.applicable_available_count);
  const resets =
    availableCount !== null
      ? { availableCount: Math.max(0, Math.floor(availableCount)), applicableCount: applicableCount === null ? null : Math.max(0, Math.floor(applicableCount)), credits: [] }
      : null;
  return { windows, notes, plan: typeof b.plan_type === "string" ? b.plan_type : null, resets };
}

/** `GET /wham/rate-limit-reset-credits` → the credits themselves. Timestamps
 *  arrive RFC3339; a missing one is null, not a parse failure. */
export function mapCodexResetCredits(body: unknown): ResetCredit[] {
  const b = rec(body);
  const list = b && Array.isArray(b.credits) ? (b.credits as unknown[]) : [];
  const out: ResetCredit[] = [];
  for (const c of list) {
    const o = rec(c);
    const id = typeof o?.id === "string" && o.id ? o.id : null;
    if (!o || !id) continue;
    const status = o.status === "available" || o.status === "redeeming" || o.status === "redeemed" ? o.status : "unknown";
    const granted = isoMs(o.granted_at);
    out.push({
      id,
      resetType: typeof o.reset_type === "string" ? o.reset_type : "unknown",
      status,
      grantedAt: granted,
      expiresAt: isoMs(o.expires_at),
      title: typeof o.title === "string" && o.title ? o.title : null,
      description: typeof o.description === "string" && o.description ? o.description : null,
    });
  }
  return out.sort((a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0));
}

function codexUA(version: string | null): string {
  return `codex_cli_rs/${version ?? "0.0.0"} (${process.platform === "darwin" ? "Mac OS" : "Linux"}; ${process.arch === "arm64" ? "aarch64" : "x86_64"}) agentbox`;
}

/** What every codex backend call needs: the account's own access token, its
 *  workspace, and a user agent the CLI itself would send. */
function codexHeaders(auth: { accessToken: string | null; accountId: string | null }, version: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    "User-Agent": codexUA(version),
    originator: "codex_cli_rs",
  };
  if (auth.accountId) h["ChatGPT-Account-Id"] = auth.accountId;
  return h;
}

/** The credits themselves, when the usage body's count says there are any:
 *  it carries only the count. Best effort — a failure leaves the count. */
async function enrichCodexResets(count: ResetCredits | null, headers: Record<string, string>, deps: UsageDeps): Promise<ResetCredits | null> {
  if (!count || count.availableCount <= 0) return count;
  let res: Response;
  try {
    res = await deps.fetch(CODEX_RESET_CREDITS_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    return count;
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    return count;
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return count;
  }
  return { ...count, credits: mapCodexResetCredits(body) };
}

export async function fetchCodexUsage(account: Pick<Account, "home">, deps: UsageDeps): Promise<Reading> {
  const auth = readCodexAuth(account.home);
  if (!auth || auth.mode === "none") return { kind: "skip", stale: "not logged in" };
  if (auth.mode === "apikey" || !auth.accessToken) return { kind: "skip", stale: "API-key login has no subscription windows" };
  const now = deps.now();
  if (auth.expiresAt !== null && auth.expiresAt <= now + 30_000) {
    return { kind: "skip", stale: "token expired — refreshes next time this account runs" };
  }
  const headers = codexHeaders(auth, await deps.version("codex"));
  let res: Response;
  try {
    res = await deps.fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return networkError(err, "usage endpoint");
  }
  if (!res.ok) return httpError(res, "usage endpoint", now);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "error", stale: "usage endpoint returned something that is not JSON" };
  }
  const at = deps.now();
  const { windows, notes, resets } = mapCodexUsage(body, at);
  if (windows.length === 0) return { kind: "error", stale: "usage endpoint returned no windows" };
  return { kind: "ok", at, windows, notes, source: "endpoint", resets: await enrichCodexResets(resets, headers, deps) };
}

export type { ResetOutcome, ResetConsumeResult } from "../types";

/**
 * Spend one Codex usage-limit reset — the CLI's `/usage` → "Full reset".
 * `creditId` picks one of several; omitted, the provider uses whichever
 * applies to a window that is spent right now. The request carries a fresh
 * idempotency key (`redeem_request_id`), so a dropped answer cannot spend two.
 */
export async function consumeCodexResetCredit(
  account: Pick<Account, "home">,
  deps: UsageDeps,
  creditId?: string | null,
): Promise<ResetConsumeResult> {
  const auth = readCodexAuth(account.home);
  if (!auth || auth.mode !== "chatgpt" || !auth.accessToken) {
    throw new Error("this is not a ChatGPT login, which is what a usage reset needs");
  }
  const now = deps.now();
  if (auth.expiresAt !== null && auth.expiresAt <= now + 30_000) {
    throw new Error("the login's token has expired — it refreshes the next time this account runs, then try again");
  }
  const payload: Record<string, string> = { redeem_request_id: randomUUID() };
  if (creditId) payload.credit_id = creditId;
  let res: Response;
  try {
    res = await deps.fetch(CODEX_RESET_CONSUME_URL, {
      method: "POST",
      headers: { ...codexHeaders(auth, await deps.version("codex")), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    throw new Error(name === "TimeoutError" || name === "AbortError" ? "the reset request timed out" : "could not reach the reset endpoint");
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 401 || res.status === 403) throw new Error("the reset was refused: this login cannot reset usage (it may have expired) — log in again");
    throw new Error(`the reset was refused (HTTP ${res.status})`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error("the reset answer was not JSON");
  }
  const b = rec(body) ?? {};
  const code = b.code;
  const outcome: ResetOutcome =
    code === "reset" ? "reset" : code === "nothing_to_reset" ? "nothing-to-reset" : code === "no_credit" ? "no-credit" : code === "already_redeemed" ? "already-redeemed" : "unknown";
  const windows = toNum(b.windows_reset);
  return { outcome, windowsReset: windows === null ? 0 : Math.max(0, Math.floor(windows)) };
}

// ------------------------------------------------------------------- devin

/**
 * `GetUserStatus` → daily/weekly windows. The server speaks Connect, which
 * accepts JSON as well as protobuf, so no generated code is needed.
 *
 * proto3 JSON omits zero values, so an absent `…RemainingPercent` next to a
 * present reset time means 0% remaining — it is reported as 100% used, with a
 * note, because treating absence as "unknown" would hide a spent quota.
 * `hideDailyQuota` plans (Devin's own UI hides the daily meter) get no daily
 * window.
 */
export function mapDevinUserStatus(body: unknown): { windows: UsageWindow[]; notes: string[]; email: string | null; plan: string | null } {
  const us = rec(rec(body)?.userStatus);
  const ps = rec(us?.planStatus);
  const info = rec(ps?.planInfo);
  const windows: UsageWindow[] = [];
  const notes: string[] = [];
  const one = (name: "daily" | "weekly", windowMs: number) => {
    const remaining = toNum(ps?.[`${name}QuotaRemainingPercent`]);
    const reset = toNum(ps?.[`${name}QuotaResetAtUnix`]);
    if (remaining === null && reset === null) return;
    if (remaining === null) notes.push(`${name} quota: devin reports 0% left`);
    windows.push({
      id: name,
      kind: name,
      label: name === "daily" ? "Daily" : "Weekly",
      usedPct: clampPct(100 - (remaining ?? 0)),
      resetsAt: reset !== null ? reset * 1000 : null,
      windowMs,
    });
  };
  if (info?.hideDailyQuota !== true) one("daily", DAY);
  one("weekly", WEEK);
  return {
    windows,
    notes,
    email: typeof us?.email === "string" ? us.email : null,
    plan: typeof info?.planName === "string" ? info.planName : null,
  };
}

export async function fetchDevinUsage(account: Pick<Account, "home">, deps: UsageDeps): Promise<Reading> {
  const cred = readDevinCredentials(account.home);
  if (!cred?.apiKey) return { kind: "skip", stale: "not logged in" };
  const server = (cred.apiServerUrl || "https://server.codeium.com").replace(/\/+$/, "");
  const apiKey = cred.apiKey.startsWith("devin-session-token$") ? cred.apiKey : `devin-session-token$${cred.apiKey}`;
  const now = deps.now();
  let res: Response;
  try {
    res = await deps.fetch(`${server}${DEVIN_STATUS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1", accept: "application/json" },
      body: JSON.stringify({
        metadata: {
          apiKey,
          ideName: "windsurf",
          ideVersion: "3.2.23",
          extensionName: "windsurf",
          extensionVersion: "1.48.2",
          locale: "en",
        },
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return networkError(err, "devin status");
  }
  if (!res.ok) return httpError(res, "devin status", now);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "error", stale: "devin status returned something that is not JSON" };
  }
  const { windows, notes } = mapDevinUserStatus(body);
  if (windows.length === 0) return { kind: "error", stale: "usage not available for devin" };
  return { kind: "ok", at: deps.now(), windows, notes, source: "endpoint" };
}

// ------------------------------------------------------------ OpenCode Go

const GO_WINDOWS: readonly { key: string; id: string; label: string; kind: WindowKind; windowMs: number }[] = [
  { key: "rolling", id: "rolling-5h", label: "5-hour", kind: "short", windowMs: FIVE_HOURS },
  { key: "weekly", id: "weekly", label: "Weekly", kind: "weekly", windowMs: WEEK },
  { key: "monthly", id: "monthly", label: "Monthly", kind: "monthly", windowMs: 30 * DAY },
];

/**
 * Map Go's usage report to windows:
 *
 *   {usage: {rolling|weekly|monthly: {status: "ok" | "rate-limited", percent, resetsAt}}}
 *
 * `percent` is whole points of the plan's dollar limit, rounded down. The
 * week ends Monday 00:00 UTC and the month on the day the subscription
 * started; the 5-hour window ends five hours after its last call, and one
 * with nothing in it is reported as ending five hours from now, which is no
 * reset at all.
 */
export function mapGoUsage(body: unknown, now: number): UsageWindow[] {
  const usage = rec(rec(body)?.usage) ?? {};
  const windows: UsageWindow[] = [];
  for (const g of GO_WINDOWS) {
    const u = rec(usage[g.key]);
    const pct = u?.status === "rate-limited" ? 100 : toNum(u?.percent);
    if (!u || pct === null) continue;
    let resetsAt = isoMs(u.resetsAt);
    if (g.key === "rolling" && pct === 0 && resetsAt !== null && resetsAt >= now + g.windowMs - MIN) resetsAt = null;
    windows.push({ id: `opencode-go:${g.id}`, kind: g.kind, label: g.label, usedPct: clampPct(pct), resetsAt, windowMs: g.windowMs, provider: "opencode-go" });
  }
  return windows;
}

/** Go's own count, asked through the bridge: it holds each account's
 *  credential (`/go/<account>/v1/usage`, src/bridge/devin.ts) and is the one
 *  thing that refreshes a Console sign-in, which asking here keeps alive. */
async function fetchGoUsage(account: Account, deps: UsageDeps): Promise<Reading> {
  if (!hasGoCredential(account)) return { kind: "skip", stale: "not signed in" };
  const now = deps.now();
  let res: Response;
  try {
    res = await deps.fetch(`${bridgeUrl()}/go/${account.id}/v1/usage`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return networkError(err, "the agentbox bridge");
  }
  if (res.status === 401 || res.status === 403) {
    await res.arrayBuffer().catch(() => undefined);
    const stale = res.status === 403 ? "no OpenCode Go subscription in this workspace" : "sign-in refused — log the account in again";
    return { kind: "error", stale, unauthorized: true };
  }
  if (!res.ok) return httpError(res, "OpenCode Go usage", now);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "error", stale: "OpenCode Go usage returned something that is not JSON" };
  }
  const windows = mapGoUsage(body, now);
  if (windows.length === 0) return { kind: "error", stale: "OpenCode Go usage had no windows" };
  return { kind: "ok", at: now, windows, notes: [], source: "endpoint" };
}

function fetchUsage(account: Account, deps: UsageDeps): Promise<Reading> {
  switch (account.provider) {
    case "muse": return Promise.resolve({ kind: "skip", stale: "Muse Code does not expose subscription usage windows here" });
    case "claude": return fetchClaudeUsage(account, deps);
    case "codex": return fetchCodexUsage(account, deps);
    case "devin": return fetchDevinUsage(account, deps);
    case "omp": return fetchGoUsage(account, deps);
  }
}

// ---------------------------------------------------------------- samples

/**
 * Whether a reading of window `w` at `at` is worth a calibration row, given
 * the last row for that window: when the percentage moved, when the reset
 * moved (a new window started), or once an hour regardless. Reset times are
 * compared with a minute's tolerance because some providers derive them from
 * "seconds until reset" and they wobble by a second between calls. A reading
 * older than the last row (a stale cache read after an endpoint call) is never
 * written: it would make the series go backwards.
 */
export function shouldSample(last: UsageSampleRow | null, w: UsageWindow, at: number): boolean {
  if (!last) return true;
  if (at <= last.at) return false;
  if (Math.abs(last.usedPct - w.usedPct) > 1e-6) return true;
  if ((last.resetsAt === null) !== (w.resetsAt === null)) return true;
  if (last.resetsAt !== null && w.resetsAt !== null && Math.abs(last.resetsAt - w.resetsAt) > MIN) return true;
  return at - last.at >= SAMPLE_EVERY_MS;
}

export function recordSamples(accountId: string, at: number, windows: UsageWindow[], source: string): number {
  let n = 0;
  for (const w of windows) {
    if (!shouldSample(lastUsageSample(accountId, w.id), w, at)) continue;
    insertUsageSample(accountId, at, w, source);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- service

interface PollState {
  nextAt: number;
  inflight: Promise<AccountUsage> | null;
  failures: number;
  /** Credentials-file mtime when we last saw a token problem: a change means
   *  a CLI refreshed it and the endpoint is worth asking again now. */
  credMtimeAtFailure: number | null;
  claudeJsonMtime: number | null;
}

const kvKey = (accountId: string) => `usage:${accountId}`;

function mtimeOf(path: string | null): number | null {
  if (!path) return null;
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export interface UsageServiceOptions {
  accounts: () => Account[];
  deps?: Partial<UsageDeps>;
  /** Test hook: jitter source, 0..1. */
  random?: () => number;
}

export class UsageService extends EventEmitter {
  private usage = new Map<string, AccountUsage>();
  private state = new Map<string, PollState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private deps: UsageDeps;
  private random: () => number;

  constructor(private opts: UsageServiceOptions) {
    super();
    this.deps = { ...defaultDeps(), ...opts.deps };
    this.random = opts.random ?? Math.random;
  }

  /** The latest usage, from memory or the last run's persisted copy. */
  get(accountId: string): AccountUsage {
    let u = this.usage.get(accountId);
    if (!u) {
      u = getKv<AccountUsage>(kvKey(accountId)) ?? emptyUsage(accountId);
      this.usage.set(accountId, u);
    }
    return u;
  }

  start(): void {
    if (this.timer) return;
    const now = this.deps.now();
    // Stagger the first round so a restart does not fire every account's
    // request in the same second.
    for (const a of this.opts.accounts()) this.poll(a.id).nextAt = now + this.random() * 15_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  forget(accountId: string): void {
    this.usage.delete(accountId);
    this.state.delete(accountId);
  }

  /** Ask now, regardless of schedule — unless a 429 back-off is in force,
   *  which "refresh" must not dig deeper. */
  async refresh(accountId: string): Promise<AccountUsage> {
    const account = this.opts.accounts().find((a) => a.id === accountId);
    if (!account) throw new AccountError(404, `no account ${accountId}`);
    const st = this.poll(accountId);
    if (st.inflight) return st.inflight;
    if (st.failures > 0 && this.get(accountId).stale?.startsWith("rate limited") && st.nextAt > this.deps.now()) {
      return this.get(accountId);
    }
    if (account.provider === "claude") this.checkClaudeCache(account);
    return this.fetchNow(account);
  }

  /**
   * A reading parsed from a codex rollout's `token_count` event. Taken if it
   * is newer than what we have; a fresh one also postpones the endpoint call,
   * since a running session is already telling us.
   */
  ingestRollout(accountId: string, reading: { at: number; windows: UsageWindow[] }): boolean {
    if (reading.windows.length === 0) return false;
    const took = this.accept(accountId, { kind: "ok", at: reading.at, windows: reading.windows, notes: [], source: "rollout" });
    if (took) {
      const account = this.opts.accounts().find((a) => a.id === accountId);
      if (account) this.postpone(account, reading.at);
    }
    return took;
  }

  /**
   * Spend one of a codex account's usage-limit resets, then read the account
   * again so the board, the balancer and every session stopped at the limit
   * see that the window is no longer spent. The reading is taken whether or
   * not the normal poll was due: the whole point is the immediate lift.
   */
  async consumeReset(accountId: string, creditId?: string | null): Promise<ResetConsumeResult> {
    const account = this.opts.accounts().find((a) => a.id === accountId);
    if (!account) throw new AccountError(404, `no account ${accountId}`);
    if (account.provider !== "codex") throw new AccountError(400, `usage resets are a Codex feature; "${account.label}" is ${account.provider}`);
    const result = await consumeCodexResetCredit(account, this.deps, creditId);
    if (result.outcome === "reset") {
      // A reset that worked changed the numbers; take a fresh reading now.
      // A no-op (nothing to reset, no credit, already redeemed) leaves them.
      await this.fetchNow(account).catch(() => undefined);
    }
    return result;
  }

  // -------------------------------------------------------------- internals

  private poll(accountId: string): PollState {
    let st = this.state.get(accountId);
    if (!st) {
      st = { nextAt: 0, inflight: null, failures: 0, credMtimeAtFailure: null, claudeJsonMtime: null };
      this.state.set(accountId, st);
    }
    return st;
  }

  private jittered(ms: number): number {
    return ms * (0.9 + 0.2 * this.random());
  }

  /** A fresh free reading means the paid one can wait a full interval. */
  private postpone(account: Account, readingAt: number): void {
    const st = this.poll(account.id);
    st.nextAt = Math.max(st.nextAt, readingAt + this.jittered(POLL_MS[account.provider]));
  }

  /** Exposed for tests; the timer calls it every ten seconds. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    const due: Promise<unknown>[] = [];
    for (const account of this.opts.accounts()) {
      const st = this.poll(account.id);
      if (account.provider === "claude") this.checkClaudeCache(account);
      if (st.credMtimeAtFailure !== null) {
        const m = mtimeOf(credentialsPath(account.provider, account.home));
        if (m !== null && m !== st.credMtimeAtFailure) st.nextAt = now;
      }
      if (!st.inflight && now >= st.nextAt) due.push(this.fetchNow(account));
    }
    await Promise.allSettled(due);
  }

  private checkClaudeCache(account: Account): void {
    const st = this.poll(account.id);
    const m = mtimeOf(claudeJsonPath(account));
    if (m === null || m === st.claudeJsonMtime) return;
    st.claudeJsonMtime = m;
    const r = readClaudeUsageCache(account);
    if (r?.kind === "ok" && this.accept(account.id, r)) this.postpone(account, r.at);
  }

  private fetchNow(account: Account): Promise<AccountUsage> {
    const st = this.poll(account.id);
    const run = (async () => {
      let r: Reading;
      try {
        r = await fetchUsage(account, this.deps);
      } catch (err) {
        r = { kind: "error", stale: `usage check failed: ${(err as Error).message}` };
      }
      this.settle(account, r);
      return this.get(account.id);
    })();
    st.inflight = run;
    return run.finally(() => {
      st.inflight = null;
    });
  }

  private settle(account: Account, r: Reading): void {
    const st = this.poll(account.id);
    const now = this.deps.now();
    const interval = POLL_MS[account.provider];
    if (r.kind === "ok") {
      st.failures = 0;
      st.credMtimeAtFailure = null;
      st.nextAt = now + this.jittered(interval);
      if (!this.accept(account.id, r)) this.markStale(account.id, null);
      return;
    }
    if (r.kind === "skip") {
      // Nothing to back off from; check again on the normal schedule, or as
      // soon as the credentials file changes.
      st.nextAt = now + this.jittered(interval);
      st.credMtimeAtFailure = mtimeOf(credentialsPath(account.provider, account.home)) ?? -1;
      this.markStale(account.id, r.stale);
      return;
    }
    st.failures++;
    if (r.rateLimited) {
      const backoff = r.retryAfterMs ?? Math.min(HOUR, 5 * MIN * 2 ** (st.failures - 1));
      st.nextAt = now + Math.max(backoff, MIN);
      this.markStale(account.id, `rate limited until ${hhmm(st.nextAt)}`);
    } else if (r.unauthorized) {
      st.nextAt = now + 15 * MIN;
      st.credMtimeAtFailure = mtimeOf(credentialsPath(account.provider, account.home)) ?? -1;
      this.markStale(account.id, r.stale);
    } else {
      st.nextAt = now + Math.min(30 * MIN, interval * 2 ** (st.failures - 1));
      this.markStale(account.id, r.stale);
    }
  }

  /** Take a reading if it is newer than the one we hold. */
  private accept(accountId: string, r: Extract<Reading, { kind: "ok" }>): boolean {
    const cur = this.get(accountId);
    if (cur.at !== null && r.at <= cur.at && cur.windows.length > 0) return false;
    const next: AccountUsage = {
      accountId,
      at: r.at,
      windows: r.windows,
      stale: null,
      source: r.source,
      notes: r.notes,
      // A rollout reading carries no reset credits: keep what the last
      // endpoint reading found rather than forgetting them.
      resets: r.resets === undefined ? (cur.resets ?? null) : r.resets,
    };
    try {
      recordSamples(accountId, r.at, r.windows, r.source);
    } catch (err) {
      // A sample write failing (disk full, locked db) must not stop the UI
      // from showing the numbers.
      console.error(`agentbox: usage sample write failed for ${accountId}: ${(err as Error).message}`);
    }
    this.store(next);
    return true;
  }

  private markStale(accountId: string, stale: string | null): void {
    const cur = this.get(accountId);
    if (cur.stale === stale) return;
    this.store({ ...cur, stale });
  }

  private store(u: AccountUsage): void {
    this.usage.set(u.accountId, u);
    try {
      setKv(kvKey(u.accountId), u);
    } catch {
      /* persistence is a convenience; memory is the truth while running */
    }
    this.emit("change", u.accountId, u);
  }
}
