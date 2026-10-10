/**
 * Every verb with a handler of its own reaches that handler. `card` once fell
 * through to `pr` (a `case` added between `card` and `cards`), and for a night
 * no session could add a card from the CLI. Each case runs the real CLI
 * against a server that only records what was asked of it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const asked: string[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/api/health") asked.push(`${req.method} ${path}`);
      return Response.json({ ok: true, data: [] });
    },
  });
});
afterAll(() => server.stop(true));

async function agentbox(...args: string[]): Promise<{ out: string; err: string; asked: string[] }> {
  asked.length = 0;
  const p = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/agentbox"), ...args], {
    env: { ...process.env, AGENTBOX_PORT: String(server.port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return { out, err, asked: [...asked] };
}

/** verb, its arguments → the request only its own handler makes. */
const REACHES: [string[], string][] = [
  [["card", "list"], "GET /api/cards"],
  [["card"], "GET /api/cards"],
  [["cards"], "GET /api/cards"],
  [["pr", "claims"], "GET /api/prs/claims"],
  [["pr"], "GET /api/prs/claims"],
  [["prs"], "GET /api/prs/claims"],
];
for (const [args, request] of REACHES) {
  test(`agentbox ${args.join(" ")} → ${request}`, async () => {
    expect((await agentbox(...args)).asked).toEqual([request]);
  });
}

/** verb with a sub-verb it does not have → its own refusal, and nothing asked of the server. */
const REFUSES: [string[], RegExp][] = [
  [["card", "zzz"], /card takes add, list, show, ack or close/],
  [["cards", "zzz"], /card takes/],
  [["pr", "zzz"], /pr takes claim, release, who or claims/],
  [["card", "add", "--kind", "note"], /card add needs --title/],
  [["schedule"], /schedule needs a time and a prompt/],
];
for (const [args, says] of REFUSES) {
  test(`agentbox ${args.join(" ")} is refused by its own handler`, async () => {
    const r = await agentbox(...args);
    expect(r.err).toMatch(says);
    expect(r.asked).toEqual([]);
  });
}

for (const verb of ["claude", "codex", "devin", "omp", "opencode", "card", "pr", "schedule", "send", "ls"]) {
  test(`agentbox ${verb} --help prints help and does nothing`, async () => {
    const r = await agentbox(verb, "--help");
    expect(r.out).toContain("claude|codex|devin|omp|opencode");
    expect(r.asked).toEqual([]);
  });
}

test("--help after a provider verb's flags starts nothing either", async () => {
  const r = await agentbox("omp", "--model", "x", "--help");
  expect(r.out).toContain("claude|codex|devin|omp|opencode");
  expect(r.asked).toEqual([]);
});
