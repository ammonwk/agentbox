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
 *
 * TLS: the hub serves HTTPS on its tailnet listener from the start, as a box
 * with `tailscale cert` does, and the node plain HTTP until it is started
 * again with a certificate. The certificates are a test CA's, which every
 * server trusts (NODE_EXTRA_CA_CERTS). Names do not resolve to 127.0.0.x on
 * one computer, so each seam's MagicDNS name is its IP, which its
 * certificate names.
 *
 * Phase 2 (placement): both the hub and the node register acme/app, a clone
 * of a bare repo standing in for GitHub (each machine's ~/.gitconfig sends
 * github.com/acme/app there). Only the node can run codex: a stand-in `codex`
 * on its PATH and an API-key login, so the hub, whose codex account is not
 * logged in, has no room for one. Push services are an HTTPS sink on
 * loopback that counts what each device was sent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { choose, type Machine as Place } from "../placement";
import { Ctx } from "../../../superagents/salus/lib/ctx";
import { Settings, writeSettings } from "../../../superagents/salus/lib/settings";
import { Store } from "../../../superagents/salus/lib/store";
import { record } from "../../../superagents/salus/lib/tick";
import { startTriage } from "../../../superagents/salus/lib/triage";

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

type Machine = { name: string; ip: string; port: number; env: Record<string, string>; home: string; proc: ReturnType<typeof Bun.spawn> | null; log: string; self: Record<string, unknown>; tls: boolean };

/** A test CA, and a certificate from it for each address that serves TLS. */
const CA_KEY = join(ROOT, "ca.key");
const CA = join(ROOT, "ca.crt");
const openssl = (...args: string[]): void => {
  const r = Bun.spawnSync(["openssl", ...args], { stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr.toString()}`);
};
openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", CA_KEY, "-out", CA, "-days", "1", "-subj", "/CN=agentbox hub test CA", "-addext", "basicConstraints=critical,CA:TRUE");
const caPem = readFileSync(CA, "utf8");
function certFor(ip: string): { cert: string; key: string } {
  const [key, csr, cert, ext] = ["key", "csr", "crt", "ext"].map((x) => join(ROOT, `${ip}.${x}`)) as [string, string, string, string];
  openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${ip}`);
  writeFileSync(ext, `subjectAltName=IP:${ip}\n`);
  openssl("x509", "-req", "-in", csr, "-CA", CA, "-CAkey", CA_KEY, "-CAcreateserial", "-out", cert, "-days", "1", "-extfile", ext);
  return { cert, key };
}

/** The machine's seam: with `tls`, it serves HTTPS at its MagicDNS name. */
function writeSeam(m: Pick<Machine, "name" | "ip" | "self" | "tls">): void {
  const tls = m.tls ? { dnsName: m.ip, tls: certFor(m.ip) } : {};
  writeFileSync(join(ROOT, `${m.name}-seam.json`), JSON.stringify({ self: { ip: m.ip, hostName: m.name, ...m.self, ...tls }, peers: PEERS }));
}

/** A stand-in `claude` on every machine's PATH: a Claude account is made only
 *  for a CLI that is installed, and its transcripts are read only then, so
 *  without it the sessions planted here exist only where the host has Claude. */
const CLAUDE_BIN = join(ROOT, "claude-bin");
mkdirSync(CLAUDE_BIN, { recursive: true });
writeFileSync(join(CLAUDE_BIN, "claude"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi\nexec sleep 600\n');
chmodSync(join(CLAUDE_BIN, "claude"), 0o755);

function machine(name: string, ip: string, port: number, self: Record<string, unknown>, extra: Record<string, string> = {}, tls = false): Machine {
  const home = join(ROOT, name);
  mkdirSync(join(home, "ab"), { recursive: true });
  const seam = join(ROOT, `${name}-seam.json`);
  writeSeam({ name, ip, self, tls });
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
    NODE_EXTRA_CA_CERTS: CA,
    ...extra,
    PATH: `${CLAUDE_BIN}:${extra.PATH ?? process.env.PATH}`,
  });
  return { name, ip, port, env, home, proc: null, log: join(ROOT, `${name}.log`), self, tls };
}

/** The machine's tailnet door, as a device on the tailnet reaches it. */
const door = (m: Machine): string => `${m.tls ? "https" : "http"}://${m.ip}:${m.port}`;

