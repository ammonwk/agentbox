/** Disposable acceptance for agent memory, rollover and pictures: the real
 * Agents routes and conversation code over a controlled fleet, in a real
 * browser. Nothing touches the user's fleet, provider homes or tmux.
 *
 *   AGENTBOX_PLAYWRIGHT_MODULE=/abs/playwright-core/index.mjs \
 *   AGENTBOX_CHROMIUM=/abs/chromium AGENTBOX_SMOKE_OUTPUT=/tmp/out \
 *   bun scripts/agent-memory-smoke.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), "agentbox-memory-"));
process.env.AGENTBOX_HOME = join(dir, "box");
const { ensureDirs } = await import("../src/core/paths");
ensureDirs();
const db = await import("../src/core/db");
const { AgentStore } = await import("../src/core/agents/store");
const { AgentConversations, CHECKPOINT_MARK } = await import("../src/core/agents/conversation");
const { AgentWorks } = await import("../src/core/agents/work");
const { agentRoutes } = await import("../src/server/agents");
const { Router, json, HttpError } = await import("../src/server/router");
const { mockServer } = await import("../web/src/mock");

/** A solid-colour PNG, a stand-in for the picture a user uploads. */
function png(rgb: [number, number, number], size = 64) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const files = join(dir, "pictures");
mkdirSync(files);
await Bun.write(join(files, "orange.png"), png([234, 120, 40]));
await Bun.write(join(files, "teal.png"), png([20, 150, 140]));
await Bun.write(join(files, "fake.png"), "not an image");

const ref = join(dir, "alpha");
mkdirSync(ref);
Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: ref });
db.insertRepo({ id: "alpha", kind: "local", ref, checkoutRoot: ref, displayName: "Alpha", fullName: "fixture/alpha", defaultBranch: "main", addedAt: Date.now(), worktreeDefault: false, setup: { copy: [], run: "" } } as any);

const base: any = await mockServer.request("GET", "/api/state", null);
const now = Date.now();
const events = new Map<string, any[]>();
const say = (id: string, kind: "user" | "assistant", text: string, at = Date.now()) => events.set(id, [...(events.get(id) ?? []), { id: `${id}-${(events.get(id) ?? []).length}`, kind, text, at }]);
const sessions: any[] = [];
function session(id: string, over: Record<string, unknown> = {}) {
  const s = { ...base.sessions[0], id, cwd: dir, repoRoot: null, title: "Vulcan chat", label: null, parent: null, children: [], status: "waiting", host: "tmux", tmux: `ab-${id}`, pid: 1, accountId: null, queued: [], question: null, limitHit: null, contextUsed: 20_000, contextLimit: 200_000, cacheWarmUntil: now + 45 * 60_000, lastActivityAt: now - 15 * 60_000, lastPromptAt: now, parkedAt: null, closedAt: null, agentSessionId: id, worktree: null, ...over };
  const at = sessions.findIndex((x) => x.id === id);
  if (at >= 0) sessions[at] = s; else sessions.push(s);
  if (!db.getSessionRecord(id)) db.insertSessionRecord({ id, provider: "codex", agentSessionId: id, accountId: null, cwd: dir, worktree: null, label: null, claim: 0, origin: "agentbox", tmux: null, transcriptPath: null, startedAt: now, lastActivityAt: now, archivedAt: null, facts: null, createdAt: now } as any);
  return s;
}
let spawned: any[] = [];
const store = new AgentStore(join(dir, "runtime.db"));
const runtime: any = {
  store,
  cards: { add: () => {}, list: () => [], close: () => {} },
  coordinators: () => [],
  fleet: {
    sessions: () => sessions,
    tick: async () => {},
    timeline: async (id: string) => ({ events: events.get(id) ?? [], before: null }),
    stopHold: async () => null,
    stopSession: async (id: string) => void session(id, { ...sessions.find((s) => s.id === id), host: "none", pid: null, tmux: null }),
    handOver: async (from: string, to: string) => db.updateSessionRecord(from, { successor: to }),
    close: async (id: string) => { db.updateSessionRecord(id, { archivedAt: Date.now() }); session(id, { ...sessions.find((s) => s.id === id), status: "closed" }); },
    heir: (id: string) => id,
    startedBy: () => [],
    spawn: async (opts: any) => {
      spawned.push(opts);
      session(opts.id, { lastActivityAt: Date.now(), cacheWarmUntil: Date.now() + 60 * 60_000, title: "Vulcan chat (continued)" });
      say(opts.id, "user", opts.prompt);
      say(opts.id, "assistant", "Picking up from the saved handoff: the memory branch is ready for review, and **one** question is still open.");
    },
    send: async (id: string, text: string, attempt?: () => void) => {
      if (await conversations.deliver(id, text, attempt)) return;
      attempt?.();
      say(id, "user", text);
      if (!text.startsWith(CHECKPOINT_MARK)) say(id, "assistant", `Noted: ${text}`);
    },
  },
};
const conversations = new AgentConversations(runtime);
runtime.conversations = conversations;
// The real routing between local and shared memory, on the controlled runtime.
const { AgentsRuntime } = await import("../src/core/agents/runtime");
for (const k of ["memoryScope", "memoryView", "memoryRecord", "remember", "current"]) runtime[k] = (AgentsRuntime.prototype as any)[k].bind(runtime);
runtime.works = new AgentWorks(runtime);
const vulcan = conversations.local("alpha").find((a) => a.name.toLowerCase() === "vulcan")!;
const jupiter = conversations.local("alpha").find((a) => a.capability === "creator")!;
const old = "chat-alpha";
session(old);
store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify({ ...vulcan, session: old, sessionProjects: { [old]: "alpha" } }), vulcan.id]);
say(old, "user", "Can you check why the release notes job failed last night?", now - 40 * 60_000);
say(old, "assistant", "The job failed in `scripts/release-notes.ts`: the changelog parser read an empty section.\n\n```ts\nconst section = parse(body) ?? []; // was parse(body)!\n```\n\nI opened a fix on branch `fix/release-notes` and armed a CI wait. A very-long-identifier-without-spaces-to-check-wrapping-in-narrow-layouts-is-handled-correctly appears here too.", now - 39 * 60_000);
say(old, "assistant", "CI is green; the PR is ready for your review.", now - 30 * 60_000);

