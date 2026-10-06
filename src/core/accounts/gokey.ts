/** OpenCode Go keys: one per omp account, which omp and opencode sessions
 * share (see `accountProvider`).
 *
 * The default account's key is opencode's own login, `opencode-go` in
 * `<XDG data>/opencode/auth.json` — the one omp's `models.yml` and opencode
 * itself fall back to. Every other account holds the key you pasted for it,
 * alone in `<home>/opencode-go.key` (0600, in a 0700 home). A key is an API
 * key, not a rotating token, so handing it to a session is safe; it is never
 * copied from one account to another.
 *
 * How a session gets its account's key: omp through `OPENCODE_GO_API_KEY`,
 * which `~/.omp/agent/models.yml` reads before auth.json; opencode through
 * the bridge (`/go/<account id or "default">/…`, src/bridge/devin.ts), which
 * puts the key on the request. opencode itself would not: signed into an
 * OpenCode workspace it bills the workspace instead of any Go key, and it
 * prefers its one stored login to a key in its config. Kept free of the
 * database so the bridge can load it.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountHomeFor, userHome } from "../paths";
import type { Account } from "../types";

export const GO_KEY_FILE = "opencode-go.key";

/** Where OpenCode Go is served; the bridge forwards `/go/<id>/<rest>` here. */
export const GO_UPSTREAM = "https://opencode.ai/zen/go";

/** opencode's login file. */
export function opencodeAuthPath(): string {
  return join(process.env.XDG_DATA_HOME || join(userHome(), ".local", "share"), "opencode", "auth.json");
}

const cache = new Map<string, { mtimeMs: number; key: string | null }>();

/** Read a key file, re-reading only when it changes. */
function readKey(path: string, parse: (text: string) => string | null): string | null {
  try {
    const { mtimeMs } = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.key;
    const key = parse(readFileSync(path, "utf8"));
    cache.set(path, { mtimeMs, key });
    return key;
  } catch {
    return null;
  }
}

/** The default account's key: opencode's own login. */
export function defaultGoKey(): string | null {
  return readKey(opencodeAuthPath(), (text) => {
    const entry = (JSON.parse(text) as Record<string, { key?: unknown }>)["opencode-go"];
    return typeof entry?.key === "string" && entry.key ? entry.key : null;
  });
}

/** A key as pasted: one token, no whitespace. */
export function cleanGoKey(text: string): string | null {
  const k = text.trim();
  return k && !/\s/.test(k) ? k : null;
}

export function goKeyOf(account: Pick<Account, "home" | "isDefault">): string | null {
  if (account.isDefault) return defaultGoKey();
  return readKey(join(account.home, GO_KEY_FILE), cleanGoKey);
}

/** For the bridge, which has an account id and no database: "default", or a
 *  non-default account's id (whose home is always `accounts/<id>`). */
export function goKeyForId(id: string): string | null {
  if (id === "default") return defaultGoKey();
  if (!/^[\w-]+$/.test(id)) return null;
  return readKey(join(accountHomeFor(id), GO_KEY_FILE), cleanGoKey);
}

/** A short fingerprint, to tell keys apart without showing one. */
export function goKeyPrint(key: string): string {
  return new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 12);
}
