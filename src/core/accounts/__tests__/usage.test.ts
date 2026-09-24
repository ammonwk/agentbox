import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { insertAccount, usageSamplesSince } from "../../db";
import type { Account, UsageWindow } from "../../types";
import {
  hhmm,
  mapClaudeUsage,
  mapCodexUsage,
  mapDevinUserStatus,
  mapOmpUsage,
  readClaudeUsageCache,
  recordSamples,
  shouldSample,
  UsageService,
  type UsageDeps,
} from "../usage";
import { claudeCreds, claudeUsageBody, codexAuth, useFakeHome, writeJson } from "./fixtures";

let env: ReturnType<typeof useFakeHome>;
let H: string;

beforeAll(() => {
  env = useFakeHome();
  H = env.home;
});
afterAll(() => env.restore());

const MIN = 60_000;

describe("mapClaudeUsage", () => {
  test("five_hour, seven_day, scoped weeklies; legacy per-model bucket deduped against limits", () => {
    const { windows, notes } = mapClaudeUsage(claudeUsageBody());
    expect(windows.map((w) => [w.id, w.kind, w.usedPct])).toEqual([
      ["five_hour", "short", 52],
      ["seven_day", "weekly", 40],
      ["seven_day:Fable", "weekly", 0],
      ["seven_day:Sonnet", "weekly", 12],
    ]);
    expect(windows[0]!.resetsAt).toBe(Date.parse("2026-09-24T21:49:59.633Z"));
    expect(windows[0]!.windowMs).toBe(5 * 60 * MIN);
    // A window with nothing used and no reset has not started.
    expect(windows[2]!.resetsAt).toBeNull();
    expect(windows[2]!.scope).toEqual({ model: "Fable" });
    expect(notes).toEqual([]);
  });

  test("falls back to limits[] when the legacy buckets are absent", () => {
    const body = claudeUsageBody(70, 20) as Record<string, unknown>;
    delete body.five_hour;
    delete body.seven_day;
    const { windows } = mapClaudeUsage(body);
    expect(windows.find((w) => w.id === "five_hour")?.usedPct).toBe(70);
    expect(windows.find((w) => w.id === "seven_day")?.usedPct).toBe(20);
  });

  test("notes extra usage and locks", () => {
    const { notes } = mapClaudeUsage({
      five_hour: { utilization: 100, resets_at: null, locked_reason: "session_limit" },
      spend: { enabled: true, percent: 30 },
    });
    expect(notes).toContain("locked: session_limit");
    expect(notes).toContain("extra usage on (30% of cap)");
  });
});

describe("mapCodexUsage", () => {
  const NOW = 1_790_000_000_000;
  test("windows by length, not position; resets from reset_at or reset_after_seconds", () => {
    const { windows, notes, plan } = mapCodexUsage(
      {
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 45, limit_window_seconds: 604800, reset_after_seconds: 100, reset_at: 1_790_500_000 },
          secondary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 600 },
        },
        additional_rate_limits: [
          { limit_name: "GPT-5.3-Codex-Spark", metered_feature: "codex_bengalfox", rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1_790_500_000 } } },
        ],
        credits: { has_credits: false, unlimited: false, balance: null },
      },
      NOW,
    );
    expect(plan).toBe("pro");
    expect(windows.map((w) => [w.id, w.kind, w.usedPct, w.resetsAt])).toEqual([
      ["weekly", "weekly", 45, 1_790_500_000_000],
      ["five_hour", "short", 10, NOW + 600_000],
      ["gpt-5-3-codex-spark:weekly", "weekly", 5, 1_790_500_000_000],
    ]);
    expect(windows[2]!.scope).toEqual({ model: "GPT-5.3-Codex-Spark" });
    expect(notes).toEqual([]);
  });

  test("weekly-only plan with the limit reached", () => {
    const { windows, notes } = mapCodexUsage(
      { rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1_790_500_000 }, secondary_window: null } },
      NOW,
    );
    expect(windows).toHaveLength(1);
    expect(notes).toEqual(["limit reached"]);
  });
});