const state = () => ({ ...base, sessions, accounts: [], logins: [], repos: [db.getRepoById("alpha")], prs: [], cards: [], skills: [], schedules: [], prClaims: [], warnings: [], onboarding: { ...base.onboarding, identity: { name: "Fixture Human", email: "human@example.test", github: "fixture-human", timezone: "UTC", context: "" } } });
const router = agentRoutes(new Router((e: any) => new HttpError(e.status ?? 500, e.message)), runtime);
router.add("GET", "/api/state", () => json(state())).add("GET", "/api/cloud", () => json({ configured: false })).add("GET", "/api/health", () => json({ version: "fixture", providers: [], deps: [], tmux: true })).add("GET", "/api/prompts", () => json([])).add("GET", "/api/models", () => json([])).add("GET", "/api/sessions/closed", () => json({ sessions: [], total: 0 }));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req, s) => { const u = new URL(req.url); if (u.pathname === "/ws" && s.upgrade(req)) return; if (u.pathname.startsWith("/api/")) return router.handle(req); const file = Bun.file(join(root, "web/dist", u.pathname === "/" ? "index.html" : u.pathname)); return (await file.exists()) ? new Response(file) : new Response(Bun.file(join(root, "web/dist/index.html"))); }, websocket: { open(ws: any) { ws.send(JSON.stringify({ type: "hot", state: { sessions, serverTime: Date.now() } })); ws.send(JSON.stringify({ type: "cold", state: state() })); }, close() {}, message() {} } });

