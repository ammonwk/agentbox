import { describe, expect, test } from "bun:test";
import { HttpError, Router, json, readBody, toHttpError } from "../router";

function req(method: string, path: string, body?: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    body,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

async function payload(res: Response): Promise<{ ok: boolean; data: unknown; error: string | null }> {
  return (await res.json()) as { ok: boolean; data: unknown; error: string | null };
}

function testRouter(): Router {
  return new Router()
    .add("GET", "/api/state", () => json({ hello: "state" }))
    .add("POST", "/api/sessions", () => json({ made: true }, 201))
    .add("DELETE", "/api/sessions/:id", ({ params }) => json({ deleted: params.id }))
    .add("POST", "/api/sessions/:id/interrupt", ({ params }) => json({ interrupted: params.id }))
    .add("GET", "/api/sessions/:id/events", ({ url, params }) =>
      json({ id: params.id, since: url.searchParams.get("since") }),
    );
}

describe("route matching", () => {
  test("dispatches on method and path together", async () => {
    const res = await testRouter().handle(req("GET", "/api/state"));
    expect(res.status).toBe(200);
    expect((await payload(res)).data).toEqual({ hello: "state" });
  });

  test("extracts path params", async () => {
    const res = await testRouter().handle(req("POST", "/api/sessions/abc-123/interrupt"));
    expect((await payload(res)).data).toEqual({ interrupted: "abc-123" });
  });

  test("percent-encoded params are decoded", async () => {
    const res = await testRouter().handle(req("DELETE", "/api/sessions/a%20b"));
    expect((await payload(res)).data).toEqual({ deleted: "a b" });
  });

  test("query strings do not affect matching", async () => {
    const res = await testRouter().handle(req("GET", "/api/sessions/s1/events?since=7"));
    expect((await payload(res)).data).toEqual({ id: "s1", since: "7" });
  });

  // The old server bundled seven verbs into one regex and never checked the
  // method, so a GET could interrupt a session.
  test("a GET on a POST-only route is 405, not a silent success", async () => {
    const res = await testRouter().handle(req("GET", "/api/sessions/abc/interrupt"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((await payload(res)).error).toContain("not allowed");
  });

  test("405 lists every method the path does accept", async () => {
    const router = new Router()
      .add("GET", "/api/repos", () => json([]))
      .add("POST", "/api/repos", () => json({}));
    const res = await router.handle(req("PATCH", "/api/repos"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
  });

  test("an unknown path is 404 with a message that names it", async () => {
    const res = await testRouter().handle(req("GET", "/api/nope"));
    expect(res.status).toBe(404);
    expect((await payload(res)).error).toContain("/api/nope");
  });

  test("a longer path does not match a shorter route", async () => {
    const res = await testRouter().handle(req("GET", "/api/state/extra"));
    expect(res.status).toBe(404);
  });

  test("the fallback handles unmatched paths so static files can be served", async () => {
    const router = testRouter().otherwise(({ url }) => new Response(`static:${url.pathname}`));
    const res = await router.handle(req("GET", "/assets/app.js"));
    expect(await res.text()).toBe("static:/assets/app.js");
  });

  test("the fallback does not swallow a method mismatch on a real route", async () => {
    const router = testRouter().otherwise(() => new Response("static"));
    expect((await router.handle(req("GET", "/api/sessions/x/interrupt"))).status).toBe(405);
  });
});

describe("error handling", () => {
  test("HttpError from a handler becomes its status and message", async () => {
    const router = new Router().add("GET", "/boom", () => {
      throw new HttpError(409, "session is already running");
    });
    const res = await router.handle(req("GET", "/boom"));
    expect(res.status).toBe(409);
    expect((await payload(res)).error).toBe("session is already running");
  });

  test("an unexpected throw is a 500 that still carries the real message", async () => {
    const router = new Router().add("GET", "/boom", () => {
      throw new Error("sqlite is on fire");
    });
    const res = await router.handle(req("GET", "/boom"));
    expect(res.status).toBe(500);
    expect((await payload(res)).error).toBe("sqlite is on fire");
  });

  test("the default mapping passes HttpError through and 500s everything else", () => {
    expect(toHttpError(new HttpError(400, "bad")).status).toBe(400);
    expect(toHttpError(new Error("disk full")).status).toBe(500);
    expect(toHttpError("a thrown string").message).toBe("a thrown string");
  });

  // The server injects a mapper that knows the engine's NotFound/Conflict/
  // BadRequest classes; router.ts itself stays independent of core.
  test("an injected mapper decides the status of a core error", async () => {
    class NotFound extends Error {}
    const router = new Router((e) =>
      e instanceof NotFound ? new HttpError(404, e.message) : new HttpError(500, String(e)),
    ).add("GET", "/x", () => {
      throw new NotFound("session not found: abc");
    });
    const res = await router.handle(req("GET", "/x"));
    expect(res.status).toBe(404);
    expect((await payload(res)).error).toBe("session not found: abc");
  });

  test("a handler's own HttpError wins over the injected mapper", async () => {
    const router = new Router(() => new HttpError(500, "mapper ran")).add("GET", "/x", () => {
      throw new HttpError(409, "wrong state");
    });
    const res = await router.handle(req("GET", "/x"));
    expect(res.status).toBe(409);
    expect((await payload(res)).error).toBe("wrong state");
  });

  test("every response carries the { ok, data, error } envelope", async () => {
    const good = await payload(await testRouter().handle(req("GET", "/api/state")));
    expect(good).toEqual({ ok: true, data: { hello: "state" }, error: null });
    const bad = await payload(await testRouter().handle(req("GET", "/api/nope")));
    expect(bad.ok).toBe(false);
    expect(bad.data).toBeNull();
    expect(typeof bad.error).toBe("string");
  });
});

describe("readBody", () => {
  test("parses a JSON object", async () => {
    expect(await readBody(req("POST", "/x", '{"a":1}'))).toEqual({ a: 1 });
  });

  test("an empty body is an empty object", async () => {
    expect(await readBody(req("POST", "/x", ""))).toEqual({});
    expect(await readBody(req("POST", "/x"))).toEqual({});
  });

  // The old readBody did a bare JSON.parse, so a truncated request was a 500.
  test("malformed JSON is a 400, not a 500", async () => {
    const router = new Router().add("POST", "/x", async ({ req: r }) => json(await readBody(r)));
    const res = await router.handle(req("POST", "/x", "{not json"));
    expect(res.status).toBe(400);
    expect((await payload(res)).error).toContain("valid JSON");
  });

  test("a non-object JSON body is a 400", async () => {
    for (const body of ["[1,2]", '"hello"', "42", "null"]) {
      const router = new Router().add("POST", "/x", async ({ req: r }) => json(await readBody(r)));
      const res = await router.handle(req("POST", "/x", body));
      expect(res.status).toBe(400);
    }
  });
});
