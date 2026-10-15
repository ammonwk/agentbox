/** The hub's and the node's routes (docs/hub.md, API additions): members,
 *  nodes and their approval on a hub; joining, lending and leaving on a node;
 *  and the gate every request from the hub passes on a node.
 *
 *  None of it does anything on a machine that is neither: `GET /api/hub`
 *  says `none`, the rest answer 409, and `/api/node/*` is refused. */

import { hostname } from "node:os";
import {
  DEFAULT_LEND,
  audit,
  hubFileError,
  hubRole,
  newToken,
  nodeName,
  parseLend,
  readLink,
  readMembers,
  readNodes,
  removeLink,
  sameToken,
  writeLink,
  writeMembers,
  writeNodes,
  type Link,
  type NodeRecord,
} from "../core/hub";
import type { AccountView, HotState, HubStatus, NodeState, Person } from "../core/types";
import type { HubNodes } from "./hubnodes";
import { parsePersonHeader, personOf, tailnetSelfNow } from "./person";
import { HttpError, json, readBody, type Router } from "./router";
import { SEAM_FROM, seamOn, type Peer } from "./tailnet";

type Row = HotState["sessions"][number];

export type HubDeps = {
  port: number;
  /** The link ended or its lending changed: close the hub's sockets, so it
   *  opens new ones under the link as it is now. */
  linkChanged: () => void;
  nodes: HubNodes;
  /** The open sessions as this machine shows them, with attention. */
  openSessions: () => Row[];
  accountViews: () => AccountView[];
  /** A connection's tailnet source, when it came over the tailnet. */
  peerOf: (req: Request) => Peer | null;
  /** `tailscale whois` of another address; null off the tailnet. */
  whois: (ip: string) => Promise<Peer | null>;
};

/** How many join requests may wait for the owner at once. */
const MAX_PENDING = 20;

/** When the hub last asked this node anything, since this server started. */
let lastHubAt: number | null = null;

const requireOwner = (req: Request): Person => {
  const p = personOf(req);
  if (p.role !== "owner") throw new HttpError(403, "only the hub's owner may do that");
  return p;
};
const requireLocal = (req: Request): void => {
  if (personOf(req).via !== "local") throw new HttpError(403, "only from this machine: run it with the agentbox CLI here");
};
const requireHub = (): void => {
  if (hubRole() !== "hub") throw new HttpError(409, "this machine is not a hub (agentbox hub init)");
};
const requireNode = (): Link => {
  const link = readLink();
  if (!link) throw new HttpError(409, "this machine is not joined to a hub (agentbox hub join <hub>)");
  return link;
};

/** Whether a node lends the account a session runs on; only those are shared. */
export function lends(link: Link, accountId: string | null): boolean {
  return link.lend.accounts === "all" || (accountId !== null && link.lend.accounts.includes(accountId));
}

export function nodeState(deps: HubDeps, link: Link, withSessions: boolean): NodeState {
  const headroom = link.lend.shareHeadroom
    ? deps.accountViews().filter((a) => lends(link, a.id)).map((a) => ({
        id: a.id,
        provider: a.provider,
        label: a.label,
        eligible: a.placement?.eligible ?? false,
        weekly: a.placement?.weekly ?? null,
        short: a.placement?.short ?? null,
        weeklyResetsAt: a.placement?.weeklyResetsAt ?? null,
        shortResetsAt: a.placement?.shortResetsAt ?? null,
      }))
    : null;
  return {
    name: link.name,
    lend: link.lend,
    headroom,
    ...(withSessions ? { sessions: deps.openSessions().filter((s) => lends(link, s.accountId)) } : {}),
  };
}

export function hubStatus(req: Request, deps: HubDeps): HubStatus {
  const role = hubRole();
  const self = tailnetSelfNow();
  const status: HubStatus = { role, person: personOf(req), self: self ? { name: self.hostName, ip: self.ip } : null };
  const error = hubFileError();
  if (error) status.error = error;
  if (role === "hub") {
    status.members = readMembers() ?? [];
    status.nodes = deps.nodes.views();
  } else if (role === "node") {
    const { token: _token, ...link } = readLink()!;
    status.link = { ...link, lastHubAt };
  }
  return status;
}

/** `plaibook-box1`, `100.64.0.1:4479` or a URL, as the URL of the hub's API. */
export function hubUrl(address: string, defaultPort: number): string {
  const raw = address.trim();
  if (!raw) throw new HttpError(400, "name the hub: its tailnet name, IP or URL");
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new HttpError(400, `not a hub address: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, `not a hub address: ${raw}`);
  if (!u.port) u.port = String(defaultPort);
  return `${u.protocol}//${u.host}`;
}

/** A request this node makes to its hub. */
async function toHub(url: string, path: string, body: unknown, token?: string): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-agentbox": "1" };
  if (token) headers["x-agentbox-hub-token"] = token;
  const self = tailnetSelfNow();
  if (seamOn() && self) headers[SEAM_FROM] = self.ip;
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new HttpError(502, `could not reach the hub at ${url}: ${(e as Error).message}`);
  }
  const env = (await res.json().catch(() => null)) as { ok: boolean; data: unknown; error: string | null } | null;
  if (!env?.ok) throw new HttpError(502, `the hub at ${url} said: ${env?.error ?? `HTTP ${res.status}`}`);
  return env.data;
}

