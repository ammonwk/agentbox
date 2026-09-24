import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAccount, listAccounts } from "../../db";
import type { Account } from "../../types";
import {
  createAccountHome,
  defaultHome,
  ensureDefaultAccounts,
  importHome,
  resyncShared,
  seedClaudeJson,
} from "../homes";
import { claudeCreds, codexAuth, useFakeHome, writeJson, writeText } from "./fixtures";

let env: ReturnType<typeof useFakeHome>;
let H: string;

beforeAll(() => {
  env = useFakeHome();
  H = env.home;
  // A default claude home with some shared config, and one thing that must
  // never be shared.
  writeJson(join(H, ".claude", "settings.json"), { theme: "dark" });
  writeText(join(H, ".claude", "CLAUDE.md"), "# rules");
  mkdirSync(join(H, ".claude", "skills", "x"), { recursive: true });
  writeText(join(H, ".claude", "statusline.sh"), "#!/bin/sh");
  writeJson(join(H, ".claude", ".credentials.json"), claudeCreds({ expiresAt: Date.now() + 3600_000 }));
  mkdirSync(join(H, ".claude", "projects"), { recursive: true });
  writeJson(join(H, ".claude.json"), {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.0",
    theme: "dark",
    mcpServers: { posthog: { type: "http", url: "https://example.invalid/mcp" } },
    sonnet45MigrationComplete: true,
    hasSeenTasksHint: true,
    hasShownOpus45Notice: { someOrg: true },
    oauthAccount: { emailAddress: "a@example.com", accountUuid: "u1" },
    userID: "secret-user-id",
    cachedUsageUtilization: { fetchedAtMs: 1 },
    projects: { "/x": { history: [] } },
    machineID: "m",
  });
  writeText(join(H, ".codex", "config.toml"), "model = 'x'");
  writeText(join(H, ".codex", "AGENTS.md"), "# agents");
  mkdirSync(join(H, ".codex", "rules"), { recursive: true });
  writeJson(join(H, ".codex", "auth.json"), codexAuth({ email: "c@example.com", plan: "pro", exp: Date.now() + 3600_000 }));
  writeJson(join(H, ".config", "devin", "config.json"), { a: 1 });
});
afterAll(() => env.restore());

describe("defaultHome", () => {
  test("resolves from $HOME at call time", () => {
    expect(defaultHome("claude")).toBe(join(H, ".claude"));
    expect(defaultHome("codex")).toBe(join(H, ".codex"));
    expect(defaultHome("devin")).toBe(join(H, ".local", "share"));
    expect(defaultHome("omp")).toBe(join(H, ".omp"));
  });
});

