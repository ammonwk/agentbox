/** Shared superagents on this machine (docs/cloud.md, "Shared superagents";
 *  src/core/superagent/team.ts).
 *
 *  Sharing is the host owner's act, and the proof is theirs: the browser's
 *  Supabase session token (`Authorization: Bearer <jwt>`), which the cloud's
 *  human-only RPCs verify. `superagent_share` and `superagent_unshare` refuse
 *  anyone who does not own this machine's installation. A session's
 *  capability or a program's token can never share, and this server never
 *  keeps the token: it acts with it for the one request. */

import { CloudError } from "../cloud/config";
import { supabaseFor } from "../cloud/client";
import { HumanSuperagents, type SuperagentInstance } from "../cloud/superagents";
import type { CloudBridge } from "../core/cloud/bridge";
import { cloudConfig } from "../core/cloud/config";
import { authenticatedSession } from "../core/session-authority";
import type { Superagents } from "../core/superagents";
import { dropShare, saveShare, shareOf } from "../core/superagent/shares";
import { sourceOf, type TeamHost } from "../core/superagent/team";
import type { WorkClaims } from "../core/workclaims";
import { HttpError, json, readBody, type Router } from "./router";
import { superagentCaller } from "./superagents";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in person's client, from the request's bearer token. */
function personOf(req: Request): HumanSuperagents {
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,16000})$/.exec(req.headers.get("authorization") ?? "");
  if (!m) throw new HttpError(401, "sign in on the Team page: this needs your cloud session (Authorization: Bearer <token>)");
  const { config, error } = cloudConfig();
  if (!config) throw new HttpError(409, error ?? "agentbox cloud is not set up on this machine (docs/cloud.md)");
  const token = m[1]!;
  return new HumanSuperagents(supabaseFor(config, { accessToken: async () => token }));
}

/** A person, not a session and not a program. */
function notAnAgent(req: Request, superagents: Superagents, what: string): void {
  if (superagentCaller(req, superagents)) throw new HttpError(403, `${what} is its host owner's to do, not a program's`);
  const session = authenticatedSession(req);
  if (session) throw new HttpError(403, `${what} is its host owner's to do, not a session's (this came from session ${session})`);
}

export function teamRoutes(router: Router, deps: { superagents: Superagents; cloud: CloudBridge; team: TeamHost; claims: WorkClaims }): Router {
  const { superagents, cloud, team, claims } = deps;
  const installation = () => {
    const i = cloud.status().installation;
    if (!i) throw new HttpError(409, "this machine is not registered with the cloud: register it on the Team page first");
    return i;
  };
  return router
    .add("POST", "/api/superagents/:name/share", async ({ req, params }) => {
      notAnAgent(req, superagents, "sharing a superagent");
      const name = params.name!;
      const info = superagents.get(name);
      const b = await readBody(req);
      const inst = installation();
      const workspace = typeof b.workspace === "string" ? b.workspace : inst.workspaceId;
      if (workspace !== inst.workspaceId) throw new HttpError(400, "this machine is registered in another workspace: a superagent is shared in its host's workspace");
      const visibility = b.visibility ?? "private";
      if (visibility !== "private" && visibility !== "workspace") throw new HttpError(400, 'visibility is "private" or "workspace"');
      const maintainers = b.maintainers ?? [];
      if (!Array.isArray(maintainers) || maintainers.length > 30 || !maintainers.every((m) => typeof m === "string" && UUID.test(m)))
        throw new HttpError(400, "maintainers is a list of at most 30 cloud user ids");
      // Claims made here before it was shared stay in box.db: they must end first.
      const held = await claims.local.list({ superagent: name }, Date.now());
      if (held.length) throw new HttpError(409, `${name} holds ${held.length} claim(s) on this machine: release them before you share it, so that its claims are kept in one place`);
      const person = personOf(req);
      const shared = await person.share({
        installation: inst.id,
        name,
        title: info.title,
        description: info.description,
        source: sourceOf(info.dir),
        visibility,
        maintainers: maintainers as string[],
      });
      saveShare({ name, instance: shared.id, workspace: shared.workspace_id, installation: inst.id, visibility: shared.visibility, maintainers: shared.maintainers, source: shared.source });
      return json(superagents.get(name));
    })
    .add("DELETE", "/api/superagents/:name/share", async ({ req, params }) => {
      notAnAgent(req, superagents, "unsharing a superagent");
      const name = params.name!;
      superagents.get(name);
      const share = shareOf(name);
      if (!share) throw new HttpError(404, `${name} is not shared`);
      const held = (await team.claims.list({ superagent: name })).filter((c) => c.state !== "released");
      if (held.length) throw new HttpError(409, `${name} holds ${held.length} claim(s) in the cloud: release them before you unshare it`);
      try {
        await personOf(req).unshare(share.instance);
      } catch (e) {
        // Gone from the cloud already (unshared elsewhere): forget it here too.
        if (!(e instanceof CloudError && e.status === 404)) throw e;
      }
      dropShare(name);
      return json(superagents.get(name));
    })
    .add("GET", "/api/team/superagents", async ({ req, url }) => {
      const inst = cloud.status().installation;
      const workspace = url.searchParams.get("workspace") ?? inst?.workspaceId;
      if (!workspace || !UUID.test(workspace)) throw new HttpError(400, "give ?workspace=<id>");
      const list: (SuperagentInstance & { here: boolean })[] = (await personOf(req).directory(workspace)).map((i) => ({ ...i, here: !!inst && i.host.installation_id === inst.id }));
      return json({ instances: list, host: { installation: inst?.id ?? null, lastError: team.lastError } });
    });
}
