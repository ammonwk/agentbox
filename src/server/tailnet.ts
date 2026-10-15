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
 * On a hub or a node (docs/hub.md) the door admits more, and only as
 * `admit` below says: a member's device on a hub, the hub on a node's
 * `/api/node/*`, a joined node on the hub's `/api/hub/node/*`. With neither,
 * it is the rule above and nothing else.
 *
 * Off with `AGENTBOX_TAILNET=0`. A test then stands a file in for
 * `tailscale` (`AGENTBOX_TAILNET_SEAM`, below).
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "../core/paths";
import type { HubMember, Person } from "../core/types";
import type { Link, NodeRecord } from "../core/hub";

export type Tailnet = {
  /** This machine's Tailscale IPv4: the address the second listener binds. */
  ip: string;
  /** Names a browser may use for it: the IP, the MagicDNS name, its short form. */
  names: string[];
  /** The Tailscale user this machine belongs to; peers must be the same one. */
  userId: number;
  /** The MagicDNS name, `host.tailnet.ts.net`, when MagicDNS is on. */
  dnsName: string | null;
  /** The login of the user this machine belongs to, and their name; null
   *  for a tagged machine, which belongs to no person. */
  login: string | null;
  displayName: string | null;
  /** Its short name on the tailnet, for a hub's or a node's name. */
  hostName: string;
};

/** A connection's source, as `tailscale whois` tells it. */
export type Peer = {
  ip: string;
  userId: number | null;
  login: string | null;
  displayName: string | null;
  /** The device's name on the tailnet. */
  device: string | null;
  tags: string[];
};

/**
 * The stand-in for `tailscale`, for tests that run two servers on one
 * computer: `AGENTBOX_TAILNET_SEAM` names a JSON file
 * `{self: {ip, userId, login, displayName, hostName, tags?}, peers: {<ip>: {userId, login, displayName, device, tags}}}`,
 * read on every lookup. The listener binds `self.ip` (another loopback
 * address), and a connection's source is the `x-agentbox-seam-from` header,
 * since one computer's connections all come from 127.0.0.1. Only with
 * `AGENTBOX_TAILNET=0`, so a server on a real tailnet never reads the header.
 */
type Seam = {
  self: { ip: string; userId: number; login: string | null; displayName?: string | null; hostName: string; tags?: string[] };
  peers: Record<string, { userId?: number | null; login?: string | null; displayName?: string | null; device?: string | null; tags?: string[] }>;
};

function seam(): Seam | null {
  const path = process.env.AGENTBOX_TAILNET_SEAM;
  if (process.env.AGENTBOX_TAILNET !== "0" || !path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Seam;
  } catch (e) {
    console.error(`agentbox: tailnet seam ${path}: ${(e as Error).message}`);
    return null;
  }
}

export const SEAM_FROM = "x-agentbox-seam-from";

/** Whether connections are judged by the seam rather than by `tailscale`. */
export const seamOn = (): boolean => seam() !== null;

/** A connection's source address: the socket's, or under the seam its header's. */
export function sourceOf(req: Request, socketAddress: string | undefined): string | undefined {
  if (seamOn()) return req.headers.get(SEAM_FROM) ?? socketAddress;
  return socketAddress;
}

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
  if (process.env.AGENTBOX_TAILNET === "0") {
    const s = seam()?.self;
    if (!s) return null;
    return { ip: s.ip, names: [s.ip, s.hostName.toLowerCase()], userId: s.userId, dnsName: null, login: s.tags?.length ? null : s.login, displayName: s.displayName ?? null, hostName: s.hostName.toLowerCase() };
  }
  if (!Bun.which("tailscale")) return null;
  const st = (await tailscaleJson(["status", "--json"])) as {
    BackendState?: string;
    Self?: { TailscaleIPs?: string[]; DNSName?: string; HostName?: string; UserID?: number; Tags?: string[] };
    User?: Record<string, { LoginName?: string; DisplayName?: string }>;
  } | null;
  const self = st?.Self;
  if (st?.BackendState !== "Running" || !self?.UserID) return null;
  const ip = self.TailscaleIPs?.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (!ip) return null;
  const dns = self.DNSName?.replace(/\.$/, "").toLowerCase();
  const names = [ip, dns, dns?.split(".")[0], self.HostName?.toLowerCase()].filter((n): n is string => !!n);
  const user = self.Tags?.length ? undefined : st.User?.[String(self.UserID)];
  return {
    ip,
    names: [...new Set(names)],
    userId: self.UserID,
    dnsName: dns ?? null,
    login: user?.LoginName?.toLowerCase() ?? null,
    displayName: user?.DisplayName ?? null,
    hostName: dns?.split(".")[0] ?? self.HostName?.toLowerCase() ?? ip,
  };
}

