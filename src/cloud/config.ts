/** The cloud's address and key, checked, and its error: what a caller needs
 *  before, or without, a Supabase client. Apart from client.ts so that
 *  reading the configuration does not load supabase-js. */

export interface CloudConfig {
  /** The project's URL, `https://<ref>.supabase.co` or a local stack's. */
  url: string;
  /** The publishable key (`sb_publishable_…`), or a legacy anon key. */
  publishableKey: string;
}

/** A refusal or failure from the service. `status` follows HTTP: the
 *  database raises `PT403` and the like, which PostgREST answers with that
 *  status; 0 means the service could not be reached. */
export class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }
  /** Worth trying again later: not reached, or the service's own trouble. */
  get transient(): boolean {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** Whether `key` would give its holder the service role. Checked before any
 *  client is made: such a key must never reach a browser or a machine. */
export function isSecretKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
}

export function checkConfig(cfg: CloudConfig): CloudConfig {
  let u: URL;
  try {
    u = new URL(cfg.url);
  } catch {
    throw new CloudError(`the cloud URL "${cfg.url}" is not a URL`, 400);
  }
  if (u.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new CloudError("the cloud URL must be https (plain http only for a local stack)", 400);
  }
  if (!cfg.publishableKey) throw new CloudError("the cloud needs its publishable key", 400);
  if (isSecretKey(cfg.publishableKey)) {
    throw new CloudError("that is a secret (service-role) key: agentbox takes only the publishable key", 400);
  }
  return { url: cfg.url.replace(/\/+$/, ""), publishableKey: cfg.publishableKey };
}
