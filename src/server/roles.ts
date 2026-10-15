/** What only a hub's owner may do (docs/hub.md, Roles on a hub). A member
 *  starts, reads and types into sessions; changing what the hub is (its
 *  accounts, settings and superagents) and anything that runs a command as
 *  the hub's user outside a session are the owner's. Reads stay open. On a
 *  machine that is not a hub every request is its owner's, so none of this
 *  refuses anything there. */

import { hubRole } from "../core/hub";
import { personOf } from "./person";
import { HttpError } from "./router";

const OWNER_ONLY: { methods: "write" | string[]; path: RegExp; what: string }[] = [
  { methods: ["POST"], path: /^\/api\/superagents$/, what: "registering a superagent" },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/superagents\/[^/]+$/, what: "changing or removing a superagent" },
  { methods: "write", path: /^\/api\/(accounts|logins)(\/|$)/, what: "changing the hub's accounts" },
  { methods: "write", path: /^\/api\/settings$/, what: "changing the hub's settings" },
  // Each of these runs a command as the hub's user with no session around it.
  { methods: "write", path: /^\/api\/mcp(\/|$)/, what: "changing the global MCP servers, which every agent runs" },
  { methods: "write", path: /^\/api\/repos(\/|$)/, what: "changing the registered repos and the setup a new worktree runs" },
  { methods: "write", path: /^\/api\/skill\//, what: "changing the skills every agent reads" },
  { methods: "write", path: /^\/api\/onboarding\//, what: "installing the hub's service" },
  { methods: ["POST"], path: /^\/api\/worktrees\/reclaim$/, what: "deleting worktrees" },
  { methods: "write", path: /^\/api\/cloud(\/|$)/, what: "acting as the hub on the agentbox cloud" },
  { methods: ["GET"], path: /^\/ws\/voice$/, what: "hands-free mode, which runs commands as the hub's user" },
];

/** What a request would do that is the owner's alone, or null. */
export function ownerOnly(method: string, path: string): string | null {
  for (const r of OWNER_ONLY) {
    const hit = r.methods === "write" ? method !== "GET" && method !== "HEAD" : r.methods.includes(method);
    if (hit && r.path.test(path)) return r.what;
  }
  return null;
}

/** Refuse a member on a hub, for a part of a request only the owner may ask
 *  for (a wait's `until` command, a schedule's note command). */
export function requireOwnerOnHub(req: Request, what: string): void {
  if (hubRole() === "hub" && personOf(req).role !== "owner") throw new HttpError(403, `only the hub's owner may do that: ${what}`);
}

/** The gate before routing: null to go on, or why not. */
export function roleRefusal(req: Request, path: string): string | null {
  if (hubRole() !== "hub" || personOf(req).role === "owner") return null;
  const what = ownerOnly(req.method, path);
  return what ? `only the hub's owner may do that: ${what}` : null;
}
