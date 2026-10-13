/** Local session capabilities authenticate managed HTTP requests. Process IDs
 * are routing hints, never credentials. This is not isolation from another
 * process with deliberate access to the same Unix user's private files. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "./paths";
import { environOf, ppidOf } from "./providers/procs";

function path(id: string) {
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error("invalid session identity");
  return join(agentboxHome(), "session-authority", id);
}
export function sessionCapability(id: string): string {
  const file = path(id);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return readFileSync(file, "utf8");
}
export function authenticatedSession(req: Request): string | null {
  const id = req.headers.get("x-agentbox-session"),
    token = req.headers.get("x-agentbox-session-token");
  if (
    !id ||
    !/^[\w-]{1,64}$/.test(id) ||
    !token ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    return null;
  try {
    const expected = readFileSync(path(id), "utf8");
    return expected.length === token.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(token))
      ? id
      : null;
  } catch {
    return null;
  }
}
/** The installed CLI can read its own private capability even when a provider
 * strips environment variables from shell tools. Nothing is fetched over HTTP. */
export function sessionHeaders(): Record<string, string> {
  let id = process.env.AGENTBOX_SESSION;
  for (
    let pid = process.ppid, n = 0;
    !id && pid > 1 && n < 64;
    n++, pid = ppidOf(pid) ?? 0
  )
    id = environOf(pid)?.get("AGENTBOX_SESSION");
  if (!id || !/^[\w-]{1,64}$/.test(id)) return {};
  return {
    "x-agentbox-session": id,
    "x-agentbox-session-token": sessionCapability(id),
  };
}
