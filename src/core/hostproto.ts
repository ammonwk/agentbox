import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "bun";
import { sessionDirFor } from "./paths";
import type { PermissionInfo } from "./acp";

/**
 * The control channel between the web server and a session's host process.
 *
 * The server does not own agents any more: each live session has its own
 * detached `agentbox host <id>` process holding the omp child and the ACP
 * connection. This module is the wire between them.
 *
 * Deliberately tiny. The host and the server are separate processes with
 * separate lifetimes, so a host started this morning may be talking to a
 * server started just now, running newer code. Every message that crosses
 * here is therefore a version-tolerance liability, and the cheapest way to
 * stay compatible is to have almost nothing to be incompatible about:
 *
 *  - Content does not cross the wire. Transcript events, status, cost and
 *    tokens all go to SQLite, which both processes already speak; the host
 *    just nudges the server to re-read. Adding a transcript field is then a
 *    schema change, not a protocol change.
 *  - Only commands cross the wire, and only ones with no return value worth
 *    parsing: send, interrupt, answer a permission, die.
 *
 * `PROTOCOL_VERSION` is bumped only when an existing op changes shape.
 * Adding a new op does not need it — an old host answers `unknown op` and the
 * server treats that as "this host is too old for that feature".
 */
export const PROTOCOL_VERSION = 1;

/**
 * Unix socket for a session's host, inside the session's own directory.
 *
 * This is past the 108-byte `sun_path` limit under a long `AGENTBOX_HOME`
 * (the test suite's scratchpad homes reach ~160 chars), which normally rules
 * the location out. Measured on Bun 1.3.14 / Linux 7.1.8: binding succeeds at
 * 160 chars, and two paths diverging only at char 115 — well past the limit,
 * exactly the shape of two session uuids under one home — bind and route to
 * their own listeners with no collision. Bun is not truncating.
 *
 * Keeping it here rather than in XDG_RUNTIME_DIR buys per-home isolation for
 * free: a test home, a dev instance and the real one cannot see each other's
 * sockets, with no hashing of the home path to keep them apart.
 */
export function hostSocketPath(sessionId: string): string {
  return join(sessionDirFor(sessionId), "ctl.sock");
}

export type HostRequest =
  | { op: "status" }
  | { op: "send"; text: string }
  | { op: "interrupt" }
  | { op: "permission"; permId: string; approved: boolean }
  | { op: "kill" };

export interface HostStatus {
  protocol: number;
  sessionId: string;
  hostPid: number;
  /** The omp process, or null before launch completes. */
  agentPid: number | null;
  ompSessionId: string | null;
  /** False once omp has exited and the host is winding down. */
  alive: boolean;
  permission: PermissionInfo | null;
}

interface Envelope {
  rid: number;
  req: HostRequest;
}

interface Reply {
  rid: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Unsolicited host -> server.
 *
 * `changed` means "re-read the database and the event log". `cold` means the
 * same plus "and rescan the expensive things" — it is raised only when a host
 * discovers a pull request, which is the one moment the PR list is known to be
 * out of date without waiting for the next sweep. They are separate because
 * the cold path shells out to `gh`, and doing that on every assistant delta is
 * how an idle agentbox came to spawn subprocesses forever once before.
 */
interface Push {
  push: "changed" | "cold" | "exiting";
}

type Frame = Reply | Push | Envelope;

function isPush(f: Frame): f is Push {
  return "push" in f;
}

/**
 * Split a socket byte stream into newline-delimited JSON values.
 *
 * A `data` callback is handed whatever happened to arrive, which is not
 * message-shaped: one write can surface as three callbacks, and three writes
 * as one. Anything that parses the buffer as-is works until a transcript-sized
 * payload spans a chunk boundary and then fails only under load.
 */
export class LineDecoder {
  private buf = "";

  push(chunk: Uint8Array): string[] {
    this.buf += Buffer.from(chunk).toString("utf8");
    const out = this.buf.split("\n");
    // The tail is either empty (the chunk ended on a newline) or a partial
    // line, and either way it is what the next chunk continues.
    this.buf = out.pop() ?? "";
    return out.filter((l) => l.trim() !== "");
  }
}

function encode(v: unknown): string {
  return `${JSON.stringify(v)}\n`;
}

// ------------------------------------------------------------------ host side

export interface HostHandlers {
  status: () => HostStatus;
  send: (text: string) => void;
  interrupt: () => void;
  permission: (permId: string, approved: boolean) => void;
  kill: () => void;
}

export interface HostServer {
  /** Tell every connected server to re-read the database. */
  broadcastChanged: () => void;
  /** As `broadcastChanged`, plus "rescan pull requests". */
  broadcastCold: () => void;
  /** Announce the host is going away, then stop listening. */
  shutdown: () => void;
}

/** Listen for control connections. Never throws on a client's bad frame — a
 *  malformed request from one server must not take the agent down. */
export function serveHost(
  sessionId: string,
  handlers: HostHandlers,
  onError: (message: string) => void
): HostServer {
  const path = hostSocketPath(sessionId);
  // A socket file left by a crashed host makes bind fail with EADDRINUSE even
  // though nothing is listening. We are the only writer of this path and we
  // are starting now, so anything already there is by definition stale.
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch (err) {
      onError(`could not clear stale socket: ${String(err)}`);
    }
  }

  // Bun's unix `listen` overload has no per-socket data generic, so the
  // decoders live beside the sockets rather than on them.
  const clients = new Map<Socket, LineDecoder>();

