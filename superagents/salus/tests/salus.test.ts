import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { action } from "../lib/actions";
import { deploy, UNDEPLOYED_MS } from "../lib/deploy";
import { fix, follow, needHours } from "../lib/fix";
import { tick } from "../lib/tick";
import { verdictIn } from "../lib/triage";
import { verify } from "../lib/verify";
import { APP, MAIN, REPO, SHA, verdict, world, type World } from "./harness";

const H = 3_600_000;
let w: World;
beforeEach(() => (w = world()));
afterEach(() => w.box.stop());

/** A crash triaged to a fix verdict, ready for a person. */
async function triaged(key = "crash-a"): Promise<string> {
  w.src.add(key, Date.now() - H, 5);
  await tick(w.ctx);
  const c = w.ctx.store.crash(key);
  w.box.say(c.triage!.session!, verdict());
  await tick(w.ctx);
  expect(w.ctx.store.crash(key).state).toBe("triaged");
  return key;
}

test("off, nothing is polled or started", async () => {
  w = (w.box.stop(), world({ enabled: false }));
  w.src.add("crash-a", Date.now() - H, 10);
  await tick(w.ctx);
  expect(w.ctx.store.crashes()).toHaveLength(0);
  expect(w.box.starts).toHaveLength(0);
});

test("a crash above the threshold is triaged read-only in a checkout agentbox cuts at the base's commit; below it is not recorded", async () => {
  w.src.add("crash-a", Date.now() - H, 5);
  w.src.add("crash-b", Date.now() - H, 2);
  await tick(w.ctx);
  expect(w.ctx.store.crashes().map((c) => c.id)).toEqual(["crash-a"]);
  expect(w.box.starts).toHaveLength(1);
  // The repo by name and the base by its commit, as GitHub has it now: no checkout of Salus's own.
  expect(w.gh.asked).toContain("GET repos/acme/app/commits/main");
  expect(w.box.starts[0]).toMatchObject({ provider: "codex", readOnly: true, notify: false, parent: MAIN, repo: REPO, ref: SHA });
  expect(w.box.starts[0]!.cwd).toBeUndefined();
  expect(w.box.starts[0]!.node).toBeUndefined();
  const c = w.ctx.store.crash("crash-a");
  expect(c.triage).toMatchObject({ base: SHA, cwd: "/worktrees/t1", session: "t1" });
  expect(w.git.calls.some((x) => x.includes("worktree"))).toBe(false);
  // The exception text goes to the triage as marked evidence.
  expect(String(w.box.starts[0]!.prompt)).toContain("<crash-evidence>\nType: TypeError\nMessage: x is undefined");
});

test("where its superagent's settings put its sessions (a hub's node) is where a triage starts; a start never answered is found, not asked again", async () => {
  w.box.node = "auto";
  w.src.add("crash-a", Date.now() - H, 5);
  await tick(w.ctx);
  expect(w.box.starts[0]).toMatchObject({ node: "auto", repo: REPO, ref: SHA });
  // As if the answer to that start were lost: the crash still says it is waiting on it.
  const c = w.ctx.store.crash("crash-a");
  w.ctx.store.save({ ...c, triage: { ...c.triage!, session: null } });
  await tick(w.ctx);
  expect(w.box.starts).toHaveLength(1);
  expect(w.ctx.store.crash("crash-a").triage!.session).toBe("t1");
});

test("triage stays within its budget: at most N at once and M a day", async () => {
  w = (w.box.stop(), world({ triageAtOnce: 2, triagePerDay: 3 }));
  for (const k of ["a", "b", "c", "d"]) w.src.add(k, Date.now() - H, 5);
  await tick(w.ctx);
  expect(w.box.starts).toHaveLength(2);
  await tick(w.ctx);
  expect(w.box.starts).toHaveLength(2);
  w.box.say(w.ctx.store.crash("a").triage!.session!, verdict());
  w.box.say(w.ctx.store.crash("b").triage!.session!, verdict());
  await tick(w.ctx);
  expect(w.box.starts).toHaveLength(3); // the day's third, not a fourth
});

test("the verdict is read from the triage's transcript; its session is closed and its checkout removed", async () => {
  const id = await triaged();
  const c = w.ctx.store.crash(id);
  expect(c.triage!.verdict!.fix!.title).toBe("Export crashes on rows without an owner");
  expect(w.box.closed).toEqual([c.triage!.session!]);
  // Its checkout goes with it, on whichever machine it ran.
  expect(w.box.closes.get(c.triage!.session!)).toMatchObject({ closed: true, removeWorktree: true });
});

