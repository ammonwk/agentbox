/**
 * `/api/github/…`: the GitHub App broker (src/core/github/, docs/superagents.md
 * "GitHub actions").
 *
 * Three kinds of caller:
 *   - a superagent's program: `x-agentbox-superagent` and
 *     `x-agentbox-superagent-token`, its own token;
 *   - one of its sessions: the session capability, from a session whose
 *     parent chain reaches the superagent's main or an earlier main;
 *   - a person: loopback (the CSRF guard) with neither. Only a person pins a
 *     policy, approves or declines an action. A request that carries either
 *     kind of header is not a person's, valid or not.
 */
import type { GitHubActions, ActionCaller, GitHubActionView } from "../core/github/actions";
import { effectivePin, pin, pinOf, proposedPolicy, unpin } from "../core/github/policy";
import { authenticatedSession } from "../core/session-authority";
import type { Superagents } from "../core/superagents";
import { HttpError, json, readBody, type Router } from "./router";
import { superagentCaller } from "./superagents";

/** Headers that make a request a session's or a program's, valid or not. */
const AGENT_HEADERS = ["x-agentbox-superagent", "x-agentbox-superagent-token", "x-agentbox-session", "x-agentbox-session-token"];

/** A person at this machine: neither a program's headers nor a session's. */
export function requirePerson(req: Request): void {
  if (AGENT_HEADERS.some((h) => req.headers.has(h))) throw new HttpError(403, "only a person can do this, from the app or their own terminal: not a session or a superagent's program");
}

/** An answer on a GitHub action's card approves it: only a person gives one. */
export function requirePersonForCard(req: Request, key: string | null): void {
  if (key?.startsWith("github-action:")) requirePerson(req);
}

export function githubRoutes(router: Router, actions: GitHubActions, superagents: Superagents): Router {
  const registered = (name: string) => (superagents.has(name) ? superagents.get(name) : null);

  /** A superagent's program, or a session it started itself; null for a request with neither. */
  const actionCaller = (req: Request): ActionCaller | null => {
    const name = superagentCaller(req, superagents);
    if (name) return { superagent: name, session: null };
    const session = authenticatedSession(req);
    if (!session) return null;
    const owner = superagents.ownerOf(session, { authority: true });
    return owner ? { superagent: owner, session } : null;
  };

  const requireSuperagent = (req: Request): ActionCaller => {
    const c = actionCaller(req);
    if (!c) throw new HttpError(403, "only a superagent's program, or a session of that superagent, can request GitHub actions");
    return c;
  };

  /** A superagent sees only its own actions; anyone else here sees all. */
  const visibleTo = (req: Request, v: GitHubActionView): GitHubActionView => {
    const c = actionCaller(req);
    if (c && c.superagent !== v.superagent) throw new HttpError(404, `no GitHub action ${v.request}`);
    return v;
  };

  const dirOf = (name: string): string => {
    const s = registered(name);
    if (!s) throw new HttpError(404, `no superagent ${name}`);
    return s.dir;
  };

  const policyView = (name: string) => {
    const dir = dirOf(name);
    let proposed: ReturnType<typeof proposedPolicy> = null;
    let proposalError: string | null = null;
    try {
      proposed = proposedPolicy(dir);
    } catch (e) {
      proposalError = (e as Error).message;
    }
    const pinned = pinOf(name);
    let current = false;
    try {
      current = !!effectivePin(name, dir);
    } catch {
      current = false;
    }
    return { superagent: name, proposed, proposalError, pinned, current };
  };

  return router
    .add("POST", "/api/github/actions", async ({ req }) => {
      const caller = requireSuperagent(req);
      const v = await actions.request(caller, await readBody(req));
      return json({ request: v.request, state: v.state, result: v.result, ...(v.card ? { card: v.card } : {}) });
    })
    .add("GET", "/api/github/actions", ({ req }) => {
      const c = actionCaller(req);
      return json(actions.list(c?.superagent));
    })
    .add("GET", "/api/github/actions/:request", async ({ req, params }) => {
      visibleTo(req, actions.get(params.request!));
      return json(await actions.reconcile(params.request!));
    })
    .add("POST", "/api/github/actions/:request/approve", async ({ req, params }) => {
      requirePerson(req);
      return json(await actions.approve(params.request!, "a person (API)"));
    })
    .add("POST", "/api/github/actions/:request/decline", ({ req, params }) => {
      requirePerson(req);
      return json(actions.decline(params.request!, "a person (API)"));
    })
    .add("POST", "/api/github/read", async ({ req }) => json(await actions.read(requireSuperagent(req), await readBody(req))))
    .add("GET", "/api/github/policies/:superagent", ({ params }) => json(policyView(params.superagent!)))
    .add("POST", "/api/github/policies/:superagent", async ({ req, params }) => {
      requirePerson(req);
      const b = await readBody(req);
      if (typeof b.digest !== "string") throw new HttpError(400, "give the digest of the policy you read (GET this path first)");
      if (b.appKeyPath !== undefined && typeof b.appKeyPath !== "string") throw new HttpError(400, "appKeyPath is a path");
      const name = params.superagent!;
      pin(name, dirOf(name), b.digest, (b.appKeyPath as string | undefined) ?? null);
      return json(policyView(name));
    })
    .add("DELETE", "/api/github/policies/:superagent", ({ req, params }) => {
      requirePerson(req);
      const name = params.superagent!;
      unpin(name);
      // A superagent that was removed can still be unpinned.
      return json(registered(name) ? policyView(name) : { superagent: name, proposed: null, proposalError: null, pinned: null, current: false });
    });
}
