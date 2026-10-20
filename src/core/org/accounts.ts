/** Org accounts (docs/org.md, Org accounts): a login that lives in the store
 *  instead of on one machine.
 *
 *  Every member's machine keeps an ordinary home for each org account, under
 *  `<agentbox home>/org/accounts/<id>`, holding the store's current access
 *  token and a placeholder refresh token, so the CLI runs on it like any
 *  account and can never rotate the org's login away. The store refreshes it
 *  instead, before the CLI would want to, under a lease; a CLI near its
 *  token's expiry re-reads the file (claude) or re-reads it on a 401 before
 *  refreshing (codex), and so picks up the new one.
 *
 *  Two holders of a Claude or Codex login log each other out at the next
 *  refresh, so moving is the only operation, and it takes every copy. */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteAccount, getAccount, insertAccount, listAccounts, updateAccount } from "../db";
import { claudeJsonPath, credentialsPath, newAccountId, resyncShared, createAccountHome, sameLogin } from "../accounts/homes";
import { POOLED, readGoLogin, writeGoLogin, type GoLogin } from "../accounts/gocred";
import { decodeJwtPayload } from "../accounts/identity";
import { exchangeGoRefresh, REFRESH_AHEAD_MS } from "../accounts/godevice";
import type { Account, AccountProvider } from "../types";
import { ORG_PROVIDERS } from "../providers/account";
import { machineName, orgAccountsRoot, personName, readOrg } from "./config";
import { seal, unseal } from "./seal";
import { linkSkills } from "./skills";
import { storeAccounts, type StoreAccount } from "./store";

export const isOrgHome = (home: string): boolean => home.startsWith(orgAccountsRoot() + "/");
export const isOrgAccount = (a: Pick<Account, "home">): boolean => isOrgHome(a.home);

/** A login as the store keeps it: claude's credentials and account, codex's
 *  auth.json, or an omp account's OpenCode Go Console sign-in. */
type ClaudeLogin = { claudeAiOauth: Record<string, unknown>; oauthAccount: Record<string, unknown> | null };
type CodexLogin = { tokens: Record<string, unknown>; last_refresh?: string } & Record<string, unknown>;
type Login = ClaudeLogin | CodexLogin | GoLogin;

export class OrgAccountError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// ----------------------------------------------------------- reading homes

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.agentbox-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The login a home holds, with its real refresh token; null when it holds none. */
function loginIn(a: Pick<Account, "provider" | "home" | "isDefault">): Login | null {
  if (a.provider === "claude") {
    const o = readJson(join(a.home, ".credentials.json"))?.claudeAiOauth as Record<string, unknown> | undefined;
    if (!o || typeof o.refreshToken !== "string" || !o.refreshToken || o.refreshToken === POOLED) return null;
    const oa = readJson(claudeJsonPath(a))?.oauthAccount;
    return { claudeAiOauth: o, oauthAccount: oa && typeof oa === "object" ? (oa as Record<string, unknown>) : null };
  }
  if (a.provider === "codex") {
    const auth = readJson(join(a.home, "auth.json"));
    const t = auth?.tokens as Record<string, unknown> | undefined;
    if (!auth || !t || typeof t.refresh_token !== "string" || !t.refresh_token || t.refresh_token === POOLED) return null;
    return auth as CodexLogin;
  }
  if (a.provider === "omp") {
    const login = readGoLogin(a.home);
    return login && login.refresh !== POOLED ? login : null;
  }
  return null;
}

/** When the store should refresh a login: an hour before claude's access
 *  token runs out (they last about eight), a day before codex's (about ten
 *  days), and codex's at least every five days, inside the CLI's own reach. */
function refreshDue(provider: AccountProvider, login: Login, refreshedAt: Date | null, now: number): boolean {
  if (provider === "claude") {
    const exp = Number((login as ClaudeLogin).claudeAiOauth.expiresAt);
    return !Number.isFinite(exp) || exp - now < 60 * 60_000;
  }
  if (provider === "omp") {
    const exp = (login as GoLogin).expires;
    return !Number.isFinite(exp) || exp - now < REFRESH_AHEAD_MS;
  }
  const t = (login as CodexLogin).tokens;
  const exp = typeof t.access_token === "string" ? Number(decodeJwtPayload(t.access_token)?.exp) * 1000 : NaN;
  return !Number.isFinite(exp) || exp - now < 24 * 3_600_000 || !refreshedAt || now - refreshedAt.getTime() > 5 * 86_400_000;
}