const { chromium } = await import(process.env.AGENTBOX_PLAYWRIGHT_MODULE!);
const browser = await chromium.launch({ executablePath: process.env.AGENTBOX_CHROMIUM, headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const errors: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
// The human's GitHub picture, served from the fixture so the check needs no network.
await page.route("https://github.com/**", (r: any) => r.fulfill({ status: 200, contentType: "image/png", body: png([90, 90, 220]) }));
const origin = `http://127.0.0.1:${server.port}`;
const out = process.env.AGENTBOX_SMOKE_OUTPUT ?? dir;
mkdirSync(out, { recursive: true });
const shot = (name: string) => page.screenshot({ path: join(out, name) });
const avatars = () => readdirSync(join(process.env.AGENTBOX_HOME!, "agents", "avatars"));
const agentBody = () => conversations.local().find((a) => a.id === vulcan.id)!;
try {
  // Fallback: no picture yet, so Vulcan's own icon.
  await page.goto(`${origin}/#/agents/${vulcan.id}/about/${agentBody().session}?project=alpha`);
  await page.getByRole("heading", { name: "Picture" }).waitFor();
  assert.equal(await page.locator(".agent-picture .agent-avatar-icon").count(), 1);
  await shot("memory-about-default-icon.png");
  // A file that is not the image it claims is refused, nothing saved.
  await page.locator('.agent-picture input[type="file"]').setInputFiles(join(files, "fake.png"));
  await page.locator(".agent-picture [role=alert]").waitFor();
  assert.equal(agentBody().avatar, undefined);
  // Upload, then reload: it is the agent's.
  await page.locator('.agent-picture input[type="file"]').setInputFiles(join(files, "orange.png"));
  await page.locator(".agent-picture img.agent-avatar").waitFor();
  const first = agentBody().avatar!;
  await page.reload();
  await page.locator(".agent-picture img.agent-avatar").waitFor();
  assert.ok((await page.locator(".agent-picture img.agent-avatar").evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)) > 0);
  // Replace: a new versioned URL; the old file is gone.
  await page.getByText("Replace picture").click();
  await page.locator('.agent-picture input[type="file"]').setInputFiles(join(files, "teal.png"));
  await page.waitForFunction((at: number) => !!document.querySelector(`.agent-picture img[src*="v="]:not([src*="v=${at}"])`), first.at);
  assert.notEqual(agentBody().avatar!.file, first.file);
  assert.deepEqual(avatars(), [agentBody().avatar!.file]);
  await shot("memory-about-picture.png");

  // Chat: replies left with the agent's picture and name, the human's picture right.
  await page.goto(`${origin}/#/agents/${vulcan.id}/chat/${old}?project=alpha`);
  await page.locator(".tl-agent").first().waitFor();
  assert.equal(await page.locator(".tl-agent .tl-agent-name").first().innerText(), vulcan.name);
  assert.match((await page.locator(".tl-agent img.agent-avatar").first().getAttribute("src"))!, /\/avatar\?v=/);
  assert.equal(await page.locator(".tl-agent-face img").count(), 1, "a run of replies shows the picture once");
  await page.locator(".tl-me img.tl-avatar").first().waitFor();
  assert.match((await page.locator(".tl-me img.tl-avatar").first().getAttribute("src"))!, /fixture-human\.png/);
  const [agentBox, meBox] = [await page.locator(".tl-agent-card").first().boundingBox(), await page.locator(".tl-bubble").first().boundingBox()];
  assert.ok(agentBox!.x < meBox!.x, "replies sit left of the human's messages");
  await shot("memory-chat-desktop.png");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await shot("memory-chat-dark.png");
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  // Sending shows your bubble with your picture before the transcript has it.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const send = runtime.fleet.send;
  runtime.fleet.send = async (...args: any[]) => { await gate; return send(...args); };
  await page.getByRole("textbox", { name: `Message ${vulcan.name}` }).fill("Thanks, I will review it after lunch.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator(".tl-me.tl-echo img.tl-avatar").waitFor();
  await shot("memory-chat-sending.png");
  release();
  await page.getByText("Noted: Thanks, I will review it after lunch.").waitFor();
  runtime.fleet.send = send;

  // Idle while warm: one checkpoint request, answered with a handoff.
  session(old, { lastActivityAt: Date.now() - 15 * 60_000, cacheWarmUntil: Date.now() + 40 * 60_000 });
  await (conversations as any).remember();
  const asked = agentBody().checkpoint!;
  assert.equal(asked.state, "requested");
  await (conversations as any).remember();
  assert.equal((events.get(old) ?? []).filter((e) => e.text.startsWith(CHECKPOINT_MARK)).length, 1);
  conversations.saveHandoff(vulcan.id, old, asked.request, { intent: "Fix the release notes job and get the PR reviewed", decisions: [{ decision: "Treat an empty changelog section as no entries", why: "matches the old behaviour" }], open: ["Should the parser warn on empty sections?"], commitments: ["Follow the CI wait on fix/release-notes"], refs: [{ label: "branch", ref: "fix/release-notes" }] });
  conversations.prefer(vulcan.id, null, { key: "review-style", text: "Short summaries first, details after" });
  // The checkpoint and its reply refreshed the cache: no second request.
  session(old, { lastActivityAt: Date.now() - 15 * 60_000, cacheWarmUntil: Date.now() + 40 * 60_000 });
  await (conversations as any).remember();
  assert.equal((events.get(old) ?? []).filter((e) => e.text.startsWith(CHECKPOINT_MARK)).length, 1);
  await page.reload();
  await page.getByText("Noted: Thanks, I will review it after lunch.").waitFor();
  assert.equal(await page.getByText(CHECKPOINT_MARK, { exact: false }).count(), 0, "checkpoint requests stay out of Chat");

  // Cold and parked: the next message starts a fresh conversation from the handoff.
  session(old, { host: "none", pid: null, tmux: null, parkedAt: Date.now(), cacheWarmUntil: Date.now() - 1 });
  await page.getByRole("textbox", { name: `Message ${vulcan.name}` }).fill("Morning! Where were we?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Picking up from the saved handoff", { exact: false }).waitFor();
  assert.equal(spawned.length, 1);
  const next = agentBody().session!;
  assert.notEqual(next, old);
  assert.ok(page.url().includes(next), "Chat follows the conversation into its successor");
  assert.match(spawned[0].prompt, /Fix the release notes job/);
  assert.match(spawned[0].prompt, /review-style: Short summaries first/);
  assert.ok(spawned[0].prompt.endsWith("User: Morning! Where were we?"));
  assert.equal((events.get(old) ?? []).filter((e) => e.text === "Morning! Where were we?").length, 0, "the old conversation never got the message");
  await page.getByText("Morning! Where were we?", { exact: true }).waitFor();
  assert.match((await page.locator(".tl-agent img.agent-avatar").first().getAttribute("src"))!, /\/avatar\?v=/, "the picture outlives the rollover");
  await shot("memory-chat-after-rollover.png");
  await page.goto(`${origin}/#/agents/${vulcan.id}/about/${agentBody().session}?project=alpha`);
  await page.getByText("Fix the release notes job", { exact: false }).first().waitFor();
  await page.getByText("1 earlier conversation continued this way", { exact: false }).waitFor();
  await page.locator("#agent-memory-title").scrollIntoViewIfNeeded();
  await shot("memory-about-memory.png");

  // Another agent with no picture keeps its own icon; a picture that fails falls back.
  await page.goto(`${origin}/#/agents/${jupiter.id}/about/new?project=alpha`);
  await page.locator(".agent-picture .agent-avatar-icon").waitFor();
  rmSync(join(process.env.AGENTBOX_HOME!, "agents", "avatars", agentBody().avatar!.file));
  await page.goto(`${origin}/#/agents/${vulcan.id}/chat/${next}?project=alpha`);
  await page.locator(".tl-agent .agent-avatar-icon").first().waitFor();
  // Remove: back to the icon, after a reload too.
  await page.goto(`${origin}/#/agents/${vulcan.id}/about/${agentBody().session}?project=alpha`);
  await page.getByRole("button", { name: "Remove" }).click();
  await page.locator(".agent-picture .agent-avatar-icon").waitFor();
  await page.reload();
  await page.locator(".agent-picture .agent-avatar-icon").waitFor();
  assert.equal(agentBody().avatar, undefined);

  // Phone width: replies and the composer fit.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/#/agents/${vulcan.id}/chat/${next}?project=alpha`);
  await page.locator(".tl-agent").first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await shot("memory-chat-mobile.png");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verified: "picture fallback/refusal/upload/reload/replace/remove/failed-load, reply and human avatars, sending bubble, one idle checkpoint, cold rollover with handoff and preference, picture after rollover, mobile", output: out, avatarDir: existsSync(join(process.env.AGENTBOX_HOME!, "agents", "avatars")) }));
} catch (e) {
  await shot("memory-failure.png").catch(() => undefined);
  console.error(errors, (await page.locator("body").innerText().catch(() => "")).slice(-1500), JSON.stringify(conversations.memoryView(vulcan.id, null)).slice(0, 600));
  throw e;
} finally {
  await browser.close();
  server.stop(true);
  store.db.close();
  db.closeDb();
}
