/** Signing an OpenCode Go account in, and keeping it signed in.
 *
 * The OpenCode Console's device flow, as `opencode auth login opencode` does
 * it (same client id, same endpoints), run by agentbox so each account holds
 * a login of its own (gocred.ts):
 *
 *   POST <server>/auth/device/code   {client_id, supports_org_scope}
 *        → {device_code, user_code, verification_uri_complete, interval, expires_in}
 *   POST <server>/auth/device/token  {grant_type: device_code, device_code, client_id}
 *        → {access_token, refresh_token, expires_in, org_id?} | {error}
 *   POST <server>/auth/device/token  {grant_type: "refresh_token", refresh_token, client_id}
 *        → the same, with a NEW refresh token
 *   GET  <server>/api/user, /api/orgs   who and which workspace
 */

import { POOLED, readGoLogin, writeGoLogin, type GoLogin } from "./gocred";

export const CONSOLE = "https://opencode.ai/console";
const CLIENT_ID = "opencode-cli";
/** Refresh this long before the access token runs out. The org's store
 *  refreshes a pooled sign-in on the same clock (org/accounts.ts). */
export const REFRESH_AHEAD_MS = 24 * 3_600_000;

type Fetch = typeof fetch;

interface TokenReply {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  org_id?: string | null;
}

async function post<T>(f: Fetch, url: string, body: unknown): Promise<T> {
  const res = await f(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`OpenCode Console answered ${res.status} to ${new URL(url).pathname}`);
  }
}

