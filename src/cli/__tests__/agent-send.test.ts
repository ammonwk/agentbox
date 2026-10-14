/** One agent reaches another's chat by name, without its ID, a script or
 *  its session; the message goes in as this session's, with its sender. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { pickAgent } from "../agents";

const agent = (id: string, name: string, repo: string | null, session: string | null, enabled = true, previous: string[] = []) =>
  ({ id, name, role: "r", repo, session, previous, enabled }) as any;
const board = { sessions: [{ id: "term-chat", status: "waiting" }, { id: "vul-chat", status: "running" }], repos: [{ id: "p1", displayName: "Plaibook-dev" }, { id: "p2", displayName: "agentbox" }] } as any;
let agents = [
  agent("local-terminus-p1", "TERMINUS", "p1", "term-chat"),
  agent("local-terminus-p2", "TERMINUS", "p2", null),
  agent("local-vulcan-p1", "VULCAN", "p1", "vul-chat", true, ["old-vul"]),
  agent("local-salus-p1", "SALUS", "p1", null, false),
];

test("a name means the caller's project's instance, or --project's; an ID means itself", () => {
  expect(pickAgent(agents, board, "terminus", null, "vul-chat").id).toBe("local-terminus-p1");
  expect(pickAgent(agents, board, "Terminus", "agentbox", "vul-chat").id).toBe("local-terminus-p2");
  expect(pickAgent(agents, board, "local-terminus-p2", null, null).id).toBe("local-terminus-p2");
  expect(() => pickAgent(agents, board, "terminus", null, null)).toThrow(/several projects[\s\S]*local-terminus-p1[\s\S]*local-terminus-p2/);
  expect(() => pickAgent(agents, board, "jupiter", null, null)).toThrow(/agent ls/);
});

const asked: { path: string; body: any }[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? await req.json() : null;
      if (path !== "/api/health") asked.push({ path, body });
      const data = path === "/api/agents/local" ? agents : path === "/api/state" ? board
        : path.endsWith("/chat") ? (agents = agents.map((a) => (a.id === "local-terminus-p2" ? { ...a, session: "new-chat" } : a)), { state: "sent", result: "" })
        : path.endsWith("/send") ? { to: "term-chat" } : [];
      return Response.json({ ok: true, data });
    },
  });
});
afterAll(() => server.stop(true));
async function cli(...args: string[]) {
  asked.length = 0;
  const p = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/agentbox"), "agent", ...args], {
    env: { ...process.env, AGENTBOX_PORT: String(server.port), AGENTBOX_SESSION: "vul-chat" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, code: await p.exited };
}

test("agent send types into the agent's current chat as this session's message, waking it", async () => {
  const r = await cli("send", "terminus", "PR", "#9220", "is", "ready", "--at", "head");
  expect(r.code).toBe(0);
  const sent = asked.find((a) => a.path === "/api/sessions/term-chat/send")!;
  expect(sent.body).toMatchObject({ text: "PR #9220 is ready --at head", from: "agent", wake: true, fromSession: "vul-chat" });
  expect(r.out).toContain("its chat term-chat took it");
});

test("agent send starts a chat for an agent that has none, and says so; a paused agent is refused", async () => {
  const r = await cli("send", "terminus", "--project", "agentbox", "Hello");
  expect(r.code).toBe(0);
  expect(asked.find((a) => a.path === "/api/agents/local/local-terminus-p2/chat")!.body).toMatchObject({ body: "Hello", target: null });
  expect(r.out).toContain("started a new conversation, session new-chat");
  const paused = await cli("send", "salus", "Hello");
  expect(paused.code).not.toBe(0);
  expect(paused.err).toContain("paused");
});

test("agent ls shows each agent, its state and its current chat", async () => {
  const r = await cli("ls");
  expect(r.out).toMatch(/TERMINUS\s+on\s+Plaibook-dev\s+term-chat\s+waiting\s+local-terminus-p1/);
  expect(r.out).toMatch(/SALUS\s+paused\s+Plaibook-dev\s+no chat/);
  const json = JSON.parse((await cli("ls", "--project", "agentbox", "--json")).out);
  expect(json.map((a: any) => a.id)).toEqual(["local-terminus-p2"]);
});
