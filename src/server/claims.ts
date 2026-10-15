/** The work claims API (src/core/workclaims.ts, docs/superagents.md "Claims"). */
import { timingSafeEqual } from "node:crypto";
import { getDb } from "../core/db";
import { authenticatedSession } from "../core/session-authority";
import { superagentToken } from "../core/superagents";
import { ClaimError, type ClaimCaller, type ClaimScope, type WorkClaims } from "../core/workclaims";
import { HttpError, json, readBody, type RouteHandler, type Router } from "./router";

/**
 * Who asks. A program sends its name and its token (`x-agentbox-superagent`,
 * `x-agentbox-superagent-token`, which the SDK's `call` sends); a wrong token
 * is 403. A session proves itself with its capability, and is then the holder
 * session. Neither: a person on this machine.
 */
export function superagentCaller(req: Request): ClaimCaller {
  const name = req.headers.get("x-agentbox-superagent");
  if (name === null) return { superagent: null, session: authenticatedSession(req) };
  const token = req.headers.get("x-agentbox-superagent-token") ?? "";
  // The name is checked before it becomes a path, and only a registered one has a token.
  const registered = /^[a-z][a-z0-9-]{0,39}$/.test(name) && !!getDb().query("SELECT 1 FROM superagents WHERE name = ?").get(name);
  const expected = registered ? Buffer.from(superagentToken(name)) : null;
  if (!expected || expected.length !== Buffer.byteLength(token) || !timingSafeEqual(expected, Buffer.from(token))) throw new HttpError(403, `not superagent ${name}: its token does not match`);
  return { superagent: name, session: null };
}

const scopeOf = (v: unknown): ClaimScope | undefined => {
  if (v === undefined || v === null) return undefined;
  if (v !== "work" && v !== "env") throw new HttpError(400, 'scope is "work" or "env"');
  return v;
};
const text = (b: Record<string, unknown>, k: string): string => {
  const v = b[k];
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${k} is required`);
  return v.trim();
};
const optText = (b: Record<string, unknown>, k: string): string | undefined => (b[k] === undefined || b[k] === null ? undefined : text(b, k));
const fenceOf = (b: Record<string, unknown>): number => {
  if (typeof b.fence !== "number" || !Number.isSafeInteger(b.fence) || b.fence < 1) throw new HttpError(400, "fence is the claim's current fence, a positive integer");
  return b.fence;
};

/** A refusal keeps its detail: a conflict answers `{key, holder, state}` as its data. */
const answering =
  (h: RouteHandler): RouteHandler =>
  async (ctx) => {
    try {
      return await h(ctx);
    } catch (e) {
      if (!(e instanceof ClaimError)) throw e;
      return new Response(JSON.stringify({ ok: false, data: e.detail, error: e.message }), { status: e.status, headers: { "content-type": "application/json" } });
    }
  };

export function claimRoutes(router: Router, claims: WorkClaims): Router {
  return router
    .add(
      "GET",
      "/api/claims",
      answering(async ({ url }) => {
        const q = (k: string) => url.searchParams.get(k) || undefined;
        return json(await claims.list({ superagent: q("superagent"), session: q("session"), key: q("key"), scope: scopeOf(q("scope")), released: q("all") === "1" }));
      }),
    )
    .add(
      "POST",
      "/api/claims",
      answering(async ({ req }) => {
        const caller = superagentCaller(req);
        const b = await readBody(req);
        if (!Array.isArray(b.sources) || b.sources.some((s) => typeof s !== "string")) throw new HttpError(400, "sources is a list of links or keys");
        const out = await claims.claim(caller, { sources: b.sources as string[], scope: scopeOf(b.scope), session: optText(b, "session"), note: optText(b, "note") });
        return json({ claims: out }, 201);
      }),
    )
    .add(
      "POST",
      "/api/claims/attach",
      answering(async ({ req }) => {
        const caller = superagentCaller(req);
        const b = await readBody(req);
        return json(await claims.attach(caller, { key: text(b, "key"), scope: scopeOf(b.scope), fence: fenceOf(b), session: text(b, "session") }));
      }),
    )
    .add(
      "POST",
      "/api/claims/release",
      answering(async ({ req }) => {
        const caller = superagentCaller(req);
        const b = await readBody(req);
        return json(await claims.release(caller, { key: text(b, "key"), scope: scopeOf(b.scope), fence: fenceOf(b) }));
      }),
    )
    .add(
      "POST",
      "/api/claims/takeover",
      answering(async ({ req }) => {
        const caller = superagentCaller(req);
        const b = await readBody(req);
        return json(await claims.takeover(caller, { key: text(b, "key"), scope: scopeOf(b.scope), to: optText(b, "to") }));
      }),
    );
}
