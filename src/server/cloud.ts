/** `/api/cloud/*`: this machine's side of the agentbox cloud (docs/cloud.md).
 *
 *  Same rules as every other route: loopback (or the vetted tailnet), and
 *  `x-agentbox: 1` on every change (csrf.ts). Nothing here opens the machine
 *  to the cloud; these are the local CLI's and the web app's handles on the
 *  bridge, which only calls out. The installation secret goes in once
 *  (`POST /api/cloud/installation`) and never comes back out. */

import { CloudError } from "../cloud/client";
import { SKILL_NAME_RE } from "../cloud/protocol";
import { SkillBundleError } from "../cloud/skillbundle";
import type { CloudBridge } from "../core/cloud/bridge";
import type { Fleet } from "../core/fleet";
import { HttpError, json, readBody, type Router } from "./router";
import { optionalString, requireString } from "./validate";

/** A cloud refusal keeps its status; "not reached" is 503. */
export function cloudHttpError(e: unknown): HttpError | null {
  if (e instanceof CloudError) return new HttpError(e.status === 0 ? 503 : e.status >= 400 && e.status < 600 ? e.status : 502, e.message);
  if (e instanceof SkillBundleError) return new HttpError(409, e.message);
  return null;
}

/** A revision a publish starts from: 0 (or none) for something new. */
const base = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "baseRev must be a revision number, or 0 for a new one");
  return n;
};

const int = (v: unknown, label: string): number | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${label} must be a revision number`);
  return n;
};

export function cloudRoutes(router: Router, bridge: CloudBridge, fleet: Pick<Fleet, "callerOf">): Router {
  /** What changes this machine's trust or contents is the human's to do:
   *  refused to a caller running inside an agent session. Agents run as the
   *  same user, so this stops their ordinary CLI use, not a determined process. */
  const yours = (pid: unknown, what: string): void => {
    const n = Number(pid);
    const inside = Number.isInteger(n) && n > 1 ? fleet.callerOf(n) : null;
    if (inside) throw new HttpError(403, `${what} is yours to do, not an agent's (this came from session ${inside}): run it in your own terminal or on the Team page`);
  };
  return router
    .add("GET", "/api/cloud", () => json(bridge.status()))
    .add("POST", "/api/cloud/installation", async ({ req }) => {
      const b = await readBody(req);
      yours(b.callerPid, "registering this machine");
      // Asked first, before a person registers it in the cloud for nothing.
      if (b.check === true) return json(null);
      return json(await bridge.register(requireString(b, "secret")));
    })
    .add("DELETE", "/api/cloud/installation", async ({ url }) => {
      yours(url.searchParams.get("callerPid"), "forgetting this machine's credential");
      return json(await bridge.forget(url.searchParams.get("revoke") === "1"));
    })
    .add("PUT", "/api/cloud/settings", async ({ req }) => {
      const b = await readBody(req);
      yours(b.callerPid, "changing this machine's cloud settings");
      const patch: Record<string, unknown> = {};
      for (const k of ["allowRemoteWake", "shareAccountEmails"]) if (typeof b[k] === "boolean") patch[k] = b[k];
      if (b.skillRoot === "claude" || b.skillRoot === "agents") patch.skillRoot = b.skillRoot;
      if (typeof b.pollSeconds === "number") patch.pollSeconds = b.pollSeconds;
      try {
        return json(bridge.settings(patch));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    })
    .add("POST", "/api/cloud/sync", async () => {
      await bridge.tick();
      return json(bridge.status());
    })
    .add("GET", "/api/cloud/directory", async ({ url }) => json(await bridge.directory(url.searchParams.get("fresh") === "1")))
    .add("POST", "/api/cloud/agents/:id", async ({ req, params }) => {
      const b = await readBody(req);
      return json(await bridge.share(params.id!, b.listed !== false));
    })
    .add("POST", "/api/cloud/messages", async ({ req }) => {
      const b = await readBody(req);
      const text = requireString(b, "text");
      if (!text.trim()) throw new HttpError(400, "the message is empty");
      // The sender is named the way `agentbox send` names it: the session
      // the caller says it is, else the one above its process. The cloud
      // then vouches for the installation and its owner, not this id.
      const callerPid = typeof b.callerPid === "number" && Number.isInteger(b.callerPid) && b.callerPid > 1 ? b.callerPid : null;
      const fromSession =
        (typeof b.fromSession === "string" && /^[\w-]{1,64}$/.test(b.fromSession) ? b.fromSession : null) ??
        (callerPid ? fleet.callerOf(callerPid) : null);
      const out = await bridge.send({
        to: requireString(b, "to"),
        text,
        senderAgent: fromSession,
        wake: b.wake === true,
        clientId: optionalString(b, "clientId"),
      });
      // A refused message never looks delivered.
      if (out.state === "refused" || out.state === "abandoned") {
        return new Response(JSON.stringify({ ok: false, data: out, error: out.error ?? "not sent" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return json(out, out.state === "pending" ? 202 : 201);
    })
    .add("GET", "/api/cloud/messages", async ({ url }) => {
      const box = url.searchParams.get("box") === "in" ? "in" : "out";
      return json(await bridge.messages(box, Math.min(200, Number(url.searchParams.get("limit")) || 50)));
    })
    .add("GET", "/api/cloud/plans", async () => json(await bridge.api().plans()))
    .add("GET", "/api/cloud/plans/:slug", async ({ params, url }) => json(await bridge.api().plan(params.slug!, int(url.searchParams.get("rev"), "rev"))))
    .add("POST", "/api/cloud/plans", async ({ req }) => {
      const b = await readBody(req);
      return json(
        await bridge.api().publishPlan({
          slug: requireString(b, "slug"),
          title: requireString(b, "title"),
          body: requireString(b, "body"),
          baseRev: base(b.baseRev),
          summary: optionalString(b, "summary"),
        }),
      );
    })
    .add("GET", "/api/cloud/skills", async () => json(await bridge.api().skills()))
    .add("GET", "/api/cloud/installed-skills", () => json(bridge.installed()))
    .add("GET", "/api/cloud/skills/:name", async ({ params, url }) => json(await bridge.api().skill(params.name!, int(url.searchParams.get("rev"), "rev"))))
    .add("POST", "/api/cloud/skills/:name/install", async ({ req, params }) => {
      const b = await readBody(req);
      if (!SKILL_NAME_RE.test(params.name!)) throw new HttpError(400, "not a skill name");
      // Pinned: the caller names the revision. "Latest" is resolved by the
      // caller first, so what was installed is always a number it saw.
      const rev = int(b.rev, "rev");
      if (!rev) throw new HttpError(400, "name the revision to install (rev)");
      yours(b.callerPid, "installing a skill");
      return json(await bridge.installSkill(params.name!, rev, b.force === true));
    })
    .add("POST", "/api/cloud/skills/publish", async ({ req }) => {
      const b = await readBody(req);
      const name = optionalString(b, "name");
      const path = optionalString(b, "path");
      if (!name && !path) throw new HttpError(400, "name a local skill, or give its path");
      if (name && !SKILL_NAME_RE.test(name)) throw new HttpError(400, "not a skill name");
      yours(b.callerPid, "publishing a skill to the workspace");
      return json(await bridge.publishSkill({ name, path, summary: optionalString(b, "summary"), baseRev: b.baseRev === undefined ? undefined : base(b.baseRev) }));
    });
}
