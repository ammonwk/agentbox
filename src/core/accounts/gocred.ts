/** OpenCode Go credentials: one per omp account, which omp and opencode
 * sessions share (see `accountProvider`).
 *
 * Every account is an OpenCode Console sign-in — the device flow
 * `opencode auth login opencode` runs, done by agentbox itself
 * (`agentbox go-login`, godevice.ts) so the login is the account's own: its
 * tokens live alone in `<home>/opencode-console.json` (0600, in a 0700 home)
 * and are never opencode's, whose refresh would rotate ours away. There is no
 * default account: the API key the CLIs hold without agentbox
 * (`<XDG data>/opencode/auth.json`) is not one, and no session agentbox
 * starts is given it.
 *
 * Neither CLI can be handed a Console sign-in (opencode prefers its stored
 * login, and signed into a workspace it bills that workspace), so a session
 * reaches Go through the bridge
 * (`/go/<account>/…`, src/bridge/devin.ts), which puts the account's
 * credential on each request and refreshes a Console token when it is due.
 * The bridge is the only thing that refreshes: a refresh replaces the refresh
 * token, so two refreshers would log each other out. Kept free of the
 * database so the bridge can load it.
 */

import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountHomeFor, accountsRoot } from "../paths";
import { orgAccountsRoot } from "../org/config";
import type { Account } from "../types";

export const GO_LOGIN_FILE = "opencode-console.json";

/** What a home's file says in place of the org's refresh token: the org's
 *  store refreshes that sign-in, and no machine may (a refresh rotates the
 *  token for every holder). */
export const POOLED = "pooled";

/** Go by an API key the caller sent itself (omp in your own terminal), and by
 *  an account's Console sign-in (OpenAI- and Anthropic-shaped). */
export const GO_KEY_UPSTREAM = "https://opencode.ai/zen/go/v1";
export const GO_CONSOLE_UPSTREAM = { openai: "https://opencode.ai/inference/go/openai/v1", anthropic: "https://opencode.ai/inference/go/anthropic/v1" } as const;

/** Go's usage report for a Console sign-in: beside the two shapes, not under
 *  either. */
export const GO_CONSOLE_USAGE = "https://opencode.ai/inference/go/v1/usage";

/** What omp sends as its key to name the account a request is for; anything
 *  else it sends is a real key and goes through as it is. */
export const GO_ACCOUNT_BEARER = "agentbox-account:";

/** A Console sign-in, as opencode keeps its own. */
export interface GoLogin {
  server: string;
  access: string;
  refresh: string;
  /** Epoch ms the access token stops working. */
  expires: number;
  accountID: string;
  email: string;
  orgID: string | null;
  orgName: string | null;
}

const cache = new Map<string, { mtimeMs: number; value: unknown }>();

/** Read and parse a file, re-reading only when it changes. */
function readCached<T>(path: string, parse: (text: string) => T | null): T | null {
  try {
    const { mtimeMs } = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value as T | null;
    const value = parse(readFileSync(path, "utf8"));
    cache.set(path, { mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

export function parseGoLogin(text: string): GoLogin | null {
  const v = JSON.parse(text) as Partial<GoLogin> | null;
  if (!v || typeof v.access !== "string" || typeof v.refresh !== "string" || typeof v.expires !== "number") return null;
  return {
    server: typeof v.server === "string" ? v.server : "https://opencode.ai/console",
    access: v.access,
    refresh: v.refresh,
    expires: v.expires,
    accountID: typeof v.accountID === "string" ? v.accountID : "",
    email: typeof v.email === "string" ? v.email : "",
    orgID: typeof v.orgID === "string" ? v.orgID : null,
    orgName: typeof v.orgName === "string" ? v.orgName : null,
  };
}

/** The Console sign-in kept in an account's home, or null. */
export function readGoLogin(home: string): GoLogin | null {
  return readCached(join(home, GO_LOGIN_FILE), parseGoLogin);
}

/** Replace a home's sign-in whole: a reader sees the old one or the new. */
export function writeGoLogin(home: string, login: GoLogin): void {
  const path = join(home, GO_LOGIN_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(login, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  cache.delete(path);
}

/** Every account home holding a Console sign-in, found on disk: yours, and
 *  the pool's mirrors of other members' logins (under org/accounts). */
export function goLoginHomes(): string[] {
  return [accountsRoot(), orgAccountsRoot()].flatMap((root) => {
    try {
      return readdirSync(root)
        .map((id) => join(root, id))
        .filter((home) => existsSync(join(home, GO_LOGIN_FILE)));
    } catch {
      return [];
    }
  });
}

/** Whether an account has what it needs to reach Go. */
export function hasGoCredential(account: Pick<Account, "home">): boolean {
  return readGoLogin(account.home) !== null;
}

/** The home behind the account id the bridge is asked for, or null when that
 *  is no id: `accounts/<id>`, else the pool's mirror `org/accounts/<id>` of
 *  someone else's login. A login you shared keeps your home and its id. */
export function goHomeForAccount(id: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const personal = accountHomeFor(id);
  const pooled = join(orgAccountsRoot(), id);
  return existsSync(pooled) && !existsSync(personal) ? pooled : personal;
}
