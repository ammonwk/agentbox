/** Which Unix user opened a connection from this machine.
 *
 *  Loopback is the owner (`csrf.ts`), which is only true on a machine where
 *  the owner is the only user who runs anything. On a shared box (a CI box
 *  whose runners are other users, running pull requests' code) any process
 *  can connect to 127.0.0.1, so a connection from this machine is the owner's
 *  only when the socket is the owner's: on Linux, the uid `/proc/net/tcp`
 *  gives the client's end of it. Elsewhere there is no such table and the old
 *  rule stands. */

import { readFileSync } from "node:fs";

const TABLES = ["/proc/net/tcp", "/proc/net/tcp6"];

/** The uid that owns the client end of a connection from `clientPort` to
 *  `serverPort` on this machine; undefined where /proc has no such table,
 *  null when no row matches. */
export function connectionUid(clientPort: number, serverPort: number): number | null | undefined {
  let any = false;
  const want = `:${clientPort.toString(16).toUpperCase().padStart(4, "0")}`;
  const peer = `:${serverPort.toString(16).toUpperCase().padStart(4, "0")}`;
  for (const t of TABLES) {
    let text: string;
    try {
      text = readFileSync(t, "utf8");
    } catch {
      continue;
    }
    any = true;
    // Only lines naming the port are split: test runs leave the table
    // thousands of rows long, and splitting every one took 10 ms a request.
    for (let i = text.indexOf(`${want} `); i >= 0; i = text.indexOf(`${want} `, i + 1)) {
      const start = text.lastIndexOf("\n", i) + 1;
      const end = text.indexOf("\n", i);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
      const c = text.slice(start, end < 0 ? undefined : end).trim().split(/\s+/);
      if (c.length > 7 && c[1]!.endsWith(want) && c[2]!.endsWith(peer)) return Number(c[7]);
    }
  }
  return any ? null : undefined;
}

const me = process.getuid?.() ?? null;

/** Why a connection from this machine is refused (another Unix user's), or null. */
export function otherUserRefusal(clientPort: number | undefined, serverPort: number): string | null {
  if (me === null || !clientPort) return null;
  const uid = connectionUid(clientPort, serverPort);
  if (uid === undefined || uid === me) return null;
  return uid === null ? "cannot tell which user opened this connection" : "only agentbox's own Unix user may connect from this machine";
}
