import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GO_LOGIN_FILE, readGoLogin, writeGoLogin, type GoLogin } from "../accounts/gocred";
import { finishDeviceLogin, freshGoLogin, refreshGoLogin, startDeviceLogin } from "../accounts/godevice";
import { anthropicGoModelsIn } from "../accounts/gomodels";
import { loginCommand, parseLoginOutput } from "../accounts/login";

const dir = mkdtempSync(join(tmpdir(), "gologin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const S = "https://console.test/console";
const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

/** A Console that approves on the third poll and rotates refresh tokens. */
function consoleServer() {
  const calls: { path: string; body: any; auth: string | null }[] = [];
  let polls = 0;
  let refreshes = 0;
  const f = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path: url.pathname, body, auth: new Headers(init?.headers).get("authorization") });
    if (url.pathname.endsWith("/auth/device/code")) return json({ device_code: "dev1", user_code: "TCXQ-SQFX", verification_uri_complete: "/console/device?user_code=TCXQ-SQFX", interval: 2, expires_in: 600 });
    if (url.pathname.endsWith("/auth/device/token") && body.grant_type === "refresh_token") {
      if (body.refresh_token !== `r${refreshes}`) return json({ error: "invalid_grant" });
      refreshes++;
      return json({ access_token: `a${refreshes}`, refresh_token: `r${refreshes}`, expires_in: 3600 });
    }
    if (url.pathname.endsWith("/auth/device/token")) return ++polls < 3 ? json({ error: "authorization_pending" }) : json({ access_token: "a0", refresh_token: "r0", expires_in: 3600, org_id: "wrk_b" });
    if (url.pathname.endsWith("/api/user")) return json({ id: "acc_1", email: "me@example.com" });
    if (url.pathname.endsWith("/api/orgs")) return json([{ id: "wrk_a", name: "Alpha" }, { id: "wrk_b", name: "Beta" }]);
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("OpenCode Go sign-in", () => {
  test("the device flow: a link and a code, polled until approved, then who and which workspace", async () => {
    const { f, calls } = consoleServer();
    const code = await startDeviceLogin(f, S, 1000);
    expect(code).toMatchObject({ userCode: "TCXQ-SQFX", url: "https://console.test/console/device?user_code=TCXQ-SQFX", intervalMs: 2000, expiresAt: 601_000 });
    expect(calls[0]!.body).toEqual({ client_id: "opencode-cli", supports_org_scope: true });
    const slept: number[] = [];
    const login = await finishDeviceLogin(code, { fetch: f, server: S, sleep: async (ms) => void slept.push(ms), now: () => 5000 });
    expect(slept).toEqual([2000, 2000, 2000]);
    expect(login).toEqual({ server: S, access: "a0", refresh: "r0", expires: 5000 + 3_600_000, accountID: "acc_1", email: "me@example.com", orgID: "wrk_b", orgName: "Beta" });
    expect(calls.find((c) => c.path.endsWith("/api/user"))!.auth).toBe("Bearer a0");
  });

  const login: GoLogin = { server: S, access: "a0", refresh: "r0", expires: 0, accountID: "acc_1", email: "me@example.com", orgID: "wrk_b", orgName: "Beta" };

  test("a login is kept whole and private in its home", () => {
    const home = join(dir, "kept");
    mkdirSync(home);
    expect(readGoLogin(home)).toBeNull();
    writeGoLogin(home, login);
    expect(readGoLogin(home)).toEqual(login);
    expect(statSync(join(home, GO_LOGIN_FILE)).mode & 0o777).toBe(0o600);
  });

  test("a refresh replaces both tokens, and the new ones are saved before use", async () => {
    const { f } = consoleServer();
    const home = join(dir, "fresh");
    mkdirSync(home);
    const HOUR = 3_600_000;
    writeGoLogin(home, { ...login, expires: 100 * HOUR });
    // Far from running out: used as it is.
    expect((await freshGoLogin(home, { fetch: f, now: () => 10 * HOUR }))!.access).toBe("a0");
    // Within a day of it: refreshed once, however many ask at the same time.
    const [x, y] = await Promise.all([freshGoLogin(home, { fetch: f, now: () => 90 * HOUR }), freshGoLogin(home, { fetch: f, now: () => 90 * HOUR })]);
    expect(x).toMatchObject({ access: "a1", refresh: "r1", expires: 91 * HOUR, email: "me@example.com", orgID: "wrk_b" });
    expect(y).toEqual(x!);
    expect(readGoLogin(home)).toEqual(x!);
    // Refused early: forced, with the token it now holds.
    expect((await freshGoLogin(home, { force: true, fetch: f, now: () => 90 * HOUR }))!.refresh).toBe("r2");
    expect(readGoLogin(home)!.refresh).toBe("r2");
  });

  test("a refresh the Console refuses says to log in again", async () => {
    const { f } = consoleServer();
    await expect(refreshGoLogin({ ...login, refresh: "stale" }, f)).rejects.toThrow(/log the account in again/);
  });

  test("the login manager runs agentbox's own sign-in and reads its link and code", () => {
    const cmd = loginCommand({ provider: "omp", home: "/h", isDefault: false });
    expect(cmd.argv.slice(-2)).toEqual(["go-login", "/h"]);
    expect(cmd).toMatchObject({ needsPaste: false, credentialFile: `/h/${GO_LOGIN_FILE}` });
    expect(() => loginCommand({ provider: "omp", home: "/h", isDefault: true })).toThrow(/opencode auth login/);
    const out = "Open this link in your browser and sign in to the OpenCode account you want here:\n   https://opencode.ai/console/device?user_code=TCXQ-SQFX&client_id=opencode-cli\nEnter code: TCXQ-SQFX\n";
    expect(parseLoginOutput("omp", out)).toEqual({ url: "https://opencode.ai/console/device?user_code=TCXQ-SQFX&client_id=opencode-cli", userCode: "TCXQ-SQFX" });
  });

  test("the models with an Anthropic endpoint of their own are read from the Console's config", () => {
    const config = { providers: { "opencode-go": { models: {
      "glm-5.3": {},
      "gpt-6-luna": { package: "aisdk:@ai-sdk/openai" },
      "qwen3.8-max": { package: "aisdk:@ai-sdk/anthropic", settings: { baseURL: "https://opencode.ai/inference/go/anthropic/v1" } },
    } }, opencode: { models: { "claude-x": { package: "aisdk:@ai-sdk/anthropic" } } } } };
    expect(anthropicGoModelsIn(config)).toEqual(["qwen3.8-max"]);
    expect(anthropicGoModelsIn(null)).toEqual([]);
  });
});
