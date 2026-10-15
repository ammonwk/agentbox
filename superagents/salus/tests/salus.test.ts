import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { action } from "../lib/actions";
import { fix, follow, needHours } from "../lib/fix";
import { tick } from "../lib/tick";
import { verdictIn } from "../lib/triage";
import { verify } from "../lib/verify";
import { APP, MAIN, REPO, verdict, world, type World } from "./harness";

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

test("a crash above the threshold is triaged read-only in a checkout of the fetched base; below it is not recorded", async () => {
  w.src.add("crash-a", Date.now() - H, 5);
  w.src.add("crash-b", Date.now() - H, 2);
  await tick(w.ctx);
  expect(w.ctx.store.crashes().map((c) => c.id)).toEqual(["crash-a"]);
  expect(w.box.starts).toHaveLength(1);
  expect(w.box.starts[0]).toMatchObject({ provider: "codex", readOnly: true, notify: false, parent: MAIN });
  const c = w.ctx.store.crash("crash-a");
  expect(w.box.starts[0]!.cwd).toBe(c.triage!.cwd);
  expect(w.git.calls.some((x) => x.endsWith("fetch --quiet origin refs/heads/main"))).toBe(true);
  expect(w.git.calls.some((x) => x.includes(`worktree add --detach ${c.triage!.cwd}`))).toBe(true);
  // The exception text goes to the triage as marked evidence.
  expect(String(w.box.starts[0]!.prompt)).toContain("<crash-evidence>\nType: TypeError\nMessage: x is undefined");
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
  expect(w.git.calls.some((x) => x.includes(`worktree remove --force ${c.triage!.cwd}`))).toBe(true);
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

test("verified only after quiet long enough at its old rate; a quiet card does not push", async () => {
  const id = await triaged();
  const mergedAt = Date.now() - 30 * H;
  w.ctx.store.save({ ...w.ctx.store.crash(id), state: "merged", pr: { url: "u", number: 7, mergedAt }, verify: { before: 168, beforeHours: 168, after: 0, lastAfter: null, needHours: needHours(168, 168), checkedAt: 0 } });
  // One an hour before the merge: 24 quiet hours are needed. The five triaged() placed an hour ago, after the
  // merge (before it was deployed), start the clock there.
  expect((await verify(w.ctx, id, Date.now() + 20 * H)).state).toBe("merged");
  const v = await verify(w.ctx, id, Date.now() + 24 * H);
  expect(v.state).toBe("verified");
  expect(w.box.cards.at(-1)).toMatchObject({ kind: "note", notify: false });
});

test("still happening past the deploy lag is recurred, with a card that asks", async () => {
  w = (w.box.stop(), world({ deployLagHours: 24 }));
  const id = await triaged();
  const mergedAt = Date.now() - 48 * H;
  w.ctx.store.save({ ...w.ctx.store.crash(id), state: "merged", pr: { url: "u", number: 7, mergedAt }, verify: { before: 50, beforeHours: 168, after: 0, lastAfter: null, needHours: 24, checkedAt: 0 } });
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
});
