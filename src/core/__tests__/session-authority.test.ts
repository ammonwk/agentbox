import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticatedSession, sessionCapability } from "../session-authority";

test("managed HTTP identity requires a private capability, never an omitted or forged PID", () => {
  const old = process.env.AGENTBOX_HOME,
    dir = mkdtempSync(join(tmpdir(), "agent-capability-"));
  process.env.AGENTBOX_HOME = dir;
  try {
    const own = sessionCapability("own"),
      other = sessionCapability("other");
    const req = (headers = {}, body = {}) =>
      new Request("http://127.0.0.1/api/prs/transfer", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    expect(statSync(join(dir, "session-authority", "own")).mode & 0o777).toBe(
      0o600,
    );
    expect(authenticatedSession(req())).toBeNull();
    expect(
      authenticatedSession(
        req({}, { callerPid: process.pid, session: "own", expected: "own" }),
      ),
    ).toBeNull();
    expect(
      authenticatedSession(
        req({ "x-agentbox-session": "own", "x-agentbox-session-token": other }),
      ),
    ).toBeNull();
    expect(
      authenticatedSession(
        req({ "x-agentbox-session": "own", "x-agentbox-session-token": own }),
      ),
    ).toBe("own");
    expect(
      authenticatedSession(
        req({ "x-agentbox-session": "other", "x-agentbox-session-token": own }),
      ),
    ).toBeNull();
  } finally {
    if (old === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