describe("mapDevinUserStatus", () => {
  test("remaining percent → used; absent remaining with a reset means 0% left; hidden daily skipped", () => {
    const body = {
      userStatus: {
        email: "d@example.com",
        planStatus: {
          planInfo: { planName: "Max", hideDailyQuota: false },
          dailyQuotaRemainingPercent: 75,
          dailyQuotaResetAtUnix: "1790323200",
          weeklyQuotaResetAtUnix: "1790496000",
        },
      },
    };
    const { windows, notes, email, plan } = mapDevinUserStatus(body);
    expect(windows.map((w) => [w.id, w.kind, w.usedPct, w.resetsAt])).toEqual([
      ["daily", "daily", 25, 1_790_323_200_000],
      ["weekly", "weekly", 100, 1_790_496_000_000],
    ]);
    expect(notes).toEqual(["weekly quota: devin reports 0% left"]);
    expect([email, plan]).toEqual(["d@example.com", "Max"]);
    body.userStatus.planStatus.planInfo.hideDailyQuota = true;
    expect(mapDevinUserStatus(body).windows.map((w) => w.id)).toEqual(["weekly"]);
  });
});

describe("mapOmpUsage", () => {
  test("one window per limit with a used fraction", () => {
    const { windows } = mapOmpUsage({
      reports: [
        {
          provider: "opencode-go",
          limits: [
            { id: "rolling-5h", window: { id: "rolling-5h", label: "5 Hour", durationMs: 18_000_000 }, amount: { usedFraction: 0.25 } },
            { id: "monthly", window: { label: "Monthly", durationMs: 2_592_000_000, resetsAt: 1_790_301_009_834 }, amount: { usedFraction: 0.00837935 } },
            { id: "no-amount", window: { durationMs: 1 }, amount: { unit: "usd" } },
          ],
        },
      ],
    });
    expect(windows.map((w) => [w.id, w.kind, w.label, Math.round(w.usedPct * 100) / 100])).toEqual([
      ["opencode-go:rolling-5h", "short", "opencode-go 5 Hour", 25],
      ["opencode-go:monthly", "monthly", "opencode-go Monthly", 0.84],
    ]);
    expect(windows[1]!.resetsAt).toBe(1_790_301_009_834);
  });
});

describe("samples", () => {
  const w = (usedPct: number, resetsAt: number | null = 1_000_000): UsageWindow => ({
    id: "seven_day", kind: "weekly", label: "Weekly", usedPct, resetsAt, windowMs: 1,
  });
  const last = { accountId: "a", at: 10 * MIN, windowId: "seven_day", kind: "weekly", usedPct: 40, resetsAt: 1_000_000, source: "endpoint" };

  test("rules: first, moved, reset moved (beyond a minute), hourly, never backwards", () => {
    expect(shouldSample(null, w(40), 0)).toBe(true);
    expect(shouldSample(last, w(40), 11 * MIN)).toBe(false);
    expect(shouldSample(last, w(41), 11 * MIN)).toBe(true);
    expect(shouldSample(last, w(40, 1_000_000 + 500), 11 * MIN)).toBe(false);
    expect(shouldSample(last, w(40, 1_000_000 + 2 * MIN), 11 * MIN)).toBe(true);
    expect(shouldSample(last, w(40, null), 11 * MIN)).toBe(true);
    expect(shouldSample(last, w(40), 70 * MIN)).toBe(true);
    expect(shouldSample(last, w(99), 9 * MIN)).toBe(false);
  });

  test("recordSamples writes only the rows that pass", () => {
    const at = 1_700_000_000_000;
    expect(recordSamples("acct-s", at, [w(40)], "endpoint")).toBe(1);
    expect(recordSamples("acct-s", at + MIN, [w(40)], "endpoint")).toBe(0);
    expect(recordSamples("acct-s", at + 2 * MIN, [w(41)], "cache")).toBe(1);
    expect(usageSamplesSince(0, "acct-s").map((r) => [r.usedPct, r.source])).toEqual([[40, "endpoint"], [41, "cache"]]);
  });
});

// ------------------------------------------------------------ the service

function account(id: string, provider: Account["provider"], home: string, isDefault = false): Account {
  return { id, provider, label: id, email: null, plan: null, home, isDefault, enabled: true, createdAt: 0 };
}