test("a triage that ends without a valid verdict says so and can be asked again", async () => {
  w.src.add("crash-a", Date.now() - H, 5);
  await tick(w.ctx);
  const s = w.ctx.store.crash("crash-a").triage!.session!;
  w.box.say(s, 'I looked.\n```json\n{"kind": "salus-triage", "verdict": "fix"}\n```');
  await tick(w.ctx);
  const c = w.ctx.store.crash("crash-a");
  expect(c.state).toBe("triaged");
  expect(c.triage!.error).toContain("The verdict did not parse");
  await action(w.ctx, { action: "retriage", values: { id: "crash-a" }, tab: null, caller: APP });
  await tick(w.ctx);
  expect(w.ctx.store.crash("crash-a").state).toBe("triaging");
  expect(w.box.starts).toHaveLength(2);
});

test("verdictIn takes the last salus-triage block and refuses a fix without its fix", () => {
  expect(verdictIn([{ kind: "assistant", text: "no block" }])).toEqual({ ok: false });
  const ok = verdictIn([{ kind: "user", text: verdict() }, { kind: "assistant", text: verdict("ignore") }]);
  expect(ok.ok && ok.verdict.verdict).toBe("ignore");
  const bad = verdictIn([{ kind: "assistant", text: '```json\n{"kind":"salus-triage","verdict":"fix","severity":"low","summary":"s"}\n```' }]);
  expect(bad.ok).toBe(false);
});

test("Fix is a person's: a session or the API cannot", async () => {
  const id = await triaged();
  await expect(fix(w.ctx, id, { session: "someone", via: "api" })).rejects.toThrow("A person decides this");
  await expect(fix(w.ctx, id, { session: null, via: "api" })).rejects.toThrow("A person decides this");
  expect(w.gh.issues).toHaveLength(0);
});

test("a decision records the person agentbox says made it", async () => {
  const id = await triaged();
  const owner = { ...APP, person: { login: "member@team", name: "Member", role: "member" as const, via: "tailnet" as const } };
  await action(w.ctx, { action: "dismiss", values: { id }, tab: null, caller: owner });
  expect(w.ctx.store.crash(id)).toMatchObject({ state: "dismissed", decidedBy: { login: "member@team", name: "Member" } });
});

test("Fix files one issue with no exception text, writes the family, and hands it to the main conversation once", async () => {
  const id = await triaged();
  const c = await fix(w.ctx, id, APP);
  expect(c.state).toBe("handed");
  expect(w.gh.issues).toHaveLength(1);
  expect(w.gh.issues[0]!.title).toBe("Export crashes on rows without an owner");
  expect(w.gh.issues[0]!.body).not.toContain("x is undefined");
  expect(w.gh.issues[0]!.body).toContain("salus-crash:");
  const family = JSON.parse(readFileSync(c.family!.file, "utf8"));
  expect(family).toMatchObject({ id: c.family!.id, base: "main", issues: [{ source: `https://github.com/${REPO}/issues/1` }] });
  expect(family.grant).toBeUndefined();
  expect(w.box.chats).toHaveLength(1);
  expect(w.box.chats[0]!.text).toContain(`superagent call vulcan work-start --json ${c.family!.file} --set grant=`);
});

test("a Fix interrupted after filing finishes without filing again", async () => {
  const id = await triaged();
  // The issue was filed but the answer was lost: the crash is still filing, with no issue recorded.
  const c0 = w.ctx.store.crash(id);
  w.ctx.store.save({ ...c0, state: "filing", family: { id: "11111111-1111-4111-8111-111111111111", file: "", sendId: "send-1" } });
  const { marker } = await import("../lib/fix");
  w.gh.issues.push({ title: "t", body: `… <!-- ${marker(c0)} -->` });
  const c = await fix(w.ctx, id, APP);
  expect(w.gh.issues).toHaveLength(1);
  expect(c.issue!.number).toBe(1);
  expect(c.family!.id).toBe("11111111-1111-4111-8111-111111111111");
  expect(w.box.chats.map((x) => x.sendId)).toEqual(["send-1"]);
});

