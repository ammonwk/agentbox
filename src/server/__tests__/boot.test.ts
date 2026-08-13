/** Does the thing the user actually runs actually start?
 *
 * Typecheck green, 231 tests green, UI build green — and `agentbox` died on
 * boot with `Export named 'AGENTBOX_HOME' not found`, because `bin/agentbox`
 * has no extension and `tsc` silently skips it. Nothing in the project
 * executed the binary, so nothing could catch it.
 *
 * This spawns the real CLI, against a temporary AGENTBOX_HOME on a temporary
 * port, and asks the running server for its health. It covers the whole class:
 * any import that does not resolve, any module-scope throw, any route table
 * that fails to build.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const home = mkdtempSync(join(tmpdir(), "agentbox-boot-"));
// A high port picked per-run: two suites on one box must not collide, and the
// real default port may well be in use by the developer's own server.
const port = 34000 + Math.floor(Math.random() * 4000);

const child = Bun.spawn(["bun", join(packageRoot, "bin", "agentbox"), "serve"], {
  cwd: packageRoot,
  env: { ...process.env, AGENTBOX_HOME: home, AGENTBOX_PORT: String(port), AGENTBOX_HOST: "127.0.0.1" },
  stdout: "pipe",
  stderr: "pipe",
});

afterAll(async () => {
  child.kill();
  await child.exited;
  rmSync(home, { recursive: true, force: true });
});

async function waitForServer(timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  for (;;) {
    if (child.exitCode !== null) {
      const err = await new Response(child.stderr).text();
      throw new Error(`the CLI exited with code ${child.exitCode} instead of serving:\n${err}`);
    }
    try {
      return await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (Date.now() > deadline) throw new Error(`server never came up on ${port}: ${lastError}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("`agentbox serve` boots and answers /api/health", async () => {
  const res = await waitForServer(30_000);
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    ok: boolean;
    data: { git: boolean; gitState: string; ghState: string; version: string } | null;
    error: string | null;
  };
  expect(body.ok).toBe(true);
  expect(body.error).toBeNull();
  // git is the one dependency the test environment is guaranteed to have; omp
  // and gh are the developer's business, so only their *shape* is asserted.
  expect(body.data?.git).toBe(true);
  expect(body.data?.gitState).toBe("ok");
  expect(["ok", "unusable", "missing"]).toContain(body.data?.ghState);
  expect(body.data?.version).toMatch(/^\d+\.\d+\.\d+/);
}, 40_000);

test("the running server serves the API contract, not just a port", async () => {
  const base = `http://127.0.0.1:${port}`;

  const state = (await (await fetch(`${base}/api/state`)).json()) as {
    ok: boolean;
    data: { sessions: unknown[]; repos: unknown[]; settings: unknown } | null;
  };
  expect(state.ok).toBe(true);
  expect(Array.isArray(state.data?.sessions)).toBe(true);
  expect(Array.isArray(state.data?.repos)).toBe(true);
  expect(state.data?.settings).toBeTruthy();

  // The method check the old server did not do.
  const wrongMethod = await fetch(`${base}/api/sessions/anything/interrupt`);
  expect(wrongMethod.status).toBe(405);
  expect(wrongMethod.headers.get("allow")).toBe("POST");

  const unknown = await fetch(`${base}/api/nope`);
  expect(unknown.status).toBe(404);

  const malformed = await fetch(`${base}/api/settings`, {
    method: "PUT",
    body: "{not json",
    headers: { "content-type": "application/json" },
  });
  expect(malformed.status).toBe(400);

  const missingSession = await fetch(`${base}/api/sessions/no-such-session/events`);
  expect(missingSession.status).toBe(404);
}, 20_000);

test("a WebSocket client gets hot then cold, and an error for garbage", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen: { type: string }[] = [];
  const done = Promise.withResolvers<void>();

  ws.onmessage = (e) => {
    seen.push(JSON.parse(String(e.data)) as { type: string });
    if (seen.length === 3) done.resolve();
  };
  ws.onerror = () => done.reject(new Error("websocket failed to connect"));
  ws.onopen = () => ws.send("this is not json");

  await Promise.race([
    done.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`only got ${seen.map((s) => s.type)}`)), 10_000)),
  ]);
  ws.close();

  expect(seen.map((s) => s.type).slice(0, 2).sort()).toEqual(["cold", "hot"]);
  // The old handler was `message(_ws) {}` — garbage was silently discarded.
  expect(seen[2]?.type).toBe("error");
}, 20_000);
