import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCommand } from "../accounts/login";
import { GO_KEY_FILE, cleanGoKey, goKeyOf } from "../accounts/gokey";

const dir = mkdtempSync(join(tmpdir(), "gokey-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("OpenCode Go keys", () => {
  test("the login asks for the key and keeps it, trimmed, 0600", async () => {
    const home = join(dir, "acct");
    mkdirSync(home);
    const cmd = loginCommand({ provider: "omp", home, isDefault: false });
    expect(cmd.needsPaste).toBe(true);
    expect(cmd.credentialFile).toBe(join(home, GO_KEY_FILE));
    const p = Bun.spawn(cmd.argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write("  sk-test-abc  \n");
    p.stdin.end();
    expect(await p.exited).toBe(0);
    expect(await new Response(p.stdout).text()).toContain("https://opencode.ai/auth");
    expect(goKeyOf({ home, isDefault: false })).toBe("sk-test-abc");
    expect(statSync(join(home, GO_KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  test("nothing pasted fails and writes nothing", async () => {
    const home = join(dir, "empty");
    mkdirSync(home);
    const cmd = loginCommand({ provider: "omp", home, isDefault: false });
    const p = Bun.spawn(cmd.argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write("   \n");
    p.stdin.end();
    expect(await p.exited).toBe(1);
    expect(goKeyOf({ home, isDefault: false })).toBeNull();
  });

  test("the default account is opencode's own login, not a paste", () => {
    expect(() => loginCommand({ provider: "omp", home: dir, isDefault: true })).toThrow(/opencode auth login/);
  });

  test("a key file is one token", () => {
    const home = join(dir, "spaced");
    mkdirSync(home);
    writeFileSync(join(home, GO_KEY_FILE), "sk-a sk-b");
    expect(goKeyOf({ home, isDefault: false })).toBeNull();
    expect(cleanGoKey(" sk-x\n")).toBe("sk-x");
  });
});
