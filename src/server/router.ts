/** A router small enough to read in one sitting.
 *
 * The old server was a chain of `if (path === ...)` that mostly forgot to
 * check the method, so `GET /api/sessions/:id/interrupt` interrupted a
 * session. Matching on method *and* path is the whole point of this file;
 * 405-vs-404 falls out of it for free.
 */

export type Params = Record<string, string>;
export type RouteHandler = (ctx: {
  req: Request;
  params: Params;
  url: URL;
}) => Response | Promise<Response>;

/** An error a handler can throw to choose its own status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data, error: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function fail(error: string, status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: false, data: null, error }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

/** Parse a JSON request body. Malformed input is the client's fault, not a 500. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await req.text();
  } catch (e) {
    throw new HttpError(400, `could not read request body: ${(e as Error).message}`);
  }
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

type Route = { method: string; segments: string[]; handler: RouteHandler };

function split(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

function matchSegments(route: string[], actual: string[]): Params | null {
  if (route.length !== actual.length) return null;
  const params: Params = {};
  for (let i = 0; i < route.length; i++) {
    const r = route[i]!;
    const a = actual[i]!;
    if (r.startsWith(":")) {
      params[r.slice(1)] = decodeURIComponent(a);
    } else if (r !== a) {
      return null;
    }
  }
  return params;
}

export class Router {
  private readonly routes: Route[] = [];
  /** Runs when nothing matched a path — the static file handler. */
  private fallback: RouteHandler | null = null;

  /**
   * @param mapError Turns whatever a handler threw into a status. The default
   * knows nothing about the core modules; the server injects one that does, so
   * this file stays independent of them.
   */
  constructor(private readonly mapError: (e: unknown) => HttpError = toHttpError) {}

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
    return this;
  }

  otherwise(handler: RouteHandler): this {
    this.fallback = handler;
    return this;
  }

  /** Resolve a request to a handler, or to the reason there isn't one. */
  resolve(
    method: string,
    path: string,
  ):
    | { kind: "handler"; handler: RouteHandler; params: Params }
    | { kind: "methodNotAllowed"; allow: string[] }
    | { kind: "notFound" } {
    const actual = split(path);
    const allow = new Set<string>();
    for (const route of this.routes) {
      const params = matchSegments(route.segments, actual);
      if (!params) continue;
      if (route.method === method.toUpperCase()) {
        return { kind: "handler", handler: route.handler, params };
      }
      allow.add(route.method);
    }
    if (allow.size > 0) return { kind: "methodNotAllowed", allow: [...allow].sort() };
    return { kind: "notFound" };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const resolved = this.resolve(req.method, url.pathname);

    if (resolved.kind === "methodNotAllowed") {
      return fail(
        `${req.method} is not allowed on ${url.pathname} — try ${resolved.allow.join(", ")}`,
        405,
        { allow: resolved.allow.join(", ") },
      );
    }
    if (resolved.kind === "notFound") {
      if (this.fallback) {
        return this.fallback({ req, params: {}, url });
      }
      return fail(`no route for ${req.method} ${url.pathname}`, 404);
    }

    try {
      return await resolved.handler({ req, params: resolved.params, url });
    } catch (e) {
      const err = e instanceof HttpError ? e : this.mapError(e);
      return fail(err.message, err.status);
    }
  }
}

/**
 * The default error mapping: everything unrecognised is a 500 carrying its
 * real message, because a legible failure beats a tidy one.
 */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  return new HttpError(500, e instanceof Error ? e.message : String(e));
}