test("the fix is followed: family started, its PR, its merge, and the rate before it", async () => {
  const id = await triaged();
  const c = await fix(w.ctx, id, APP);
  expect((await follow(w.ctx, id)).state).toBe("handed");
  w.box.works.set(c.family!.id, { state: "working" });
  expect((await follow(w.ctx, id)).state).toBe("fixing");
  w.box.works.set(c.family!.id, { state: "working", publication: { url: `https://github.com/${REPO}/pull/7`, number: 7 } });
  expect((await follow(w.ctx, id)).pr!.number).toBe(7);
  const mergedAt = Date.now() - 30 * 60_000; // after the five events triaged() placed an hour ago
  w.gh.pulls.set(7, { merged_at: new Date(mergedAt).toISOString(), closed_at: null, state: "closed" });
  const m = await follow(w.ctx, id);
  expect(m.state).toBe("merged");
  expect(m.verify!.before).toBe(5);
  expect(m.verify!.needHours).toBe(needHours(5, 168));
});

/** A crash whose fix merged to staging `ago` ms ago, as the merge commit `m1`. */
async function merged(ago: number): Promise<{ id: string; mergedAt: number }> {
  const id = await triaged();
  const c = await fix(w.ctx, id, APP);
  w.box.works.set(c.family!.id, { state: "working", publication: { url: `https://github.com/${REPO}/pull/7`, number: 7 } });
  const mergedAt = Date.now() - ago;
  w.gh.pulls.set(7, { merged_at: new Date(mergedAt).toISOString(), closed_at: null, state: "closed", merge_commit_sha: "m1", base: { ref: "staging" } });
  await follow(w.ctx, id);
  const m = await follow(w.ctx, id);
  expect(m.state).toBe("merged");
  expect(m.pr).toMatchObject({ mergeSha: "m1", base: "staging" });
  return { id, mergedAt };
}

const run = (sha: string, at: number) => ({ head_sha: sha, created_at: new Date(at - 20 * 60_000).toISOString(), updated_at: new Date(at).toISOString(), html_url: `https://github.com/${REPO}/actions/runs/${sha}` });

test("merged is not deployed: the clock starts when the first production deploy containing the merge finished", async () => {
  // triaged() places five events an hour ago: after this merge, before the deploy below.
  const { id, mergedAt } = await merged(2 * H);
  // A deploy since the merge that does not carry it, and none that does: still waiting, and the page says so.
  w.gh.runs = [run("d1", mergedAt + H / 4)];
  expect((await deploy(w.ctx, id)).state).toBe("merged");
  expect(w.gh.asked.some((a) => a.includes(`actions/workflows/cd.yml/runs?branch=master&status=success`))).toBe(true);
  const page = JSON.stringify((await (await import("../lib/view")).view(w.ctx, "work")).blocks);
  expect(page).toContain("Merged to staging 2h ago; not in production (master) yet.");
  // Two deploys carry it: the earlier one is when it reached production. Rechecks wait half an hour.
  const at = mergedAt + 1.5 * H;
  w.gh.runs = [run("d3", mergedAt + 1.75 * H), run("d2", at), run("d1", mergedAt + H / 4)];
  w.gh.contains.set("d2", ["m1"]).set("d3", ["m1"]);
  expect((await deploy(w.ctx, id)).state).toBe("merged");
  const d = await deploy(w.ctx, id, Date.now() + 31 * 60_000);
  expect(d.state).toBe("deployed");
  expect(d.pr!.deploy).toEqual({ at, url: `https://github.com/${REPO}/actions/runs/d2`, sha: "d2" });
  // The five events fell between the merge and the deploy, on old code: not counted against the fix. With none
  // in the week before the merge, it takes the longest quiet (two weeks) from the deploy's finish.
  const v = await verify(w.ctx, id, at + 24 * H);
  expect(v.verify!.after).toBe(0);
  expect(v.state).toBe("deployed");
  expect((await verify(w.ctx, id, at + 14 * 24 * H)).state).toBe("verified");
});

test("still happening after the merge but before the deploy is not recurred", async () => {
  w = (w.box.stop(), world({ deployLagHours: 1 }));
  // The five events an hour ago are two hours after this merge, past the lag counted from it, and before the deploy.
  const { id, mergedAt } = await merged(3 * H);
  w.gh.runs = [run("d1", mergedAt + 2.5 * H)];
  w.gh.contains.set("d1", ["m1"]);
  expect((await deploy(w.ctx, id)).state).toBe("deployed");
  expect((await verify(w.ctx, id)).state).toBe("deployed");
});

