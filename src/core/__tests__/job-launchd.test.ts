import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdRunner } from "../job-launchd";
import { ApiError, apiClient } from "../../client";

// Destructive replay boundary, exercised without a service manager on Linux
// too. Native launchd acceptance is separate; this must never start a live wait.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-job-replay-"));
  const runner = join(dir, "run.mjs");
  writeFileSync(runner, launchdRunner);
  writeFileSync(join(dir, "payload.json"), JSON.stringify({
    command: 'test ! -e payload.json && test "$JOB_PRIVATE_VALUE" = private && printf x >> effects',
    cwd: dir, env: { PATH: process.env.PATH, JOB_PRIVATE_VALUE: "private" },
  }), { mode: 0o600 });
  return { dir, run: () => Bun.spawnSync([process.execPath, runner, dir]) };
}

test("a completed job cannot replay after a launchd kickstart or reload", () => {
  const { dir, run } = fixture();
  try {
    expect(run().exitCode).toBe(0);
    expect(readFileSync(join(dir, "effects"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "result"), "utf8")).toBe("success exited 0\n");
    expect(existsSync(join(dir, "payload.json"))).toBe(false);
    expect(run().exitCode).toBe(125);
    expect(readFileSync(join(dir, "effects"), "utf8")).toBe("x");
    expect(readFileSync(join(dir, "result"), "utf8")).toBe("success exited 0\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an attempt without completion cannot replay or manufacture success", () => {
  const { dir, run } = fixture();
  try {
    writeFileSync(join(dir, "attempted"), "");
    expect(run().exitCode).toBe(125);
    expect(existsSync(join(dir, "effects"))).toBe(false);
    expect(existsSync(join(dir, "result"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only a parsed server refusal grants authority to stop an uncertain job", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    switch (new URL(req.url).pathname) {
      case "/refused": return Response.json({ ok: false, error: "closed owner", data: null }, { status: 409 });
      case "/error": return Response.json({ ok: false, error: "internal error", data: null }, { status: 500 });
      case "/lost": server.stop(true); return new Response();
      case "/bad-envelope": return Response.json({ error: "not a receipt" }, { status: 400 });
      default: return new Response("not JSON", { status: 400 });
    }
  } });
  try {
    const api = apiClient(`http://127.0.0.1:${server.port}`);
    for (const [path, status] of [["/refused", 409], ["/error", 500], ["/bad-envelope", null], ["/bad-json", null], ["/lost", null]] as const) {
      const e = await api("POST", path, {}).catch(e => e);
      expect(e).toBeInstanceOf(ApiError);
      if (!(e instanceof ApiError)) throw new Error("expected an API error");
      expect(e.status).toBe(status);
    }
  } finally { server.stop(true); }
});