interface FakeCall {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(responses: (() => Response)[]): { fetch: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("UsageService", () => {
  let clock: number;
  let accounts: Account[];
  const deps = (f: typeof fetch): Partial<UsageDeps> => ({ fetch: f, now: () => clock, version: async () => "9.9.9" });

  beforeEach(() => {
    clock = Date.parse("2026-09-24T12:00:00Z");
    accounts = [];
  });

  function claudeAccount(id: string, expiresAt = clock + 3600_000, scopes?: string[]): Account {
    const home = join(H, "svc", id);
    writeJson(join(home, ".credentials.json"), claudeCreds({ expiresAt, scopes }));
    const a = account(id, "claude", home);
    insertAccount(a);
    accounts.push(a);
    return a;
  }

  test("claude: headers, mapping, persistence across instances", async () => {
    const a = claudeAccount("c-ok");
    const { fetch, calls } = fakeFetch([() => json(claudeUsageBody(30, 60))]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch) });
    const u = await svc.refresh(a.id);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(calls[0]!.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(calls[0]!.headers["User-Agent"]).toBe("claude-cli/9.9.9 (external, cli)");
    expect(calls[0]!.headers.Authorization).toBe("Bearer fake-access");
    expect(u.source).toBe("endpoint");
    expect(u.stale).toBeNull();
    expect(u.windows.find((w) => w.id === "seven_day")?.usedPct).toBe(60);
    // A fresh service (a restart) shows the last reading straight away.
    const again = new UsageService({ accounts: () => accounts, deps: deps(fakeFetch([]).fetch) });
    expect(again.get(a.id).windows.find((w) => w.id === "five_hour")?.usedPct).toBe(30);
  });

  test("claude: 429 → stale with the retry time, keeps the last reading, refresh does not dig deeper", async () => {
    const a = claudeAccount("c-429");
    const { fetch, calls } = fakeFetch([
      () => json(claudeUsageBody(10, 20)),
      () => json({ error: { type: "rate_limit_error" } }, 429, { "retry-after": "600" }),
    ]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch) });
    await svc.refresh(a.id);
    clock += 4 * MIN;
    const u = await svc.refresh(a.id);
    expect(u.stale).toBe(`rate limited until ${hhmm(clock + 10 * MIN)}`);
    expect(u.windows.find((w) => w.id === "seven_day")?.usedPct).toBe(20);
    clock += MIN;
    await svc.refresh(a.id);
    expect(calls).toHaveLength(2);
    // The ticker also leaves it alone until the back-off ends.
    await svc.tick();
    expect(calls).toHaveLength(2);
  });

