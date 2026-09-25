import { existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Socket } from "bun";
import { LineDecoder } from "./line-decoder";
import type { SteerReply, SteerRequest } from "../omp/steer";

/** The extension itself, handed to omp as `--extension`. */
export const STEER_EXTENSION = fileURLToPath(new URL("../omp/steer.ts", import.meta.url));

/** A reply about one message; `hello` is the link's own business. */
export type SteerOutcome = Exclude<SteerReply, { t: "hello" }>;

/**
 * The runner's end of the steer extension's socket (src/omp/steer.ts).
 *
 * Every omp session that loads the extension connects — a subagent omp runs
 * in-process loads its own copy — and each names its session in a `hello`.
 * Messages go only to the connection named after the runner's own session;
 * the rest stay open and unused.
 */
export class SteerLink {
  private conns = new Map<Socket, { dec: LineDecoder; session: string | null }>();
  private listener: { stop(closeActiveConnections?: boolean): void } | null;

  constructor(
    readonly path: string,
    onOutcome: (r: SteerOutcome) => void,
    onDrop: (session: string) => void,
  ) {
    // Left by a runner that crashed, and binding over it fails with
    // EADDRINUSE.
    if (existsSync(path)) unlinkSync(path);
    const conns = this.conns;
    const drop = (sock: Socket) => {
      const c = conns.get(sock);
      conns.delete(sock);
      if (c?.session) onDrop(c.session);
    };
    this.listener = Bun.listen({
      unix: path,
      socket: {
        open(sock) {
          conns.set(sock, { dec: new LineDecoder(), session: null });
        },
        data(sock, chunk) {
          const c = conns.get(sock);
          if (!c) return;
          for (const line of c.dec.push(chunk)) {
            let r: SteerReply;
            try {
              r = JSON.parse(line) as SteerReply;
            } catch {
              continue;
            }
            if (r.t === "hello") c.session = r.session;
            else onOutcome(r);
          }
        },
        close: drop,
        error: drop,
      },
    });
  }

  /** Hand a message to `session`'s extension. False if it has not said hello. */
  send(session: string, req: SteerRequest): boolean {
    for (const [sock, c] of this.conns) {
      if (c.session !== session) continue;
      sock.write(`${JSON.stringify(req)}\n`);
      return true;
    }
    return false;
  }

  close(): void {
    const listener = this.listener;
    if (!listener) return;
    this.listener = null;
    // Cleared first, so closing them reports nothing: the runner is going.
    this.conns.clear();
    listener.stop(true);
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // Best effort. A leftover file is cleared by the next bind.
    }
  }
}
