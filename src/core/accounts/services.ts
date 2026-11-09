/** The services an omp account can be a login to, as this machine holds
 * them: which service a home is on, and the key an api-key account keeps
 * there. The services themselves are `SERVICES` (providers/account.ts),
 * shared with the board. Kept free of the database so the bridge and the CLI
 * can load it.
 */

import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { service, servesModel, type ModelService } from "../providers/account";
import type { Account, ProviderId, ServiceId } from "../types";

export { SERVICES, service, serviceOfModel, type ModelService } from "../providers/account";

/** The service an account is a login to: null for a CLI's own login (claude,
 *  codex, devin, muse). An omp home holding a key is that key's service's;
 *  any other is an OpenCode Go sign-in, finished or not. */
export function serviceOf(account: Pick<Account, "provider" | "home">): ModelService | null {
  if (account.provider !== "omp") return null;
  return service(readApiKey(account.home)?.service) ?? service("opencode-go");
}

/** Whether a session of `harness` on `model` can run on this account. */
export function accountServes(account: Pick<Account, "provider" | "home">, harness: ProviderId, model: string | null | undefined): boolean {
  return servesModel(serviceOf(account)?.id ?? null, harness, model);
}

// ------------------------------------------------------------------ keys

export const API_KEY_FILE = "api-key.json";

const keys = new Map<string, { mtimeMs: number; value: { service: ServiceId; key: string } | null }>();

/** The key an api-key account holds, re-read only when its file changes. */
export function readApiKey(home: string): { service: ServiceId; key: string } | null {
  const path = join(home, API_KEY_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const hit = keys.get(path);
  if (hit?.mtimeMs === mtimeMs) return hit.value;
  let value: { service: ServiceId; key: string } | null = null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as { service?: unknown; key?: unknown };
    const svc = service(typeof v.service === "string" ? v.service : null);
    if (svc?.login === "api-key" && typeof v.key === "string" && v.key) value = { service: svc.id, key: v.key };
  } catch {
    // Unreadable is no key.
  }
  keys.set(path, { mtimeMs, value });
  return value;
}

/** Keep a key in an account's home (0600, in its 0700 home), whole. */
export function writeApiKey(home: string, svc: ServiceId, key: string): void {
  const path = join(home, API_KEY_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ service: svc, key }, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  keys.delete(path);
}

/** Ask the service whether it takes a key: "ok", "refused", or why it could not tell. */
export async function checkApiKey(svc: ModelService, key: string, fetchFn: typeof fetch = fetch): Promise<"ok" | "refused" | string> {
  if (!svc.keyCheck) return "ok";
  try {
    const res = await fetchFn(svc.keyCheck, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "refused";
    return `${svc.label} answered ${res.status}`;
  } catch (e) {
    return `${svc.label} could not be reached: ${(e as Error).message}`;
  }
}