async function get<T>(f: Fetch, url: string, access: string): Promise<T> {
  const res = await f(url, { headers: { authorization: `Bearer ${access}`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`OpenCode Console answered ${res.status} to ${new URL(url).pathname}`);
  return (await res.json()) as T;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  url: string;
  intervalMs: number;
  expiresAt: number;
}

export async function startDeviceLogin(f: Fetch = fetch, server = CONSOLE, now = Date.now()): Promise<DeviceCode> {
  const r = await post<{ device_code?: string; user_code?: string; verification_uri_complete?: string; interval?: number; expires_in?: number; error?: string }>(
    f,
    `${server}/auth/device/code`,
    { client_id: CLIENT_ID, supports_org_scope: true },
  );
  if (!r.device_code || !r.user_code || !r.verification_uri_complete) throw new Error(`OpenCode Console would not start a sign-in${r.error ? `: ${r.error}` : ""}`);
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    url: new URL(r.verification_uri_complete, `${server}/`).href,
    intervalMs: Math.max(1, r.interval ?? 5) * 1000,
    expiresAt: now + (r.expires_in ?? 900) * 1000,
  };
}

/** The workspace a token is for: the one it names, else the first by name,
 *  as opencode picks. */
async function loginOf(f: Fetch, server: string, t: TokenReply, now: number): Promise<GoLogin> {
  const [user, orgs] = await Promise.all([
    get<{ id: string; email: string }>(f, `${server}/api/user`, t.access_token),
    get<{ id: string; name: string }[]>(f, `${server}/api/orgs`, t.access_token),
  ]);
  const org = t.org_id ? orgs.find((o) => o.id === t.org_id) : [...orgs].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
  if (t.org_id && !org) throw new Error(`OpenCode workspace not found: ${t.org_id}`);
  return {
    server,
    access: t.access_token,
    refresh: t.refresh_token,
    expires: now + t.expires_in * 1000,
    accountID: user.id,
    email: user.email,
    orgID: org?.id ?? null,
    orgName: org?.name ?? null,
  };
}

/** Wait for the sign-in to be approved in the browser. */
export async function finishDeviceLogin(
  code: DeviceCode,
  opts: { fetch?: Fetch; server?: string; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<GoLogin> {
  const f = opts.fetch ?? fetch;
  const server = opts.server ?? CONSOLE;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let wait = code.intervalMs;
  while (now() < code.expiresAt) {
    await sleep(wait);
    const r = await post<Partial<TokenReply> & { error?: string }>(f, `${server}/auth/device/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.deviceCode,
      client_id: CLIENT_ID,
    });
    if (r.access_token && r.refresh_token) return loginOf(f, server, r as TokenReply, now());
    if (r.error === "slow_down") wait += 5000;
    else if (r.error !== "authorization_pending") throw new Error(`sign-in failed: ${r.error ?? "no token"}`);
  }
  throw new Error("the sign-in code expired before it was approved");
}

/** The provider's answer to a refresh: the new login, or why it was refused
 *  for good (`refused`: log in again), or a failure worth retrying. */
export type GoRefreshReply = { login: GoLogin } | { refused: string } | { retry: string };

/** Exchange the refresh token. The reply's refresh token replaces it. */
export async function exchangeGoRefresh(login: GoLogin, f: Fetch = fetch, now = Date.now()): Promise<GoRefreshReply> {
  let res: Response;
  try {
    res = await f(`${login.server}/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: login.refresh, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { retry: (e as Error).message };
  }
  const text = await res.text();
  if (res.status === 400 || res.status === 401 || res.status === 403) return { refused: `${res.status} ${text.slice(0, 200)}` };
  if (!res.ok) return { retry: `${res.status} ${text.slice(0, 200)}` };
  let r: Partial<TokenReply> & { error?: string };
  try {
    r = JSON.parse(text) as Partial<TokenReply> & { error?: string };
  } catch {
    return { retry: `OpenCode Console answered something that is not JSON: ${text.slice(0, 200)}` };
  }
  if (!r.access_token || !r.refresh_token || !r.expires_in) return { refused: r.error ?? "no token in the reply" };
  const orgID = r.org_id ?? login.orgID;
  return {
    login: {
      ...login,
      access: r.access_token,
      refresh: r.refresh_token,
      expires: now + r.expires_in * 1000,
      orgID,
      orgName: orgID === login.orgID ? login.orgName : orgID,
    },
  };
}

/** Exchange the refresh token, or throw: the sign-in as the provider now has it. */
export async function refreshGoLogin(login: GoLogin, f: Fetch = fetch, now = Date.now()): Promise<GoLogin> {
  if (login.refresh === POOLED) throw new Error("this sign-in belongs to the org; its store refreshes it");
  const r = await exchangeGoRefresh(login, f, now);
  if ("login" in r) return r.login;
  if ("refused" in r) throw new Error(`OpenCode Console would not refresh the sign-in: ${r.refused} — log the account in again`);
  throw new Error(`OpenCode Console could not refresh the sign-in: ${r.retry}`);
}

const refreshing = new Map<string, Promise<GoLogin>>();

/**
 * A home's sign-in with an access token that works, refreshed (and saved)
 * when it is about to run out or `force` says it was refused. For the bridge
 * alone: one process, one refresh at a time per home, written before use.
 *
 * A pooled sign-in is the org's: the server refreshes it in the store and
 * writes each machine's copy, so this hands back what the file holds — an
 * expired token shows as a 401 the CLI retries, never as a refresh that would
 * rotate the token out from under every other member.
 */
export async function freshGoLogin(home: string, opts: { force?: boolean; fetch?: Fetch; now?: () => number } = {}): Promise<GoLogin | null> {
  const now = (opts.now ?? Date.now)();
  const login = readGoLogin(home);
  if (!login) return null;
  if (login.refresh === POOLED) return login;
  if (!opts.force && login.expires - now > REFRESH_AHEAD_MS) return login;
  let pending = refreshing.get(home);
  if (!pending) {
    pending = refreshGoLogin(login, opts.fetch ?? fetch, now)
      .then((next) => {
        writeGoLogin(home, next);
        return next;
      })
      .finally(() => refreshing.delete(home));
    refreshing.set(home, pending);
  }
  try {
    return await pending;
  } catch (e) {
    // Still good for now: use it, and try again on the next request.
    if (!opts.force && login.expires > now) return login;
    throw e;
  }
}

/** `agentbox go-login <home>`: the sign-in, in a terminal the login manager
 *  reads. Prints the page to open and the code, waits, saves the login. */
export async function runGoLogin(home: string, out: (line: string) => void = console.log): Promise<number> {
  try {
    const code = await startDeviceLogin();
    out(`Open this link in your browser and sign in to the OpenCode account you want here:`);
    out(`   ${code.url}`);
    out(`Enter code: ${code.userCode}`);
    const login = await finishDeviceLogin(code);
    writeGoLogin(home, login);
    out(`Signed in as ${login.email}${login.orgName ? ` (${login.orgName})` : ""}.`);
    return 0;
  } catch (e) {
    out(`OpenCode sign-in failed: ${(e as Error).message}`);
    return 1;
  }
}
