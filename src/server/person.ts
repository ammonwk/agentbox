/** The person behind each request (docs/hub.md, Trust model), kept beside
 *  the request for the routes that care: `personOf(req)`.
 *
 *  Loopback is the machine's owner; a tailnet device is its `whois` login;
 *  on a node, a request the hub passed through is the person the hub names. */

import { userInfo } from "node:os";
import { readMembers } from "../core/hub";
import { readUserIdentity } from "../core/user";
import type { Person } from "../core/types";
import type { Tailnet } from "./tailnet";

const persons = new WeakMap<Request, Person>();

/** This machine on the tailnet, once the listener has found it. */
let self: Tailnet | null = null;
export function setTailnetSelf(t: Tailnet | null): void {
  self = t;
}
export const tailnetSelfNow = (): Tailnet | null => self;

/** The machine's owner: the hub's owner on a hub, else this machine's own
 *  tailnet login, else who `user.env` says agentbox works for. */
export function ownerPerson(): Person {
  const owner = readMembers()?.find((m) => m.role === "owner");
  if (owner) return { login: owner.login, name: owner.name ?? self?.displayName ?? owner.login, role: "owner", via: "local" };
  const id = readUserIdentity();
  const login = self?.login ?? (id.email || id.github || userInfo().username);
  return { login, name: self?.displayName ?? (id.name || login), role: "owner", via: "local" };
}

export function setPerson(req: Request, p: Person): void {
  persons.set(req, p);
}

/** Who made the request. A request no listener stamped (none should reach a
 *  route that way) is nobody's, never the owner's. */
export function personOf(req: Request): Person {
  return persons.get(req) ?? { login: "", name: "unknown", role: null, via: "tailnet" };
}

/** The person a hub names in `x-agentbox-person`: URI-encoded JSON `{login, name}`. */
export function personHeader(p: Person): string {
  return encodeURIComponent(JSON.stringify({ login: p.login, name: p.name }));
}

export function parsePersonHeader(v: string | null): Person {
  try {
    const o = JSON.parse(decodeURIComponent(v ?? "")) as { login?: unknown; name?: unknown };
    const login = typeof o.login === "string" ? o.login.slice(0, 200) : "";
    const name = typeof o.name === "string" ? o.name.slice(0, 200) : login;
    return { login, name: name || login || "someone on the hub", role: null, via: "hub" };
  } catch {
    return { login: "", name: "someone on the hub", role: null, via: "hub" };
  }
}
