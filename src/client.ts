/** The HTTP client the CLI and the fleet MCP share.
 *
 * Both are thin clients of the running server: every response is the
 * `{ok, data, error}` envelope, and every request carries `x-agentbox: 1`,
 * without which the server refuses a mutation (docs/v2.md, Security).
 */

import { DEFAULT_PORT } from "./core/paths";

/** Where the server listens: loopback, on `$AGENTBOX_PORT` or the default. */
export function serverBase(): string {
  return `http://127.0.0.1:${Number(process.env.AGENTBOX_PORT ?? DEFAULT_PORT)}`;
}

/** A refusal or failure from the server. `data` is whatever came with it — a
 *  refused spawn sends the placement, so the caller can show why. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

export type Api = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export function apiClient(base: string): Api {
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { "content-type": "application/json", "x-agentbox": "1" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(`agentbox server is not running at ${base} — start it with \`agentbox serve\` (${(e as Error).message})`);
    }
    const env = (await res.json().catch(() => null)) as { ok: boolean; data: T; error: string | null } | null;
    if (!env) throw new ApiError(`agentbox answered ${path} with HTTP ${res.status} and no JSON`);
    if (!env.ok) throw new ApiError(env.error ?? `HTTP ${res.status}`, env.data);
    return env.data;
  };
}
