/** Org accounts (docs/org.md, Org accounts): a login that lives in the store
 *  instead of on one machine.
 *
 *  Sharing a login puts it in the store for good, and `shared` says whether
 *  the org's pool has it now: flipping that is all sharing and unsharing do.
 *  Every home of a login the store keeps is a mirror, holding the store's
 *  current access token and a placeholder refresh token, so the CLI runs on
 *  it like any account and can never rotate the login away: the sharer's own
 *  homes always, and on every other member's machine, while it is shared, an
 *  ordinary home under `<agentbox home>/org/accounts/<id>`. The store
 *  refreshes it instead, before the CLI would want to, under a lease; a CLI
 *  near its token's expiry re-reads the file (claude) or re-reads it on a 401
 *  before refreshing (codex), and so picks up the new one.
 *
 *  Two holders of a refresh token log each other out at the next refresh,
 *  which is why the store keeps the only one until the sharer takes it back
 *  (`reclaimFromOrg`). */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { deleteAccount, getAccount, insertAccount, listAccounts } from "../db";
import { claudeJsonPath, credentialsPath, resyncShared } from "../accounts/homes";
import { POOLED, readGoLogin, writeGoLogin, type GoLogin } from "../accounts/gocred";
import { decodeJwtPayload } from "../accounts/identity";
import { exchangeGoRefresh, REFRESH_AHEAD_MS } from "../accounts/godevice";
import type { Account, AccountProvider } from "../types";
import { ORG_PROVIDERS } from "../providers/account";
import { isOrgHome, machineName, orgAccountsRoot, personName, readOrg } from "./config";
import { seal, unseal } from "./seal";
import { storeAccounts, type StoreAccount } from "./store";

export const isOrgAccount = (a: Pick<Account, "home">): boolean => isOrgHome(a.home);

/** A login as the store keeps it: claude's credentials and account, codex's
 *  auth.json, an omp account's OpenCode Go Console sign-in, or a devin/muse
 *  credential file whose token does not rotate (`text`). */