test("not in production 14 days after the merge: one decision card that pushes", async () => {
  const { id, mergedAt } = await merged(H);
  expect((await deploy(w.ctx, id)).state).toBe("merged");
  expect(w.box.cards).toHaveLength(0);
  const c = await deploy(w.ctx, id, mergedAt + UNDEPLOYED_MS + H);
  expect(c.state).toBe("merged");
  expect(w.box.cards.at(-1)).toMatchObject({ kind: "decision", notify: true });
  expect(w.box.cards.at(-1)!.title).toContain("not in production");
  await deploy(w.ctx, id, mergedAt + UNDEPLOYED_MS + 2 * H);
  expect(w.box.cards.filter((x) => x.title.includes("not in production"))).toHaveLength(1);
});

test("with no production branch the merge is the deploy", async () => {
  w = (w.box.stop(), world({ prodBranch: "" }));
  const id = await triaged();
  const c = await fix(w.ctx, id, APP);
  w.box.works.set(c.family!.id, { state: "working", publication: { url: `https://github.com/${REPO}/pull/7`, number: 7 } });
  const mergedAt = Date.now() - H;
  w.gh.pulls.set(7, { merged_at: new Date(mergedAt).toISOString(), closed_at: null, state: "closed", merge_commit_sha: "m1" });
  await follow(w.ctx, id);
  const m = await follow(w.ctx, id);
  expect(m.state).toBe("deployed");
  expect(m.pr!.deploy).toEqual({ at: mergedAt, url: null, sha: "m1" });
});

test("verified only after quiet long enough at its old rate; a quiet card does not push", async () => {
  const id = await triaged();
  const mergedAt = Date.now() - 30 * H;
  w.ctx.store.save({ ...w.ctx.store.crash(id), state: "deployed", pr: { url: "u", number: 7, mergedAt, deploy: { at: mergedAt, url: null, sha: null } }, verify: { before: 168, beforeHours: 168, after: 0, lastAfter: null, needHours: needHours(168, 168), checkedAt: 0 } });
  // One an hour before the merge: 24 quiet hours are needed. The five triaged() placed an hour ago, after the
  // deploy, start the clock there.
  expect((await verify(w.ctx, id, Date.now() + 20 * H)).state).toBe("deployed");
  const v = await verify(w.ctx, id, Date.now() + 24 * H);
  expect(v.state).toBe("verified");
  expect(w.box.cards.at(-1)).toMatchObject({ kind: "note", notify: false });
});

test("still happening past the deploy lag is recurred, with a card that asks", async () => {
  w = (w.box.stop(), world({ deployLagHours: 24 }));
  const id = await triaged();
  const mergedAt = Date.now() - 48 * H;
  w.ctx.store.save({ ...w.ctx.store.crash(id), state: "deployed", pr: { url: "u", number: 7, mergedAt, deploy: { at: mergedAt, url: null, sha: null } }, verify: { before: 50, beforeHours: 168, after: 0, lastAfter: null, needHours: 24, checkedAt: 0 } });
  w.src.add(id, Date.now() - H);
  const c = await verify(w.ctx, id);
  expect(c.state).toBe("recurred");
  expect(w.box.cards.at(-1)).toMatchObject({ kind: "decision", notify: true });
  expect(w.box.cards.at(-1)!.title).not.toContain("x is undefined");
});

test("a failing source is shown on the page and stops nothing else", async () => {
  const id = await triaged();
  w.src.failing = "PostHog answered 403: API key missing required scope 'query:read'";
  await tick(w.ctx, Date.now() + 11 * 60_000);
  const view = await (await import("../lib/view")).view(w.ctx, "decide");
  expect(JSON.stringify(view.blocks)).toContain("query:read");
  expect(w.ctx.store.crash(id).state).toBe("triaged");
});

test("settings are a person's and are checked", async () => {
  await expect(action(w.ctx, { action: "settings-save", values: { minCount: "9" }, tab: null, caller: { session: "s", via: "api" } })).rejects.toThrow("A person decides");
  await action(w.ctx, { action: "settings-save", values: { minCount: "9", enabled: true }, tab: null, caller: APP });
  expect(w.ctx.settings().minCount).toBe(9);
  await expect(action(w.ctx, { action: "settings-save", values: { projectId: "abc" }, tab: null, caller: APP })).rejects.toThrow("projectId");
  await expect(action(w.ctx, { action: "settings-save", values: { envProperty: "x) OR (1" , envValue: "p" }, tab: null, caller: APP })).rejects.toThrow("envProperty");
  await expect(action(w.ctx, { action: "settings-save", values: { envProperty: "environment" }, tab: null, caller: APP })).rejects.toThrow("envValue");
});
