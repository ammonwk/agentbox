/** Disposable project navigation acceptance. Controlled conversations and Feed
 * are fixture evidence, never inserted into the user's fleet or provider homes. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.cwd(), dir = mkdtempSync(join(tmpdir(), "agentbox-projects-"));
process.env.AGENTBOX_HOME = join(dir, "box");
const { ensureDirs } = await import("../src/core/paths"); ensureDirs();
const db = await import("../src/core/db");
const { repoRootOf } = await import("../src/core/fleet");
const { sessionProject } = await import("../src/core/projects");
const { AgentStore } = await import("../src/core/agents/store");
const { AgentConversations } = await import("../src/core/agents/conversation");
const { agentRoutes } = await import("../src/server/agents");
const { Router, json, HttpError } = await import("../src/server/router");
const { mockServer } = await import("../web/src/mock");
const base: any = await mockServer.request("GET", "/api/state", null);
const repos = ["alpha", "beta"].map((id) => {
  const ref = join(dir, id); mkdirSync(ref);
  const git = (args: string[]) => { const r = Bun.spawnSync(["git", ...args], { cwd: ref }); assert.equal(r.exitCode, 0, r.stderr.toString()); };
  git(["init", "-b", "main"]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Fixture"]);
  git(["worktree", "add", "-b", "work", join(dir, `${id}-work`)]);
  const repo: any = { id, kind: "local", ref, checkoutRoot: repoRootOf(ref), displayName: id === "alpha" ? "Alpha" : "Beta", fullName: `fixture/${id}`, defaultBranch: "main", addedAt: Date.now(), worktreeDefault: true, setup: { copy: [], run: "" } };
  assert.equal(repoRootOf(join(dir, `${id}-work`)), realpathSync(ref)); db.insertRepo(repo); return repo;
});
let starts = 0, stops = 0;
const store = new AgentStore(join(dir, "runtime.db"));
const session = (id: string, cwd: string, repoRoot: string | null, title: string) => ({ ...base.sessions[0], id, cwd, repoRoot, title, label: title, parent: null, children: [], branch: "work", accountId: null, status: "waiting", host: "none", pid: null, attention: { kind: "waiting", since: Date.now() }, lastActivityAt: Date.now(), lastPromptAt: Date.now(), lastMessage: "Fixture conversation", firstPrompt: "Fixture", worktree: null, closedAt: null, agentSessionId: id });
const sessions = repos.flatMap((r) => [session(`work-${r.id}`, join(dir, `${r.id}-work`), repoRootOf(join(dir, `${r.id}-work`)), `${r.displayName} worktree`), session(`chat-${r.id}`, join(dir, "private", r.id), null, `${r.displayName} conversation`)]);
sessions.push(session("general", dir, null, "General work"));
const runtime: any = { store, fleet: {
  sessions: () => sessions, spawn: async () => { starts++; throw Error("Navigation must not activate agents"); }, stopSession: async () => { stops++; },
  timeline: async (id: string) => ({ events: [{ id: `${id}-reply`, kind: "assistant", text: `Controlled ${id} conversation`, at: Date.now() }], before: null }),
}, cards: { add: () => {}, list: () => [], close: () => {} } };
const conversations = new AgentConversations(runtime); runtime.conversations = conversations;
conversations.local();
const agents = repos.map((r) => conversations.local(r.id).find((a) => a.name === "VULCAN" && a.repo === r.id)!);
for (const [i, a] of agents.entries()) {
  a.session = `chat-${a.repo}`; a.sessionProjects = { [a.session]: a.repo };
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(a), a.id]);
  await conversations.propose(a.id, a.session, crypto.randomUUID(), { title: `${repos[i]!.displayName} recommendation`, finding: `Observed ${a.repo} issue in this controlled fixture.`, reason: "Keep each project's recommendations separate.", next: `Inspect ${a.repo}`, evidence: [] });
}
assert.notEqual(agents[0]!.id, agents[1]!.id);
for (const s of sessions) assert.equal(sessionProject(repos, conversations.local(), s), s.id.endsWith("alpha") ? "alpha" : s.id.endsWith("beta") ? "beta" : null);
const cards = ["alpha", "beta", "general"].map((id, i) => ({ ...base.cards[0], id: i + 1, kind: "decision", title: `${id} review`, short: `Controlled ${id} decision`, hasLong: false, pr: id === "general" ? null : `https://github.com/fixture/${id}/pull/1`, sessionId: id === "general" ? "general" : `chat-${id}`, about: null, state: "open", key: id, defaultAt: null, default: null, unread: false }));
let available = repos;
const state = () => ({ ...base, sessions, accounts: [], logins: [], repos: available, prs: [], cards, skills: [], schedules: [], prClaims: [], warnings: [] });
const router = agentRoutes(new Router((e: any) => new HttpError(e.status ?? 500, e.message)), runtime);
router.add("GET", "/api/state", () => json(state())).add("GET", "/api/cloud", () => json({ configured: false })).add("GET", "/api/health", () => json({ version: "fixture", providers: [], deps: [], tmux: true })).add("GET", "/api/prompts", () => json([])).add("GET", "/api/models", () => json([])).add("GET", "/api/sessions/closed", ({ url }) => { const project = url.searchParams.get("project"); const rows = sessions.filter((s) => !project || sessionProject(repos, conversations.local(), s) === project); return json({ sessions: rows.map((s) => ({ ...s, status: "closed" })), total: rows.length }); });
router.add("POST", "/api/placement", () => json({ provider: "codex", mode: "none", candidates: [], reason: "Controlled fixture has no provider accounts" }));
const sockets = new Set<any>();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req, s) => { const u = new URL(req.url); if (u.pathname === "/ws" && s.upgrade(req)) return; if (u.pathname.startsWith("/api/")) return router.handle(req); const file = Bun.file(join(root, "web/dist", u.pathname === "/" ? "index.html" : u.pathname)); return await file.exists() ? new Response(file) : new Response("missing", { status: 404 }); }, websocket: { open(ws: any) { sockets.add(ws); ws.send(JSON.stringify({ type: "hot", state: { sessions, serverTime: Date.now() } })); ws.send(JSON.stringify({ type: "cold", state: state() })); }, close(ws: any) { sockets.delete(ws); }, message() {} } });
const { chromium } = await import(process.env.AGENTBOX_PLAYWRIGHT_MODULE!);
const browser = await chromium.launch({ executablePath: process.env.AGENTBOX_CHROMIUM, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(15000); const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
const origin = `http://127.0.0.1:${server.port}`;
const out = process.env.AGENTBOX_SMOKE_OUTPUT ?? dir; mkdirSync(out, { recursive: true });
async function openSwitcher() { await page.locator(page.viewportSize()!.width > 900 ? ".project-brand" : ".project-bar button").click(); }
async function pick(name: string) { await openSwitcher(); await page.getByRole("button", { name: new RegExp(`^${name}`) }).click(); }
async function agent() { await page.locator(".agent-directory-card").filter({ has: page.getByRole("heading", { name: "VULCAN", exact: true }) }).click(); await page.getByRole("textbox", { name: "Message VULCAN" }).waitFor(); }
try {
  await page.goto(`${origin}/#/agents`);
  await pick("Alpha"); await agent();
  await page.getByText("Controlled chat-alpha conversation", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Message VULCAN" }).fill("Alpha unsent guidance");
  await page.getByRole("button", { name: /^Feed/ }).click(); await page.getByText("Alpha recommendation", { exact: true }).waitFor(); assert.equal(await page.getByText("Beta recommendation", { exact: true }).count(), 0);
  await pick("Beta"); await agent(); await page.getByText("Controlled chat-beta conversation", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Message VULCAN" }).inputValue(), "");
  await page.getByRole("textbox", { name: "Message VULCAN" }).fill("Beta unsent guidance");
  await page.getByRole("button", { name: /^Feed/ }).click(); await page.getByText("Beta recommendation", { exact: true }).waitFor();
  await page.goBack(); // project B directory
  await page.goBack(); // project A's Feed/chat detail
  await page.getByRole("textbox", { name: "Message VULCAN" }).waitFor(); assert.equal(await page.getByRole("textbox", { name: "Message VULCAN" }).inputValue(), "Alpha unsent guidance");
  await page.reload(); await page.getByText("Controlled chat-alpha conversation", { exact: true }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Message VULCAN" }).inputValue(), "Alpha unsent guidance");
  await page.locator('[data-nav-id="sessions"]').click(); await page.locator(".rail-row").filter({ hasText: "Alpha worktree" }).waitFor(); assert.equal(await page.locator(".rail-row").filter({ hasText: "Beta worktree" }).count(), 0); await page.locator(".rail-row").filter({ hasText: "Alpha conversation" }).waitFor();
  await page.getByRole("tab", { name: /^Inactive/ }).click(); await page.getByRole("button", { name: /See closed/ }).click(); await page.locator(".rail-closed .rail-row").filter({ hasText: "Alpha worktree" }).waitFor(); assert.equal(await page.locator(".rail-closed .rail-row").count(), 2);
  await page.locator('[data-nav-id="review"]').click(); await page.getByText("alpha review", { exact: true }).waitFor(); assert.equal(await page.getByText("beta review", { exact: true }).count(), 0); assert.equal(await page.locator('[data-nav-id="review"] .count').innerText(), "1");
  await page.locator(".nav-new").click(); 
  const prompt = page.getByRole("dialog").locator("textarea").first(); await prompt.fill("Alpha draft task");
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("agentbox.newSession.project.alpha")!))).repoId, "alpha");
  await page.keyboard.press("Escape"); await pick("Beta"); await page.locator(".nav-new").click(); assert.equal(await page.getByRole("dialog").locator("textarea").first().inputValue(), ""); await page.getByRole("dialog").locator("textarea").first().fill("Beta draft task");
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("agentbox.newSession.project.beta")!))).repoId, "beta"); await page.keyboard.press("Escape");
  await pick("Alpha"); await page.locator(".nav-new").click(); assert.equal(await page.getByRole("dialog").locator("textarea").first().inputValue(), "Alpha draft task"); await page.keyboard.press("Escape");
  const second = await context.newPage(); await second.goto(`${origin}/#/agents/${agents[1]!.id}?project=beta`); await second.getByText("Controlled chat-beta conversation", { exact: true }).waitFor(); assert.ok(page.url().includes("project=alpha")); assert.equal(await second.getByRole("textbox", { name: "Message VULCAN" }).inputValue(), "Beta unsent guidance"); await second.close();
  await page.goto(`${origin}/#/agents/${agents[1]!.id}?project=alpha`); await page.getByText("This agent belongs to another project", { exact: true }).waitFor(); await page.getByRole("button", { name: "Open in its project" }).click(); await page.getByText("Controlled chat-beta conversation", { exact: true }).waitFor();
  // A slow response from the abandoned Alpha page cannot replace Beta.
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/agents/local/project", async (route: any) => {
    if (route.request().postDataJSON().repo === "alpha") { arrived(); await delayed; }
    await route.continue();
  });
  await pick("Alpha"); await arrival; await pick("Beta"); release(); await agent(); await page.getByText("Controlled chat-beta conversation", { exact: true }).waitFor(); assert.equal(await page.getByText("Controlled chat-alpha conversation", { exact: true }).count(), 0); await page.unroute("**/api/agents/local/project");
  await page.locator(".project-brand").focus(); await page.keyboard.press("Enter"); await page.getByRole("textbox", { name: "Search projects" }).fill("Alpha"); await page.keyboard.press("Enter"); await page.locator(".agent-directory-card").first().waitFor(); assert.ok(page.url().includes("project=alpha"));
  await openSwitcher(); await page.screenshot({ path: join(out, "project-switcher-desktop.png") }); await page.keyboard.press("Escape");
  await agent(); await page.screenshot({ path: join(out, "project-chat-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await openSwitcher(); await page.screenshot({ path: join(out, "project-switcher-mobile.png") }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); await page.keyboard.press("Escape");
  available = repos.filter((r) => r.id !== "alpha"); for (const ws of sockets) ws.send(JSON.stringify({ type: "cold", state: state() })); await page.getByText("This project is no longer registered", { exact: true }).waitFor(); await page.getByRole("button", { name: "All projects", exact: true }).click(); await page.locator(".agent-directory-card").first().waitFor(); assert.ok(await page.getByText("General conversation", { exact: true }).count());
  assert.equal(starts, 0); assert.equal(stops, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, output: out, twoProjects: true, linkedWorktrees: true, distinctChatFeedDrafts: true, delayedResponseDiscarded: true, archivedSessionsScoped: true, scopedSessionsReview: true, newSessionDefaultsDrafts: true, historyReloadDeepLinks: true, multiTab: true, keyboardMobile: true, removedProject: true, starts, stops, errors }));
} catch (e) { console.error(JSON.stringify({ url: page.url(), body: (await page.locator("body").innerText()).slice(0, 7000), errors })); await page.screenshot({ path: join(out, "failure.png") }); throw e; } finally { await browser.close(); server.stop(true); store.db.close(); db.closeDb(); }