describe("createAccountHome", () => {
  test("claude: 0700 home, shared config symlinked, credentials and history not", () => {
    const home = createAccountHome("claude", "acc1");
    expect(statSync(home).mode & 0o777).toBe(0o700);
    for (const n of ["settings.json", "CLAUDE.md", "skills", "statusline.sh"]) {
      expect(lstatSync(join(home, n)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(home, n))).toBe(join(H, ".claude", n));
    }
    // Only links for what exists in the default home.
    expect(existsSync(join(home, "agents"))).toBe(false);
    expect(existsSync(join(home, ".credentials.json"))).toBe(false);
    expect(existsSync(join(home, "projects"))).toBe(false);
  });

  test("claude: .claude.json is seeded with preferences only, never identity or history", () => {
    const seeded = JSON.parse(readFileSync(join(createAccountHome("claude", "acc2"), ".claude.json"), "utf8"));
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(seeded.theme).toBe("dark");
    expect(seeded.mcpServers.posthog).toBeDefined();
    expect(seeded.sonnet45MigrationComplete).toBe(true);
    expect(seeded.hasSeenTasksHint).toBe(true);
    for (const k of ["oauthAccount", "userID", "cachedUsageUtilization", "projects", "machineID", "hasShownOpus45Notice"]) {
      expect(seeded[k]).toBeUndefined();
    }
    const home = join(process.env.AGENTBOX_HOME!, "accounts", "acc2");
    expect(statSync(join(home, ".claude.json")).mode & 0o777).toBe(0o600);
  });

  test("seedClaudeJson copies pattern keys only when primitive", () => {
    expect(seedClaudeJson({ fooMigrationComplete: true, barMigrationComplete: { x: 1 }, hasSeenX: 1 })).toEqual({
      fooMigrationComplete: true,
      hasSeenX: 1,
    });
  });

  test("codex links its shared files", () => {
    const home = createAccountHome("codex", "acc3");
    for (const n of ["config.toml", "AGENTS.md", "rules"]) expect(lstatSync(join(home, n)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
  });

  test("devin gets a data dir and a config dir with config.json linked", () => {
    const home = createAccountHome("devin", "acc4");
    expect(statSync(join(home, "devin")).isDirectory()).toBe(true);
    expect(readlinkSync(join(home, "config", "devin", "config.json"))).toBe(join(H, ".config", "devin", "config.json"));
  });

  test("omp has no extra homes", () => {
    expect(() => createAccountHome("omp", "acc5")).toThrow(/one implicit account/);
  });
});

describe("resyncShared", () => {
  test("adds links for files that appeared later, leaves existing ones, is idempotent", () => {
    const home = createAccountHome("claude", "acc6");
    writeJson(join(H, ".claude", "keybindings.json"), {});
    const acct = { provider: "claude" as const, home, isDefault: false };
    expect(resyncShared(acct)).toEqual(["keybindings.json"]);
    expect(resyncShared(acct)).toEqual([]);
  });

  test("merges new MCP servers without overwriting the account's own choices", () => {
    const home = createAccountHome("claude", "acc7");
    const path = join(home, ".claude.json");
    const mine = JSON.parse(readFileSync(path, "utf8"));
    mine.theme = "light";
    mine.mcpServers.mine = { type: "stdio" };
    writeJson(path, mine);
    const src = JSON.parse(readFileSync(join(H, ".claude.json"), "utf8"));
    src.mcpServers.newer = { type: "http" };
    writeJson(join(H, ".claude.json"), src);
    resyncShared({ provider: "claude", home, isDefault: false });
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.theme).toBe("light");
    expect(Object.keys(after.mcpServers).sort()).toEqual(["mine", "newer", "posthog"]);
  });

  test("never touches a default home", () => {
    expect(resyncShared({ provider: "claude", home: join(H, ".claude"), isDefault: true })).toEqual([]);
  });
});

describe("ensureDefaultAccounts", () => {
  test("registers installed providers once", async () => {
    const detect = async (p: string) => ({ installed: p !== "devin", version: "1.0.0" });
    const added = await ensureDefaultAccounts(detect as never);
    expect(added.map((a) => a.provider).sort()).toEqual(["claude", "codex", "omp"]);
    expect(added.every((a) => a.isDefault && a.label.endsWith("(default)"))).toBe(true);
    expect(await ensureDefaultAccounts(detect as never)).toEqual([]);
  });
});

describe("importHome", () => {
  const identifyEmail = async (a: Pick<Account, "home">) =>
    a.home.endsWith(".codex") ? "c@example.com" : a.home.includes("second") ? "second@example.com" : "c@example.com";

  test("refuses a home with no credentials", async () => {
    mkdirSync(join(H, ".codex-empty"), { recursive: true });
    await expect(importHome("codex", join(H, ".codex-empty"), { identifyEmail })).rejects.toThrow(/no codex login/);
  });

  test("refuses a home already registered", async () => {
    await expect(importHome("codex", join(H, ".codex"), { identifyEmail })).rejects.toThrow(/already registered/);
  });

  test("refuses a second home on an identity already registered", async () => {
    writeJson(join(H, ".codex-dup", "auth.json"), codexAuth({ email: "c@example.com", plan: "pro", exp: Date.now() + 1e6 }));
    await expect(importHome("codex", join(H, ".codex-dup"), { identifyEmail })).rejects.toThrow(/log each other out/);
  });

  test("registers a genuinely different login", async () => {
    writeJson(join(H, ".codex-second", "auth.json"), codexAuth({ email: "second@example.com", plan: "plus", exp: Date.now() + 1e6 }));
    const { account } = await importHome("codex", "~/.codex-second", { identifyEmail });
    expect(account.home).toBe(join(H, ".codex-second"));
    expect(account.label).toBe("second@example.com");
    expect(account.isDefault).toBe(false);
    expect(getAccount(account.id)?.email).toBe("second@example.com");
    expect(listAccounts("codex")).toHaveLength(2);
  });
});