type ClaudeLogin = { claudeAiOauth: Record<string, unknown>; oauthAccount: Record<string, unknown> | null };
type CodexLogin = { tokens: Record<string, unknown>; last_refresh?: string } & Record<string, unknown>;
type StaticLogin = { text: string };
type Login = ClaudeLogin | CodexLogin | GoLogin | StaticLogin;

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
    return rec(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function readText(path: string): string | null {
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.agentbox-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.agentbox-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The file a home keeps its login in. */
const fileOf = (a: Pick<Account, "provider" | "home">): string => credentialsPath(a.provider, a.home);

/** How one provider's login is read, refreshed and written, the same for
 *  every home of it. */
interface Kind<L extends Login = Login> {
  /** The login a home holds, with its real refresh token; null when it holds none. */
  read(a: Pick<Account, "provider" | "home" | "isDefault">): L | null;
  /** When its access token runs out, NaN when it does not say. */
  expiry(l: L): number;
  /** The login with its refresh token held back: what a member's home gets.
   *  Its expiry stays: it is when the login ends, refreshed or not. */
  pooled(l: L): L;
  /** Puts a login in a home, unless the home already holds it. */
  write(a: Account, l: L): void;
  /** Refreshed `ahead` ms before it runs out, and at least `every` ms; a
   *  login without it does not rotate and is never refreshed. */
  refresh?: { ahead: number; every?: number; run(l: L, now: number): Promise<{ login: L } | { refused: string } | { retry: string }> };
  /** The login's own id, where the email does not name it. */
  id?(home: string): string | null;
  /** Why a home whose login `read` does not take cannot be shared. */
  unshareable?: string;
  /** On macOS the login is in the Keychain, which agentbox cannot share yet. */
  keychain?: true;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A refresh token exchanged at an OAuth endpoint: the provider's reply, or
 *  why it was refused for good (`refused`: log in again), or a failure worth
 *  retrying. */
async function exchange(url: string, body: Record<string, unknown>): Promise<{ r: Record<string, unknown> } | { refused: string } | { retry: string }> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return { retry: (e as Error).message };
  }
  const text = await res.text();
  if (res.status === 400 || res.status === 401 || res.status === 403) return { refused: `${res.status} ${text.slice(0, 200)}` };
  if (!res.ok) return { retry: `${res.status} ${text.slice(0, 200)}` };
  return { r: JSON.parse(text) as Record<string, unknown> };
}

/** devin's WINDSURF_API_KEY and muse's api_key: static, so a copy is not a
 *  second refresher, and the store keeps the file's text as it is. */
const staticKind = (valid: (text: string, a: Pick<Account, "home">) => boolean, more?: Partial<Kind<StaticLogin>>): Kind<StaticLogin> => ({
  read(a) {
    const text = readText(fileOf(a));
    return text && valid(text, a) ? { text } : null;
  },
  expiry: () => NaN,
  pooled: (l) => l,
  write(a, l) {
    if (readText(fileOf(a)) !== l.text) writeText(fileOf(a), l.text);
  },
  ...more,
});

const KINDS: Record<AccountProvider, Kind> = {
  claude: {
    read(a): ClaudeLogin | null {
      const o = readJson(fileOf(a))?.claudeAiOauth as Record<string, unknown> | undefined;
      if (!o || typeof o.refreshToken !== "string" || !o.refreshToken || o.refreshToken === POOLED) return null;
      const oa = readJson(claudeJsonPath(a))?.oauthAccount;
      return { claudeAiOauth: o, oauthAccount: oa && typeof oa === "object" ? (oa as Record<string, unknown>) : null };
    },
    expiry: (l: ClaudeLogin) => Number(l.claudeAiOauth.expiresAt),
    pooled: (l: ClaudeLogin) => ({ ...l, claudeAiOauth: { ...l.claudeAiOauth, refreshToken: POOLED } }),
    write(a, l: ClaudeLogin) {
      if (!same(readJson(fileOf(a)), { claudeAiOauth: l.claudeAiOauth })) writeJson(fileOf(a), { claudeAiOauth: l.claudeAiOauth });
      const cj = readJson(claudeJsonPath(a)) ?? {};
      if (l.oauthAccount && !same(cj.oauthAccount, l.oauthAccount)) writeJson(claudeJsonPath(a), { ...cj, oauthAccount: l.oauthAccount });
    },
    // Access tokens last about eight hours.
    refresh: {
      ahead: 60 * 60_000,
      async run(l: ClaudeLogin, now) {
        const old = l.claudeAiOauth;
        const scope = (old.scopes as string[] | undefined)?.join(" ") ?? "user:inference user:profile";
        const x = await exchange(CLAUDE_TOKEN_URL, { grant_type: "refresh_token", refresh_token: old.refreshToken, client_id: CLAUDE_CLIENT_ID, scope });
        if (!("r" in x)) return x;
        const { r } = x;
        const o: Record<string, unknown> = { ...old, accessToken: r.access_token, refreshToken: r.refresh_token ?? old.refreshToken, expiresAt: now + Number(r.expires_in) * 1000 };
        if (typeof r.refresh_token_expires_in === "number") o.refreshTokenExpiresAt = now + r.refresh_token_expires_in * 1000;
        return { login: { ...l, claudeAiOauth: o } };
      },
    },
    keychain: true,
  },
  codex: {
    read(a): CodexLogin | null {
      const auth = readJson(fileOf(a));
      const t = auth?.tokens as Record<string, unknown> | undefined;
      if (!auth || !t || typeof t.refresh_token !== "string" || !t.refresh_token || t.refresh_token === POOLED) return null;
      return auth as CodexLogin;
    },
    expiry: (l: CodexLogin) => (typeof l.tokens.access_token === "string" ? Number(decodeJwtPayload(l.tokens.access_token)?.exp) * 1000 : NaN),
    pooled: (l: CodexLogin) => ({ ...l, tokens: { ...l.tokens, refresh_token: POOLED } }),
    write(a, l) {
      if (!same(readJson(fileOf(a)), l)) writeJson(fileOf(a), l);
    },
    // Access tokens last about ten days; every five days stays inside the CLI's own reach.
    refresh: {
      ahead: 24 * 3_600_000,
      every: 5 * 86_400_000,
      async run(l: CodexLogin, now) {
        const x = await exchange(CODEX_TOKEN_URL, { grant_type: "refresh_token", refresh_token: l.tokens.refresh_token, client_id: CODEX_CLIENT_ID, scope: "openid profile email" });
        if (!("r" in x)) return x;
        const { r } = x;
        const tokens = { ...l.tokens, ...(r.id_token ? { id_token: r.id_token } : {}), ...(r.access_token ? { access_token: r.access_token } : {}), ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}) };
        return { login: { ...l, tokens, last_refresh: new Date(now).toISOString() } };
      },
    },
  },
  omp: {
    read(a) {
      const login = readGoLogin(a.home);
      return login && login.refresh !== POOLED ? login : null;
    },
    expiry: (l: GoLogin) => l.expires,
    pooled: (l: GoLogin) => ({ ...l, refresh: POOLED }),
    write(a, l: GoLogin) {
      const cur = readGoLogin(a.home);
      // Only what the store moves on: rewriting a file per pass would be churn.
      if (!cur || cur.refresh !== l.refresh || cur.access !== l.access || cur.expires !== l.expires || cur.orgID !== l.orgID) writeGoLogin(a.home, l);
    },
    refresh: { ahead: REFRESH_AHEAD_MS, run: (l: GoLogin, now) => exchangeGoRefresh(l, fetch, now) },
    // An email can hold several OpenCode accounts, each its own sign-in.
    id(home) {
      const l = readGoLogin(home);
      return l?.accountID ? `${l.accountID}:${l.orgID ?? ""}` : null;
    },
  },
  devin: staticKind((text) => /^\s*windsurf_api_key\s*=\s*["'][^"']+["']/m.test(text)),
  // Only a static api_key: an access token may rotate, and the default home's
  // login lives in the Keychain, which has no file to read.
  muse: staticKind((_text, a) => {
    const meta = rec(rec(readJson(join(a.home, "muse", "auth.json"))?.providers)?.meta);
    return typeof meta?.api_key === "string" && !!meta.api_key;
  }, { unshareable: "can be shared only with a static api_key login: its token login (or the Keychain) rotates and would log every sharer out" }),
};

