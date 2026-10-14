/** Manual security/lifecycle acceptance on a disposable local Supabase stack.
 * No provider credentials, live fleet, real GitHub writes or external bot setup.
 * Set AGENTBOX_PLAYWRIGHT_MODULE to an installed playwright-core module and
 * AGENTBOX_CHROMIUM to its browser executable. Output stays outside the repo. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
const root = process.cwd();
const output =
  process.env.AGENTBOX_SMOKE_OUTPUT ||
  mkdtempSync(join(tmpdir(), "agentbox-agents-evidence-"));
mkdirSync(output, { recursive: true });
const playwrightModule = process.env.AGENTBOX_PLAYWRIGHT_MODULE;
const chromiumPath = process.env.AGENTBOX_CHROMIUM;
if (!playwrightModule || !chromiumPath)
  throw new Error(
    "Set AGENTBOX_PLAYWRIGHT_MODULE and AGENTBOX_CHROMIUM for browser validation",
  );
const dir = mkdtempSync(join(tmpdir(), "agentbox-agents-smoke-"));
process.env.AGENTBOX_HOME = join(dir, "box");
process.env.AGENTBOX_TMUX_SOCKET = `ab-agents-smoke-${process.pid}`;
const status = Bun.spawnSync(["supabase", "status", "-o", "env"], {
  stderr: "ignore",
}).stdout.toString();
const env = Object.fromEntries(
  status
    .split("\n")
    .map((l) => /^([A-Z_]+)="?(.*?)"?$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m![1], m![2]]),
);
const { createClient } = await import(
  join(root, "node_modules/@supabase/supabase-js/dist/index.mjs")
);
const { HumanCloud, InstallationCloud, supabaseFor } = await import(
  join(root, "src/cloud/client.ts")
);
const { HumanAgents, InstallationAgents } = await import(
  join(root, "src/cloud/agent-client.ts")
);
const { AGENT_TEMPLATES } = await import(join(root, "src/cloud/agents.ts"));
const cfg = { url: env.API_URL!, publishableKey: env.PUBLISHABLE_KEY! };
if (!["127.0.0.1", "localhost"].includes(new URL(cfg.url).hostname))
  throw new Error("This smoke accepts only the disposable local stack");
const admin = createClient(cfg.url, env.SECRET_KEY!, {
  auth: { persistSession: false },
});
const tag = crypto.randomUUID().slice(0, 8);
async function human(name: string) {
  const email = `${name}-${tag}@agents-smoke.test`,
    password = `Smoke-${tag}-A1!`;
  const r = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (r.error) throw r.error;
  const sb = supabaseFor(cfg);
  const login = await sb.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  const api = new HumanCloud(sb);
  await api.me();
  await api.setDisplayName(name);
  return {
    api,
    agents: new HumanAgents(api),
    id: r.data.user.id,
    session: login.data.session,
    email,
  };
}
const alice = await human("Maintainer"),
  bob = await human("Teammate");
const ws = await alice.api.createWorkspace(
  "Agentbox validation",
  `smoke-${tag}`,
);
await bob.api.acceptInvite(
  (await alice.api.createInvite(ws.id, { email: bob.email })).token,
);
const reg = await alice.api.registerInstallation(
  ws.id,
  `execution-server-${tag}`,
  { scopes: ["agents:execute", "artifacts:read"] },
);
const otherReg = await bob.api.registerInstallation(
  ws.id,
  `team-laptop-${tag}`,
  { scopes: ["agents:execute"] },
);
const { cloudConfig, writeCredential } = await import(
  join(root, "src/core/cloud/config.ts")
);
process.env.AGENTBOX_CLOUD_URL = cfg.url;
process.env.AGENTBOX_CLOUD_PUBLISHABLE_KEY = cfg.publishableKey;
writeCredential({
  v: 1,
  url: cfg.url,
  installationId: reg.installation.id,
  workspaceId: ws.id,
  workspaceSlug: ws.slug,
  name: reg.installation.name,
  secret: reg.secret,
  savedAt: new Date().toISOString(),
});
const { ensureDirs } = await import(join(root, "src/core/paths.ts"));
ensureDirs();
const db = await import(join(root, "src/core/db.ts"));
const checkout = join(dir, "fixture");
mkdirSync(checkout);
function git(args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
git(["init", "-b", "main"]);
git(["config", "user.name", "Fixture Author"]);
git(["config", "user.email", "fixture@agents.test"]);
writeFileSync(
  join(checkout, "sum.ts"),
  "export const sum = (a: number, b: number) => a - b;\n",
);
git(["add", "sum.ts"]);
git(["commit", "-m", "Reproducible fixture"]);
const repository = {
  id: "smoke-repo",
  kind: "local",
  ref: checkout,
  displayName: "Fixture repository",
  fullName: "fixture/repo",
  defaultBranch: "main",
  addedAt: Date.now(),
  worktreeDefault: true,
  setup: { copy: [], run: [] },
};
db.insertRepo(repository);
db.insertAccount({
  id: "smoke-account",
  provider: "codex",
  label: "Controlled adapter",
  email: null,
  plan: "pro",
  home: join(dir, "provider"),
  isDefault: false,
  enabled: true,
  createdAt: Date.now(),
});
const { codexAdapter } = await import(
  join(root, "src/core/providers/codex.ts")
);
const tmux = await import(join(root, "src/core/tmux.ts"));
const { Fleet } = await import(join(root, "src/core/fleet.ts"));
let spawned = 0;
const adapter = {
  ...codexAdapter,
  defaultHome: () => join(dir, "provider"),
  listTranscripts: async () => [],
  liveProcesses: async () => [],
  findTranscript: async () => null,
  spawnCommand: (opts: any) => {
    assert.match(opts.prompt, /a shared Agentbox agent/);
    spawned++;
    return {
      argv: [
        "sh",
        "-c",
        opts.prompt.includes("coordination conversation")
          ? "exec cat"
          : "printf 'export const sum = (a: number, b: number) => a + b;\\n' > sum.ts; exec cat",
      ],
      env: {},
      agentSessionId: null,
    };
  },
};
const fleet = new Fleet({
  adapters: [adapter],
  runtime: tmux,
  usage: { usageOf: () => null, authOf: () => "ok" },
});
await fleet.tick();
const { CloudBridge } = await import(join(root, "src/core/cloud/bridge.ts"));
const cloud = new CloudBridge(fleet, "smoke");
cloud.reload();
await cloud.api().hello("smoke", "darwin");
const { Cards } = await import(join(root, "src/core/cards.ts"));
const cards = new Cards(fleet, () => {});
const { AgentsRuntime } = await import(
  join(root, "src/core/agents/runtime.ts")
);
let runtime = new AgentsRuntime(fleet, cloud, cards);
let a = await alice.agents.save({
  workspace: ws.id,
  name: "VULCAN",
  team: true,
  maintainers: [alice.id],
  definition: { ...AGENT_TEMPLATES[0].definition, repos: ["fixture/repo"] },
});
await alice.agents.authorize(a.id, reg.installation.id, true);
a = await alice.agents.save({
  workspace: ws.id,
  id: a.id,
  base: a.revision,
  name: a.name,
  team: true,
  maintainers: a.maintainers,
  definition: a.definition,
  executor: reg.installation.id,
  enabled: true,
});
await runtime.bind({
  agent: a.id,
  url: cfg.url,
  workspace: ws.id,
  provider: "codex",
  repos: { "fixture/repo": repository.id },
});
const w = await alice.agents.intake(a.id, {
  source: "https://github.com/fixture/repo/issues/7",
  title: "Sum returns a difference",
  acceptance:
    "sum(2, 3) should be 5. Add evidence that the original symptom is resolved.",
});
const r = await alice.agents.run(w, crypto.randomUUID());
let browser: any, debugPage: any;
try {
  await runtime.tick();
  assert.equal(spawned, 1, `no Fleet spawn: ${runtime.lastError}`);
  const live = runtime.store.runs().find((x: any) => x.run.id === r.id)!;
  assert.equal(live.phase, "attached", runtime.lastError ?? "not attached");
  runtime.store.db.close();
  runtime = new AgentsRuntime(fleet, cloud, cards);
  await runtime.tick();
  assert.equal(spawned, 1, "runtime restart duplicated the writer");
  const session = fleet.get(live.session);
  assert.equal(session.host, "tmux");
  assert.ok(session.cwd.startsWith(dir));
  assert.match(readFileSync(join(session.cwd, "sum.ts"), "utf8"), /a \+ b/);
  await runtime.progress(
    r.id,
    live.session,
    {
      stage: "in_progress",
      next: "Validate the fixture and prepare a scoped PR",
      outcome: "Reproduced the arithmetic error and prepared the local fix.",
      evidence: [],
    },
    "Confirm the acceptance criteria before publishing",
  );
  const two = await bob.agents.board(ws.id);
  assert.equal(
    two.runs.find((x: any) => x.id === r.id).session_id,
    live.session,
  );
  assert.equal(
    two.runs.find((x: any) => x.id === r.id).pending_decision,
    "Confirm the acceptance criteria before publishing",
  );
  await assert.rejects(() =>
    runtime.progress(r.id, "standalone", { stage: "blocked" }),
  );
  assert.ok(runtime.directContactRefusal(live.session));
  assert.equal(runtime.directContactRefusal("standalone"), null);
  // The sender cannot request another run while the first writer holds work.
  await assert.rejects(() =>
    alice.agents.run(
      two.work.find((x: any) => x.id === w.id),
      crypto.randomUUID(),
    ),
  );
  for (const t of AGENT_TEMPLATES.slice(1))
    await alice.agents.save({
      workspace: ws.id,
      name: t.name,
      team: true,
      maintainers: [alice.id],
      definition: t.definition,
    });
  await alice.agents.expertise(ws.id, {
    areas: ["TypeScript", "API"],
    login: "fixture-maintainer",
    emails: ["fixture@agents.test"],
    paths: ["sum.ts"],
  });
  const suggestions = await runtime.suggestions(
    a.id,
    ["TypeScript"],
    ["sum.ts"],
  );
  assert.ok(
    suggestions.suggestions[0].evidence.some((s: string) =>
      s.includes("commits"),
    ),
  );

  const transcript = join(dir, "controlled-provider.jsonl");
  const stamp = new Date().toISOString();
  writeFileSync(
    transcript,
    [
      {
        timestamp: stamp,
        type: "session_meta",
        payload: { id: crypto.randomUUID(), cwd: session.cwd },
      },
      {
        timestamp: stamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Please investigate the arithmetic fixture.",
            },
          ],
        },
      },
      {
        timestamp: stamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "I reproduced the subtraction error and prepared a scoped fix.",
            },
          ],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const reader = codexAdapter.reader({
    provider: "codex",
    accountId: "smoke-account",
    agentSessionId: crypto.randomUUID(),
    path: transcript,
    mtimeMs: Date.now(),
    size: Bun.file(transcript).size,
  });
  const originalTimeline = fleet.timeline.bind(fleet);
  fleet.timeline = async (id: string, before: string | null, limit: number) =>
    id === live.session
      ? reader.timeline({ before, limit })
      : originalTimeline(id, before, limit);
  const { AgentConversation } = await import(
    join(root, "src/cloud/agent-conversation.ts")
  );
  const sharedChat = new AgentConversation(bob.api);
  const relayRead = sharedChat.read(a.id);
  void relayRead.catch(() => undefined);
  // The read's subscription handshake must finish before a real host tick.
  // This is a bounded smoke condition, not a persistent external watcher.
  const readQueued = await new Promise<boolean>((resolve) => {
    const timer = setInterval(async () => {
      const q = await cloud
        .api()
        .agentCall(
          "inst_agent_reads",
          {},
          (await import("zod")).z.array((await import("zod")).z.unknown()),
        );
      if (q.length) {
        clearInterval(timer);
        resolve(true);
      }
    }, 100);
    setTimeout(() => {
      clearInterval(timer);
      resolve(false);
    }, 5000);
  });
  assert.ok(
    readQueued,
    "Realtime subscription did not queue an authenticated read",
  );
  await runtime.conversations.tick();
  if (runtime.lastError) console.log("RELAY HOST", runtime.lastError);
  const pageFromHost = await relayRead;
  assert.ok(
    pageFromHost.events.some((e: any) =>
      e.text?.includes("reproduced the subtraction error"),
    ),
    "relay did not read provider transcript",
  );
  assert.equal(pageFromHost.session, live.session);
  const proposal = await runtime.conversations.propose(
    r.id,
    live.session,
    crypto.randomUUID(),
    {
      title: "Validate the arithmetic fix",
      finding: "The fixture subtracts instead of adding.",
      reason: "The result is wrong for ordinary positive inputs.",
      next: "Check sum(2, 3) and report the result.",
      evidence: [
        {
          url: "https://github.com/fixture/repo/issues/7",
          label: "Reported issue",
        },
      ],
    },
  );
  assert.ok(
    (await sharedChat.proposals(a.id)).some((p: any) => p.id === proposal.id),
  );
  const guidance = crypto.randomUUID();
  await sharedChat.guide(
    a.id,
    r.id,
    guidance,
    "Please include a zero-input case",
    proposal.id,
  );
  await runtime.conversations.tick();
  assert.equal((await sharedChat.receipt(guidance)).state, "sent");
  await runtime.conversations.tick();
  assert.equal((await sharedChat.receipt(guidance)).state, "sent");
  console.log(
    "Verified encrypted two-installation read-through, real provider folding, durable Feed and scoped guidance receipt",
  );
  // Render the real cloud-backed feature. Only the surrounding board chrome
  // uses an empty fixture, so no live fleet/accounts/transcripts are exposed.
  const { mockServer } = await import(join(root, "web/src/mock.ts"));
  const base = await mockServer.request("GET", "/api/state", null);
  const { attentionOf } = await import(join(root, "src/core/attention.ts"));
  const appState = () => ({
    ...base,
    sessions: fleet
      .sessions()
      .map((s: any) => ({ ...s, attention: attentionOf(s) })),
    accounts: [],
    logins: [],
    repos: [repository],
    prs: [],
    cards: cards.shown(),
    skills: [],
    schedules: [],
    prClaims: [],
    warnings: [],
  });
  const { Router, json, fail, HttpError } = await import(
    join(root, "src/server/router.ts")
  );
  const { agentRoutes } = await import(join(root, "src/server/agents.ts"));
  const router = new Router(
    (e: any) => new HttpError(e.status ?? 500, e.message),
  );
  agentRoutes(router, runtime);
  const { sessionCapability } = await import(
    join(root, "src/core/session-authority.ts")
  );
  const headers = { "content-type": "application/json", "x-agentbox": "1" };
  const attempt = async (path: string, body: any, extra: any = {}) => {
    const req = new Request("http://127.0.0.1" + path, {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    });
    const response = await router.handle(req);
    if (!response.ok) {
      assert.equal(response.status, 403);
      throw new Error((await response.json()).error);
    }
    return response;
  };
  const progressPath = `/api/agents/runs/${r.id}/progress`;
  for (const body of [
    { progress: { stage: "blocked" } },
    {
      callerPid: process.pid,
      session: live.session,
      progress: { stage: "blocked" },
    },
  ])
    await assert.rejects(() => attempt(progressPath, body));
  await assert.rejects(() =>
    attempt(
      progressPath,
      { progress: { stage: "blocked" } },
      {
        "x-agentbox-session": live.session,
        "x-agentbox-session-token": sessionCapability("unrelated"),
      },
    ),
  );
  assert.ok(
    await attempt(
      progressPath,
      {
        progress: {
          stage: "in_progress",
          next: "Check the HTTP capability boundary",
          outcome: "Fixture fix prepared",
          evidence: [],
        },
      },
      {
        "x-agentbox-session": live.session,
        "x-agentbox-session-token": sessionCapability(live.session),
      },
    ),
  );
  for (const body of [
    {},
    { callerPid: process.pid },
    { humanToken: bob.session.access_token },
  ])
    await assert.rejects(() =>
      attempt(`/api/agents/runs/${r.id}/rotate`, body),
    );
  await assert.rejects(() =>
    attempt("/api/agents/binding", { callerPid: process.pid, binding: {} }),
  );
  await assert.rejects(() =>
    attempt("/api/agents/binding", {
      humanToken: bob.session.access_token,
      binding: {},
    }),
  );
  const extra = await alice.agents.save({
    workspace: ws.id,
    name: "Host setup authorization",
    team: true,
    maintainers: [alice.id],
    definition: a.definition,
  });
  await alice.agents.authorize(extra.id, reg.installation.id, true);
  await alice.agents.save({
    workspace: ws.id,
    id: extra.id,
    base: extra.revision,
    name: extra.name,
    team: true,
    maintainers: extra.maintainers,
    definition: extra.definition,
    executor: reg.installation.id,
  });
  assert.ok(
    await attempt("/api/agents/binding", {
      humanToken: alice.session.access_token,
      binding: {
        agent: extra.id,
        url: cfg.url,
        workspace: ws.id,
        provider: "codex",
        repos: { "fixture/repo": repository.id },
      },
    }),
  );
  router.add("GET", "/api/health", () =>
    json({ version: "smoke", tmux: true, providers: [], deps: [] }),
  );
  router.add("GET", "/api/cloud", () => json(cloud.status()));
  router.add("GET", "/api/state", () => json(appState()));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req, s) => {
      const u = new URL(req.url);
      if (u.pathname === "/ws") {
        if (s.upgrade(req)) return;
      }
      if (u.pathname.startsWith("/api/")) return await router.handle(req);
      const file = Bun.file(
        join(root, "web/dist", u.pathname === "/" ? "index.html" : u.pathname),
      );
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: any) {
        const st = appState();
        ws.send(
          JSON.stringify({
            type: "hot",
            state: { sessions: st.sessions, serverTime: Date.now() },
          }),
        );
        ws.send(JSON.stringify({ type: "cold", state: st }));
      },
      message() {},
    },
  });
  try {
    const cli = Bun.spawn(
      [
        "bun",
        join(root, "bin/agentbox"),
        "agent",
        "progress",
        r.id,
        "--stage",
        "in_progress",
        "--next",
        "Validate the fix and prepare a PR",
        "--outcome",
        "Reproduced the arithmetic error and prepared the local fix.",
        "--decision",
        "Confirm the acceptance criteria before publishing",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          AGENTBOX_SESSION: live.session,
          AGENTBOX_PORT: String(server.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [cliOut, cliErr, cliCode] = await Promise.all([
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text(),
      cli.exited,
    ]);
    assert.equal(cliCode, 0, cliErr);
    assert.ok(cliOut.includes("in_progress"));
    const { chromium } = await import(playwrightModule);
    browser = await chromium.launch({
      executablePath: chromiumPath,
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1080 },
    });
    await context.addInitScript(
      ({ key, session }: any) =>
        localStorage.setItem(key, JSON.stringify(session)),
      {
        key: `agentbox.cloud.auth.${new URL(cfg.url).host}`,
        session: alice.session,
      },
    );
    const page = await context.newPage(); debugPage = page;
    const errors: string[] = [];
    let relayQueue = Promise.resolve();
    context.on("page", (p:any) => p.on("response", (r:any) => { if (r.url().endsWith("/agent_read_request") && r.ok()) relayQueue = relayQueue.then(() => runtime.conversations.tick()); }));
    page.on("response", (r:any) => { if (r.url().endsWith("/agent_read_request") && r.ok()) relayQueue = relayQueue.then(() => runtime.conversations.tick()); });
    page.on("pageerror", (e: any) => errors.push(e.stack || e.message));
    await page.goto(`http://127.0.0.1:${server.port}/#/agents/manage`);
    try {
      await page
        .getByRole("heading", { name: "A shared view of the work" })
        .waitFor({ timeout: 10000 });
    } catch (e) {
      console.log("UI BODY", await page.locator("body").innerText());
      console.log("UI ERRORS", errors);
      await page.screenshot({ path: join(output, "debug.png") });
      throw e;
    }
    await page
      .getByRole("link")
      .filter({
        has: page.getByRole("heading", { name: "VULCAN", exact: true }),
      })
      .waitFor();
    await page.screenshot({
      path: join(output, "directory.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await page
      .getByLabel("Name", { exact: true })
      .fill("Custom responsibility");
    await page
      .getByLabel("Role", { exact: true })
      .fill("Investigate validation fixtures");
    await page
      .getByLabel("Allowed repositories")
      .fill("fixture/repo, fixture/second");
    await page
      .getByLabel("Instructions", { exact: true })
      .fill("Read the source and report a reproducible finding.");
    await page.getByRole("button", { name: "Create paused agent" }).click();
    await page
      .getByRole("heading", { name: "Custom responsibility", exact: true })
      .waitFor();
    const created = (await alice.agents.board(ws.id)).agents.find(
      (x: any) => x.name === "Custom responsibility",
    );
    assert.equal(created.enabled, false);
    assert.deepEqual(created.definition.repos, [
      "fixture/repo",
      "fixture/second",
    ]);
    await page.getByRole("button", { name: "About", exact: true }).click();
    await page.getByRole("button", { name: "Edit definition" }).click();
    await page
      .getByLabel("Instructions", { exact: true })
      .fill("Updated instructions, kept in a new revision.");
    await page.getByRole("button", { name: "Save revision" }).click();
    await page
      .getByRole("heading", { name: "Custom responsibility", exact: true })
      .waitFor();
    assert.equal((await alice.agents.revisions(created.id)).length, 2);

    // Arm before navigation; wait for the committed request before the host tick.
    const firstRead = page.waitForResponse(
      (q: any) => q.url().endsWith("/agent_read_request"),
      { timeout: 10000 },
    );
    await page.goto(`http://127.0.0.1:${server.port}/#/agents/${a.id}/chat/${live.session}`);
    await page.getByRole("button", { name: "Select agent", exact: true }).waitFor();
    // Exercise the real shared Chat/Feed UI. Only refusal below is injected,
    // so recovery can be checked without an actual network outage.
    await firstRead;
    await runtime.conversations.tick();
    await page
      .getByText(
        "I reproduced the subtraction error and prepared a scoped fix.",
        { exact: true },
      )
      .waitFor();
    const composer = page.getByRole("textbox", { name: "Message VULCAN" });
    await composer.fill("Keep my existing draft.");
    await page.getByRole("button", { name: /^Feed/ }).click();
    await page
      .getByRole("button", { name: "Give guidance", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message VULCAN"]',
        )
        ?.value.includes("Regarding"),
    );
    assert.match(
      await composer.inputValue(),
      /^Keep my existing draft\.\n\nRegarding/,
    );
    await page.reload();
    await composer.waitFor();
    assert.match(
      await composer.inputValue(),
      /^Keep my existing draft\.\n\nRegarding/,
    );
    let refused: any;
    await page.route("**/rest/v1/rpc/agent_session_guide", async (route: any) => {
      refused = route.request().postDataJSON();
      await route.fulfill({
        json: {
          id: refused.p_id,
          state: "refused",
          result: "Controlled pre-delivery refusal",
        },
      });
    });
    await page.route(
      "**/rest/v1/rpc/agent_command_receipt",
      async (route: any) =>
        route.fulfill({
          json: {
            id: route.request().postDataJSON().p_id,
            state: "refused",
            result: "Controlled pre-delivery refusal",
          },
        }),
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByRole("button", { name: "Restore draft", exact: true })
      .waitFor();
    assert.equal(refused.p_proposal, proposal.id);
    assert.equal(refused.p_run, r.id);
    await composer.fill("Newer typing.");
    await page
      .getByRole("button", { name: "Restore draft", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Message VULCAN"]',
        )
        ?.value.includes("Keep my existing draft"),
    );
    assert.match(
      await composer.inputValue(),
      /^Newer typing\.\n\nKeep my existing draft/,
    );
    await page.unroute("**/rest/v1/rpc/agent_session_guide");
    await page.unroute("**/rest/v1/rpc/agent_command_receipt");
    const guideResponse = page.waitForResponse((q: any) =>
      q.url().endsWith("/agent_session_guide"),
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const guideReceipt = await (await guideResponse).json();
    await runtime.conversations.tick();
    assert.equal(
      (await new AgentConversation(alice.api).receipt(guideReceipt.id)).state,
      "sent",
    );
    await page.screenshot({ path: join(output, "chat.png"), fullPage: true });
    await page.getByRole("button", { name: /^Feed/ }).click();
    await page.screenshot({ path: join(output, "feed.png"), fullPage: true });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await page.getByRole("button", { name: /^Feed/ }).click();
    await page.getByText("approved", { exact: true }).waitFor();
    await runtime.conversations.tick();
    assert.equal(
      (await sharedChat.proposals(a.id)).find((p: any) => p.id === proposal.id)
        ?.state,
      "approved",
    );
    const dismissed = await runtime.conversations.propose(
      r.id,
      live.session,
      crypto.randomUUID(),
      {
        title: "Review the zero case",
        finding: "Zero-input coverage has been requested.",
        reason: "It exercises the boundary.",
        next: "Discuss the zero-input case before adding more scope.",
        evidence: [],
      },
    );
    await page.getByRole("button", { name: "Dismiss", exact: true }).waitFor();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByText("dismissed", { exact: true }).waitFor();
    assert.equal(
      (await sharedChat.proposals(a.id)).find((p: any) => p.id === dismissed.id)
        ?.state,
      "dismissed",
    );
    console.log(
      "Verified draft append/reload/refusal/restore, real guidance delivery, Feed approval and dismissal",
    );
    await page.getByRole("button", { name: "About", exact: true }).click();
    await page.getByText("Sum returns a difference", { exact: true }).waitFor();
    await page.screenshot({ path: join(output, "vulcan.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
      "mobile document overflow",
    );
    assert.ok(await page.locator('[data-nav-id="agents"]').isVisible());
    const nav = await page.locator('[data-nav-id="agents"]').boundingBox(),
      sess = await page.locator('[data-nav-id="sessions"]').boundingBox();
    assert.ok(nav.x < sess.x, "Agents follows Sessions on mobile");
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.locator('[data-nav-id="agents"]').focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("data-nav-id"),
      ),
      "sessions",
    );
    const teammate = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await teammate.addInitScript(
      ({ key, session }: any) =>
        localStorage.setItem(key, JSON.stringify(session)),
      {
        key: `agentbox.cloud.auth.${new URL(cfg.url).host}`,
        session: bob.session,
      },
    );
    const other = await teammate.newPage();
    await other.goto(`http://127.0.0.1:${server.port}/#/agents/${a.id}`);
    await other.getByRole("heading", { name: "VULCAN", exact: true }).waitFor();
    assert.equal(
      await other.getByRole("button", { name: "Edit definition" }).count(),
      0,
    );
    assert.equal(
      await other.getByRole("button", { name: "Run now", exact: true }).count(),
      0,
    );
    await other.getByRole("button", { name: "About", exact: true }).click();
    await other
      .getByText("Sum returns a difference", { exact: true })
      .waitFor();
    const removed = await human("RemovedMember");
    await removed.api.acceptInvite((await alice.api.createInvite(ws.id, { email: removed.email })).token);
    const removedContext = await browser.newContext();
    const revokedPage = await removedContext.newPage();
    await revokedPage.goto(`http://127.0.0.1:${server.port}/`);
    await revokedPage.evaluate(({ key, session }: any) => localStorage.setItem(key, JSON.stringify(session)), { key: `agentbox.cloud.auth.${new URL(cfg.url).host}`, session: removed.session });
    await revokedPage.goto(`http://127.0.0.1:${server.port}/#/agents/${a.id}?workspace=${ws.id}`);
    await revokedPage.reload();
    await revokedPage.getByRole("heading", { name: "VULCAN", exact: true }).waitFor();
    await alice.api.removeMember(ws.id, removed.id);
    await revokedPage.getByText("Workspace unavailable", { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(await revokedPage.getByRole("textbox", { name: "Message VULCAN" }).count(), 0);
    // Real sign-out in Team must unmount shared data, including when returning through history.
    await page.locator('[data-nav-id="team"]').click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.locator('[data-nav-id="agents"]').click();
    await page.getByText("Sign in to see your shared agents", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Message VULCAN" }).count(), 0);
    assert.deepEqual(errors, []);
  } catch (e) {
    if (debugPage) { console.log("UI FAILURE", (await debugPage.locator("body").innerText()).slice(-8000)); await debugPage.screenshot({path:join(output,"failure.png")}); }
    throw e;
  } finally {
    if (browser) await browser.close();
    server.stop(true);
  }
  // Actual Fleet stop, fenced replacement, and human takeover through cloud.
  const staleMessage = crypto.randomUUID();
  await sharedChat.guide(a.id, r.id, staleMessage, "Must never reach replacement", null, live.session);
  await assert.rejects(() => sharedChat.guide(a.id, r.id, crypto.randomUUID(), "Foreign session", null, "unrelated-private"));
  await runtime.rotate(r.id);
  await runtime.conversations.tick();
  assert.equal((await sharedChat.receipt(staleMessage)).state, "refused");
  await assert.rejects(() => runtime.conversations.page(a.id, {target:"unrelated-private"}));
  const historical = await runtime.conversations.page(a.id, {target:live.session});
  assert.equal(historical.thread?.writable, false);
  assert.equal(historical.next, null);
  const rotated = runtime.store.runs().find((x: any) => x.run.id === r.id)!;
  assert.equal(spawned, 2);
  assert.equal(fleet.get(live.session).host, "none");
  assert.equal(fleet.heir(live.session), rotated.session);
  await assert.rejects(() =>
    runtime.progress(r.id, live.session, { stage: "in_progress" }),
  );
  assert.ok(runtime.directContactRefusal(live.session));
  let current = (await alice.agents.board(ws.id)).work.find(
    (x: any) => x.id === w.id,
  );
  await alice.agents.takeover(current);
  await runtime.tick();
  current = (await bob.agents.board(ws.id)).work.find(
    (x: any) => x.id === w.id,
  );
  assert.equal(current.control, "human");
  assert.equal(fleet.get(rotated.session).host, "none");
  await alice.agents.progress(current, {
    stage: "verified_resolved",
    next: "",
    outcome:
      "The controlled adapter corrected sum(2, 3) from -1 to 5 in its isolated worktree.",
    evidence: [
      {
        url: "https://example.test/agentbox/validation/7",
        label: "Local controlled lifecycle smoke",
      },
    ],
  });
  // A real Fleet coordinator remains alive while the configured single worker
  // claims a new canonical issue and publishes/receives its scoped follow-up.
  let coordinated = await alice.agents.save({
    workspace: ws.id,
    name: "VULCAN coordination",
    team: true,
    maintainers: [alice.id],
    definition: {
      ...a.definition,
      activation: { mode: "event", when: "" },
      maxConcurrent: 1,
      sources: [{ kind: "manual" }],
    },
  });
  await alice.agents.authorize(coordinated.id, reg.installation.id, true);
  coordinated = await alice.agents.save({
    workspace: ws.id,
    id: coordinated.id,
    base: coordinated.revision,
    name: coordinated.name,
    team: true,
    maintainers: coordinated.maintainers,
    definition: coordinated.definition,
    executor: reg.installation.id,
    enabled: true,
  });
  await runtime.bind({
    agent: coordinated.id,
    url: cfg.url,
    workspace: ws.id,
    provider: "codex",
    repos: { "fixture/repo": repository.id },
  });
  const begun = await alice.api.sb.rpc("agent_conversation_start", {
    p_agent: coordinated.id,
    p_request: crypto.randomUUID(),
  });
  assert.equal(begun.error, null);
  await runtime.tick();
  const coordination = runtime.store
    .runs()
    .find((x: any) => x.run.id === begun.data.id)!;
  assert.equal(coordination.phase, "attached");
  const queued = await runtime.conversationIntake(
    coordination.run.id,
    coordination.session,
    {
      source: "https://github.com/fixture/repo/issues/42",
      title: "Next arithmetic issue",
      acceptance: "Validate the scoped arithmetic behavior",
    },
  );
  await runtime.tick();
  const worker = runtime.store.runs().find((x: any) => x.run.id === queued.id)!;
  assert.equal(worker.phase, "attached", runtime.lastError ?? "worker starved");
  assert.equal(fleet.get(coordination.session).host, "tmux");
  const recommended = await runtime.conversations.propose(
    worker.run.id,
    worker.session,
    crypto.randomUUID(),
    {
      title: "Check the queued issue",
      finding: "The scheduled issue has its own active worker.",
      reason: "Chat remains available during work.",
      next: "Run the local arithmetic check and report the result.",
      evidence: [],
    },
  );
  await new AgentConversation(alice.api).decide(
    recommended.id,
    "approved",
    crypto.randomUUID(),
  );
  await runtime.conversations.tick();
  assert.equal(
    (await sharedChat.proposals(coordinated.id)).find(
      (p: any) => p.id === recommended.id,
    )?.delivery?.state,
    "sent",
  );
  assert.equal(fleet.get(coordination.session).host, "tmux");
  console.log(
    "Verified real coordinator and exclusive issue worker coexist with maxConcurrent=1; approved Feed follow-up delivered",
  );
  // Jupiter's real shared proposal/authoring boundary and runnable custom agent.
  const creatorReply = await alice.api.sb.rpc("agent_creator", { p_workspace:ws.id, p_repos:["fixture/repo"], p_host:reg.installation.id });
  assert.equal(creatorReply.error,null); const jupiter=creatorReply.data;
  const again = await alice.api.sb.rpc("agent_creator", { p_workspace:ws.id, p_repos:["fixture/repo"], p_host:reg.installation.id });
  assert.equal(again.data.id,jupiter.id);
  const notOwner=await bob.api.sb.rpc("agent_creator",{p_workspace:ws.id,p_repos:[],p_host:reg.installation.id}); assert.ok(notOwner.error);
  const creatorStart = await alice.api.sb.rpc("agent_conversation_start",{p_agent:jupiter.id,p_request:crypto.randomUUID()}); assert.equal(creatorStart.error,null);
  await runtime.tick();
  const creatorRun=runtime.store.runs().find((x:any)=>x.run.id===creatorStart.data.id)!;
  assert.equal(creatorRun.phase,"attached",runtime.lastError ?? "creator not started");
  const spec={name:"Atlas shared",role:"Explain code",instructions:"Explain with diagrams and source references.",provider:"codex",limits:"Read only",automation:""};
  await assert.rejects(()=>runtime.conversations.draft(r.id,rotated.session,crypto.randomUUID(),spec));
  const draft=await runtime.conversations.draft(creatorRun.run.id,creatorRun.session,crypto.randomUUID(),spec);
  const edit = (api:any, p:any) => api.sb.rpc("agent_creation_edit",{p_creator:jupiter.id,p_id:draft.id,p_revision:draft.revision,p_spec:spec,p_create:true,...p});
  assert.ok((await edit(bob.api,{})).error);
  assert.ok((await edit(alice.api,{p_creator:a.id})).error);
  assert.ok((await edit(alice.api,{p_revision:0})).error);
  const creation=await edit(alice.api,{}); assert.equal(creation.error,null);
  assert.equal((await edit(alice.api,{})).data.created,creation.data.created);
  const made=(await alice.agents.board(ws.id)).agents.find((x:any)=>x.id===creation.data.created)!;
  assert.equal(made.capability,null); assert.equal(made.created_by,alice.id); assert.deepEqual(made.maintainers,[alice.id]); assert.equal(made.definition.activation.mode,"manual"); assert.equal(made.definition.github.kind,"human");
  assert.deepEqual(made.definition.repos,["fixture/repo"]);
  const first=await alice.api.sb.rpc("agent_conversation_start",{p_agent:made.id,p_request:crypto.randomUUID()}); assert.equal(first.error,null);
  await runtime.tick(); assert.equal(runtime.store.runs().find((x:any)=>x.run.id===first.data.id)?.phase,"attached",runtime.lastError ?? "custom agent not runnable");
  const staleDraft=await runtime.conversations.draft(creatorRun.run.id,creatorRun.session,crypto.randomUUID(),spec);
  await runtime.rotate(creatorRun.run.id);
  assert.ok((await alice.api.sb.rpc("agent_creation_edit",{p_creator:jupiter.id,p_id:staleDraft.id,p_revision:1,p_spec:spec,p_create:true})).error);
  console.log("Verified shared Jupiter capability, human ownership/host grants, scope and revision checks, exactly-once creation, runnable custom instance and replaced-creator refusal");
  console.log(
    JSON.stringify({
      ok: true,
      workspace: ws.id,
      agent: a.id,
      run: r.id,
      spawned,
      checks: [
        "capability rejects missing/forged PID and other session token",
        "human host JWT denies teammate and omitted identity",
        "generic UI create/edit revisions",
        "runtime restart retains one writer",
        "real CLI capability progress",
        "actual Fleet worktree/session spawn",
        "shared two-human progress",
        "standalone denial",
        "exclusive writer",
        "git-history expertise",
        "desktop/mobile/keyboard",
        "viewer cannot edit/run",
        "membership removal unmounts stale shared conversation",
        "real sign-out clears shared agent access",
        "fenced session rotation",
        "takeover waits for stop",
        "evidence-gated human outcome",
      ],
      fixture: dir,
      screenshots: [
        join(output, "directory.png"),
        join(output, "vulcan.png"),
        join(output, "mobile.png"),
      ],
    }),
  );
} finally {
  for (const s of fleet.sessions()) if (s.tmux) tmux.killSession(s.tmux);
  fleet.stop();
  runtime.store.db.close();
  db.closeDb();
}
process.exit(0);