/** The MagicDNS name's certificate, fetched or renewed by `tailscale cert`
 *  (which only goes to Let's Encrypt when the one it has is near expiry).
 *  Null while the tailnet has HTTPS turned off. */
export async function tailnetCert(self: Tailnet): Promise<{ cert: string; key: string } | null> {
  if (!self.dnsName || process.env.AGENTBOX_TAILNET === "0") return null;
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

/** Who a source address is, by `tailscale whois`. Cached: five minutes
 *  for a device, ten seconds for an address it could not vouch for. */
export class PeerCheck {
  private cache = new Map<string, { peer: Peer | null; until: number }>();
  constructor(private self: Tailnet) {}

  async whois(ip: string): Promise<Peer | null> {
    const fake = seam();
    if (fake) {
      const p = fake.peers[ip];
      return p ? { ip, userId: p.userId ?? null, login: p.login?.toLowerCase() ?? null, displayName: p.displayName ?? null, device: p.device ?? null, tags: p.tags ?? [] } : null;
    }
    const hit = this.cache.get(ip);
    if (hit && hit.until > Date.now()) return hit.peer;
    const who = (await tailscaleJson(["whois", "--json", ip])) as {
      Node?: { User?: number; Tags?: string[]; Name?: string; ComputedName?: string };
      UserProfile?: { LoginName?: string; DisplayName?: string };
    } | null;
    const peer: Peer | null = who?.Node
      ? {
          ip,
          userId: who.Node.User ?? null,
          // A tagged device belongs to its tags, whoever tagged it.
          login: who.Node.Tags?.length ? null : (who.UserProfile?.LoginName?.toLowerCase() ?? null),
          displayName: who.Node.Tags?.length ? null : (who.UserProfile?.DisplayName ?? null),
          device: who.Node.ComputedName ?? who.Node.Name?.split(".")[0] ?? null,
          tags: who.Node.Tags ?? [],
        }
      : null;
    this.cache.set(ip, { peer, until: Date.now() + (peer ? WHOIS_OK_MS : WHOIS_FAIL_MS) });
    return peer;
  }

  /** v2's rule: one of the owner's own untagged devices. */
  isOwnDevice(peer: Peer | null): boolean {
    return !!peer && peer.userId === this.self.userId && !peer.tags.length;
  }
}

/** What a tailnet connection may do (docs/hub.md, Trust model), the first that applies:
 *  - `person`: the whole app, as that person;
 *  - `hub`: on a node, the hub's own address: `/api/node/*` only, where its token is checked;
 *  - `node`: on a hub, a joined node: `/api/hub/node/*` only, where its token is checked;
 *  - `joiner`: on a hub, another tagged device: `POST /api/hub/join` only;
 *  - `refused`. */
export type Admission =
  | { kind: "person"; person: Person }
  | { kind: "hub" }
  | { kind: "node"; node: NodeRecord }
  | { kind: "joiner"; peer: Peer }
  | { kind: "refused"; reason: string };

export function admit(
  peer: Peer | null,
  own: boolean,
  hub: { members: HubMember[] | null; nodes: NodeRecord[]; link: Link | null },
): Admission {
  if (!peer) return { kind: "refused", reason: "only your own Tailscale devices may connect" };
  if (own) {
    const login = peer.login ?? "";
    return { kind: "person", person: { login, name: peer.displayName ?? login, role: "owner", via: "tailnet" } };
  }
  if (hub.members) {
    const member = !peer.tags.length && peer.login ? hub.members.find((m) => m.login === peer.login) : undefined;
    if (member) return { kind: "person", person: { login: member.login, name: member.name ?? peer.displayName ?? member.login, role: member.role, via: "tailnet" } };
    const node = hub.nodes.find((n) => n.approvedAt !== null && n.ip === peer.ip);
    if (node) return { kind: "node", node };
    if (peer.tags.length) return { kind: "joiner", peer };
    return { kind: "refused", reason: "only the hub's members may connect" };
  }
  if (hub.link && peer.ip === hub.link.hub.ip) return { kind: "hub" };
  return { kind: "refused", reason: "only your own Tailscale devices may connect" };
}

/** The paths an admission reaches; anything else is refused before routing. */
export function admitted(a: Admission, method: string, path: string): boolean {
  switch (a.kind) {
    case "person":
      return true;
    case "hub":
      return path.startsWith("/api/node/");
    case "node":
      return path.startsWith("/api/hub/node/");
    case "joiner":
      return method === "POST" && path === "/api/hub/join";
    case "refused":
      return false;
  }
}
