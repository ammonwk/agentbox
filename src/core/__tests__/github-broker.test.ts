/** The GitHub App broker's security rules: a token never leaves it, only a
 *  pinned and unchanged policy acts, consent and the claim fence are read at
 *  dispatch (after any approval), a request id means one action, and an
 *  interrupted action is never sent again. GitHub is a fake transport. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cards } from "../cards";
import { closeDb, getDb } from "../db";
import { FleetError, type Fleet } from "../fleet";
import { GitHubActions, type ClaimCheck } from "../github/actions";
import { GitHubBroker } from "../github/broker";
import { superagentToken } from "../superagents";
import type { Superagents } from "../superagents";
import { githubRoutes } from "../../server/github";
import { HttpError, Router, toHttpError } from "../../server/router";

const TOKEN = "server-only-fixture-token";
const dir = mkdtempSync(join(tmpdir(), "agentbox-broker-"));
const saDir = join(dir, "sa");
const pem = join(dir, "app.pem");
const saved = { home: process.env.HOME, box: process.env.AGENTBOX_HOME };

let allowed = true;
let mutations = 0;
let failComment = false;
const transport = (async (url: string | URL | Request, init?: RequestInit) => {
  const path = new URL(String(url)).pathname;
  const method = init?.method ?? "GET";
  let body: unknown;
  if (path === "/app") body = { slug: "fixture-bot", id: 10 };
  else if (path === "/app/installations/20") body = { app_id: 10, account: { login: "fixture" } };
  else if (path.endsWith("/access_tokens")) body = { token: TOKEN };
  else if (path.startsWith("/users/")) {
    const login = decodeURIComponent(path.slice(7));
    body = login.endsWith("[bot]") ? { id: 1, login } : { id: 42, login };
  } else if (path.endsWith("/issues/1") && method === "GET") body = { user: { login: "reporter" }, title: "t", body: "b", html_url: "https://github.com/fixture/repo/issues/1", state: "open", labels: [] };
  else if (path.endsWith("/comments") && method === "POST") {
    mutations++;
    if (failComment) throw new Error("socket closed");
    body = { html_url: "https://github.com/fixture/repo/issues/1#comment-1" };
  } else throw new Error(`unexpected fixture endpoint ${method} ${path}`);
  return Response.json(body);
}) as typeof fetch;

const basePolicy = {
  app: { appId: 10, installationId: 20, login: "fixture-bot[bot]" },
  repos: ["fixture/repo"],
  actions: ["comment"],
  approval: "prepare",
};
const writeManifest = (github: unknown) => writeFileSync(join(saDir, "superagent.json"), JSON.stringify({ name: "sa", github }));

let actions: GitHubActions;
let router: Router;
let fence = 1;
const claims: ClaimCheck = { current: async () => ({ fence, holder: { superagent: "sa", session: null } }) };

const newActions = () => {
  const a = new GitHubActions({ broker: new GitHubBroker(transport), cards: new Cards({} as Fleet, () => {}), dirOf: () => saDir, cwdOf: () => null });
  a.consent = { check: async (rs) => rs.map((r) => ({ id: r.id, allowed })) };
  return a;
};

async function call(method: string, path: string, body?: unknown, who: "program" | "person" | "session" = "program") {
  const headers: Record<string, string> = { "content-type": "application/json", "x-agentbox": "1" };
  if (who === "program") Object.assign(headers, { "x-agentbox-superagent": "sa", "x-agentbox-superagent-token": superagentToken("sa") });
  if (who === "session") Object.assign(headers, { "x-agentbox-session": "child", "x-agentbox-session-token": "0".repeat(64) });
  const res = await router.handle(new Request(`http://127.0.0.1:4479${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  answers.push(text);
  return { status: res.status, text, data: (JSON.parse(text) as { data: any }).data };
}
const answers: string[] = [];

async function pinNow() {
  const seen = await call("GET", "/api/github/policies/sa", undefined, "person");
  const r = await call("POST", "/api/github/policies/sa", { digest: seen.data.proposed.digest, appKeyPath: pem }, "person");
  expect(r.status).toBe(200);
}
const comment = (body = "I can reproduce the report.") => ({ kind: "comment", repo: "fixture/repo", number: 1, body });

beforeAll(() => {
  process.env.HOME = join(dir, "home");
  process.env.AGENTBOX_HOME = join(dir, "box");
  mkdirSync(process.env.HOME, { recursive: true });
  mkdirSync(saDir, { recursive: true });
  closeDb();
  writeFileSync(pem, generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey, {
    mode: 0o600,
  });
});
afterAll(() => {
  closeDb();
  process.env.HOME = saved.home;
  if (saved.box === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = saved.box;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  getDb().run("DELETE FROM github_pins");
  getDb().run("DELETE FROM github_actions");
  getDb().run("DELETE FROM cards");
  allowed = true;
  mutations = 0;
  failComment = false;
  fence = 1;
  writeManifest(basePolicy);
  actions = newActions();
  router = new Router((e) => (e instanceof FleetError ? new HttpError(e.status, e.message) : toHttpError(e)));
  // The hub as these routes use it: one superagent "sa", whose main started "child".
  const hub = {
    has: (n: string) => n === "sa",
    get: (n: string) => ({ name: n, dir: saDir }),
    manifest: () => JSON.parse(readFileSync(join(saDir, "superagent.json"), "utf8")),
    ownerOf: (id: string) => (id === "main1" || id === "child" ? "sa" : null),
  } as unknown as Superagents;
  githubRoutes(router, actions, hub);
});

test("a token never appears in any route answer, the journal or a log line", async () => {
  const logged: string[] = [];
  const keep = { log: console.log, error: console.error, warn: console.warn };
  for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    writeManifest({ ...basePolicy, approval: "automatic" });
    await pinNow();
    const sent = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment() });
    expect(sent.data.state).toBe("sent");
    expect(mutations).toBe(1);
    await call("GET", `/api/github/actions/${sent.data.request}`);
    await call("GET", "/api/github/actions");
    await call("POST", "/api/github/read", { repo: "fixture/repo", kind: "issue", number: 1 });
    failComment = true;
    const broken = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment("again") });
    expect(broken.data.state).toBe("uncertain");
    await actions.tick();
  } finally {
    Object.assign(console, keep);
  }
  const journal = JSON.stringify(getDb().query("SELECT * FROM github_actions").all()) + JSON.stringify(getDb().query("SELECT * FROM cards").all());
  for (const text of [...answers, ...logged, journal]) expect(text).not.toContain(TOKEN);
});

test("an unpinned or changed policy refuses, and only a person pins", async () => {
  const unpinned = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment() });
  expect(unpinned.status).toBe(403);
  expect(unpinned.text).toContain("no pinned GitHub policy");

  const seen = await call("GET", "/api/github/policies/sa", undefined, "person");
  for (const who of ["program", "session"] as const) expect((await call("POST", "/api/github/policies/sa", { digest: seen.data.proposed.digest, appKeyPath: pem }, who)).status).toBe(403);

  await pinNow();
  const prepared = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment() });
  expect(prepared.data.state).toBe("prepared");

  // The manifest widens its own policy: nothing it asks for runs until the owner pins again.
  writeManifest({ ...basePolicy, repos: ["fixture/repo", "fixture/other"] });
  const changed = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment() });
  expect(changed.status).toBe(403);
  expect(changed.text).toContain("changed since it was pinned");
  const approved = await call("POST", `/api/github/actions/${prepared.data.request}/approve`, undefined, "person");
  expect(approved.data.state).toBe("refused");
  expect(mutations).toBe(0);
});

test("an action outside the pinned repos or kinds refuses", async () => {
  await pinNow();
  const repo = await call("POST", "/api/github/actions", { request: randomUUID(), action: { ...comment(), repo: "fixture/other" } });
  expect(repo.status).toBe(403);
  const kind = await call("POST", "/api/github/actions", {
    request: randomUUID(),
    action: { kind: "ready_pr", repo: "fixture/repo", number: 2, head: "a".repeat(40), base: "main" },
  });
  expect(kind.status).toBe(403);
  expect(getDb().query("SELECT COUNT(*) AS n FROM github_actions").get()).toEqual({ n: 0 });
  expect(mutations).toBe(0);
});

test("consent is read at dispatch: an approval does not outlive an opt-out, and no cloud means no contact", async () => {
  await pinNow();
  const prepared = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment("Thanks @Helper, does this fix it?") });
  expect(prepared.data.state).toBe("prepared");
  expect(prepared.data.card).toBeGreaterThan(0);
  expect((await call("POST", `/api/github/actions/${prepared.data.request}/approve`)).status).toBe(403);

  allowed = false; // revoked after the request, before the approval
  const approved = await call("POST", `/api/github/actions/${prepared.data.request}/approve`, undefined, "person");
  expect(approved.data.state).toBe("refused");
  expect(approved.data.result.message).toContain("no verified opt-in");
  expect(mutations).toBe(0);

  allowed = true;
  actions.consent = null;
  const local = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment() });
  const noCloud = await call("POST", `/api/github/actions/${local.data.request}/approve`, undefined, "person");
  expect(noCloud.data.state).toBe("refused");
  expect(mutations).toBe(0);

  const team = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment("cc @fixture/maintainers") });
  actions.consent = { check: async (rs) => rs.map((r) => ({ id: r.id, allowed: true })) };
  expect((await call("POST", `/api/github/actions/${team.data.request}/approve`, undefined, "person")).data.state).toBe("refused");
  expect(mutations).toBe(0);
});

test("a request id is one action: a retry answers the same record, another body is 409", async () => {
  await pinNow();
  const request = randomUUID();
  const first = await call("POST", "/api/github/actions", { request, action: comment() });
  const again = await call("POST", "/api/github/actions", { request, action: comment() });
  expect(again.data).toEqual(first.data);
  expect(getDb().query("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 1 });
  const other = await call("POST", "/api/github/actions", { request, action: comment("something else") });
  expect(other.status).toBe(409);
});

test("an action left attempting by a stopped server is uncertain and never sent again", async () => {
  await pinNow();
  const r = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment() });
  getDb().run("UPDATE github_actions SET state = 'attempting' WHERE request = ?", [r.data.request]);
  const next = newActions();
  next.start();
  next.stop();
  await next.tick();
  const after = await call("GET", `/api/github/actions/${r.data.request}`);
  expect(after.data.state).toBe("uncertain");
  expect((await call("POST", `/api/github/actions/${r.data.request}/approve`, undefined, "person")).data.state).toBe("uncertain");
  expect(mutations).toBe(0);
});

test("a claim is checked at dispatch: a stale fence refuses, and so does a claim with no claims service", async () => {
  await pinNow();
  const noService = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment(), claim: { key: "https://github.com/fixture/repo/issues/1", fence: 1 } });
  expect(noService.status).toBe(409);

  actions.claims = claims;
  fence = 2;
  const stale = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment(), claim: { key: "https://github.com/fixture/repo/issues/1", fence: 1 } });
  expect(stale.status).toBe(409);

  const held = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment(), claim: { key: "https://github.com/fixture/repo/issues/1", fence: 2 } }, "session");
  expect(held.status).toBe(403); // a forged session capability is nobody
  const ok = await call("POST", "/api/github/actions", { request: randomUUID(), action: comment(), claim: { key: "https://github.com/fixture/repo/issues/1", fence: 2 } });
  expect(ok.data.state).toBe("prepared");
  fence = 3; // taken over between the request and the approval
  const approved = await call("POST", `/api/github/actions/${ok.data.request}/approve`, undefined, "person");
  expect(approved.data.state).toBe("refused");
  expect(mutations).toBe(0);
});
