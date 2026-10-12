import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountsService } from "../accounts";
import { GO_ACCOUNT_BEARER, goHomeForAccount, hasGoCredential, writeGoLogin, type GoLogin } from "../accounts/gocred";
import { ensureDefaultAccounts } from "../accounts/homes";
import { identify } from "../accounts/identity";
import { closeDb, getAccount, getDb, getSessionRecord, insertAccount, insertSessionRecord, listAccounts } from "../db";
import { accountHomeFor } from "../paths";
import { ompAdapter } from "../providers/omp";
import type { Account } from "../types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-goaccounts-"));
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  process.env.AGENTBOX_HOME = join(dir, "box");
  mkdirSync(process.env.HOME, { recursive: true });
  closeDb();
});

afterAll(() => {
  closeDb();
  process.env.HOME = saved.home;
  if (saved.box === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved.box;
  rmSync(dir, { recursive: true, force: true });
});

const login: GoLogin = { server: "https://console.test/console", access: "a0", refresh: "r0", expires: 9e15, accountID: "acc_1", email: "me@example.com", orgID: "wrk_b", orgName: "Beta" };

function account(id: string, over: Partial<Account> = {}): Account {
  return { id, provider: "omp", label: id, email: null, plan: null, home: accountHomeFor(id), isDefault: false, enabled: true, createdAt: 1, ...over };
}

describe("OpenCode Go accounts", () => {
  test("omp gets no default account, however installed its CLI is", async () => {
    const added = await ensureDefaultAccounts(async () => ({ installed: true, version: "1" }));
    expect(added.map((a) => a.provider).sort()).toEqual(["claude", "codex", "devin"]);
    expect(listAccounts("omp")).toEqual([]);
  });

  test("an account is its sign-in: missing until it has one, then who it is", async () => {
    const a = account("go1");
    mkdirSync(a.home, { recursive: true });
    expect(hasGoCredential(a)).toBe(false);
    expect((await identify(a)).auth.state).toBe("missing");
    writeGoLogin(a.home, login);
    expect(hasGoCredential(a)).toBe(true);
    expect(await identify(a)).toMatchObject({ email: "me@example.com", plan: "OpenCode Go · Beta", auth: { state: "ok" } });
  });

  test("every session names its account to the bridge, and none is left to a key", () => {
    const cmd = ompAdapter.accountCommand(account("go1"));
    expect(cmd.env).toEqual({ OPENCODE_GO_API_KEY: `${GO_ACCOUNT_BEARER}go1` });
    expect(cmd.unset).not.toContain("OPENCODE_GO_API_KEY");
    expect(goHomeForAccount("go1")).toBe(accountHomeFor("go1"));
    expect(goHomeForAccount("../etc")).toBeNull();
  });

  test("any account can be forgotten", () => {
    insertAccount(account("go1"));
    insertAccount(account("go2", { createdAt: 2 }));
    const service = new AccountsService();
    service.remove("go1");
    expect(listAccounts("omp").map((a) => a.id)).toEqual(["go2"]);
    service.remove("go2");
    expect(listAccounts("omp")).toEqual([]);
  });

  test("the key account of before is removed, and its sessions go to an account that is left", () => {
    insertAccount(account("key", { home: join(process.env.HOME!, ".omp"), isDefault: true, createdAt: 0 }));
    insertAccount(account("go3", { createdAt: 3 }));
    insertAccount(account("go4", { createdAt: 4 }));
    insertSessionRecord({
      id: "s1", provider: "opencode", agentSessionId: "ses_1", accountId: "key", cwd: "/w", worktree: null, label: null, claim: 1,
      origin: "agentbox", tmux: null, transcriptPath: null, startedAt: 1, lastActivityAt: 1, archivedAt: null, facts: null, createdAt: 1,
    });
    getDb().exec("PRAGMA user_version = 17");
    closeDb();
    expect(getAccount("key")).toBeNull();
    expect(listAccounts("omp").map((a) => a.id)).toEqual(["go3", "go4"]);
    expect(getSessionRecord("s1")!.accountId).toBe("go3");
    // Other providers' default accounts are their CLIs' own logins, and stay.
    expect(listAccounts().filter((a) => a.isDefault).map((a) => a.provider).sort()).toEqual(["claude", "codex", "devin"]);
  });
});