/** The file a member's home holds for a login: everything but the refresh token. */
function homeFile(provider: AccountProvider, login: Login): Record<string, unknown> {
  if (provider === "claude") {
    const { refreshTokenExpiresAt: _r, ...o } = (login as ClaudeLogin).claudeAiOauth;
    return { claudeAiOauth: { ...o, refreshToken: POOLED } };
  }
  if (provider === "omp") return { ...(login as GoLogin), refresh: POOLED };
  const l = login as CodexLogin;
  return { ...l, tokens: { ...l.tokens, refresh_token: POOLED } };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Keep a home's file equal to the store's login. A CLI that failed a
 *  refresh blanks its file ("Login expired"); this puts the login back, and
 *  its next prompt goes through. */
function writeHome(a: Account, login: Login): void {
  if (a.provider === "omp") {
    const want = homeFile("omp", login) as unknown as GoLogin;
    const cur = readGoLogin(a.home);
    // Only what the store moves on: rewriting a file per pass would be churn.
    if (!cur || cur.refresh !== POOLED || cur.access !== want.access || cur.expires !== want.expires || cur.orgID !== want.orgID) writeGoLogin(a.home, want);
    return;
  }
  const path = credentialsPath(a.provider, a.home)!;
  const want = homeFile(a.provider, login);
  if (!same(readJson(path), want)) writeJson(path, want);
  if (a.provider === "claude") {
    const oa = (login as ClaudeLogin).oauthAccount;
    const path = claudeJsonPath(a);
    const cj = readJson(path) ?? {};
    if (oa && !same(cj.oauthAccount, oa)) writeJson(path, { ...cj, oauthAccount: oa });
  }
}

// --------------------------------------------------------------- refreshing

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** The provider's answer to a refresh: the new login, or why it was refused
 *  for good (`refused`: log in again), or a failure worth retrying. */
async function refreshLogin(provider: AccountProvider, login: Login, now: number): Promise<{ login: Login } | { refused: string } | { retry: string }> {
  if (provider === "omp") return exchangeGoRefresh(login as GoLogin, fetch, now);
  const body =
    provider === "claude"
      ? {
          grant_type: "refresh_token",
          refresh_token: (login as ClaudeLogin).claudeAiOauth.refreshToken,
          client_id: CLAUDE_CLIENT_ID,
          scope: ((login as ClaudeLogin).claudeAiOauth.scopes as string[] | undefined)?.join(" ") ?? "user:inference user:profile",
        }
      : { grant_type: "refresh_token", refresh_token: (login as CodexLogin).tokens.refresh_token, client_id: CODEX_CLIENT_ID, scope: "openid profile email" };
  let res: Response;
  try {
    res = await fetch(provider === "claude" ? CLAUDE_TOKEN_URL : CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return { retry: (e as Error).message };
  }
  const text = await res.text();
  if (res.status === 400 || res.status === 401 || res.status === 403) return { refused: `${res.status} ${text.slice(0, 200)}` };
  if (!res.ok) return { retry: `${res.status} ${text.slice(0, 200)}` };
  const r = JSON.parse(text) as Record<string, unknown>;
  if (provider === "claude") {
    const old = (login as ClaudeLogin).claudeAiOauth;
    const o: Record<string, unknown> = {
      ...old,
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? old.refreshToken,
      expiresAt: now + Number(r.expires_in) * 1000,
    };
    if (typeof r.refresh_token_expires_in === "number") o.refreshTokenExpiresAt = now + r.refresh_token_expires_in * 1000;
    return { login: { ...(login as ClaudeLogin), claudeAiOauth: o } };
  }
  const l = login as CodexLogin;
  return {
    login: {
      ...l,
      tokens: { ...l.tokens, ...(r.id_token ? { id_token: r.id_token } : {}), ...(r.access_token ? { access_token: r.access_token } : {}), ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}) },
      last_refresh: new Date(now).toISOString(),
    },
  };
}

/** A refresh the provider answered whose login the store has not taken yet:
 *  kept here first, so a machine that dies in between does not lose it. */
const pendingPath = (id: string): string => join(orgAccountsRoot(), `${id}.pending`);

// ------------------------------------------------------------------- syncing

/** One pass over the org's accounts: this machine's homes made to match the
 *  store, a new login found in one of them taken to the store, and a login
 *  that is due refreshed. Returns whether anything here changed. */
