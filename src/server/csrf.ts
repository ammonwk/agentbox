/** Who may drive the API.
 *
 * The server binds loopback, which stops other machines — and nothing else.
 * Any web page open in your browser can send a request to 127.0.0.1, and v1
 * accepted it: a `text/plain` POST from any site could spawn sessions or call
 * the skill endpoints. Here it can type into running agents that skip their
 * permission prompts, so the bar is higher:
 *
 *   - Host must be a loopback name. Stops DNS rebinding, where a hostile
 *     domain re-resolves to 127.0.0.1 and becomes "same-origin" with us.
 *   - Origin, when the browser sends one, must be loopback on our port or the
 *     vite dev server's. Browsers always send it on WebSocket upgrades and on
 *     cross-origin requests, and WebSockets are not covered by CORS at all.
 *   - Every mutating request carries `x-agentbox: 1`. A custom header cannot be
 *     sent cross-origin without a CORS preflight, which we never answer.
 *
 * Non-browser clients (the CLI, the MCP server, curl) send no Origin and set
 * the header; they are local processes running as you, which is the trust
 * boundary anyway.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const VITE_DEV_PORT = 5173;

function hostOk(host: string | null, port: number): boolean {
  if (!host) return false;
  const m = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
  if (!m) return false;
  const name = m[1]!.toLowerCase();
  const p = m[2] ? Number(m[2]) : 80;
  return LOOPBACK.has(name) && (p === port || p === VITE_DEV_PORT);
}

function originOk(origin: string | null, port: number): boolean {
  if (origin === null) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:") return false;
    return hostOk(u.host, port);
  } catch {
    return false;
  }
}

export type Verdict = { ok: true } | { ok: false; reason: string };

export function checkRequest(req: Request, port: number, opts: { upgrade?: boolean } = {}): Verdict {
  if (!hostOk(req.headers.get("host"), port)) return { ok: false, reason: "unexpected Host header" };
  if (!originOk(req.headers.get("origin"), port)) return { ok: false, reason: "cross-origin requests are not allowed" };
  const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  if (!safe && !opts.upgrade && req.headers.get("x-agentbox") !== "1") {
    return { ok: false, reason: "missing x-agentbox header" };
  }
  return { ok: true };
}
