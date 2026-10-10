/**
 * Every verb with a handler of its own reaches that handler. `card` once fell
 * through to `pr` (a `case` added between `card` and `cards`), and for a night
 * no session could add a card from the CLI. Each case runs the real CLI
 * against a server that only records what was asked of it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

const asked: string[] = [];
const bodies: Record<string, unknown>[] = [];
/** What a path answers, when not `[]`. */
const replies = new Map<string, unknown>();
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path !== "/api/health") asked.push(`${req.method} ${path}`);
      if (req.method === "POST") bodies.push((await req.json().catch(() => ({}))) as Record<string, unknown>);
      return Response.json({ ok: true, data: replies.get(path) ?? [] });
    },
  });
});
afterAll(() => server.stop(true));

/** The CLI as a session's command runs it: `session` is the
 *  `AGENTBOX_SESSION` its provider passes down (Codex passes none). */
async function agentbox(...args: string[]): Promise<{ out: string; err: string; asked: string[]; code: number }>;
async function agentbox(opts: { session: string | null }, ...args: string[]): Promise<{ out: string; err: string; asked: string[]; code: number }>;
async function agentbox(...all: (string | { session: string | null })[]) {
  const opts = typeof all[0] === "object" ? (all.shift() as { session: string | null }) : null;
  const args = all as string[];
  asked.length = 0;
  bodies.length = 0;
  const env: Record<string, string | undefined> = { ...process.env, AGENTBOX_PORT: String(server.port) };
  delete env.AGENTBOX_SESSION;
  if (opts?.session) env.AGENTBOX_SESSION = opts.session;
  const p = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/agentbox"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, asked: [...asked], code: await p.exited };
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

/**
 * `agentbox pr claim` speaks for the session it runs in. Started with
 * `--claim 8679` and then running `agentbox pr claim 8679` itself, as
 * green-and-clean does, two omp sessions were refused as holding it and stood
 * down: the CLI sent no session, and the server's guess from the process tree
 * named a sibling. Claude and omp pass `AGENTBOX_SESSION` to commands, which
 * the CLI now sends; Codex passes none, so the server walks up from the pid.
 */
const CLAIM = { repo: "o/r", number: 8679, how: "said", at: 1 };
for (const [provider, session] of [["claude", "c1aude00"], ["omp", "vzp795ac"], ["codex", null]] as const) {
  test(`pr claim in a session of ${provider} names ${session ?? "the caller's process"}`, async () => {
    replies.set("/api/prs/claim", { ...CLAIM, sessionId: session ?? "c0dex000", already: false });
    const r = await agentbox({ session }, "pr", "claim", "8679");
    expect(r.asked).toEqual(["POST /api/prs/claim"]);
    expect(bodies[0]!.session).toBe(session ?? undefined);
    expect(typeof bodies[0]!.callerPid).toBe("number");
    expect(r.out).toContain(`o/r#8679 is ${session ?? "c0dex000"}'s until`);
  });

  test(`pr claim of what a session of ${provider} already holds succeeds and says nothing`, async () => {
    replies.set("/api/prs/claim", { ...CLAIM, sessionId: session ?? "c0dex000", already: true });
    const r = await agentbox({ session }, "pr", "claim", "8679");
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toBe("");
  });
}

test("--for names the session over the one it runs in", async () => {
  replies.set("/api/prs/claim", { ...CLAIM, sessionId: "other000", already: false });
  await agentbox({ session: "vzp795ac" }, "pr", "claim", "8679", "--for", "other000");
  expect(bodies[0]!.session).toBe("other000");
});