export async function syncOrgAccounts(now = Date.now()): Promise<boolean> {
  const org = readOrg();
  const col = await storeAccounts();
  if (!org || !col) return false;
  let changed = false;
  const docs = await col.find().toArray();
  const ids = new Set(docs.map((d) => d._id));
  for (const doc of docs) {
    let local = getAccount(doc._id);
    if (!local) {
      local = { id: doc._id, provider: doc.provider, label: doc.label, email: doc.email, plan: doc.plan, home: join(orgAccountsRoot(), doc._id), isDefault: false, enabled: true, createdAt: doc.addedAt.getTime() };
      mkdirSync(local.home, { recursive: true, mode: 0o700 });
      chmodSync(local.home, 0o700);
      resyncShared(local);
      linkSkills(local);
      insertAccount(local);
      changed = true;
    }
    // A login made here (logging an org account in again) goes to the store.
    const fresh = loginIn(local);
    if (fresh) {
      const login = seal(org.key, fresh);
      await col.updateOne({ _id: doc._id }, { $set: { login, version: doc.version + 1, refreshedAt: new Date(now), problem: null } });
      Object.assign(doc, { login, version: doc.version + 1, refreshedAt: new Date(now), problem: null });
      console.log(`agentbox: org: ${doc.label} logged in here; its login is the org's now`);
      changed = true;
    } else await recoverPending(doc);
    if (!doc.login) {
      const path = credentialsPath(local.provider, local.home)!;
      if (existsSync(path)) {
        rmSync(path);
        changed = true;
      }
      continue;
    }
    const login = unseal<Login>(org.key, doc.login);
    writeHome(local, login);
    if (refreshDue(doc.provider, login, doc.refreshedAt, now)) changed = (await refreshOne(doc, login, org.key, now)) || changed;
  }
  // Taken back to someone's machine: its homes here go with it.
  for (const a of listAccounts()) {
    if (!isOrgAccount(a) || ids.has(a.id)) continue;
    deleteAccount(a.id);
    rmSync(credentialsPath(a.provider, a.home)!, { force: true });
    changed = true;
  }
  return changed;
}

async function recoverPending(doc: StoreAccount): Promise<void> {
  const path = pendingPath(doc._id);
  if (!existsSync(path)) return;
  const p = JSON.parse(readFileSync(path, "utf8")) as { version: number; login: string; at: number };
  const col = (await storeAccounts())!;
  // Nobody wrote a newer one meanwhile: this is the login the provider holds.
  if (doc.version === p.version) {
    await col.updateOne({ _id: doc._id, version: p.version }, { $set: { login: p.login, version: p.version + 1, refreshedAt: new Date(p.at), lease: null, problem: null } });
    doc.login = p.login;
    doc.version = p.version + 1;
    console.log(`agentbox: org: ${doc.label}: stored the refresh this machine had kept`);
  }
  rmSync(path, { force: true });
}

async function refreshOne(doc: StoreAccount, login: Login, key: string, now: number): Promise<boolean> {
  const col = (await storeAccounts())!;
  const me = machineName();
  const leased = await col.findOneAndUpdate(
    { _id: doc._id, version: doc.version, $or: [{ lease: null }, { "lease.until": { $lt: new Date(now) } }] },
    { $set: { lease: { by: me, until: new Date(now + 60_000) } } },
  );
  if (!leased) return false;
  const r = await refreshLogin(doc.provider, login, now);
  if ("retry" in r) {
    console.error(`agentbox: org: refreshing ${doc.label} failed, will retry: ${r.retry}`);
    await col.updateOne({ _id: doc._id }, { $set: { lease: null } });
    return false;
  }
  if ("refused" in r) {
    console.error(`agentbox: org: ${doc.label}'s login was refused (${r.refused}); it needs logging in again`);
    await col.updateOne({ _id: doc._id }, { $set: { login: null, lease: null, problem: "its login was refused: log in again" } });
    return true;
  }
  const sealed = seal(key, r.login);
  writeJson(pendingPath(doc._id), { version: doc.version, login: sealed, at: now });
  await col.updateOne({ _id: doc._id, version: doc.version }, { $set: { login: sealed, version: doc.version + 1, refreshedAt: new Date(now), lease: null, problem: null } });
  rmSync(pendingPath(doc._id), { force: true });
  const local = getAccount(doc._id);
  if (local) writeHome(local, r.login);
  console.log(`agentbox: org: refreshed ${doc.label}`);
  return true;
}

// ------------------------------------------------------------------ moving

/** Whether an account is in use: a live session on it, here. */
export type InUse = (accountIds: readonly string[]) => string | null;

/** The homes on this machine logged in as the same login as `a`, `a` among them. */
function copiesOf(a: Account): Account[] {
  return listAccounts(a.provider).filter((o) => !isOrgAccount(o) && (o.id === a.id || sameLogin(a, o)));
}

/** Move an account's login into the org: every copy of it on this machine
 *  is logged out, so the org's refreshes are the only ones. */
