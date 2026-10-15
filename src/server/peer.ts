/**
 * Who is at the other end of a loopback request, for the few acts only a
 * person may take (approve a GitHub action, pin a policy, answer its card,
 * speak for a superagent). A session that leaves its capability headers out
 * looks like a person to the header checks; the process behind the
 * connection does not lie. On loopback, the client's port names its process
 * (`lsof`), and a process under an agentbox session is that session's.
 *
 * Where it cannot be told (no `lsof`, a request from the tailnet, which is
 * your own devices by design), the header checks stand alone.
 */
import { spawnSync } from "node:child_process";
import { HttpError } from "./router";

/** The client port of each loopback request, set where the server takes it. */
export const peerPorts = new WeakMap<Request, number>();

let lsof: boolean | null = null;

/** The process that holds the client end of loopback port `port`, or null. */
function processOn(port: number, server: number): number | null {
  if (lsof === false) return null;
  const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fpn"], { encoding: "utf8", timeout: 3_000 });
  if (r.error) {
    lsof = false;
    return null;
  }
  lsof = true;
  let pid: number | null = null;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    // The client's end: its own port first, the server's after the arrow.
    else if (line.startsWith("n") && new RegExp(`:${port}->[^:]+:${server}$`).test(line) && pid && pid !== process.pid) return pid;
  }
  return null;
}

/** The session the request's client process runs under, or null when none
 *  does or it cannot be told. */
export function sessionOfPeer(req: Request, server: number, sessionAbove: (pid: number) => string | null): string | null {
  const port = peerPorts.get(req);
  if (!port) return null;
  const pid = processOn(port, server);
  return pid ? sessionAbove(pid) : null;
}

let config: { server: number; sessionAbove: (pid: number) => string | null } | null = null;

/** The server's port and how a process maps to a session, set at startup. */
export function configurePeers(c: { server: number; sessionAbove: (pid: number) => string | null }): void {
  config = c;
}

/** Refuse a request whose client process runs under an agentbox session:
 *  `what` is a person's to do, whatever headers the request leaves out. */
export function requireNoSessionPeer(req: Request, what: string): void {
  if (!config) return;
  const s = sessionOfPeer(req, config.server, config.sessionAbove);
  if (s) throw new HttpError(403, `${what} is a person's to do; this request comes from inside session ${s}`);
}
