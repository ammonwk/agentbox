import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Account, LoginFlow } from "../../types";
import { loginCommand, LoginManager, parseLoginOutput, scrubSecrets, stripAnsi, type LoginCommand } from "../login";
import { tempDir } from "./fixtures";

// What each CLI prints, reconstructed from the strings in the installed
// binaries (claude 2.1.x `auth login`, codex 0.15x `login --device-auth`,
// devin 3000.x `auth login --force-manual-token-flow`). The URLs and codes are
// made up.
const OSC8 = (url: string) => `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
const CLAUDE_URL = "https://claude.ai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile+user%3Ainference&code_challenge=xyz&state=st4te";
const CLAUDE_OUT = `Opening browser to sign in…\r\nIf the browser didn't open, visit: ${OSC8(CLAUDE_URL)}\r\nPaste code here if prompted > `;
const CODEX_OUT =
  "\r\nWelcome to Codex [v\x1b[2m0.156.1\x1b[0m]\r\n\x1b[2mOpenAI's command-line coding agent\x1b[0m\r\n\r\n" +
  "Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n" +
  "1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n" +
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94mK7QZ-4M2PX\x1b[0m\r\n\r\n" +
  "\x1b[90mDevice codes are a common phishing target. Never share this code.\x1b[0m\r\n";
const DEVIN_OUT = "Visit \x1b[4mhttps://app.devin.ai/auth/cli?state=abc123\x1b[24m to sign in, then copy the token and paste it below.\r\nToken: ";

describe("parsing", () => {
  test("stripAnsi keeps an OSC 8 link's visible URL and drops the escapes", () => {
    expect(stripAnsi(`visit: ${OSC8("https://x/y")}\r\n`)).toBe("visit: https://x/y\n");
    expect(stripAnsi("\x1b[1;32mok\x1b[0m\r50%\r100%")).toBe("ok\n50%\n100%");
  });

  test("claude: the URL after 'visit:'", () => {
    expect(parseLoginOutput("claude", stripAnsi(CLAUDE_OUT))).toEqual({ url: CLAUDE_URL, userCode: null });
  });

  test("codex: verification URL and one-time code", () => {
    expect(parseLoginOutput("codex", stripAnsi(CODEX_OUT))).toEqual({ url: "https://auth.openai.com/codex/device", userCode: "K7QZ-4M2PX" });
  });

  test("devin: the URL after 'Visit'", () => {
    expect(parseLoginOutput("devin", stripAnsi(DEVIN_OUT)).url).toBe("https://app.devin.ai/auth/cli?state=abc123");
  });

  test("nothing yet", () => {
    expect(parseLoginOutput("codex", "Welcome to Codex")).toEqual({ url: null, userCode: null });
  });

  test("scrubSecrets removes whole secrets and long fragments of them", () => {
    const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789#state";
    expect(scrubSecrets(`> ${secret}\ncode was ${secret}`, [secret])).toBe("> [pasted]\ncode was [pasted]");
    // A TUI that wrapped the echo leaves two fragments; both go.
    const wrapped = `> ${secret.slice(0, 20)}\n${secret.slice(20)}`;
    expect(scrubSecrets(wrapped, [secret])).not.toContain(secret.slice(0, 12));
    expect(scrubSecrets(wrapped, [secret])).not.toContain(secret.slice(20, 32));
    expect(scrubSecrets("unrelated text", [secret])).toBe("unrelated text");
  });
});

describe("loginCommand", () => {
  test("isolates non-default homes and unsets stray env for defaults", () => {
    const c = loginCommand({ provider: "claude", home: "/h/a", isDefault: false });
    expect(c.argv).toEqual(["claude", "auth", "login", "--claudeai"]);
    expect(c.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/h/a", BROWSER: "true" });
    expect(c.credentialFile).toBe("/h/a/.credentials.json");
    expect(loginCommand({ provider: "claude", home: "/x/.claude", isDefault: true }).unset).toEqual(["CLAUDE_CONFIG_DIR"]);
    expect(loginCommand({ provider: "codex", home: "/h/b", isDefault: false })).toMatchObject({
      argv: ["codex", "login", "--device-auth"], env: { CODEX_HOME: "/h/b" }, needsPaste: false,
    });
    expect(loginCommand({ provider: "devin", home: "/h/c", isDefault: false })).toMatchObject({
      argv: ["devin", "auth", "login", "--force-manual-token-flow"],
      env: { XDG_DATA_HOME: "/h/c", XDG_CONFIG_HOME: "/h/c/config" },
      credentialFile: "/h/c/devin/credentials.toml",
    });
  });
});

// ------------------------------------------------------------ the PTY runner

let dir: string;
beforeAll(() => {
  dir = tempDir("agentbox-login-");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function acct(id: string, provider: Account["provider"] = "claude"): Account {
  return { id, provider, label: id, email: null, plan: null, home: join(dir, id), isDefault: false, enabled: true, createdAt: 0 };
}

/** A stand-in CLI: prints a claude-shaped prompt, reads the pasted line, echoes
 *  it back (worst case for leaks), writes the credential file, exits. */
function fakeCli(script: string, cred: string, needsPaste = true): LoginCommand {
  return { argv: ["bash", "-c", script], env: { CRED: cred }, unset: [], credentialFile: cred, needsPaste };
}

async function waitFor(m: LoginManager, id: string, pred: (f: LoginFlow) => boolean, ms = 5000): Promise<LoginFlow> {
  const until = Date.now() + ms;
  for (;;) {
    const f = m.get(id);
    if (f && pred(f)) return f;
    if (Date.now() > until) throw new Error(`timed out; last state ${JSON.stringify(f)}`);
    await Bun.sleep(20);
  }
}

describe("LoginManager", () => {
  test("happy path: URL shown, paste typed, success hook, secret never in output", async () => {
    const cred = join(dir, "ok.json");
    const secret = "S3cretCodeFromTheBrowser-0123456789#stateXYZ";
    let hooked = 0;
    const m = new LoginManager({
      command: () =>
        fakeCli(
          `echo "If the browser didn't open, visit: https://claude.example/oauth?x=1"; printf "Paste code here if prompted > "; read code; echo "code was $code"; echo '{}' > "$CRED"; echo "Login successful."`,
          cred,
        ),
      onSuccess: async () => {
        hooked++;
        return null;
      },
    });
    const flow = m.start(acct("a1"));
    const waiting = await waitFor(m, flow.id, (f) => f.state === "awaiting-user");
    expect(waiting.url).toBe("https://claude.example/oauth?x=1");
    expect(waiting.needsPaste).toBe(true);
    m.paste(flow.id, `  ${secret}\n`);
    const done = await waitFor(m, flow.id, (f) => f.state === "done" || f.state === "failed");
    expect(done.state).toBe("done");
    expect(done.error).toBeNull();
    expect(hooked).toBe(1);
    expect(existsSync(cred)).toBe(true);
    expect(done.output).toContain("Login successful.");
    expect(done.output).toContain("[pasted]");
    expect(done.output).not.toContain(secret.slice(0, 12));
    expect(done.output).not.toContain(secret.slice(-12));
  });

  test("codex-style: code parsed, done on exit 0 with the file written", async () => {
    const cred = join(dir, "codex.json");
    const m = new LoginManager({
      command: () =>
        fakeCli(
          `printf '1. Open this link in your browser\\n   https://auth.openai.com/codex/device\\n2. Enter this one-time code (expires in 15 minutes)\\n   ABCD-12345\\n'; sleep 0.3; echo '{}' > "$CRED"`,
          cred,
          false,
        ),
    });
    const flow = m.start(acct("x1", "codex"));
    const w = await waitFor(m, flow.id, (f) => f.userCode !== null);
    expect(w.url).toBe("https://auth.openai.com/codex/device");
    expect(w.userCode).toBe("ABCD-12345");
    expect((await waitFor(m, flow.id, (f) => f.state === "done")).state).toBe("done");
  });

  test("a non-zero exit fails with the CLI's last line", async () => {
    const m = new LoginManager({ command: () => fakeCli(`echo "Login failed: invalid code"; exit 3`, join(dir, "never.json")) });
    const flow = m.start(acct("f1"));
    const f = await waitFor(m, flow.id, (x) => x.state === "failed");
    expect(f.error).toMatch(/code 3: Login failed: invalid code/);
  });

  test("exit 0 without a credentials file is a failure", async () => {
    const m = new LoginManager({ command: () => fakeCli(`echo done`, join(dir, "never2.json")) });
    const flow = m.start(acct("f2"));
    expect((await waitFor(m, flow.id, (x) => x.state === "failed")).error).toMatch(/without writing/);
  });

  test("one login per provider; the same account gets its running flow back", async () => {
    const m = new LoginManager({ command: () => fakeCli(`sleep 5`, join(dir, "n3.json")) });
    const a = acct("p1");
    const first = m.start(a);
    expect(m.start(a).id).toBe(first.id);
    expect(() => m.start(acct("p2"))).toThrow(/already running/);
    expect(() => m.start(acct("p3", "codex"))).not.toThrow();
    m.stop();
    await waitFor(m, first.id, (f) => f.state === "failed");
  });

  test("cancel kills the CLI; timeout fails it", async () => {
    const m = new LoginManager({ command: () => fakeCli(`sleep 30`, join(dir, "n4.json")) });
    const flow = m.start(acct("k1"));
    m.cancel(flow.id);
    expect((await waitFor(m, flow.id, (f) => f.state === "failed")).error).toBe("cancelled");

    const t = new LoginManager({ command: () => fakeCli(`sleep 30`, join(dir, "n5.json")), timeoutMs: 150 });
    const tf = t.start(acct("k2"));
    expect((await waitFor(t, tf.id, (f) => f.state === "failed")).error).toMatch(/timed out/);
  });

  test("finished flows are dropped after the keep window", async () => {
    const m = new LoginManager({ command: () => fakeCli(`exit 1`, join(dir, "n6.json")), keepFinishedMs: 50 });
    const flow = m.start(acct("d1"));
    await waitFor(m, flow.id, (f) => f.state === "failed");
    await Bun.sleep(120);
    expect(m.get(flow.id)).toBeNull();
  });
});
