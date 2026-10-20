/** The tailnet door: the same app on this machine's Tailscale address, so a
 *  phone on your tailnet can drive it.
 *
 * Loopback is the trust boundary everywhere else (`csrf.ts`), and this widens
 * it by exactly one kind of peer: a device logged in to Tailscale as the same
 * user as this machine. Every connection's source address is looked up with
 * `tailscale whois`; a tagged node (a server, a shared box) or another user's
 * device is refused before routing, and so is anything the lookup cannot
 * vouch for. WireGuard already encrypts and authenticates the path, so plain
 * HTTP on it is not the weak point.
 *
 * Once HTTPS is enabled for the tailnet (admin console → DNS), `tailscale
 * cert` gives the MagicDNS name a real certificate and the listener serves
 * HTTPS instead — which a phone needs before it lets a page use the mic.
 *
 * Off with `AGENTBOX_TAILNET=0`.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../core/paths";

export type Tailnet = {
  /** This machine's Tailscale IPv4: the address the second listener binds. */
  ip: string;
  /** Names a browser may use for it: the IP, the MagicDNS name, its short form. */
  names: string[];
  /** The Tailscale user this machine belongs to; peers must be the same one. */
  userId: number;
  /** The MagicDNS name, `host.tailnet.ts.net`, when MagicDNS is on. */
  dnsName: string | null;
};

const WHOIS_OK_MS = 5 * 60_000;
const WHOIS_FAIL_MS = 10_000;

async function tailscaleJson(args: string[]): Promise<unknown> {
  const proc = Bun.spawn(["tailscale", ...args], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), 4000);
  try {
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return JSON.parse(out);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** This machine on its tailnet, or null when Tailscale is absent, stopped or logged out. */
export async function tailnetSelf(): Promise<Tailnet | null> {
  if (process.env.AGENTBOX_TAILNET === "0" || !Bun.which("tailscale")) return null;
  const st = (await tailscaleJson(["status", "--json"])) as {
    BackendState?: string;
    Self?: { TailscaleIPs?: string[]; DNSName?: string; HostName?: string; UserID?: number; Tags?: string[] };
  } | null;
  const self = st?.Self;
  if (st?.BackendState !== "Running" || !self?.UserID) return null;
  const ip = self.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ip) return null;
  const dns = self.DNSName?.replace(/\.$/, "").toLowerCase();
  const names = [ip, dns, dns?.split(".")[0], self.HostName?.toLowerCase()].filter((n): n is string => !!n);
  return { ip, names: [...new Set(names)], userId: self.UserID, dnsName: dns ?? null };
}

/** The MagicDNS name's certificate, fetched or renewed by `tailscale cert`
 *  (which only goes to Let's Encrypt when the one it has is near expiry).
 *  Null while the tailnet has HTTPS turned off. */
export async function tailnetCert(self: Tailnet): Promise<{ cert: string; key: string } | null> {
  if (!self.dnsName) return null;
  const dir = join(agentboxHome(), "tls");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cert = join(dir, `${self.dnsName}.crt`);
  const key = join(dir, `${self.dnsName}.key`);
  const proc = Bun.spawn(["tailscale", "cert", "--cert-file", cert, "--key-file", key, self.dnsName], { stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), 60_000);
  try {
    if ((await proc.exited) !== 0) return null;
    return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a source address is one of the owner's own untagged devices. Cached. */
export class PeerCheck {
  private cache = new Map<string, { ok: boolean; until: number }>();
  constructor(private self: Tailnet) {}

  async isOwner(ip: string): Promise<boolean> {
    const hit = this.cache.get(ip);
    if (hit && hit.until > Date.now()) return hit.ok;
    const who = (await tailscaleJson(["whois", "--json", ip])) as { Node?: { User?: number; Tags?: string[] } } | null;
    const ok = !!who?.Node && who.Node.User === this.self.userId && !who.Node.Tags?.length;
    this.cache.set(ip, { ok, until: Date.now() + (ok ? WHOIS_OK_MS : WHOIS_FAIL_MS) });
    return ok;
  }
}
