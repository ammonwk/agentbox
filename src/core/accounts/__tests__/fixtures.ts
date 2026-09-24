import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeDb } from "../../db";
import { useTempHome } from "../../__tests__/tmp-home";

/**
 * A throwaway `$HOME` and `AGENTBOX_HOME` for one suite. Every path in the
 * accounts module is derived from `$HOME` at call time, so pointing it here
 * keeps the suite away from the developer's real `~/.claude`, `~/.codex` and
 * devin credentials — which these tests must never read, let alone write.
 */
export function useFakeHome(): { home: string; restore: () => void } {
  const prev = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const home = mkdtempSync(join(tmpdir(), "agentbox-accounts-home-"));
  process.env.HOME = home;
  delete process.env.XDG_DATA_HOME;
  delete process.env.XDG_CONFIG_HOME;
  closeDb();
  const ab = useTempHome();
  return {
    home,
    restore() {
      closeDb();
      ab.restore();
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const b64url = (s: string) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An unsigned JWT with the given payload. Only the payload is ever read. */
export function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(payload))}.sig`;
}

export function claudeCreds(opts: { expiresAt: number; refresh?: boolean; scopes?: string[]; refreshExpiresAt?: number }) {
  return {
    claudeAiOauth: {
      accessToken: "fake-access",
      ...(opts.refresh === false ? {} : { refreshToken: "fake-refresh" }),
      expiresAt: opts.expiresAt,
      ...(opts.refreshExpiresAt ? { refreshTokenExpiresAt: opts.refreshExpiresAt } : {}),
      scopes: opts.scopes ?? ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    },
  };
}

export function codexAuth(opts: { email: string; plan: string; exp: number }) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ email: opts.email, "https://api.openai.com/auth": { chatgpt_plan_type: opts.plan, chatgpt_account_id: "acct-1" } }),
      access_token: fakeJwt({ exp: Math.floor(opts.exp / 1000) }),
      refresh_token: "fake-refresh",
      account_id: "acct-1",
    },
    last_refresh: "2026-09-20T00:00:00Z",
  };
}

/** A claude usage body in the documented shape (hand-written, not captured). */
export function claudeUsageBody(fiveHour = 52, weekly = 40) {
  return {
    five_hour: { utilization: fiveHour, resets_at: "2026-09-24T21:49:59.633031+00:00" },
    seven_day: { utilization: weekly, resets_at: "2026-10-01T01:59:59.633053+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3, resets_at: "2026-10-01T01:59:59+00:00" },
    extra_usage: { is_enabled: false },
    limits: [
      { kind: "session", group: "session", percent: fiveHour, severity: "normal", resets_at: "2026-09-24T21:49:59.633031+00:00", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: weekly, severity: "normal", resets_at: "2026-10-01T01:59:59.633053+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { id: null, display_name: "Fable" } }, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 12, severity: "normal", resets_at: "2026-10-01T02:00:00+00:00", scope: { model: { id: null, display_name: "Sonnet" } }, is_active: false },
    ],
    spend: { enabled: false, percent: 0 },
  };
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
