/**
 * The hub and its nodes widen the tailnet door (docs/hub.md, Trust model),
 * so the rule is checked against real servers: three on one computer, each
 * with its own AGENTBOX_HOME, HOME, port and tmux socket, the tailnet off
 * and the seam (`AGENTBOX_TAILNET_SEAM`) standing in for `tailscale status`
 * and `whois`. Each binds its seam address on loopback (127.0.0.x), and a
 * request says where it comes from with `x-agentbox-seam-from`.
 *
 *   hub   127.0.0.2  a tagged box, owned (in members.json) by owner@team
 *   node  127.0.0.3  a tagged box that joins it, with one Claude session
 *   solo  127.0.0.10 owned by solo@team, with no hub: v2's rule
 *
 * Devices: owner@team 127.0.0.4, member@team 127.0.0.5, stranger@team
 * 127.0.0.6 (on the tailnet, not a member), another tagged box 127.0.0.7,
 * solo@team's phone 127.0.0.9.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "agentbox-hub-test-"));
const BIN = join(import.meta.dir, "..", "..", "..", "bin", "agentbox");
const SESSION_UUID = "0c9b1a52-6f1e-4c47-9a39-1f2d3e4c5b6a";

const PEERS = {
  "127.0.0.2": { userId: 10, login: null, device: "hubbox", tags: ["tag:server"] },
  "127.0.0.3": { userId: 10, login: null, device: "nodebox", tags: ["tag:server"] },
  "127.0.0.4": { userId: 1, login: "owner@team", displayName: "Owner", device: "owner-laptop", tags: [] },
  "127.0.0.5": { userId: 2, login: "member@team", displayName: "Member", device: "member-laptop", tags: [] },
  "127.0.0.6": { userId: 3, login: "stranger@team", displayName: "Stranger", device: "stranger-laptop", tags: [] },
  "127.0.0.7": { userId: 10, login: null, device: "otherbox", tags: ["tag:server"] },
  "127.0.0.9": { userId: 30, login: "solo@team", displayName: "Solo", device: "solo-phone", tags: [] },
  "127.0.0.10": { userId: 30, login: "solo@team", displayName: "Solo", device: "solobox", tags: [] },
};

type Machine = { name: string; ip: string; port: number; env: Record<string, string>; home: string; proc: ReturnType<typeof Bun.spawn> | null; log: string };

function machine(name: string, ip: string, port: number, self: Record<string, unknown>): Machine {
  const home = join(ROOT, name);
  mkdirSync(join(home, "ab"), { recursive: true });
  const seam = join(ROOT, `${name}-seam.json`);
  writeFileSync(seam, JSON.stringify({ self: { ip, hostName: name, ...self }, peers: PEERS }));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(AGENTBOX_|XDG_|CLAUDE_|CODEX_|TMUX)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    AGENTBOX_HOME: join(home, "ab"),
    AGENTBOX_PORT: String(port),
    AGENTBOX_TMUX_SOCKET: `agentbox-hubtest-${name}-${process.pid}`,
    AGENTBOX_TAILNET: "0",
    AGENTBOX_TAILNET_SEAM: seam,
  });
  return { name, ip, port, env, home, proc: null, log: join(ROOT, `${name}.log`) };
}

async function start(m: Machine): Promise<void> {
  m.proc = Bun.spawn(["bun", BIN, "serve"], { env: m.env, stdout: Bun.file(m.log), stderr: Bun.file(`${m.log}.err`), stdin: "ignore" });
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const r = await fetch(`http://127.0.0.1:${m.port}/api/state`).catch(() => null);
    if (r?.ok) {
      // And the tailnet door, which opens beside the first pass.
      const t = await fetch(`http://${m.ip}:${m.port}/api/health`, { headers: { "x-agentbox-seam-from": "127.0.0.250" } }).catch(() => null);
      if (t) return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`${m.name} did not start: ${readFileSync(`${m.log}.err`, "utf8").slice(-2000)}`);
}

async function stop(m: Machine): Promise<void> {
  m.proc?.kill("SIGTERM");
  await m.proc?.exited;
  m.proc = null;
}

type Env = { ok: boolean; data: any; error: string | null };

/** A request on loopback: this machine's owner. */
async function local(m: Machine, method: string, path: string, body?: unknown): Promise<{ status: number } & Env> {
  const res = await fetch(`http://127.0.0.1:${m.port}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agentbox": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, ...((await res.json()) as Env) };
}

/** A request over the tailnet door, from a device. */
async function from(device: string, m: Machine, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number } & Env> {
  const res = await fetch(`http://${m.ip}:${m.port}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agentbox": "1", "x-agentbox-seam-from": device, ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  try {
    return { status: res.status, ...(JSON.parse(text) as Env) };
  } catch {
    return { status: res.status, ok: false, data: null, error: text };
  }
}

