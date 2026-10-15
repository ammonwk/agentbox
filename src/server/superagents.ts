/** `/api/superagents…` (src/core/superagents.ts, docs/superagents.md): the
 *  registry, a program's page and actions, the main conversation, and the
 *  generic services a manifest turns on. */

import { timingSafeEqual } from "node:crypto";
import { authenticatedSession } from "../core/session-authority";
import { superagentToken, type Superagents } from "../core/superagents";
import { AVATAR_MAX_BYTES } from "../core/superagent/avatar";
import { HttpError, json, readBody, type Router } from "./router";
import { requireString } from "./validate";
import { requireNoSessionPeer } from "./peer";

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * The superagent whose program sent this request: it names itself in
 * `x-agentbox-superagent` and proves it with its token (the SDK's `call`
 * sends both). Null when the request does not say; a wrong token is 403, so
 * a program is never taken for a person by mistake.
 */
export function superagentCaller(req: Request, superagents: Superagents): string | null {
  const name = req.headers.get("x-agentbox-superagent");
  if (!name) return null;
  const token = req.headers.get("x-agentbox-superagent-token") ?? "";
  if (!NAME.test(name) || !superagents.has(name)) throw new HttpError(403, `no superagent ${name}`);
  const a = Buffer.from(token), b = Buffer.from(superagentToken(name));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, `the token does not prove ${name}`);
  return name;
}

/** Who acts on a superagent's own records: its program, its current main
 *  conversation, or a person (loopback, no session). Any other session is refused. */
export type { Actor } from "../core/superagent/memory-view";
import type { Actor } from "../core/superagent/memory-view";

export function actorFor(req: Request, superagents: Superagents, name: string, what: string): Actor {
  const program = superagentCaller(req, superagents);
  if (program) {
    if (program !== name) throw new HttpError(403, `${program}'s program cannot ${what} for ${name}`);
    return { kind: "program" };
  }
  const session = authenticatedSession(req);
  if (!session) {
    // A read is open to the person anyway; a write as a person must not come from inside a session.
    if (req.method !== "GET") requireNoSessionPeer(req, `to ${what} as a person`);
    return { kind: "person" };
  }
  if (superagents.get(name).main === session) return { kind: "main", session };
  throw new HttpError(403, `only ${name}'s current main conversation, its program or a person can ${what}`);
}