async function start(m: Machine): Promise<void> {
  m.proc = Bun.spawn(["bun", BIN, "serve"], { env: m.env, stdout: Bun.file(m.log), stderr: Bun.file(`${m.log}.err`), stdin: "ignore" });
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const r = await fetch(`http://127.0.0.1:${m.port}/api/state`).catch(() => null);
    if (r?.ok) {
      // And the tailnet door, which opens beside the first pass.
      const t = await fetch(`${door(m)}/api/health`, { headers: { "x-agentbox-seam-from": "127.0.0.250" }, tls: { ca: caPem } }).catch(() => null);
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
  const res = await fetch(`${door(m)}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-agentbox": "1", "x-agentbox-seam-from": device, ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    tls: { ca: caPem },
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

const git = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

/** GitHub's acme/app, as a bare repo; its main's commit. */
const ORIGIN = join(ROOT, "origin.git");
let MAIN_SHA = "";
function plantOrigin(): void {
  const work = join(ROOT, "origin-work");
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q");
  writeFileSync(join(work, "README.md"), "acme/app\n");
  git(work, "add", "README.md");
  git(work, "commit", "-q", "-m", "first");
  git(ROOT, "clone", "-q", "--bare", work, ORIGIN);
  MAIN_SHA = git(ORIGIN, "rev-parse", "main");
}

/** A clone of acme/app on a machine, its origin named as GitHub's. */
function plantClone(m: Machine): string {
  const dir = join(m.home, "app");
  git(ROOT, "clone", "-q", ORIGIN, dir);
  git(dir, "remote", "set-url", "origin", "https://github.com/acme/app.git");
  return dir;
}

/** Registered as acme/app; from then on the machine's git fetches GitHub's acme/app from the bare repo. */
async function registerRepo(m: Machine, dir: string): Promise<string> {
  const r = await local(m, "POST", "/api/repos", { ref: dir });
  expect(r.status).toBe(201);
  expect(r.data.fullName).toBe("acme/app");
  writeFileSync(join(m.home, ".gitconfig"), `[url "${ORIGIN}"]\n\tinsteadOf = https://github.com/acme/app.git\n`);
  return r.data.id;
}

/** A `codex` that answers --version and otherwise sits, and a login it is happy with. */
function plantCodex(m: Machine): string {
  const bin = join(ROOT, `${m.name}-bin`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.200.0"; exit 0; fi\nexec sleep 600\n');
  chmodSync(join(bin, "codex"), 0o755);
  mkdirSync(join(m.home, ".codex"), { recursive: true });
  writeFileSync(join(m.home, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
  return bin;
}

/** Push services: an HTTPS sink that counts the messages each device was sent. */
const pushed = new Map<string, number>();
let sink: ReturnType<typeof Bun.serve> | null = null;
function startSink(): void {
  const { key, cert } = certFor("127.0.0.1");
  sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(key), cert: Bun.file(cert) },
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      pushed.set(path, (pushed.get(path) ?? 0) + 1);
      return new Response(null, { status: 201 });
    },
  });
}

/** A browser's push subscription for a device whose sink path is `name`. */
async function subscription(name: string): Promise<Record<string, unknown>> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))).toString("base64url");
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  return { endpoint: `https://127.0.0.1:${sink!.port}/${name}`, keys: { p256dh, auth } };
}

/** A port nothing holds, a closing socket's TIME-WAIT included: a fixed one
 *  is refused for a minute after the last run (the server's port hold does
 *  not reuse it). */
function freePort(): number {
  const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = l.port;
  l.stop(true);
  return port;
}

const NODE_BIN = join(ROOT, "nodebox-bin");
const hub = machine("hubbox", "127.0.0.2", freePort(), { userId: 10, login: null, tags: ["tag:server"] }, {}, true);
const node = machine("nodebox", "127.0.0.3", freePort(), { userId: 10, login: null, tags: ["tag:server"] }, { PATH: `${NODE_BIN}:${process.env.PATH}` });
const solo = machine("solobox", "127.0.0.10", freePort(), { userId: 30, login: "solo@team", displayName: "Solo" });
let hubRepoId = "";

beforeAll(async () => {
  plantSession(node);
  plantSession(solo);
  plantCodex(node);
  plantOrigin();
  const hubClone = plantClone(hub);
  const nodeClone = plantClone(node);
  startSink();
  await Promise.all([start(hub), start(node), start(solo)]);
  hubRepoId = await registerRepo(hub, hubClone);
  await registerRepo(node, nodeClone);
}, 60_000);