/** Whether the store should refresh a login now. */
function refreshDue(provider: AccountProvider, login: Login, refreshedAt: Date | null, now: number): boolean {
  const { refresh, expiry } = KINDS[provider];
  if (!refresh) return false;
  const exp = expiry(login);
  if (!Number.isFinite(exp)) return true;
  return exp - now < refresh.ahead || (!!refresh.every && (!refreshedAt || now - refreshedAt.getTime() > refresh.every));
}

/** Keep a home's file equal to the store's login. A CLI that failed a
 *  refresh blanks its file ("Login expired"); this puts the login back, and
 *  its next prompt goes through. */
const writeHome = (a: Account, login: Login): void => KINDS[a.provider].write(a, KINDS[a.provider].pooled(login));

// --------------------------------------------------------------- refreshing

const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** A refresh the provider answered whose login the store has not taken yet:
 *  kept here first, so a machine that dies in between does not lose it. */
const pendingPath = (id: string): string => join(orgAccountsRoot(), `${id}.pending`);

// ------------------------------------------------------------------- syncing

/** A login's name on every machine: one email for claude and codex, its own
 *  id for a provider whose email does not name it (omp). */
function loginKey(a: Pick<Account, "provider" | "email" | "home">): string | null {
  const id = KINDS[a.provider].id;
  const name = id ? id(a.home) : a.email?.toLowerCase();
  return name ? `${a.provider}:${name}` : null;
}

function storeKey(d: Pick<StoreAccount, "provider" | "email" | "externalId">): string | null {
  const name = KINDS[d.provider].id ? d.externalId : d.email;
  return name ? `${d.provider}:${name}` : null;
}