export function superagentRoutes(router: Router, superagents: Superagents, hooks: { scheduleHot: () => void }): Router {
  return router
    .add("GET", "/api/superagents", () => json(superagents.list()))
    .add("POST", "/api/superagents", async ({ req }) => json(await superagents.register(requireString(await readBody(req), "dir")), 201))
    .add("GET", "/api/superagents/:name", ({ params }) => json(superagents.get(superagents.canonical(params.name!))))
    .add("PATCH", "/api/superagents/:name", async ({ req, params }) => {
      // Its main gives its authority to the sessions it starts: only a person,
      // its program or its main itself names another.
      actorFor(req, superagents, superagents.canonical(params.name!), "change it");
      const b = await readBody(req);
      const main = b.main === null ? null : typeof b.main === "string" ? b.main : undefined;
      const enabled = typeof b.enabled === "boolean" ? b.enabled : undefined;
      return json(await superagents.patch(superagents.canonical(params.name!), { main, enabled }));
    })
    .add("DELETE", "/api/superagents/:name", ({ params }) => {
      superagents.remove(superagents.canonical(params.name!));
      return json(null);
    })
    .add("POST", "/api/superagents/:name/restart", async ({ params }) => json(await superagents.restart(superagents.canonical(params.name!))))
    .add("GET", "/api/superagents/:name/log", ({ params, url }) => {
      const bytes = Number(url.searchParams.get("bytes")) || undefined;
      return json({ text: superagents.log(superagents.canonical(params.name!), bytes && Math.min(bytes, 1024 * 1024)) });
    })
    .add("GET", "/api/superagents/:name/view", async ({ params, url }) => json(await superagents.view(superagents.canonical(params.name!), url.searchParams.get("tab"))))
    .add("POST", "/api/superagents/:name/action", async ({ req, params }) => {
      const b = await readBody(req);
      requireString(b, "action");
      // Who asked: a session proves itself with its capability; a page in a browser sends an Origin.
      const caller = { session: authenticatedSession(req), via: req.headers.get("origin") ? ("app" as const) : ("api" as const) };
      return json(await superagents.action(superagents.canonical(params.name!), b, caller));
    })
    .add("POST", "/api/superagents/:name/chat", async ({ req, params }) => {
      const b = await readBody(req);
      const text = requireString(b, "text");
      if (!text.trim()) throw new HttpError(400, "the message is empty");
      const sendId = requireString(b, "sendId");
      if (!/^[\w-]{1,64}$/.test(sendId)) throw new HttpError(400, "invalid send ID");
      const out = await superagents.chat(superagents.canonical(params.name!), text, sendId);
      hooks.scheduleHot();
      return json(out);
    })

    // ----- its memory journal (src/core/superagent/memory-view.ts)
    .add("GET", "/api/superagents/:name/memory", ({ req, params, url }) => {
      actorFor(req, superagents, superagents.canonical(params.name!), "read its memory");
      return json(superagents.memory(superagents.canonical(params.name!), url.searchParams.get("q")));
    })
    .add("GET", "/api/superagents/:name/memory/:record", ({ req, params }) => {
      actorFor(req, superagents, superagents.canonical(params.name!), "read its memory");
      return json(superagents.memoryRecord(superagents.canonical(params.name!), params.record!));
    })
    .add("POST", "/api/superagents/:name/memory/:kind", async ({ req, params }) => {
      const kind = params.kind!;
      if (kind !== "handoff" && kind !== "note" && kind !== "prefer") throw new HttpError(404, `no memory write ${kind}: handoff, note or prefer`);
      const actor = actorFor(req, superagents, superagents.canonical(params.name!), `write its memory`);
      return json(superagents.remember(superagents.canonical(params.name!), kind, actor, await readBody(req)));
    })

    // ----- its loops (src/core/superagent/loops.ts)
    .add("PUT", "/api/superagents/:name/loops/:id", async ({ req, params }) => {
      actorFor(req, superagents, superagents.canonical(params.name!), "set its loops");
      return json(superagents.setLoop(superagents.canonical(params.name!), params.id!, await readBody(req)));
    })
    .add("DELETE", "/api/superagents/:name/loops/:id", ({ req, params }) => {
      actorFor(req, superagents, superagents.canonical(params.name!), "remove its loops");
      return json(superagents.removeLoop(superagents.canonical(params.name!), params.id!));
    })
    .add("GET", "/api/superagents/:name/sweeps", ({ params }) => {
      superagents.get(superagents.canonical(params.name!));
      return json(superagents.sweeps.list(superagents.canonical(params.name!)));
    })

    // ----- its picture (src/core/superagent/avatar.ts): a person sets it on the page
    .add("GET", "/api/superagents/:name/avatar", ({ params }) => {
      const f = superagents.avatar(superagents.canonical(params.name!));
      if (!f) throw new HttpError(404, `${params.name} has no picture`);
      return new Response(Bun.file(f.path), { headers: { "content-type": f.mime, "cache-control": "private, max-age=31536000, immutable" } });
    })
    .add("PUT", "/api/superagents/:name/avatar", async ({ req, params }) => {
      if (actorFor(req, superagents, superagents.canonical(params.name!), "set its picture").kind !== "person") throw new HttpError(403, "a person sets a superagent's picture");
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > AVATAR_MAX_BYTES) throw new HttpError(413, `Choose an image of at most ${AVATAR_MAX_BYTES / 1024 / 1024} MB`);
      const bytes = new Uint8Array(await req.arrayBuffer());
      return json(superagents.setAvatar(superagents.canonical(params.name!), bytes, req.headers.get("content-type") ?? ""));
    })
    .add("DELETE", "/api/superagents/:name/avatar", ({ req, params }) => {
      if (actorFor(req, superagents, superagents.canonical(params.name!), "remove its picture").kind !== "person") throw new HttpError(403, "a person removes a superagent's picture");
      return json(superagents.setAvatar(superagents.canonical(params.name!), null));
    })

    // ----- reports to agentbox's issue tracker (src/core/superagent/feedback.ts)
    .add("POST", "/api/superagents/:name/help", async ({ req, params }) => {
      if (authenticatedSession(req) || superagentCaller(req, superagents)) throw new HttpError(403, "/help is a person's report from the Agents page; a session files one with agentbox report");
      requireNoSessionPeer(req, "/help");
      superagents.get(superagents.canonical(params.name!));
      return json(await superagents.feedback.submit(superagents.canonical(params.name!), await readBody(req)));
    })
    .add("GET", "/api/superagents/:name/help/:request", async ({ params }) => json(await superagents.feedback.receipt(superagents.canonical(params.name!), params.request!)))
    .add("POST", "/api/report", async ({ req }) => {
      const by = authenticatedSession(req);
      if (!by) throw new HttpError(403, "a report comes from a superagent's session: run agentbox report from inside one");
      return json(await superagents.feedback.report(by, await readBody(req)));
    });
}
