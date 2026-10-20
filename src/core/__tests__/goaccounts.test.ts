import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountsService } from "../accounts";
import { GO_ACCOUNT_BEARER, goHomeForAccount, goLoginHomes, hasGoCredential, writeGoLogin, type GoLogin } from "../accounts/gocred";
import { ensureDefaultAccounts } from "../accounts/homes";
import { identify } from "../accounts/identity";
import { orgAccountsRoot } from "../org/config";
import { closeDb, getAccount, getSessionRecord, insertAccount, listAccounts, MIGRATIONS } from "../db";
import { accountHomeFor, dbPath } from "../paths";
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
    expect(added.map((a) => a.provider).sort()).toEqual(["claude", "codex", "devin", "muse"]);
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

  test("a pooled sign-in is found in the org's homes, where its account lives", () => {
    // The bridge is told only an account id: a home under accounts/ that does
    // not exist must not hide the one under org/accounts/.
    const orgHome = join(orgAccountsRoot(), "orggo1");
    mkdirSync(orgHome, { recursive: true });
    writeGoLogin(orgHome, login);
    expect(goHomeForAccount("orggo1")).toBe(orgHome);
    expect(goLoginHomes()).toContain(orgHome);
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
    const accounts = [
      ...listAccounts(),
      account("key", { home: join(process.env.HOME!, ".omp"), isDefault: true, createdAt: 0 }),
      account("go3", { createdAt: 3 }),
      account("go4", { createdAt: 4 }),
    ];
    const currentBox = process.env.AGENTBOX_HOME;
    closeDb();
    process.env.AGENTBOX_HOME = join(dir, "legacy-box");
    mkdirSync(process.env.AGENTBOX_HOME, { recursive: true });
    try {
      // Build the actual old schema. Rewinding a current database's version
      // alone replays later CREATE TABLE / ALTER TABLE migrations twice.
      const legacy = new Database(dbPath(), { create: true });
      try {
        for (const migration of MIGRATIONS.slice(0, 17)) legacy.exec(migration);
        legacy.exec("PRAGMA user_version = 17");
        for (const a of accounts) {
          legacy.run("INSERT INTO accounts (id, provider, label, home, is_default, created_at) VALUES (?,?,?,?,?,?)",
            [a.id, a.provider, a.label, a.home, Number(a.isDefault), a.createdAt]);
        }
        legacy.exec("INSERT INTO sessions (id, provider, agent_session_id, account_id, cwd, origin, started_at, last_activity_at, created_at) VALUES ('s1','opencode','ses_1','key','/w','agentbox',1,1,1)");
      } finally {
        legacy.close();
      }
      expect(getAccount("key")).toBeNull();
      expect(listAccounts("omp").map((a) => a.id)).toEqual(["go3", "go4"]);
      expect(getSessionRecord("s1")!.accountId).toBe("go3");
      // Other providers' default accounts are their CLIs' own logins, and stay.
      expect(listAccounts().filter((a) => a.isDefault).map((a) => a.provider).sort()).toEqual(["claude", "codex", "devin", "muse"]);
    } finally {
      closeDb();
      process.env.AGENTBOX_HOME = currentBox;
    }
  });
});
