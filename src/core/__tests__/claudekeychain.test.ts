import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHome } from "../accounts/homes";
import { claudeKeychainService, forgetClaudeKeychain, identifyClaude, readClaudeCredentials, type KeychainDeps } from "../accounts/identity";

const dir = mkdtempSync(join(tmpdir(), "keychain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const login = (accessToken = "tok") =>
  JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "secret-refresh", expiresAt: 9e15, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } });

function keychain(items: Record<string, { status: number | null; stdout: string }>, clock = { t: 1000 }) {
  const asked: string[] = [];
  const deps: KeychainDeps = {
    darwin: true,
    now: () => clock.t,
    read: (service) => {
      asked.push(service);
      return items[service] ?? { status: 44, stdout: "" };
    },
  };
  return { deps, asked, clock };
}

let n = 0;
const freshHome = () => join(dir, `home-${n++}`);

describe("a claude login in the macOS Keychain", () => {
  test("names items as the CLI does: bare for the default home, hashed from the path otherwise", () => {
    expect(claudeKeychainService(defaultHome("claude"))).toBe("Claude Code-credentials");
    expect(claudeKeychainService("/tmp/x")).toBe("Claude Code-credentials-2e56aa36");
  });

  test("a home with no credentials file is logged in when its item exists", () => {
    const home = freshHome();
    const { deps } = keychain({ [claudeKeychainService(home)]: { status: 0, stdout: login() } });
    const cred = readClaudeCredentials(home, deps);
    expect(cred?.accessToken).toBe("tok");
    expect(cred?.hasRefreshToken).toBe(true);
    expect(JSON.stringify(cred)).not.toContain("secret-refresh");
  });

  test("the Keychain wins over a leftover file, and the file is the fallback", () => {
    const home = mkdtempSync(join(dir, "both-"));
    writeFileSync(join(home, ".credentials.json"), login("from-file"));
    const service = claudeKeychainService(home);
    expect(readClaudeCredentials(home, keychain({ [service]: { status: 0, stdout: login("from-keychain") } }).deps)?.accessToken).toBe("from-keychain");
    forgetClaudeKeychain(home);
    expect(readClaudeCredentials(home, keychain({}).deps)?.accessToken).toBe("from-file");
  });

  test("holds a read for 30 seconds; forgetting it reads again at once", () => {
    const home = freshHome();
    const { deps, asked, clock } = keychain({ [claudeKeychainService(home)]: { status: 0, stdout: login() } });
    readClaudeCredentials(home, deps);
    clock.t += 29_000;
    readClaudeCredentials(home, deps);
    expect(asked.length).toBe(1);
    clock.t += 2_000;
    readClaudeCredentials(home, deps);
    expect(asked.length).toBe(2);
    forgetClaudeKeychain(home);
    readClaudeCredentials(home, deps);
    expect(asked.length).toBe(3);
  });

  test("a failed read keeps the login; a removed item ends it", () => {
    const home = freshHome();
    const items = { [claudeKeychainService(home)]: { status: 0 as number | null, stdout: login() } };
    const { deps, clock } = keychain(items);
    expect(readClaudeCredentials(home, deps)).not.toBeNull();
    items[claudeKeychainService(home)] = { status: null, stdout: "" }; // timed out
    clock.t += 31_000;
    expect(readClaudeCredentials(home, deps)).not.toBeNull();
    items[claudeKeychainService(home)] = { status: 44, stdout: "" };
    clock.t += 31_000;
    expect(readClaudeCredentials(home, deps)).toBeNull();
  });

  test("off macOS nothing is asked", () => {
    const { deps, asked } = keychain({});
    expect(readClaudeCredentials(freshHome(), { ...deps, darwin: false })).toBeNull();
    expect(asked).toEqual([]);
  });

  test("tests never read the real Keychain", () => {
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(dir, "user-"));
    try {
      const id = identifyClaude({ provider: "claude", home: defaultHome("claude"), isDefault: true });
      expect(id.auth.state).toBe("missing");
    } finally {
      process.env.HOME = home;
    }
  });
});
