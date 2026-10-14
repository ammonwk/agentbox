import { AgentWorks } from "../src/core/agents/work";
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
const conversations = new AgentConversations(runtime); runtime.conversations = conversations; runtime.works = new AgentWorks(runtime);
conversations.local();
const agents = repos.map((r) => conversations.local(r.id).find((a) => a.name === "VULCAN" && a.repo === r.id)!);
for (const [i, a] of agents.entries()) {
  a.session = `chat-${a.repo}`; a.sessionProjects = { [a.session]: a.repo };
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(a), a.id]);
  await conversations.propose(a.id, a.session, crypto.randomUUID(), { title: `${repos[i]!.displayName} recommendation`, finding: `Observed ${a.repo} issue in this controlled fixture.`, reason: "Keep each project's recommendations separate.", next: `Inspect ${a.repo}`, evidence: [] });
}
// Deliberately retain two agents' separate histories; no standalone reparenting.
const a = agents[0]!;
a.previous = ["old-alpha"];
store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(a), a.id]);
sessions.push({...session("old-alpha",dir,null,"Previous Vulcan conversation"), status:"stopped", lastActivityAt:1});
const salus = conversations.local("alpha").find((a) => a.repo === "alpha" && a.name === "SALUS")!;
salus.session = "salus-current"; salus.previous = ["salus-old"];
store.db.run("UPDATE local_agents SET body=? WHERE id=?",[JSON.stringify(salus),salus.id]);
sessions.push(session("salus-current",dir,null,"Review deployment evidence"), {...session("salus-old",dir,null,"Previous Salus conversation"),status:"stopped",lastActivityAt:1});
const jupiter = conversations.local("alpha").find((a) => a.repo === "alpha" && a.capability === "creator")!;
jupiter.session = "creator-current";
store.db.run("UPDATE local_agents SET body=? WHERE id=?",[JSON.stringify(jupiter),jupiter.id]);
sessions.push(session("creator-current",dir,null,"Create a repository guide"));
for (const s of sessions) db.insertSessionRecord({ id:s.id, provider:"codex",agentSessionId:s.id,accountId:null,cwd:dir,worktree:null,label:s.title,claim:0,origin:"agentbox",tmux:null,transcriptPath:null,startedAt:1,lastActivityAt:s.lastActivityAt,archivedAt:null,facts:null,createdAt:1 });
const creation = await conversations.draft(jupiter.id,jupiter.session,crypto.randomUUID(),{name:"Atlas",role:"Explain repository architecture",instructions:"Answer with concise diagrams and cite source paths.",provider:"codex",limits:"Read only. No external publication.",automation:""});
let capturedPrompt = "";
runtime.fleet.spawn = async (opts:any) => { starts++; capturedPrompt=opts.prompt;
 db.insertSessionRecord({id:opts.id,provider:opts.provider,agentSessionId:opts.id,accountId:null,cwd:dir,worktree:null,label:"Explain architecture",claim:0,origin:"agentbox",tmux:null,transcriptPath:null,startedAt:Date.now(),lastActivityAt:Date.now(),archivedAt:null,facts:null,createdAt:Date.now()});
 sessions.push(session(opts.id,dir,null,"Explain architecture"));
};
assert.notEqual(agents[0]!.id, agents[1]!.id);

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
async function choose(name:string) {
 await page.getByRole("button",{name:"Select agent",exact:true}).click();
 await page.getByRole("textbox",{name:"Search agents"}).fill(name);
 await page.locator(".project-option").filter({has:page.locator("strong",{hasText:new RegExp(`^${name}$`)})}).click();
}
async function openThread(id:string) { await page.locator(`.rail-row[data-id="${id}"]`).click(); }
try {
 await page.goto(`${origin}/#/agents/${a.id}/chat/chat-alpha?project=alpha`);
 await page.getByText("Controlled chat-alpha conversation",{exact:true}).waitFor();
 await page.getByRole("tab",{name:"Active 1",exact:true}).waitFor();
 await page.getByRole("tab",{name:"Inactive 1",exact:true}).waitFor();
 await page.getByRole("textbox",{name:"Message VULCAN"}).fill("Current exact-target draft");
 await page.getByRole("tab",{name:/Inactive/}).click(); await openThread("old-alpha");
 await page.getByText("Controlled old-alpha conversation",{exact:true}).waitFor();
 assert.equal(await page.getByText("Controlled chat-alpha conversation",{exact:true}).count(),0);
 assert.equal(await page.getByRole("textbox",{name:"Message VULCAN"}).count(),0);
 await page.getByRole("link",{name:"Open current session"}).click();
 assert.equal(await page.getByRole("textbox",{name:"Message VULCAN"}).inputValue(),"Current exact-target draft");
 await choose("SALUS");
 await page.getByRole("tab",{name:"Active 1",exact:true}).waitFor();
 await openThread("salus-current");
 await page.getByRole("textbox",{name:"Message SALUS"}).fill("Salus draft");
 await choose("VULCAN"); await openThread("chat-alpha");
 assert.equal(await page.getByRole("textbox",{name:"Message VULCAN"}).inputValue(),"Current exact-target draft");
 await page.getByRole("button",{name:/^Feed/}).click(); await page.getByRole("button",{name:"Give guidance"}).click();
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message VULCAN"]')?.value.includes("Regarding"));
 assert.match(await page.getByRole("textbox",{name:"Message VULCAN"}).inputValue(),/^Current exact-target draft/);
 assert.ok(page.url().includes("chat-alpha"));
 await page.getByRole("textbox",{name:"Message VULCAN"}).fill("");
 await page.getByRole("button",{name:/^Feed/}).click(); await page.getByRole("button",{name:"Chat",exact:true}).click();
 assert.equal(await page.getByRole("textbox",{name:"Message VULCAN"}).inputValue(),"");
 await page.reload(); await page.getByText("Controlled chat-alpha conversation",{exact:true}).waitFor();
 assert.equal(await page.getByRole("textbox",{name:"Message VULCAN"}).inputValue(),"");
 await page.goto(`${origin}/#/agents/${a.id}/chat/general?project=alpha`);
 await page.getByText("Session does not belong to this agent",{exact:true}).waitFor();
 assert.equal(await page.getByRole("textbox",{name:"Message VULCAN"}).count(),0);
 const forbidden = await fetch(`${origin}/api/agents/local/${a.id}/chat`,{method:"POST",headers:{"content-type":"application/json","x-agentbox":"1"},body:JSON.stringify({request:crypto.randomUUID(),body:"Must not send",target:"old-alpha"})});
 assert.equal((await forbidden.json()).data.state,"refused");
 assert.equal(starts,0); assert.equal(stops,0);
 await page.goto(`${origin}/#/agents/${jupiter.id}/chat/creator-current?project=alpha`);
 await page.getByRole("heading",{name:"Create an agent",exact:true}).waitFor();
 await page.getByLabel("Name",{exact:true}).fill("Atlas custom");
 await page.getByRole("button",{name:"Create agent",exact:true}).click();
 await page.getByRole("link",{name:"Open Atlas custom →"}).waitFor();
 const made = conversations.creations(jupiter.id).find((d)=>d.id===creation.id)!;
 assert.ok(made.created); assert.equal(starts,0);
 assert.equal(conversations.editCreation(jupiter.id,made.id,made.revision,"alpha",made.spec,true).created,made.created);
 await page.reload(); await page.getByRole("link",{name:"Open Atlas custom →"}).waitFor();
 await page.screenshot({path:join(out,"jupiter-created-desktop.png")});
 await page.getByRole("link",{name:"Open Atlas custom →"}).click();
 await page.getByRole("textbox",{name:"Message Atlas custom"}).fill("Explain the architecture");
 await page.getByRole("button",{name:"Send",exact:true}).click();
 await page.getByText(/^Controlled .* conversation$/).waitFor();
 assert.equal(starts,1); assert.match(capturedPrompt,/Answer with concise diagrams and cite source paths/);
 await page.getByRole("button",{name:"Select agent"}).click();
 await page.getByRole("textbox",{name:"Search agents"}).fill("Atlas");
 await page.locator(".project-option").filter({hasText:"Atlas custom"}).waitFor();
 await page.keyboard.press("Escape");
 await page.goto(`${origin}/#/agents/${a.id}/chat/chat-alpha?project=alpha`);
 await page.getByText("Controlled chat-alpha conversation",{exact:true}).waitFor();
 await page.screenshot({path:join(out,"session-browser-desktop.png")});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole("textbox",{name:"Message VULCAN"}).fill("Mobile draft");
 let send = await page.getByRole("button",{name:"Send",exact:true}).boundingBox();
 const nav = await page.locator('.mobile-nav, .mobilebar, .mobile-bar').first().boundingBox().catch(()=>null);
 const edge = await page.evaluate(()=>document.querySelector('.systembar')?.getBoundingClientRect().top ?? innerHeight-60);
 assert.ok(send && send.y+send.height <= edge,JSON.stringify({send,edge,nav}));
 await page.screenshot({path:join(out,"session-browser-mobile-chat.png")});
 await page.getByRole("link",{name:"Back to agent sessions"}).click();
 await page.getByRole("button",{name:"Select agent"}).waitFor({state:"visible"});
 await page.screenshot({path:join(out,"session-browser-mobile-list.png")});
 await openThread("chat-alpha"); assert.equal(await page.getByRole("textbox",{name:"Message VULCAN"}).inputValue(),"Mobile draft");
 await page.evaluate(()=>document.documentElement.style.setProperty("--kbh","300px"));
 send=await page.getByRole("button",{name:"Send",exact:true}).boundingBox();
 assert.ok(send && send.y+send.height < 544);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({verified:"two-agent histories/counts, exact transcript, read-only predecessor, drafts/clear/feed, foreign deep link/send, real typed creator card edit/create/reload/retry and custom instructions, mobile rail/Send",starts,stops,output:out}));
} finally { await browser.close(); server.stop(true); store.db.close(); db.closeDb(); }
