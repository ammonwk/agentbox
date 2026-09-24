import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ExecFn } from "../exec";
import { claudePlan, decodeJwtPayload, identify, parseDevinAuthStatus, readCodexAuth } from "../identity";
import { claudeCreds, codexAuth, fakeJwt, useFakeHome, writeJson, writeText } from "./fixtures";

let env: ReturnType<typeof useFakeHome>;
let H: string;
const NOW = 1_790_000_000_000;

beforeAll(() => {
  env = useFakeHome();
  H = env.home;
});
afterAll(() => env.restore());

const claude = (home: string, isDefault = false) => ({ provider: "claude" as const, home, isDefault });

describe("claude", () => {
  test("default account: email from ~/.claude.json, plan with tier multiplier", async () => {
    writeJson(join(H, ".claude", ".credentials.json"), claudeCreds({ expiresAt: NOW + 60_000 }));
    writeJson(join(H, ".claude.json"), { oauthAccount: { emailAddress: "me@example.com" } });
    const id = await identify(claude(join(H, ".claude"), true), { now: NOW });
    expect(id).toEqual({ email: "me@example.com", plan: "max 20x", auth: { state: "ok", expiresAt: NOW + 60_000, detail: null } });
  });

  test("non-default account reads <home>/.claude.json, not ~/.claude.json", async () => {
    const home = join(H, "acct-a");
    writeJson(join(home, ".credentials.json"), claudeCreds({ expiresAt: NOW + 60_000 }));
    writeJson(join(home, ".claude.json"), { oauthAccount: { emailAddress: "other@example.com" } });
    expect((await identify(claude(home), { now: NOW })).email).toBe("other@example.com");
  });

  test("an expired access token with a refresh token is still a working login", async () => {
    const home = join(H, "acct-b");
    writeJson(join(home, ".credentials.json"), claudeCreds({ expiresAt: NOW - 1 }));
    const { auth } = await identify(claude(home), { now: NOW });
    expect(auth.state).toBe("ok");
    expect(auth.detail).toMatch(/refreshes on next use/);
    expect(auth.expiresAt).toBe(NOW - 1);
  });

  test("an expired refresh token, or none, needs a new login", async () => {
    const home = join(H, "acct-c");
    writeJson(join(home, ".credentials.json"), claudeCreds({ expiresAt: NOW - 1, refresh: false }));
    expect((await identify(claude(home), { now: NOW })).auth.state).toBe("expired");
    writeJson(join(home, ".credentials.json"), claudeCreds({ expiresAt: NOW + 1, refreshExpiresAt: NOW - 1 }));
    expect((await identify(claude(home), { now: NOW })).auth.state).toBe("expired");
  });

  test("no credentials, or MCP-only credentials, is missing", async () => {
    expect((await identify(claude(join(H, "nothing")), { now: NOW })).auth.state).toBe("missing");
    const home = join(H, "acct-mcp");
    writeJson(join(home, ".credentials.json"), { mcpOAuth: {} });
    expect((await identify(claude(home), { now: NOW })).auth.state).toBe("missing");
  });

  test("claudePlan", () => {
    expect(claudePlan("pro", null)).toBe("pro");
    expect(claudePlan("max", "default_claude_max_5x")).toBe("max 5x");
    expect(claudePlan(null, "x")).toBeNull();
  });
});

describe("codex", () => {
  test("email and plan from the id_token, expiry from the access token", async () => {
    const home = join(H, "codex-a");
    writeJson(join(home, "auth.json"), codexAuth({ email: "c@example.com", plan: "prolite", exp: NOW + 3600_000 }));
    const id = await identify({ provider: "codex", home, isDefault: false }, { now: NOW });
    expect(id.email).toBe("c@example.com");
    expect(id.plan).toBe("prolite");
    expect(id.auth.state).toBe("ok");
    expect(id.auth.expiresAt).toBe(NOW + 3600_000);
    const raw = readCodexAuth(home)!;
    expect(raw.accountId).toBe("acct-1");
    expect(raw.lastRefresh).toBe(Date.parse("2026-09-20T00:00:00Z"));
  });

  test("expired access token is refreshable, missing file is missing, API key is ok", async () => {
    const home = join(H, "codex-b");
    writeJson(join(home, "auth.json"), codexAuth({ email: "c@example.com", plan: "pro", exp: NOW - 1000 }));
    expect((await identify({ provider: "codex", home, isDefault: false }, { now: NOW })).auth.detail).toMatch(/refreshes/);
    expect((await identify({ provider: "codex", home: join(H, "nope"), isDefault: false })).auth.state).toBe("missing");
    const k = join(H, "codex-key");
    writeJson(join(k, "auth.json"), { OPENAI_API_KEY: "sk-fake" });
    const id = await identify({ provider: "codex", home: k, isDefault: false });
    expect(id.auth.state).toBe("ok");
    expect(id.plan).toBe("api key");
  });

  test("decodeJwtPayload handles base64url and rejects junk", () => {
    expect(decodeJwtPayload(fakeJwt({ a: "ü/+?" }))).toEqual({ a: "ü/+?" });
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

describe("devin", () => {
  const STATUS = `Logged in (via Devin).

Credentials:
  File:              /home/x/.local/share/devin/credentials.toml
  API server:        https://server.codeium.com

User:
  Name:              Some One
  Email:             someone@example.com
  User ID:           user-123

Account:
  Tier:              Devin Max
  Plan:              Max
`;

  test("parses `devin auth status`", () => {
    expect(parseDevinAuthStatus(STATUS)).toEqual({ loggedIn: true, email: "someone@example.com", plan: "Devin Max" });
    expect(parseDevinAuthStatus("Not logged in. Run `devin auth login`.").loggedIn).toBe(false);
  });

  test("runs the CLI with XDG overrides for a non-default home, without for the default", async () => {
    const calls: { argv: string[]; env?: Record<string, string>; unset?: string[] }[] = [];
    const exec: ExecFn = async (argv, opts) => {
      calls.push({ argv, env: opts?.env, unset: opts?.unset });
      return { code: 0, stdout: STATUS, stderr: "", timedOut: false };
    };
    const home = join(H, "devin-a");
    writeText(join(home, "devin", "credentials.toml"), 'windsurf_api_key = "fake"\n');
    const id = await identify({ provider: "devin", home, isDefault: false }, { exec });
    expect(id).toMatchObject({ email: "someone@example.com", plan: "Devin Max", auth: { state: "ok" } });
    expect(calls[0]!.env).toEqual({ XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, "config") });

    const def = join(H, ".local", "share");
    writeText(join(def, "devin", "credentials.toml"), 'windsurf_api_key = "fake"\n');
    await identify({ provider: "devin", home: def, isDefault: true }, { exec });
    expect(calls[1]!.env).toEqual({});
    expect(calls[1]!.unset).toEqual(["XDG_DATA_HOME", "XDG_CONFIG_HOME"]);
  });

  test("no credentials file: missing, and the CLI is not run", async () => {
    let ran = false;
    const exec: ExecFn = async () => {
      ran = true;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    expect((await identify({ provider: "devin", home: join(H, "devin-none"), isDefault: false }, { exec })).auth.state).toBe("missing");
    expect(ran).toBe(false);
  });
});