/** The hub's URL at its tailnet IPv4, which is the address it knows this
 *  node by: a MagicDNS name may resolve to IPv6. */
function atHubIp(link: Link): string {
  const u = new URL(link.hub.url);
  u.hostname = link.hub.ip;
  return `${u.protocol}//${u.host}`;
}

/** The hub's side of a node's request: its token, from its own address. */
function joinedNode(req: Request, deps: HubDeps): NodeRecord {
  const peer = deps.peerOf(req);
  const token = req.headers.get("x-agentbox-hub-token");
  const node = readNodes().find((n) => n.approvedAt !== null && peer?.ip === n.ip && sameToken(n.token, token));
  if (!node) throw new HttpError(403, "not a joined node");
  return node;
}

export function hubRoutes(router: Router, deps: HubDeps): Router {
  return (
    router
      .add("GET", "/api/hub", ({ req }) => json(hubStatus(req, deps)))

      // ---- on the hub
      .add("POST", "/api/hub/init", async ({ req }) => {
        requireLocal(req);
        if (hubRole() === "node") throw new HttpError(409, "this machine is joined to a hub; leave it first (agentbox hub leave)");
        if (hubRole() === "hub") throw new HttpError(409, "this machine is already a hub");
        const b = await readBody(req);
        const self = tailnetSelfNow();
        const login = typeof b.owner === "string" && b.owner.trim() ? b.owner.trim().toLowerCase() : self?.login;
        if (!login) throw new HttpError(400, "this machine belongs to no tailnet person (it is tagged, or not on a tailnet): name the owner's login with --owner");
        writeMembers([{ login, role: "owner", ...(b.owner ? {} : self?.displayName ? { name: self.displayName } : {}) }]);
        deps.nodes.sync();
        return json(hubStatus(req, deps));
      })
      .add("PUT", "/api/hub/members", async ({ req }) => {
        requireHub();
        requireOwner(req);
        const b = await readBody(req);
        try {
          writeMembers(b.members as never);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        return json(hubStatus(req, deps));
      })
      .add("POST", "/api/hub/nodes/:id/approve", ({ req, params }) => {
        requireHub();
        const who = requireOwner(req);
        const nodes = readNodes();
        const n = nodes.find((x) => x.id === params.id || x.name === params.id);
        if (!n) throw new HttpError(404, `no node ${params.id}`);
        if (n.approvedAt === null) {
          n.approvedAt = Date.now();
          n.approvedBy = who.login || who.name;
          writeNodes(nodes);
          deps.nodes.sync();
        }
        return json(hubStatus(req, deps));
      })
      .add("DELETE", "/api/hub/nodes/:id", async ({ req, params }) => {
        requireHub();
        requireOwner(req);
        const nodes = readNodes();
        const n = nodes.find((x) => x.id === params.id || x.name === params.id);
        if (!n) throw new HttpError(404, `no node ${params.id}`);
        writeNodes(nodes.filter((x) => x !== n));
        deps.nodes.sync();
        // Best effort: a node the hub has forgotten is never asked anything again.
        if (n.approvedAt !== null) {
          const headers = { ...deps.nodes.headers(n, personOf(req)), "x-agentbox": "1" };
          await fetch(`http://${n.ip}:${n.port}/api/node/leave`, { method: "POST", headers, signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
        }
        return json(hubStatus(req, deps));
      })
      .add("POST", "/api/hub/join", async ({ req }) => {
        requireHub();
        const peer = deps.peerOf(req);
        if (!peer) throw new HttpError(400, "a node joins over the tailnet");
        const b = await readBody(req);
        const token = typeof b.token === "string" && /^[a-f0-9]{64}$/.test(b.token) ? b.token : null;
        const port = Number.isInteger(b.port) && (b.port as number) > 0 && (b.port as number) < 65536 ? (b.port as number) : null;
        if (!token || !port) throw new HttpError(400, "a join carries the node's port and a 64-hex token");
        // The address the hub will call it on: the IPv4 its listener binds,
        // which it names, when that is the same device the request came
        // from (it may have come over IPv6).
        let ip = peer.ip;
        if (typeof b.ip === "string" && b.ip !== peer.ip) {
          const named = await deps.whois(b.ip);
          if (!named || named.device !== peer.device || named.userId !== peer.userId) throw new HttpError(400, `${b.ip} is not the device this request came from`);
          ip = b.ip;
        }
        const nodes = readNodes().filter((n) => n.ip !== ip);
        if (nodes.filter((n) => n.approvedAt === null).length >= MAX_PENDING) throw new HttpError(429, "too many nodes are waiting for the owner already");
        let name = nodeName(typeof b.name === "string" ? b.name : (peer.device ?? peer.ip));
        for (let i = 2; nodes.some((n) => n.name === name); i++) name = `${nodeName(typeof b.name === "string" ? b.name : (peer.device ?? "node")).slice(0, 36)}-${i}`;
        const rec: NodeRecord = {
          id: newToken().slice(0, 8),
          name,
          ip,
          port,
          token,
          device: peer.device,
          login: peer.login,
          tags: peer.tags,
          requestedAt: Date.now(),
          approvedAt: null,
          approvedBy: null,
        };
        writeNodes([...nodes, rec]);
        deps.nodes.sync();
        const self = tailnetSelfNow();
        return json({ id: rec.id, name: rec.name, hub: { name: self?.hostName ?? hostname(), ip: self?.ip ?? "" } });
      })
      .add("POST", "/api/hub/node/leave", ({ req }) => {
        requireHub();
        const n = joinedNode(req, deps);
        writeNodes(readNodes().filter((x) => x.id !== n.id));
        deps.nodes.sync();
        return json(null);
      })

      // ---- on a node
      .add("POST", "/api/hub/link", async ({ req }) => {
        requireLocal(req);
        const role = hubRole();
        if (role === "hub") throw new HttpError(409, "this machine is a hub; a hub does not join another");
        if (role === "node") throw new HttpError(409, `already joined to ${readLink()!.hub.name}; leave it first (agentbox hub leave)`);
        const self = tailnetSelfNow();
        if (!self) throw new HttpError(409, "this machine's tailnet listener is not up, so a hub could not reach it (is Tailscale running? AGENTBOX_TAILNET=0?)");
        const b = await readBody(req);
        const url = hubUrl(typeof b.hub === "string" ? b.hub : "", deps.port);
        const token = newToken();
        const asked = nodeName(typeof b.name === "string" && b.name.trim() ? b.name : self.hostName);
        const out = (await toHub(url, "/api/hub/join", { name: asked, port: deps.port, token, ip: self.ip })) as { id?: unknown; name?: unknown; hub?: { name?: unknown; ip?: unknown } };
        const ip = typeof out?.hub?.ip === "string" ? out.hub.ip : "";
        if (!ip) throw new HttpError(502, `the hub at ${url} did not say its tailnet address`);
        writeLink({
          hub: { url, ip, name: typeof out.hub?.name === "string" ? out.hub.name : ip },
          name: typeof out.name === "string" ? nodeName(out.name) : asked,
          token,
          joinedAt: Date.now(),
          lend: parseLend(b.lend, DEFAULT_LEND),
        });
        lastHubAt = null;
        return json(hubStatus(req, deps), 201);
      })
      .add("PATCH", "/api/hub/link", async ({ req }) => {
        requireLocal(req);
        const link = requireNode();
        const b = await readBody(req);
        try {
          writeLink({ ...link, lend: parseLend(b.lend, link.lend) });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        deps.linkChanged();
        return json(hubStatus(req, deps));
      })
      .add("DELETE", "/api/hub/link", async ({ req }) => {
        requireLocal(req);
        const link = requireNode();
        removeLink();
        lastHubAt = null;
        deps.linkChanged();
        // Best effort: without link.json this node refuses the hub whatever it sends.
        const told = await toHub(atHubIp(link), "/api/hub/node/leave", {}, link.token).then(() => true, () => false);
        return json({ ...hubStatus(req, deps), told });
      })
  );
}

// ------------------------------------------------------------ the node's gate

export type NodeVerdict =
  | { ok: false; status: number; reason: string }
  | { ok: true; link: Link; person: Person; rest: string };

/**
 * On a node: a request under `/api/node/` is the hub's only when it comes
 * from the hub's tailnet address in `link.json` with the link's token.
 * Anything else is refused, whatever else the listener let in.
 */
export function nodeGate(req: Request, url: URL, source: string | null): NodeVerdict {
  const link = readLink();
  if (!link) return { ok: false, status: 403, reason: "this machine is not joined to a hub" };
  if (!source || source !== link.hub.ip || !sameToken(link.token, req.headers.get("x-agentbox-hub-token"))) {
    console.error(`agentbox: hub: refused ${req.method} ${url.pathname} from ${source ?? "loopback"}: not the hub, or not its token`);
    return { ok: false, status: 403, reason: "not this node's hub" };
  }
  lastHubAt = Date.now();
  return { ok: true, link, person: parsePersonHeader(req.headers.get("x-agentbox-person")), rest: url.pathname.slice("/api/node".length) };
}

/** A hub request for `/api/sessions/:id/…`, made loopback-shaped so the
 *  node's own CSRF check and routes run on it as on any other. */
export function asLocalRequest(req: Request, url: URL, path: string, port: number): Request {
  const headers = new Headers();
  for (const h of ["content-type", "x-agentbox", "accept"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set("host", `127.0.0.1:${port}`);
  return new Request(`http://127.0.0.1:${port}${path}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    // A streamed body needs this in Bun's Request.
    ...(req.method === "GET" || req.method === "HEAD" ? {} : { duplex: "half" }),
  } as RequestInit);
}

export function auditHubAction(person: Person, method: string, path: string): void {
  if (method === "GET" || method === "HEAD") return;
  audit({ person: { login: person.login, name: person.name }, method, path });
}
