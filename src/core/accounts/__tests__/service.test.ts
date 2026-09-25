import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Account, LoginFlow } from "../../types";
import { AccountError, AccountsService } from "../index";
import { claudeCreds, useFakeHome, writeJson } from "./fixtures";

let env: ReturnType<typeof useFakeHome>;
let H: string;
let svc: AccountsService;

beforeAll(async () => {
  env = useFakeHome();
  H = env.home;
  writeJson(join(H, ".claude", ".credentials.json"), claudeCreds({ expiresAt: Date.now() + 3600_000 }));
  writeJson(join(H, ".claude.json"), { oauthAccount: { emailAddress: "me@example.com" }, hasCompletedOnboarding: true });
  svc = new AccountsService({
    detect: async (p) => ({ installed: p === "claude" || p === "codex", version: "1.0.0" }),
    fetch: (async () => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    usageDeps: { version: async () => "1.0.0" },
    // Stands in for `claude auth login`: writes a login for a second identity.
    loginCommand: (a: Account) => ({
      argv: [
        "bash",
        "-c",
        `echo "visit: https://claude.example/x"; read code; echo '${JSON.stringify(claudeCreds({ expiresAt: Date.now() + 3600_000 }))}' > "$HOME_DIR/.credentials.json"; ` +
          `echo '{"oauthAccount":{"emailAddress":"${a.label === "twin" ? "me@example.com" : "second@example.com"}"}}' > "$HOME_DIR/.claude.json"`,
      ],
      env: { HOME_DIR: a.home },
      unset: [],
      credentialFile: join(a.home, ".credentials.json"),
      needsPaste: true,
    }),
  });
  await svc.start();
});
afterAll(() => {
  svc.stop();
  env.restore();
});

async function settle(id: string): Promise<LoginFlow> {
  for (let i = 0; i < 250; i++) {
    const f = svc.loginFlows().find((x) => x.id === id)!;
    if (f.state === "done" || f.state === "failed") return f;
    await Bun.sleep(20);
  }
  throw new Error("login did not finish");
}

describe("AccountsService", () => {
  test("start registers defaults and labels them by email once known", () => {
    const list = svc.list();
    expect(list.map((a) => a.provider).sort()).toEqual(["claude", "codex"]);
    const claude = list.find((a) => a.provider === "claude")!;
    expect(claude.label).toBe("me@example.com");
    expect(claude.plan).toBe("max 20x");
    expect(claude.auth.state).toBe("ok");
    expect(list.find((a) => a.provider === "codex")!.auth.state).toBe("missing");
    expect(claude.usage.windows).toEqual([]);
  });

  test("create → login → paste → done relabels the new account", async () => {
    const { account, login } = await svc.create("claude");
    expect(account.label).toBe("claude (new account)");
    expect(existsSync(join(account.home, ".claude.json"))).toBe(true);
    for (let i = 0; i < 100 && !svc.loginFlows().find((f) => f.id === login.id)?.url; i++) await Bun.sleep(20);
    svc.paste(login.id, "abc#def");
    const done = await settle(login.id);
    expect(done.state).toBe("done");
    expect(done.error).toBeNull();
    const after = svc.get(account.id)!;
    expect(after.email).toBe("second@example.com");
    expect(after.label).toBe("second@example.com");
  });

  test("a login that turns out to be an existing identity finishes with a warning", async () => {
    const { login } = await svc.create("claude", "twin");
    for (let i = 0; i < 100 && !svc.loginFlows().find((f) => f.id === login.id)?.url; i++) await Bun.sleep(20);
    svc.paste(login.id, "abc#def");
    const done = await settle(login.id);
    expect(done.state).toBe("done");
    expect(done.error).toMatch(/share one usage pool/);
  });

  test("update and remove; the default cannot be forgotten, other homes are left on disk", () => {
    const def = svc.list().find((a) => a.isDefault && a.provider === "claude")!;
    expect(() => svc.remove(def.id)).toThrow(/disable it instead/);
    expect(svc.update(def.id, { enabled: false }).enabled).toBe(false);
    const extra = svc.list().find((a) => a.label === "twin")!;
    svc.remove(extra.id);
    expect(svc.get(extra.id)).toBeNull();
    expect(existsSync(extra.home)).toBe(true);
  });

  test("refusals carry the 4xx the server answers with: missing 404, never-works 400, conflict 409", async () => {
    const statusOf = (fn: () => unknown): number | null => {
      try {
        fn();
      } catch (e) {
        return e instanceof AccountError ? e.status : null;
      }
      return null;
    };
    expect(statusOf(() => svc.update("nope", {}))).toBe(404);
    expect(statusOf(() => svc.login("nope"))).toBe(404);
    expect(statusOf(() => svc.paste("nope", "x"))).toBe(404);
    const def = svc.list().find((a) => a.isDefault && a.provider === "claude")!;
    expect(statusOf(() => svc.remove(def.id))).toBe(409);
    const omp = await svc.create("omp").catch((e: unknown) => e);
    expect(omp instanceof AccountError ? omp.status : null).toBe(400);
  });
});