export async function moveIntoOrg(accountId: string, inUse: InUse): Promise<{ account: StoreAccount; loggedOut: string[] }> {
  const org = readOrg();
  if (!org) throw new OrgAccountError(409, "this machine is in no org: agentbox org join <invite>");
  const a = getAccount(accountId);
  if (!a) throw new OrgAccountError(404, `no account ${accountId}`);
  if (isOrgAccount(a)) throw new OrgAccountError(409, `${a.label} is already ${org.name}'s`);
  if (!ORG_PROVIDERS.includes(a.provider)) throw new OrgAccountError(400, `${a.provider} accounts stay on their machine (docs/org.md)`);
  if (a.provider === "claude" && process.platform === "darwin") throw new OrgAccountError(400, "on macOS claude keeps its login in the Keychain, which agentbox cannot move yet");
  const login = loginIn(a);
  if (!login) throw new OrgAccountError(409, `${a.label} is not logged in here`);
  const copies = copiesOf(a);
  const busy = inUse(copies.map((c) => c.id));
  if (busy) throw new OrgAccountError(409, `${a.label} is in use: ${busy}. Close it first.`);
  const col = await storeAccounts();
  if (!col) throw new OrgAccountError(409, "the org's store cannot be reached");
  const email = a.email?.toLowerCase() ?? null;
  // A Go sign-in's identity is one account in one workspace: an email can
  // hold several, each its own refresh token.
  const externalId = a.provider === "omp" ? `${(login as GoLogin).accountID}:${(login as GoLogin).orgID ?? ""}` : null;
  const held =
    a.provider === "omp" && externalId
      ? await col.findOne({ provider: "omp", externalId })
      : email
        ? await col.findOne({ provider: a.provider, email })
        : null;
  if (held) throw new OrgAccountError(409, `${org.name} already has ${a.label}${email ? ` (${email})` : ""}`);
  const doc: StoreAccount = {
    _id: newAccountId(),
    provider: a.provider,
    label: a.label,
    email,
    plan: a.plan,
    externalId,
    login: seal(org.key, login),
    version: 1,
    refreshedAt: null,
    lease: null,
    problem: null,
    addedBy: personName(),
    addedAt: new Date(),
  };
  await col.insertOne(doc);
  // Only once the store has it: a failure before here leaves the login where it was.
  const loggedOut: string[] = [];
  for (const c of copies) {
    rmSync(credentialsPath(c.provider, c.home)!, { force: true });
    // Kept for its transcripts; its email goes, or it would pass for the login it no longer holds.
    updateAccount(c.id, c.isDefault ? { email: null } : { email: null, label: `${c.label} (moved to ${org.name})` });
    loggedOut.push(c.isDefault ? `your plain ${c.provider} (${c.home})` : c.label);
  }
  console.log(`agentbox: org: ${a.label} moved into ${org.name}; logged out here: ${loggedOut.join(", ")}`);
  return { account: doc, loggedOut };
}

/** Take an org account back onto this machine, as a personal account with its own home. */
export async function takeFromOrg(accountId: string, liveElsewhere: (id: string) => Promise<string | null>, inUse: InUse): Promise<Account> {
  const org = readOrg();
  const col = await storeAccounts();
  if (!org || !col) throw new OrgAccountError(409, "this machine is in no org, or its store cannot be reached");
  const doc = await col.findOne({ _id: accountId });
  if (!doc) throw new OrgAccountError(404, `${org.name} has no account ${accountId}`);
  if (!doc.login) throw new OrgAccountError(409, `${doc.label} needs logging in again before it can be taken`);
  const busy = inUse([accountId]) ?? (await liveElsewhere(accountId));
  if (busy) throw new OrgAccountError(409, `${doc.label} is in use: ${busy}`);
  const login = unseal<Login>(org.key, doc.login);
  const id = newAccountId();
  const home = createAccountHome(doc.provider, id);
  const account: Account = { id, provider: doc.provider, label: doc.label, email: doc.email, plan: doc.plan, home, isDefault: false, enabled: true, createdAt: Date.now() };
  // The whole login, refresh token and all: this home is its only holder now.
  if (doc.provider === "omp") writeGoLogin(home, login as GoLogin);
  else writeJson(credentialsPath(doc.provider, home)!, doc.provider === "claude" ? { claudeAiOauth: (login as ClaudeLogin).claudeAiOauth } : login);
  if (doc.provider === "claude" && (login as ClaudeLogin).oauthAccount) {
    const cj = readJson(join(home, ".claude.json")) ?? {};
    writeJson(join(home, ".claude.json"), { ...cj, oauthAccount: (login as ClaudeLogin).oauthAccount });
  }
  insertAccount(account);
  await col.deleteOne({ _id: accountId });
  console.log(`agentbox: org: ${doc.label} taken from ${org.name} onto this machine`);
  return account;
}