/** Every home here of a login the store keeps: each of yours logged in as
 *  it (the sharer's own account has its id), or the pool's mirror of it. */
function homesOf(doc: StoreAccount): Account[] {
  const key = storeKey(doc);
  return listAccounts(doc.provider).filter((a) => a.id === doc._id || (!isOrgAccount(a) && key !== null && loginKey(a) === key));
}

/** One pass over the store's logins: this machine's homes of each made to
 *  match the store, a newer login found in one of them taken to the store,
 *  and a login that is due refreshed. A machine holding no login of its own
 *  of a shared one gets the pool's mirror of it, and loses it once it is
 *  unshared. Returns whether anything here changed. */
export async function syncOrgAccounts(now = Date.now()): Promise<boolean> {
  const org = readOrg();
  const col = await storeAccounts();
  if (!org || !col) return false;
  let changed = false;
  const docs = await col.find().toArray();
  const mirrors = new Set<string>();
  for (const doc of docs) {
    if (doc.shared && !homesOf(doc).some((a) => !isOrgAccount(a))) {
      mirrors.add(doc._id);
      if (!getAccount(doc._id)) {
        const local: Account = { id: doc._id, provider: doc.provider, label: doc.label, email: doc.email, plan: doc.plan, home: join(orgAccountsRoot(), doc._id), isDefault: false, enabled: true, createdAt: doc.addedAt.getTime() };
        mkdirSync(local.home, { recursive: true, mode: 0o700 });
        chmodSync(local.home, 0o700);
        resyncShared(local);
        insertAccount(local);
        changed = true;
      }
    }
    const homes = homesOf(doc).filter((a) => !isOrgAccount(a) || mirrors.has(a.id));
    // Not yours and not in the pool: nothing of it here.
    if (!homes.length) continue;
    await recoverPending(doc);
    // A login made in one of them (logging in again, or the sharer's CLI
    // refreshing its own before it saw the store's) goes to the store when it
    // is newer than the store's; an older one is only a stale copy.
    const held = doc.login ? unseal<Login>(org.key, doc.login) : null;
    // NaN for a login that does not expire: devin's key, muse's api_key.
    const age = (l: Login) => KINDS[doc.provider].expiry(l);
    const found = homes.flatMap((h) => KINDS[h.provider].read(h) ?? []);
    // A login with an expiry is newest when it lasts longest. A static one
    // (devin's key, muse's api_key) has no expiry to compare: the login a
    // mirror holds that differs from the store's is one made there since.
    const newest = !held || Number.isFinite(age(held)) ? found.sort((x, y) => (age(y) || 0) - (age(x) || 0))[0] : found.find((l) => !same(l, held));
    const newer = !!newest && (!held || !Number.isFinite(age(held)) || age(newest) > age(held));
    if (newer) {
      const login = seal(org.key, newest);
      await col.updateOne({ _id: doc._id }, { $set: { login, version: doc.version + 1, refreshedAt: new Date(now), problem: null } });
      Object.assign(doc, { login, version: doc.version + 1, refreshedAt: new Date(now), problem: null });
      console.log(`agentbox: org: ${doc.label}: took this machine's newer login to the store`);
      changed = true;
    }
    if (!doc.login) {
      for (const h of homes) {
        const path = credentialsPath(h.provider, h.home);
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
  // The pool's mirror of a login no longer in it, or one this machine now
  // holds a login of its own of, goes.
  for (const a of listAccounts()) {
    if (!isOrgAccount(a) || mirrors.has(a.id)) continue;
    deleteAccount(a.id);
    rmSync(credentialsPath(a.provider, a.home), { force: true });
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
  const r = await KINDS[doc.provider].refresh!.run(login, now);
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

/** The store's document of a login you hold here, shared or not. */
async function keptAs(a: Account): Promise<StoreAccount | null> {
  const key = loginKey(a);
  const col = await storeAccounts();
  if (!key || !col) return null;
  return (await col.find({ provider: a.provider }).toArray()).find((d) => storeKey(d) === key) ?? null;
}

/** Put an account's login in the org's pool. It stays yours: the store
 *  keeps it from the first share on and refreshes it, and your homes of it
 *  get each new login as everyone else's do. */
export async function shareWithOrg(accountId: string): Promise<void> {
  const org = readOrg();
  if (!org) throw new OrgAccountError(409, "this machine is in no org: agentbox org join <invite>");
  const a = getAccount(accountId);
  if (!a) throw new OrgAccountError(404, `no account ${accountId}`);
  if (isOrgAccount(a)) throw new OrgAccountError(409, `${a.label} is ${org.name}'s mirror of someone else's login`);
  if (!ORG_PROVIDERS.includes(a.provider)) throw new OrgAccountError(400, `${a.provider} accounts stay on their machine (docs/org.md)`);
  const col = await storeAccounts();
  if (!col) throw new OrgAccountError(409, "the org's store cannot be reached");
  const kept = await keptAs(a);
  if (kept) {
    await col.updateOne({ _id: kept._id }, { $set: { shared: true } });
    console.log(`agentbox: org: ${a.label} shared with ${org.name} again`);
    return;
  }
  const kind = KINDS[a.provider];
  if (kind.keychain && process.platform === "darwin") throw new OrgAccountError(400, `on macOS ${a.provider} keeps its login in the Keychain, which agentbox cannot share yet`);
  const login = kind.read(a);
  if (!login) throw new OrgAccountError(409, `${a.label} ${kind.unshareable ?? "is not logged in here"}`);
  await col.insertOne({
    _id: a.id,
    provider: a.provider,
    label: a.label,
    email: a.email?.toLowerCase() ?? null,
    plan: a.plan,
    externalId: kind.id?.(a.home) ?? null,
    login: seal(org.key, login),
    version: 1,
    refreshedAt: null,
    lease: null,
    problem: null,
    shared: true,
    addedBy: personName(),
    addedAt: new Date(),
  });
  console.log(`agentbox: org: ${a.label} shared with ${org.name}`);
}

/** Take an account's login out of the org's pool. The store still keeps
 *  and refreshes it for your machines; the other members' mirrors of it go
 *  at their next sync, and a session there already on it keeps its access
 *  token until it runs out. */
export async function unshareFromOrg(accountId: string): Promise<void> {
  const a = getAccount(accountId);
  if (!a) throw new OrgAccountError(404, `no account ${accountId}`);
  const kept = await keptAs(a);
  if (kept) await (await storeAccounts())!.updateOne({ _id: kept._id }, { $set: { shared: false } });
  console.log(`agentbox: org: ${a.label} no longer shared`);
}

/** Take a login out of the store altogether: your homes of it get the whole
 *  login back, refresh token and all, and the pool's mirrors of it go at
 *  each machine's next sync. For leaving the org, or a store you cannot
 *  rely on. */
export async function reclaimFromOrg(accountId: string): Promise<void> {
  const org = readOrg();
  const col = await storeAccounts();
  if (!org || !col) throw new OrgAccountError(409, "this machine is in no org, or its store cannot be reached");
  const a = getAccount(accountId);
  if (!a) throw new OrgAccountError(404, `no account ${accountId}`);
  if (isOrgAccount(a)) throw new OrgAccountError(409, `${a.label} is ${org.name}'s mirror of someone else's login`);
  const kept = await keptAs(a);
  if (!kept) return;
  // Only the version read: a refresh landing in between would be lost with it.
  if (!(await col.deleteOne({ _id: kept._id, version: kept.version })).deletedCount) {
    throw new OrgAccountError(409, `${a.label}'s login was just refreshed: try again`);
  }
  if (kept.login) {
    const login = unseal<Login>(org.key, kept.login);
    for (const h of homesOf(kept)) if (!isOrgAccount(h)) KINDS[h.provider].write(h, login);
  }
  console.log(`agentbox: org: ${a.label} taken back from ${org.name}'s store`);
}