  const listener = Bun.listen({
    unix: path,
    socket: {
      open(sock) {
        clients.set(sock, new LineDecoder());
      },
      close(sock) {
        clients.delete(sock);
      },
      error(sock, err) {
        clients.delete(sock);
        onError(`control socket error: ${err.message}`);
      },
      data(sock, chunk) {
        const dec = clients.get(sock) ?? new LineDecoder();
        for (const line of dec.push(chunk)) {
          let env: Envelope;
          try {
            env = JSON.parse(line) as Envelope;
          } catch {
            onError(`unparseable control frame: ${line.slice(0, 200)}`);
            continue;
          }
          let reply: Reply;
          try {
            reply = { rid: env.rid, ok: true, data: dispatch(handlers, env.req) };
          } catch (err) {
            reply = { rid: env.rid, ok: false, error: String(err) };
          }
          sock.write(encode(reply));
        }
      },
    },
  });

  const pushAll = (push: Push["push"]) => {
    for (const c of clients.keys()) {
      try {
        c.write(encode({ push }));
      } catch {
        // A server that vanished mid-write is not the host's problem; its
        // `close` will clean the entry up.
      }
    }
  };

  return {
    broadcastChanged: () => pushAll("changed"),
    broadcastCold: () => pushAll("cold"),
    shutdown: () => {
      pushAll("exiting");
      listener.stop();
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Best effort. A leftover file is cleared by the next host's bind.
      }
    },
  };
}

function dispatch(h: HostHandlers, req: HostRequest): unknown {
  switch (req.op) {
    case "status":
      return h.status();
    case "send":
      h.send(req.text);
      return null;
    case "interrupt":
      h.interrupt();
      return null;
    case "permission":
      h.permission(req.permId, req.approved);
      return null;
    case "kill":
      h.kill();
      return null;
    default:
      // Reached when a newer server speaks an op this host predates. The
      // error travels back as a failed reply rather than killing anything.
      throw new Error(`unknown op: ${(req as { op: string }).op}`);
  }
}

// ---------------------------------------------------------------- server side

/**
 * The server's handle on one host.
 *
 * Every method is safe to call on a host that has already died: the socket is
 * the liveness test, and a dead one rejects rather than throwing somewhere
 * unrelated. Callers treat a rejection as "that agent is gone".
 */
export class HostClient {
  private sock: Socket | null = null;
  private dec = new LineDecoder();
  private rid = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  private constructor(
    readonly sessionId: string,
    private onChanged: (kind: "hot" | "cold") => void,
    private onGone: () => void
  ) {}

  /**
   * Connect to a session's host, or throw if there is none.
   *
   * This doubles as the liveness check at boot: a session whose socket refuses
   * a connection has no host, whatever its stored status says.
   */
  static async connect(
    sessionId: string,
    onChanged: (kind: "hot" | "cold") => void,
    onGone: () => void
  ): Promise<HostClient> {
    const client = new HostClient(sessionId, onChanged, onGone);
    client.sock = await Bun.connect({
      unix: hostSocketPath(sessionId),
      socket: {
        data(_sock, chunk) {
          for (const line of client.dec.push(chunk)) {
            let frame: Frame;
            try {
              frame = JSON.parse(line) as Frame;
            } catch {
              continue;
            }
            if (isPush(frame)) {
              if (frame.push === "changed") client.onChanged("hot");
              else if (frame.push === "cold") client.onChanged("cold");
              else client.markGone();
              continue;
            }
            const reply = frame as Reply;
            const waiter = client.pending.get(reply.rid);
            if (!waiter) continue;
            client.pending.delete(reply.rid);
            if (reply.ok) waiter.resolve(reply.data);
            else waiter.reject(new Error(reply.error ?? "host refused"));
          }
        },
        close() {
          client.markGone();
        },
        error() {
          client.markGone();
        },
      },
    });
    return client;
  }

  private markGone() {
    if (this.closed) return;
    this.closed = true;
    // Anything still waiting will never be answered now.
    for (const [, w] of this.pending) w.reject(new Error("host is gone"));
    this.pending.clear();
    this.sock = null;
    this.onGone();
  }

  get alive(): boolean {
    return !this.closed && this.sock !== null;
  }

  private request(req: HostRequest, timeoutMs = 5000): Promise<unknown> {
    if (!this.sock || this.closed) return Promise.reject(new Error("host is gone"));
    const rid = ++this.rid;
    const sock = this.sock;
    return new Promise<unknown>((resolve, reject) => {
      // Without this a host that is alive but wedged — blocked on a write, say
      // — would leave the request hanging forever, and with it whatever HTTP
      // request the UI is waiting on.
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error(`host did not answer ${req.op} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(rid, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      sock.write(encode({ rid, req } satisfies Envelope));
    });
  }

  async status(): Promise<HostStatus> {
    return (await this.request({ op: "status" })) as HostStatus;
  }

  async send(text: string): Promise<void> {
    await this.request({ op: "send", text });
  }

  async interrupt(): Promise<void> {
    await this.request({ op: "interrupt" });
  }

  async replyPermission(permId: string, approved: boolean): Promise<void> {
    await this.request({ op: "permission", permId, approved });
  }

  async kill(): Promise<void> {
    await this.request({ op: "kill" });
  }

  /** Drop the connection without touching the agent. Used when the server is
   *  shutting down: the host and its agent carry on without us. */
  detach(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.clear();
    try {
      this.sock?.end();
    } catch {
      // Already gone.
    }
    this.sock = null;
  }
}