async function eventually<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

/** A Claude session on the node: a transcript in its default account's home. */
function plantSession(m: Machine): void {
  const cwd = join(m.home, "proj");
  mkdirSync(cwd, { recursive: true });
  const dir = join(m.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - 60_000).toISOString();
  const base = { sessionId: SESSION_UUID, cwd, version: "2.1.0", userType: "external", isSidechain: false, gitBranch: "" };
  const lines = [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at, message: { role: "user", content: "say hello from the node" } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: at, message: { id: "msg_1", role: "assistant", model: "claude-opus-5-5", type: "message", content: [{ type: "text", text: "hello from the node" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  writeFileSync(join(dir, `${SESSION_UUID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const hub = machine("hubbox", "127.0.0.2", 47911, { userId: 10, login: null, tags: ["tag:server"] });
const node = machine("nodebox", "127.0.0.3", 47912, { userId: 10, login: null, tags: ["tag:server"] });
const solo = machine("solobox", "127.0.0.10", 47913, { userId: 30, login: "solo@team", displayName: "Solo" });

beforeAll(async () => {
  plantSession(node);
  plantSession(solo);
  await Promise.all([start(hub), start(node), start(solo)]);
}, 60_000);

afterAll(async () => {
  await Promise.all([hub, node, solo].map(stop));
  for (const m of [hub, node, solo]) Bun.spawnSync(["tmux", "-L", m.env.AGENTBOX_TMUX_SOCKET!, "kill-server"], { stderr: "ignore" });
  if (!process.env.AGENTBOX_KEEP_HUB_TEST) rmSync(ROOT, { recursive: true, force: true });
});

describe("no hub configured: v2's rule", () => {
  test("the owner's own untagged device is admitted, as the owner", async () => {
    const r = await from("127.0.0.9", solo, "GET", "/api/hub");
    expect(r.status).toBe(200);
    expect(r.data.role).toBe("none");
    expect(r.data.person).toMatchObject({ login: "solo@team", role: "owner", via: "tailnet" });
    const s = await from("127.0.0.9", solo, "GET", "/api/state?open=1");
    expect(s.status).toBe(200);
    // No hub, no node field: the board is what it was.
    for (const row of s.data.sessions) expect("node" in row).toBe(false);
  });

  test("another person's device, a tagged box and an unknown address are refused", async () => {
    for (const ip of ["127.0.0.6", "127.0.0.4", "127.0.0.7", "127.0.0.250"]) {
      const r = await from(ip, solo, "GET", "/api/state");
      expect(r.status).toBe(403);
    }
    // Not even a join request: a machine that is no hub has no such door.
    expect((await from("127.0.0.7", solo, "POST", "/api/hub/join", { body: {} })).status).toBe(403);
  });

  test("/api/node/* is refused to everyone", async () => {
    expect((await from("127.0.0.9", solo, "GET", "/api/node/state", { headers: { "x-agentbox-hub-token": "0".repeat(64) } })).status).toBe(403);
    expect((await local(solo, "GET", "/api/node/state")).status).toBe(403);
  });

  test("loopback is the machine's owner", async () => {
    const r = await local(solo, "GET", "/api/hub");
    expect(r.data.person).toMatchObject({ login: "solo@team", role: "owner", via: "local" });
  });
});

describe("a hub and a node", () => {
  let token = "";
  let sessionId = "";

  test("the hub is made and its members set, by its owner only", async () => {
    // The hub is a tagged box, which belongs to no person: it must be told its owner.
    expect((await local(hub, "POST", "/api/hub/init", {})).status).toBe(400);
    const init = await local(hub, "POST", "/api/hub/init", { owner: "owner@team" });
    expect(init.status).toBe(200);
    expect(init.data.role).toBe("hub");
    // Before member@team is a member, their device is refused.
    expect((await from("127.0.0.5", hub, "GET", "/api/state")).status).toBe(403);
    const members = [
      { login: "owner@team", role: "owner" },
      { login: "member@team", role: "member" },
    ];
    expect((await from("127.0.0.4", hub, "PUT", "/api/hub/members", { body: { members } })).status).toBe(200);
    const asMember = await from("127.0.0.5", hub, "GET", "/api/hub");
    expect(asMember.status).toBe(200);
    expect(asMember.data.person).toMatchObject({ login: "member@team", role: "member", via: "tailnet" });
    // A member cannot change the members.
    expect((await from("127.0.0.5", hub, "PUT", "/api/hub/members", { body: { members: [{ login: "member@team", role: "owner" }] } })).status).toBe(403);
  });

  test("a non-member is refused", async () => {
    for (const path of ["/api/state", "/api/hub", "/ws"]) expect((await from("127.0.0.6", hub, "GET", path)).status).toBe(403);
    expect((await from("127.0.0.6", hub, "POST", "/api/hub/join", { body: {} })).status).toBe(403);
  });

  test("join: the node asks, the owner approves, and the hub connects", async () => {
    const joined = await local(node, "POST", "/api/hub/link", { hub: `http://${hub.ip}:${hub.port}` });
    expect(joined.status).toBe(201);
    expect(joined.data.role).toBe("node");
    expect(joined.data.link.hub.ip).toBe(hub.ip);
    expect(joined.data.link.token).toBeUndefined();
    const link = JSON.parse(readFileSync(join(node.home, "ab", "hub", "link.json"), "utf8"));
    token = link.token;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    // Both sides keep it private.
    expect(Bun.spawnSync(["stat", "-c", "%a", join(node.home, "ab", "hub", "link.json")]).stdout.toString().trim()).toBe("600");
    expect(Bun.spawnSync(["stat", "-c", "%a", join(hub.home, "ab", "hub", "nodes.json")]).stdout.toString().trim()).toBe("600");

    const pending = await local(hub, "GET", "/api/hub");
    const n = pending.data.nodes.find((x: { name: string }) => x.name === "nodebox");
    expect(n).toMatchObject({ ip: node.ip, port: node.port, approvedAt: null, tags: ["tag:server"] });
    expect(JSON.stringify(pending.data)).not.toContain(token);

    // A member cannot approve; the owner can.
    expect((await from("127.0.0.5", hub, "POST", `/api/hub/nodes/${n.id}/approve`)).status).toBe(403);
    expect((await from("127.0.0.4", hub, "POST", `/api/hub/nodes/${n.id}/approve`)).status).toBe(200);
    await eventually("the hub to reach the node", async () => (await local(node, "GET", "/api/hub")).data.link.lastHubAt);
  });

  test("aggregation: the hub's board has the node's session, marked with its node", async () => {
    const row = await eventually("the node's session on the hub", async () => {
      const s = await local(hub, "GET", "/api/state");
      return s.data.sessions.find((x: { node?: string }) => x.node === "nodebox");
    });
    sessionId = row.id;
    const onNode = (await local(node, "GET", "/api/state")).data.sessions.find((x: { id: string }) => x.id === sessionId);
    expect(onNode).toBeTruthy();
    expect(row.away).toBeUndefined();
    // The hub's own sessions say they are its own; the node's own board has no node field.
    const own = (await local(hub, "GET", "/api/state")).data.sessions.filter((x: { node?: string | null }) => x.node !== "nodebox");
    for (const r of own) expect(r.node).toBeNull();
    expect("node" in onNode).toBe(false);
    const view = (await local(hub, "GET", "/api/hub")).data.nodes.find((x: { name: string }) => x.name === "nodebox");
    expect(view).toMatchObject({ reachable: true, sessions: 1 });
    expect(view.lend).toMatchObject({ accounts: "all", acceptStarts: false });
  });

  test("a request passes through to the node, as the person who made it", async () => {
    const t = await from("127.0.0.5", hub, "GET", `/api/sessions/${sessionId}/timeline`);
    expect(t.status).toBe(200);
    expect(JSON.stringify(t.data.events)).toContain("hello from the node");

    const label = await from("127.0.0.5", hub, "PATCH", `/api/sessions/${sessionId}`, { body: { label: "labelled from the hub" } });
    expect(label.status).toBe(200);
    const onNode = (await local(node, "GET", "/api/state")).data.sessions.find((x: { id: string }) => x.id === sessionId);
    expect(onNode.label).toBe("labelled from the hub");
    const audit = readFileSync(join(node.home, "ab", "hub", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ method: "PATCH", path: `/api/node/sessions/${sessionId}`, person: { login: "member@team" } });

    // The hub's CSRF rule still runs first.
    expect((await from("127.0.0.5", hub, "PATCH", `/api/sessions/${sessionId}`, { body: { label: "x" }, headers: { "x-agentbox": "" } })).status).toBe(403);
  });

  test("the timeline and the terminal pass through over sockets", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/ws`);
    const frames: { type: string; sessionId?: string; events?: unknown[] }[] = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ type: "watch", sessionId }));
    const tl = await eventually("a timeline frame", async () => frames.find((f) => f.type === "timeline" && f.sessionId === sessionId));
    expect(JSON.stringify(tl.events)).toContain("hello from the node");
    ws.close();

    // The session is in no tmux, so the node's terminal says so and closes
    // with 4000; the hub passes both on.
    const term = new WebSocket(`ws://127.0.0.1:${hub.port}/ws/term/${sessionId}`);
    const said: string[] = [];
    term.onmessage = (e) => said.push(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer));
    const closed = await new Promise<CloseEvent>((r) => (term.onclose = r));
    expect(closed.code).toBe(4000);
    expect(said.join("")).toContain("tmux");
  });

  test("a tagged box is refused unless it is a joined node, and that only on node routes", async () => {
    // Another tagged box: a join request, and nothing else.
    expect((await from("127.0.0.7", hub, "GET", "/api/state")).status).toBe(403);
    expect((await from("127.0.0.7", hub, "GET", "/api/hub")).status).toBe(403);
    // The joined node: nothing of the hub's app.
    for (const path of ["/api/state", "/api/hub", "/ws"]) expect((await from("127.0.0.3", hub, "GET", path)).status).toBe(403);
    expect((await from("127.0.0.3", hub, "POST", "/api/hub/node/leave", { headers: { "x-agentbox-hub-token": "f".repeat(64) } })).status).toBe(403);
  });

  test("the node refuses a request without the token, or from anywhere but the hub", async () => {
    const path = "/api/node/state";
    expect((await from("127.0.0.2", node, "GET", path)).status).toBe(403);
    expect((await from("127.0.0.2", node, "GET", path, { headers: { "x-agentbox-hub-token": "a".repeat(64) } })).status).toBe(403);
    // The right token from the wrong address: another device, or loopback.
    for (const ip of ["127.0.0.4", "127.0.0.7"]) expect((await from(ip, node, "GET", path, { headers: { "x-agentbox-hub-token": token } })).status).toBe(403);
    const lo = await fetch(`http://127.0.0.1:${node.port}${path}`, { headers: { "x-agentbox-hub-token": token } });
    expect(lo.status).toBe(403);
    // And the hub itself reaches only /api/node/*.
    expect((await from("127.0.0.2", node, "GET", "/api/state", { headers: { "x-agentbox-hub-token": token } })).status).toBe(403);
    // The right token from the hub: in, and the node's own CSRF rule still holds.
    const ok = await from("127.0.0.2", node, "GET", path, { headers: { "x-agentbox-hub-token": token } });
    expect(ok.status).toBe(200);
    expect(ok.data.sessions.map((s: { id: string }) => s.id)).toContain(sessionId);
    const noHeader = await from("127.0.0.2", node, "PATCH", `/api/node/sessions/${sessionId}`, { body: { label: "y" }, headers: { "x-agentbox-hub-token": token, "x-agentbox": "" } });
    expect(noHeader.status).toBe(403);
  });

  test("a node that goes away stays listed, marked away, and comes back", async () => {
    await stop(node);
    const row = await eventually("the session marked away", async () => {
      const s = await local(hub, "GET", "/api/state");
      return s.data.sessions.find((x: { id: string; away?: unknown }) => x.id === sessionId && x.away);
    });
    expect(row.node).toBe("nodebox");
    expect(row.status).not.toBe("closed");
    expect(row.away.lastSeen).toBeGreaterThan(0);
    const r = await local(hub, "GET", `/api/sessions/${sessionId}/timeline`);
    expect(r.status).toBe(502);
    expect(r.error).toContain("nodebox");

    await start(node);
    await eventually("the node back", async () => {
      const s = await local(hub, "GET", "/api/state");
      return s.data.sessions.find((x: { id: string; away?: unknown }) => x.id === sessionId && !x.away);
    }, 30_000);
  }, 60_000);

  test("leave: the node ends its link, and the hub forgets it", async () => {
    const left = await local(node, "DELETE", "/api/hub/link");
    expect(left.status).toBe(200);
    expect(left.data.role).toBe("none");
    expect(left.data.told).toBe(true);
    const hubNow = await local(hub, "GET", "/api/hub");
    expect(hubNow.data.nodes.some((x: { name: string }) => x.name === "nodebox")).toBe(false);
    await eventually("the session gone from the hub", async () => !(await local(hub, "GET", "/api/state")).data.sessions.some((x: { id: string }) => x.id === sessionId));
    // The old token opens nothing.
    expect((await from("127.0.0.2", node, "GET", "/api/node/state", { headers: { "x-agentbox-hub-token": token } })).status).toBe(403);
  });
});