  test("claude: 429 without Retry-After backs off exponentially", async () => {
    const a = claudeAccount("c-429b");
    const { fetch } = fakeFetch([() => json({}, 429), () => json({}, 429)]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch), random: () => 0.5 });
    expect((await svc.refresh(a.id)).stale).toBe(`rate limited until ${hhmm(clock + 5 * MIN)}`);
    clock += 5 * MIN;
    await svc.tick();
    expect(svc.get(a.id).stale).toBe(`rate limited until ${hhmm(clock + 10 * MIN)}`);
  });

  test("claude: 401 → stale 'token expired', last good windows kept", async () => {
    const a = claudeAccount("c-401");
    const { fetch } = fakeFetch([() => json(claudeUsageBody(10, 20)), () => json({}, 401)]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch) });
    await svc.refresh(a.id);
    const u = await svc.refresh(a.id);
    expect(u.stale).toMatch(/token expired/);
    expect(u.windows).toHaveLength(4);
  });

  test("claude: an expired access token or a token without user:profile is never sent", async () => {
    const a = claudeAccount("c-exp", clock - 1);
    const b = claudeAccount("c-scope", clock + 3600_000, ["user:inference"]);
    const { fetch, calls } = fakeFetch([]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch) });
    expect((await svc.refresh(a.id)).stale).toMatch(/token expired/);
    expect((await svc.refresh(b.id)).stale).toMatch(/user:profile/);
    expect(calls).toHaveLength(0);
  });

  test("claude: the CLI's cached reading is used when newer, and postpones the endpoint", async () => {
    const a = claudeAccount("c-cache");
    writeJson(join(a.home, ".claude.json"), {
      oauthAccount: { accountUuid: "u1" },
      cachedUsageUtilization: { fetchedAtMs: clock - MIN, accountUuid: "u1", utilization: claudeUsageBody(77, 33) },
    });
    expect(readClaudeUsageCache(a)?.kind).toBe("ok");
    const { fetch, calls } = fakeFetch([]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch) });
    await svc.tick();
    const u = svc.get(a.id);
    expect(u.source).toBe("cache");
    expect(u.at).toBe(clock - MIN);
    expect(u.windows.find((w) => w.id === "five_hour")?.usedPct).toBe(77);
    expect(calls).toHaveLength(0);
  });

  test("claude: a cache written for a different account is ignored", () => {
    const home = join(H, "svc", "c-other");
    writeJson(join(home, ".claude.json"), {
      oauthAccount: { accountUuid: "new" },
      cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: "old", utilization: claudeUsageBody() },
    });
    expect(readClaudeUsageCache({ home, isDefault: false })).toBeNull();
  });

  test("codex: headers, and rollout readings win only when newer", async () => {
    const home = join(H, "svc", "x1");
    writeJson(join(home, "auth.json"), codexAuth({ email: "x@example.com", plan: "pro", exp: clock + 3600_000 }));
    const a = account("x1", "codex", home);
    insertAccount(a);
    accounts.push(a);
    const body = { rate_limit: { primary_window: { used_percent: 45, limit_window_seconds: 604800, reset_at: 1_790_500_000 } } };
    const { fetch, calls } = fakeFetch([() => json(body)]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch) });
    await svc.refresh(a.id);
    expect(calls[0]!.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(calls[0]!.headers["ChatGPT-Account-Id"]).toBe("acct-1");
    expect(calls[0]!.headers["User-Agent"]).toStartWith("codex_cli_rs/9.9.9 ");

    const win = (p: number): UsageWindow[] => [{ id: "weekly", kind: "weekly", label: "Weekly", usedPct: p, resetsAt: 1_790_500_000_000, windowMs: 604_800_000 }];
    expect(svc.ingestRollout(a.id, { at: clock - MIN, windows: win(40) })).toBe(false);
    expect(svc.ingestRollout(a.id, { at: clock + MIN, windows: win(47) })).toBe(true);
    expect(svc.get(a.id)).toMatchObject({ source: "rollout", at: clock + MIN });
    expect(svc.get(a.id).windows[0]!.usedPct).toBe(47);
    // A fresh rollout reading pushes the endpoint back a full interval.
    clock += 2 * MIN;
    await svc.tick();
    expect(calls).toHaveLength(1);
  });

  test("omp: `omp usage --json` through the injected exec", async () => {
    const a = account("o1", "omp", join(H, ".omp"), true);
    insertAccount(a);
    accounts.push(a);
    const svc = new UsageService({
      accounts: () => accounts,
      deps: {
        now: () => clock,
        exec: async (argv) => {
          expect(argv).toEqual(["omp", "usage", "--json"]);
          return { code: 0, stdout: JSON.stringify({ reports: [{ provider: "p", limits: [{ id: "w", window: { label: "Weekly", durationMs: 604_800_000 }, amount: { usedFraction: 0.5 } }] }] }), stderr: "", timedOut: false };
        },
      },
    });
    const u = await svc.refresh(a.id);
    expect(u).toMatchObject({ source: "cli", stale: null });
    expect(u.windows[0]).toMatchObject({ id: "p:w", kind: "weekly", usedPct: 50 });
  });

  test("emits change", async () => {
    const a = claudeAccount("c-emit");
    const { fetch } = fakeFetch([() => json(claudeUsageBody())]);
    const svc = new UsageService({ accounts: () => accounts, deps: deps(fetch) });
    const seen: string[] = [];
    svc.on("change", (id: string) => seen.push(id));
    await svc.refresh(a.id);
    expect(seen).toContain(a.id);
  });
});
