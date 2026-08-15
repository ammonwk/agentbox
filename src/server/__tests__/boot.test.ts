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
    data: Record<string, unknown> | null;
    error: string | null;
  };
  expect(body.ok).toBe(true);
  expect(body.error).toBeNull();

  const health = body.data;
  if (health === null) throw new Error(`health returned no data: ${body.error}`);

  // git is the one dependency the test environment is guaranteed to have; omp
  // and gh are the developer's business, so only their *shape* is asserted.
  expect(health.gitState).toBe("ok");
  expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(typeof health.checkedAt).toBe("number");

  // The tri-state: an installed-but-logged-out `gh` must be distinguishable
  // from a missing one, because both make PR data silently absent.
  for (const dep of ["omp", "gh", "git"]) {
    // Narrow once per dependency rather than casting at each assertion: the
    // response is typed `Record<string, unknown>` because the keys are built
    // dynamically, and a `state` that is not a string is itself a failure
    // worth naming rather than coercing past.
    const state = health[`${dep}State`];
    expect(typeof state).toBe("string");
    expect(["ok", "unusable", "missing"]).toContain(state as string);
    if (state !== "ok") expect(health[`${dep}Detail`]).toBeTruthy();
    // The per-dependency boolean is deliberately gone: it could only ever
    // restate the tri-state less precisely, and `gh: true` for a logged-out
    // gh is the exact ambiguity this endpoint exists to remove.
    expect(dep in health).toBe(false);
  }
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

// This is the shape the Settings UI sends. Every one of these 400'd against
// the live server while the whole Supervision section sat unusable in the
// browser, so it is asserted end-to-end and not only at the validator.
test("PUT /api/settings deep-merges a nested partial and keeps its siblings", async () => {
  const base = `http://127.0.0.1:${port}`;
  type Settings = {
    model: string;
    supervisor: { enabled: boolean; everyToolCalls: number; model: string };
    advisor: { enabled: boolean; model: string };
  };
  const put = async (patch: unknown) => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      body: JSON.stringify(patch),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as { ok: boolean; data: Settings | null; error: string | null };
    return { status: res.status, ...body };
  };

  const before = ((await (await fetch(`${base}/api/settings`)).json()) as { data: Settings }).data;
  expect(before.supervisor.model).toBeTruthy();

  const one = await put({ supervisor: { enabled: true } });
  expect(one.status).toBe(200);
  expect(one.error).toBeNull();
  expect(one.data?.supervisor.enabled).toBe(true);
  // The half that a validator fix alone would not catch: a patch that is
  // accepted but drops the keys it did not mention is the original bug.
  expect(one.data?.supervisor.model).toBe(before.supervisor.model);
  expect(one.data?.supervisor.everyToolCalls).toBe(before.supervisor.everyToolCalls);

  const two = await put({ supervisor: { everyToolCalls: 10 } });
  expect(two.status).toBe(200);
  expect(two.data?.supervisor.everyToolCalls).toBe(10);
  expect(two.data?.supervisor.enabled).toBe(true); // survived from the previous PUT
  expect(two.data?.supervisor.model).toBe(before.supervisor.model);

  const three = await put({ advisor: { enabled: true } });
  expect(three.status).toBe(200);
  expect(three.data?.advisor.enabled).toBe(true);
  expect(three.data?.advisor.model).toBe(before.advisor.model);
  expect(three.data?.supervisor.everyToolCalls).toBe(10); // untouched group intact

  const scalar = await put({ model: "provider/other" });
  expect(scalar.status).toBe(200);
  expect(scalar.data?.model).toBe("provider/other");
  expect(scalar.data?.supervisor.enabled).toBe(true);

  const bad = await put({ supervisor: { enabled: "yes" } });
  expect(bad.status).toBe(400);
  expect(bad.error).toContain("supervisor.enabled");
}, 20_000);

// A rebuild that the browser cannot see cost real debugging time: disk had a
// new bundle, the page kept running the old one.
test("index.html revalidates and hashed assets are immutable", async () => {
  const base = `http://127.0.0.1:${port}`;

  const index = await fetch(`${base}/`);
  if (index.status === 503) return; // UI not built in this checkout; nothing to assert
  expect(index.status).toBe(200);
  expect(index.headers.get("content-type")).toContain("text/html");
  expect(index.headers.get("cache-control")).toBe("no-cache");
  const lastModified = index.headers.get("last-modified");
  expect(lastModified).toBeTruthy();

  // With a validator, revalidation costs a 304 rather than the whole document.
  const revalidated = await fetch(`${base}/`, { headers: { "if-modified-since": lastModified! } });
  expect(revalidated.status).toBe(304);

  // Find whatever bundle this build produced rather than hardcoding a hash.
  const html = await index.text();
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  if (asset === undefined) return; // no hashed entry to check
  const bundle = await fetch(`${base}${asset}`);
  expect(bundle.status).toBe(200);
  expect(bundle.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(bundle.headers.get("content-type")).toContain("javascript");
}, 20_000);

test("a WebSocket client gets its opening snapshot, and an error for garbage", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const seen: { type: string }[] = [];
  const done = Promise.withResolvers<void>();

  ws.onmessage = (e) => {
    seen.push(JSON.parse(String(e.data)) as { type: string });
    // Resolve on the reply to the garbage rather than on a message count: the
    // opening snapshot has grown once already (hot, cold, and now metrics), and
    // an assertion keyed to how many frames arrive first fails on the next
    // channel added rather than on anything being wrong.
    if (seen.some((s) => s.type === "error")) done.resolve();
  };
  ws.onerror = () => done.reject(new Error("websocket failed to connect"));
  ws.onopen = () => ws.send("this is not json");

  await Promise.race([
    done.promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`only got ${seen.map((s) => s.type)}`)), 10_000)),
  ]);
  ws.close();

  const types = seen.map((s) => s.type);
  // Both states arrive unasked, so a client paints something before it has
  // sent anything.
  expect(types).toContain("hot");
  expect(types).toContain("cold");
  // The old handler was `message(_ws) {}` — garbage was silently discarded.
  expect(types).toContain("error");
}, 20_000);
