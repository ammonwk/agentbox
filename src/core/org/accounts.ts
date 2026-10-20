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
 *  Two holders of a refresh token log each other out at the next refresh,
 *  so while a login is shared the store holds its only one: every home of it
 *  on every member's machine, the sharer's own among them, is a mirror. */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deleteAccount, getAccount, insertAccount, listAccounts } from "../db";
import { claudeJsonPath, credentialsPath, newAccountId, resyncShared } from "../accounts/homes";
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

/** When a login's access token runs out, NaN when it does not say. */
function expiryOf(provider: AccountProvider, login: Login): number {
  if (provider === "claude") return Number((login as ClaudeLogin).claudeAiOauth.expiresAt);
  if (provider === "omp") return (login as GoLogin).expires;
  const t = (login as CodexLogin).tokens;
  return typeof t.access_token === "string" ? Number(decodeJwtPayload(t.access_token)?.exp) * 1000 : NaN;
}

/** When the store should refresh a login: an hour before claude's access
 *  token runs out (they last about eight), a day before codex's (about ten
 *  days), and codex's at least every five days, inside the CLI's own reach. */
function refreshDue(provider: AccountProvider, login: Login, refreshedAt: Date | null, now: number): boolean {
  const exp = expiryOf(provider, login);
  if (!Number.isFinite(exp)) return true;
  if (provider === "claude") return exp - now < 60 * 60_000;
  if (provider === "omp") return exp - now < REFRESH_AHEAD_MS;
  return exp - now < 24 * 3_600_000 || !refreshedAt || now - refreshedAt.getTime() > 5 * 86_400_000;
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

/** A login's name on every machine: one email for claude and codex, one
 *  OpenCode account in one workspace for omp (an email can hold several,
 *  each its own sign-in). */
export function loginKey(a: Pick<Account, "provider" | "email" | "home">): string | null {
  if (a.provider === "omp") {
    const l = readGoLogin(a.home);
    return l?.accountID ? `omp:${l.accountID}:${l.orgID ?? ""}` : null;
  }
  return a.email ? `${a.provider}:${a.email.toLowerCase()}` : null;
}

export const storeKey = (d: Pick<StoreAccount, "provider" | "email" | "externalId">): string | null =>
  d.provider === "omp" ? (d.externalId ? `omp:${d.externalId}` : null) : d.email ? `${d.provider}:${d.email}` : null;

/** Every home here that holds a shared login: the org's own, and each of
 *  yours logged in as it. */
function homesOf(doc: StoreAccount): Account[] {
  const key = storeKey(doc);
  return listAccounts(doc.provider).filter((a) => a.id === doc._id || (!isOrgAccount(a) && key !== null && loginKey(a) === key));
}

/** One pass over the org's accounts: this machine's homes of each made to
 *  match the store, a newer login found in one of them taken to the store,
 *  and a login that is due refreshed. Returns whether anything here changed. */
export async function syncOrgAccounts(now = Date.now()): Promise<boolean> {
  const org = readOrg();
  const col = await storeAccounts();
  if (!org || !col) return false;
  let changed = false;
  const docs = await col.find().toArray();
  const ids = new Set(docs.map((d) => d._id));
  for (const doc of docs) {
    if (!getAccount(doc._id)) {
      const local: Account = { id: doc._id, provider: doc.provider, label: doc.label, email: doc.email, plan: doc.plan, home: join(orgAccountsRoot(), doc._id), isDefault: false, enabled: true, createdAt: doc.addedAt.getTime() };
      mkdirSync(local.home, { recursive: true, mode: 0o700 });
      chmodSync(local.home, 0o700);
      resyncShared(local);
      linkSkills(local);
      insertAccount(local);
      changed = true;
    }
    await recoverPending(doc);
    const homes = homesOf(doc);
    // A login made in one of them (logging in again, or the sharer's CLI
    // refreshing its own before it saw the store's) goes to the store when it
    // is newer than the store's; an older one is only a stale copy.
    const held = doc.login ? unseal<Login>(org.key, doc.login) : null;
    const age = (l: Login) => expiryOf(doc.provider, l) || 0;
    const newest = homes.flatMap((h) => loginIn(h) ?? []).sort((x, y) => age(y) - age(x))[0];
    if (newest && (!held || age(newest) > age(held))) {
      const login = seal(org.key, newest);
      await col.updateOne({ _id: doc._id }, { $set: { login, version: doc.version + 1, refreshedAt: new Date(now), problem: null } });
      Object.assign(doc, { login, version: doc.version + 1, refreshedAt: new Date(now), problem: null });
      console.log(`agentbox: org: ${doc.label}: took this machine's newer login to the store`);
      changed = true;
    }
    if (!doc.login) {
      for (const h of homes) {
        const path = credentialsPath(h.provider, h.home)!;
        if (!existsSync(path)) continue;
        rmSync(path);
        changed = true;
      }
      continue;
    }
    const login = unseal<Login>(org.key, doc.login);
    for (const h of homes) writeHome(h, login);
    if (refreshDue(doc.provider, login, doc.refreshedAt, now)) changed = (await refreshOne(doc, login, org.key, now)) || changed;
  }
  // No longer shared: the org's home of it here goes. Yours were given the
  // login back by the machine that stopped sharing it.
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
  for (const h of homesOf(doc)) writeHome(h, r.login);
  console.log(`agentbox: org: refreshed ${doc.label}`);
  return true;
}

// ----------------------------------------------------------------- sharing

/** The org's account of a login you hold here, if it is shared. */
async function sharedAs(a: Account): Promise<StoreAccount | null> {
  const key = loginKey(a);
  const col = await storeAccounts();
  if (!key || !col) return null;
  return (await col.find({ provider: a.provider }).toArray()).find((d) => storeKey(d) === key) ?? null;
}

/** Share an account's login with the org. It stays yours: from now on the
 *  store refreshes it, and your homes of it get each new login as everyone
 *  else's do. */
export async function shareWithOrg(accountId: string): Promise<StoreAccount> {
  const org = readOrg();
  if (!org) throw new OrgAccountError(409, "this machine is in no org: agentbox org join <invite>");
  const a = getAccount(accountId);
  if (!a) throw new OrgAccountError(404, `no account ${accountId}`);
  if (isOrgAccount(a)) throw new OrgAccountError(409, `${a.label} is ${org.name}'s own home of a shared login`);
  if (!ORG_PROVIDERS.includes(a.provider)) throw new OrgAccountError(400, `${a.provider} accounts stay on their machine (docs/org.md)`);
  if (a.provider === "claude" && process.platform === "darwin") throw new OrgAccountError(400, "on macOS claude keeps its login in the Keychain, which agentbox cannot share yet");
  const login = loginIn(a);
  if (!login) throw new OrgAccountError(409, `${a.label} is not logged in here`);
  const col = await storeAccounts();
  if (!col) throw new OrgAccountError(409, "the org's store cannot be reached");
  const existing = await sharedAs(a);
  if (existing) return existing;
  const doc: StoreAccount = {
    _id: newAccountId(),
    provider: a.provider,
    label: a.label,
    email: a.email?.toLowerCase() ?? null,
    plan: a.plan,
    externalId: a.provider === "omp" ? loginKey(a)!.slice("omp:".length) : null,
    login: seal(org.key, login),
    version: 1,
    refreshedAt: null,
    lease: null,
    problem: null,
    addedBy: personName(),
    addedAt: new Date(),
  };
  await col.insertOne(doc);
  console.log(`agentbox: org: ${a.label} shared with ${org.name}`);
  return doc;
}

/** Stop sharing an account's login: your homes of it get the whole login
 *  back, refresh token and all, and the org's homes of it go at each
 *  machine's next sync. A session there already on it keeps its access
 *  token until it runs out. */
export async function unshareFromOrg(accountId: string): Promise<void> {
  const org = readOrg();
  const col = await storeAccounts();
  if (!org || !col) throw new OrgAccountError(409, "this machine is in no org, or its store cannot be reached");
  const a = getAccount(accountId);
  if (!a) throw new OrgAccountError(404, `no account ${accountId}`);
  const doc = await sharedAs(a);
  if (!doc) return;
  // Only the version read: a refresh landing in between would be lost with it.
  if (!(await col.deleteOne({ _id: doc._id, version: doc.version })).deletedCount) {
    throw new OrgAccountError(409, `${a.label}'s login was just refreshed: try again`);
  }
  if (doc.login) {
    const login = unseal<Login>(org.key, doc.login);
    for (const h of homesOf(doc)) if (!isOrgAccount(h)) writeLogin(h, login);
  }
  console.log(`agentbox: org: ${a.label} no longer shared with ${org.name}`);
}

/** A whole login, refresh token and all, into one of your homes. */
function writeLogin(a: Account, login: Login): void {
  if (a.provider === "omp") return writeGoLogin(a.home, login as GoLogin);
  writeJson(credentialsPath(a.provider, a.home)!, a.provider === "claude" ? { claudeAiOauth: (login as ClaudeLogin).claudeAiOauth } : login);
  const oa = a.provider === "claude" ? (login as ClaudeLogin).oauthAccount : null;
  if (oa) writeJson(claudeJsonPath(a), { ...(readJson(claudeJsonPath(a)) ?? {}), oauthAccount: oa });
}