afterAll(async () => {
  sink?.stop(true);
  await Promise.all([hub, node, solo].map(stop));
  for (const m of [hub, node, solo]) Bun.spawnSync(["tmux", "-L", m.env.AGENTBOX_TMUX_SOCKET!, "kill-server"], { stderr: "ignore" });
  if (!process.env.AGENTBOX_KEEP_HUB_TEST) rmSync(ROOT, { recursive: true, force: true });
});

/** A page on the hub watches a node's session and opens its terminal: both
 *  relayed through the hub's sockets to the node. */
async function relays(sessionId: string): Promise<void> {
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
}

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
    // A bare address is tried over HTTPS first: the hub serves only that.
    const joined = await local(node, "POST", "/api/hub/link", { hub: `${hub.ip}:${hub.port}` });
    expect(joined.status).toBe(201);
    expect(joined.data.role).toBe("node");
    expect(joined.data.link.hub).toMatchObject({ ip: hub.ip, url: `https://${hub.ip}:${hub.port}` });
    expect(joined.data.link.token).toBeUndefined();
    const link = JSON.parse(readFileSync(join(node.home, "ab", "hub", "link.json"), "utf8"));
    token = link.token;
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    // Both sides keep it private.
    expect(Bun.spawnSync(["stat", "-c", "%a", join(node.home, "ab", "hub", "link.json")]).stdout.toString().trim()).toBe("600");
    expect(Bun.spawnSync(["stat", "-c", "%a", join(hub.home, "ab", "hub", "nodes.json")]).stdout.toString().trim()).toBe("600");

    const pending = await local(hub, "GET", "/api/hub");
    const n = pending.data.nodes.find((x: { name: string }) => x.name === "nodebox");
    // Each side keeps the URL the other serves at.
    expect(n).toMatchObject({ ip: node.ip, url: `http://${node.ip}:${node.port}`, approvedAt: null, tags: ["tag:server"] });
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

  test("the timeline and the terminal pass through over sockets", () => relays(sessionId));

  test("a node says where it serves only as itself", async () => {
    const said = (url: string) => from("127.0.0.3", hub, "POST", "/api/hub/node/url", { body: { url }, headers: { "x-agentbox-hub-token": token } });
    expect((await said(`https://127.0.0.7:${node.port}`)).status).toBe(400);
    expect((await said("ftp://127.0.0.3:21")).status).toBe(400);
    expect((await said(`http://${node.ip}:${node.port}`)).status).toBe(200);
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

  // ---- phase 2: placement, worktrees at a ref, superagents, people

  test("a node refuses starts until its owner lends them, and then within its limit", async () => {
    const body = { provider: "codex", node: "nodebox", repo: "acme/app", ref: "main", readOnly: true, notify: false, prompt: "look around" };
    const no = await from("127.0.0.5", hub, "POST", "/api/sessions", { body });
    expect(no.status).toBe(403);
    expect(no.error).toContain("nodebox does not take starts");
    // Auto has nowhere either: the hub has no codex account with room, the node takes no starts.
    const none = await from("127.0.0.5", hub, "POST", "/api/sessions", { body: { ...body, node: "auto" } });
    expect(none.status).toBe(409);
    expect(none.error).toContain("no machine can take it");
    expect(none.error).toContain("nodebox: it does not take starts");

    expect((await local(node, "PATCH", "/api/hub/link", { lend: { acceptStarts: true, maxSessions: 1 } })).status).toBe(200);
    await eventually("the hub to hear the node lends starts", async () => {
      const v = (await local(hub, "GET", "/api/hub")).data.nodes.find((x: { name: string }) => x.name === "nodebox");
      return v?.reachable && v.lend?.acceptStarts && v.repos?.some((r: { fullName: string }) => r.fullName === "acme/app") && v.headroom?.some((h: { provider: string; eligible: boolean }) => h.provider === "codex" && h.eligible);
    }, 30_000);
  }, 60_000);

  let placedId = "";
  test("auto places a repo-and-ref start on the node with room, which cuts a detached worktree at the fetched commit", async () => {
    const r = await from("127.0.0.5", hub, "POST", "/api/sessions", { body: { provider: "codex", node: "auto", repo: "acme/app", ref: "main", readOnly: true, notify: false, prompt: "read the README" } });
    expect(r.status).toBe(201);
    expect(r.data.node).toBe("nodebox");
    expect(r.data.session.node).toBe("nodebox");
    placedId = r.data.session.id;
    const cwd = r.data.session.cwd as string;
    // On the node's disk, under its own worktree root: at origin's main, detached, and nobody's branch.
    expect(cwd.startsWith(node.home)).toBe(true);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(MAIN_SHA);
    expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd }).exitCode).not.toBe(0);
    // The hub shows it as the node's, and the node knows who asked.
    await eventually("the placed session on the hub's board", async () => (await local(hub, "GET", "/api/state")).data.sessions.find((x: { id: string; node?: string }) => x.id === placedId && x.node === "nodebox"));
    const audit = readFileSync(join(node.home, "ab", "hub", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.some((a: { path: string; person: { login: string } }) => a.path === "/api/node/sessions" && a.person.login === "member@team")).toBe(true);
  }, 60_000);

  test("a node at its limit refuses another start, and says why", async () => {
    const body = { provider: "codex", repo: "acme/app", ref: "main", readOnly: true, notify: false, prompt: "again" };
    const named = await from("127.0.0.5", hub, "POST", "/api/sessions", { body: { ...body, node: "nodebox" } });
    expect(named.status).toBe(409);
    expect(named.error).toContain("at its limit");
    const auto = await from("127.0.0.5", hub, "POST", "/api/sessions", { body: { ...body, node: "auto" } });
    expect(auto.status).toBe(409);
    expect(auto.error).toContain("limit");
    // An account the node does not lend is refused outright.
    await local(node, "PATCH", "/api/hub/link", { lend: { accounts: [] } });
    const lent = await from("127.0.0.5", hub, "POST", "/api/sessions", { body: { ...body, node: "nodebox", accountId: "not-lent" } });
    expect([403, 409]).toContain(lent.status);
    await local(node, "PATCH", "/api/hub/link", { lend: { accounts: "all" } });
  }, 60_000);

  test("closing a placed session through the hub removes the worktree it was cut", async () => {
    await eventually("the hub to reach the node again", async () => (await local(hub, "GET", `/api/sessions/${placedId}/timeline`)).status !== 502, 30_000);
    const cwd = (await local(node, "GET", "/api/state")).data.sessions.find((x: { id: string }) => x.id === placedId).cwd;
    const r = await from("127.0.0.5", hub, "POST", `/api/sessions/${placedId}/close`, { body: { closed: true, removeWorktree: true } });
    expect(r.status).toBe(200);
    expect(r.data.worktreeRemoved).toBe(true);
    expect(existsSync(cwd)).toBe(false);
  }, 60_000);

  test("Salus starts its triage where there is room: on the node, at the base's commit", async () => {
    // The lending changed in the test before, so the hub reconnects.
    await eventually("the node reachable again", async () => (await local(hub, "GET", "/api/hub")).data.nodes.find((x: { name: string; reachable: boolean }) => x.name === "nodebox" && x.reachable), 30_000);
    // Salus registered on the hub, opted in to "auto"; its program is this test.
    const dir = join(ROOT, "salus");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "superagent.json"), JSON.stringify({ name: "salus", node: "auto" }));
    expect((await local(hub, "POST", "/api/superagents", { dir })).status).toBe(201);
    expect((await local(hub, "GET", "/api/superagents/salus")).data.node).toBe("auto");
    const home = join(ROOT, "salus-home");
    mkdirSync(home, { recursive: true });
    Object.assign(process.env, { AGENTBOX_URL: `http://127.0.0.1:${hub.port}`, AGENTBOX_SUPERAGENT: "salus", AGENTBOX_SUPERAGENT_HOME: home });
    writeSettings(home, Settings.parse({ enabled: true, projectId: "1", repo: hubRepoId, minCount: 1 }));
    const asked: string[] = [];
    const gh = async <T>(path: string): Promise<T> => {
      asked.push(path);
      if (path === "repos/acme/app/commits/main") return { sha: MAIN_SHA } as T;
      throw new Error(`gh ${path}`);
    };
    const noGit = async (): Promise<string> => {
      throw new Error("Salus runs no git of its own for a triage");
    };
    const ctx = new Ctx(new Store(new Database(":memory:")), { git: noGit, gh }, home, "agentbox", () => null);
    const now = Date.now();
    record(ctx, [{ key: "crash-a", count: 3, first: now - 60_000, last: now, sample: { type: "TypeError", value: "x is undefined", frames: [], url: null, lib: "posthog-node" } }], now);
    const c = await startTriage(ctx, "crash-a");
    expect(asked).toEqual(["repos/acme/app/commits/main"]);
    expect(c.triage).toMatchObject({ base: MAIN_SHA });
    const id = c.triage!.session!;
    const row = await eventually("the triage on the hub's board", async () => (await local(hub, "GET", "/api/state")).data.sessions.find((x: { id: string }) => x.id === id));
    expect(row.node).toBe("nodebox");
    expect(c.triage!.cwd.startsWith(node.home)).toBe(true);
    expect(git(c.triage!.cwd, "rev-parse", "HEAD")).toBe(MAIN_SHA);
    // Done with: closed, and its checkout gone from the node.
    expect((await local(hub, "POST", `/api/sessions/${id}/close`, { closed: true, removeWorktree: true })).data.worktreeRemoved).toBe(true);
    for (const k of ["AGENTBOX_URL", "AGENTBOX_SUPERAGENT", "AGENTBOX_SUPERAGENT_HOME"]) delete process.env[k];
  }, 60_000);

  test("a card for a member is pushed to that member's devices only; one for nobody, to the owner's", async () => {
    expect((await from("127.0.0.4", hub, "POST", "/api/push/subscribe", { body: await subscription("owner-phone") })).status).toBe(200);
    expect((await from("127.0.0.5", hub, "POST", "/api/push/subscribe", { body: await subscription("member-phone") })).status).toBe(200);
    // Each sees only their own devices.
    expect((await from("127.0.0.5", hub, "GET", "/api/push")).data.devices.map((d: { endpoint: string }) => d.endpoint.split("/").pop())).toEqual(["member-phone"]);
    // A card names a member, or nobody.
    expect((await local(hub, "POST", "/api/cards", { kind: "decision", title: "x", short: "y", person: "stranger@team" })).status).toBe(400);
    const mine = await local(hub, "POST", "/api/cards", { kind: "decision", title: "Member's call", short: "Yours to decide.", person: "Member@Team" });
    expect(mine.data.person).toBe("member@team");
    await local(hub, "POST", "/api/cards", { kind: "decision", title: "Owner's call", short: "The owner's." });
    // New decisions are pushed as one batch, 20 seconds after the first.
    await eventually("the batch to be pushed", async () => (pushed.get("/member-phone") ?? 0) > 0 && (pushed.get("/owner-phone") ?? 0) > 0, 40_000);
    await Bun.sleep(1_000);
    expect(pushed.get("/member-phone")).toBe(1);
    expect(pushed.get("/owner-phone")).toBe(1);
    // A test push from a member reaches their device, not the owner's.
    expect((await from("127.0.0.5", hub, "POST", "/api/push/test")).data.sent).toBe(1);
    expect(pushed.get("/member-phone")).toBe(2);
    expect(pushed.get("/owner-phone")).toBe(1);
    // Who answered is on the card.
    const answered = await from("127.0.0.5", hub, "POST", `/api/cards/${mine.data.id}/answer`, { body: { text: "go ahead" } });
    expect(answered.data.decidedBy).toEqual({ login: "member@team", name: "Member" });
  }, 60_000);

  test("what is the owner's alone is refused to a member; a member still starts and reads", async () => {
    const refused: [string, string, unknown?][] = [
      ["PUT", "/api/settings", {}],
      ["POST", "/api/superagents", { dir: "/tmp" }],
      ["DELETE", "/api/superagents/salus"],
      ["PATCH", "/api/superagents/salus", { node: null }],
      ["POST", "/api/accounts", { provider: "codex" }],
      ["PATCH", "/api/accounts/anything", { enabled: false }],
      ["POST", "/api/mcp/servers", { name: "x", command: "true" }],
      ["PATCH", `/api/repos/${hubRepoId}`, { setup: { copy: [], run: "touch /tmp/pwned" } }],
      ["POST", "/api/worktrees/reclaim", { paths: [] }],
      ["POST", "/api/waits", { session: "abc123", spec: { kind: "until", cmd: "true", cwd: "/" } }],
      ["POST", "/api/schedules", { when: "in 4 hours", spec: { provider: "codex", cwd: "/tmp" }, noteCmd: "true" }],
    ];
    for (const [method, path, body] of refused) {
      const r = await from("127.0.0.5", hub, method, path, { body });
      expect({ method, path, status: r.status }).toEqual({ method, path, status: 403 });
      expect(r.error).toContain("only the hub's owner");
    }
    expect((await from("127.0.0.5", hub, "GET", "/ws/voice?c=abcdefgh", { headers: { upgrade: "websocket", connection: "upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } })).status).toBe(403);
    // Reads stay open, and the owner may.
    expect((await from("127.0.0.5", hub, "GET", "/api/accounts")).status).toBe(200);
    expect((await from("127.0.0.5", hub, "GET", "/api/settings")).status).toBe(200);
    expect((await from("127.0.0.4", hub, "PUT", "/api/settings", { body: {} })).status).toBe(200);
    expect((await from("127.0.0.4", hub, "PATCH", "/api/superagents/salus", { body: { node: "local" } })).data.node).toBeNull();
    // With no hub, the machine's owner on the tailnet is refused nothing.
    expect((await from("127.0.0.9", solo, "PUT", "/api/settings", { body: {} })).status).toBe(200);
    // And a start with a node is a hub's alone.
    expect((await local(solo, "POST", "/api/sessions", { provider: "codex", node: "auto", repo: "acme/app" })).status).toBe(409);
  }, 60_000);

  test("a node that goes away stays listed, marked away, and comes back on HTTPS", async () => {
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

    // It comes back with a certificate, so it serves only HTTPS now: it tells
    // the hub, which reaches it there, sockets and all.
    node.tls = true;
    writeSeam(node);
    await start(node);
    await eventually("the node back", async () => {
      const s = await local(hub, "GET", "/api/state");
      return s.data.sessions.find((x: { id: string; away?: unknown }) => x.id === sessionId && !x.away);
    }, 30_000);
    const view = (await local(hub, "GET", "/api/hub")).data.nodes.find((x: { name: string }) => x.name === "nodebox");
    expect(view).toMatchObject({ reachable: true, url: `https://${node.ip}:${node.port}` });
    expect((await local(hub, "GET", `/api/sessions/${sessionId}/timeline`)).status).toBe(200);
    await relays(sessionId);
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

describe("auto placement chooses by room", () => {
  const room = (weekly: number | null, short: number | null = null) => [{ id: "a", provider: "codex" as const, label: "a", eligible: true, weekly, short, weeklyResetsAt: null, shortResetsAt: null }];
  const repos = [{ fullName: "acme/app", displayName: "app" }];
  const m = (node: string | null, over: Partial<Place> = {}): Place => ({ node, reachable: true, lend: { acceptStarts: true, maxSessions: null }, headroom: room(50), repos, placed: 0, ...over });
  const want = { provider: "codex" as const, repo: "acme/app" };

  test("the most room wins, measured by an account's fuller window; the hub wins a tie", () => {
    expect(choose([m(null, { headroom: room(60) }), m("a", { headroom: room(20) }), m("b", { headroom: room(10, 70) })], want)).toMatchObject({ ok: true, node: "a", room: 80 });
    expect(choose([m(null), m("a")], want)).toMatchObject({ ok: true, node: null });
  });

  test("away, closed to starts, at its limit, without the repo or without a lent account with room: not a candidate", () => {
    const c = choose(
      [
        m(null, { headroom: [] }),
        m("away", { reachable: false, headroom: room(0) }),
        m("closed", { lend: { acceptStarts: false, maxSessions: null }, headroom: room(0) }),
        m("full", { lend: { acceptStarts: true, maxSessions: 2 }, placed: 2, headroom: room(0) }),
        m("norepo", { repos: [], headroom: room(0) }),
        m("private", { headroom: null }),
        m("spent", { headroom: [{ ...room(100)[0]!, eligible: false }] }),
        m("ok", { headroom: room(95) }),
      ],
      want,
    );
    expect(c).toMatchObject({ ok: true, node: "ok", room: 5 });
    if (!c.ok) return;
    expect(Object.fromEntries(c.considered.map((x) => [x.node ?? "hub", x.why]))).toEqual({
      hub: "it has no codex account with room",
      away: "it is away",
      closed: "it does not take starts from the hub",
      full: "it is at its limit (2 of 2 open)",
      norepo: "it has no acme/app registered",
      private: "it does not share its accounts' use",
      spent: "it has no codex account with room that it lends",
      ok: null,
    });
  });

  test("a start that names a directory, not a repo, stays on the hub", () => {
    expect(choose([m(null, { headroom: room(90) }), m("a", { headroom: room(0) })], { provider: "codex", repo: null })).toMatchObject({ ok: true, node: null });
    expect(choose([m(null, { headroom: [] }), m("a", { headroom: room(0) })], { provider: "codex", repo: null })).toMatchObject({ ok: false });
  });
});
