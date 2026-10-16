/** A worker started with --worktree must not run in the shared checkout:
 *  three detached workers once started on main in the live checkout. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string, server: ReturnType<typeof Bun.serve>;
const posted: any[] = [];
beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "start-worktree-")));
  Bun.spawnSync(["git", "init", "-q", repo]);
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST") posted.push(await req.json());
      const data = path === "/api/state" ? { sessions: [], accounts: [], repos: [{ id: "r1", checkoutRoot: repo }] }
        : path === "/api/sessions" ? { session: { id: "abcd1234" }, placement: { accountId: "a", why: "room", candidates: [] } } : null;
      return Response.json({ ok: true, data });
    },
  });
});
afterAll(() => { server.stop(true); rmSync(repo, { recursive: true, force: true }); });
const start = async (cwd: string, ...args: string[]) => {
  posted.length = 0;
  const p = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/agentbox"), "claude", ...args], { cwd, env: { ...process.env, AGENTBOX_PORT: String(server.port) }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, code: await p.exited };
};

test("--worktree starts in a new worktree of the registered repo it runs in", async () => {
  const r = await start(repo, "--worktree", "--detach", "Fix", "#35");
  expect(r.code).toBe(0);
  expect(posted[0]).toMatchObject({ provider: "claude", repoId: "r1", worktree: true, prompt: "Fix #35" });
  expect(posted[0].cwd).toBeUndefined();
  await start(repo, "--branch", "fix/x", "--detach", "Go");
  expect(posted[0]).toMatchObject({ repoId: "r1", worktree: true, branch: "fix/x" });
});

test("without it, it runs here; outside a registered repo, --worktree is refused", async () => {
  await start(repo, "--detach", "Here");
  expect(posted[0]).toMatchObject({ cwd: repo });
  expect(posted[0].worktree).toBeUndefined();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "not-a-repo-")));
  const r = await start(elsewhere, "--worktree", "--detach", "x");
  expect(r.code).toBe(2);
  expect(r.err).toContain("registered repo");
  expect(posted).toHaveLength(0);
  rmSync(elsewhere, { recursive: true, force: true });
});
