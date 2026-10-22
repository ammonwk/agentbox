import { afterEach, beforeEach, expect, test } from "bun:test";
import { followPublication, publish, reconcile } from "../lib/publish";
import { collect, review } from "../lib/reviews";
import { agentPrTitle, mentionedPeople, refuseAutomaticClosure } from "../lib/text";
import type { Work } from "../lib/types";
import { startWork } from "../lib/work";
import { ACTOR, BASE, family, HEAD1, HEAD2, MAIN, REPO, verdict, world, type World } from "./harness";

let w: World;
let work: Work;
beforeEach(async () => {
  w = world();
  work = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
});
afterEach(() => w.box.stop());

async function cleanRound(head: string) {
  w.git.heads.set(work.cwd!, head);
  const r = await review(w.ctx, work.id, work.session, { validation: ["bun test"] });
  for (const x of r.reviewers) {
    w.box.session(x.session!).status = "waiting";
    w.box.say(x.session!, verdict(r.number, x.focus, BASE, head));
  }
  await collect(w.ctx, work.id, work.session);
}

const req = (head = HEAD1, title = "Fix the export", body = "Plain words about the change. See https://github.com/acme/app/issues/1.") => ({ head, title, body });

test("the title is [Agent · Human] summary, with mentions and brackets taken out", () => {
  expect(agentPrTitle("Vulcan", "Ada Lovelace", "Fix the export")).toBe("[Vulcan · Ada Lovelace] Fix the export");
  expect(agentPrTitle("Vulcan", "Ada", "[WIP] @bob fix [x]")).toBe("[Vulcan · Ada] bob fix x");
  expect(() => agentPrTitle("Vulcan", "", "x")).toThrow("accountable human");
  expect(() => agentPrTitle("Vulcan", "Ada", "[only a tag]")).toThrow("Describe the concrete change");
  expect(agentPrTitle("Vulcan", "Ada", "x".repeat(400))).toHaveLength(256);
});

test("closing keywords and mentions are refused wherever they appear", () => {
  for (const t of ["Fixes #12", "closes acme/app#3", "Resolved: https://github.com/acme/app/issues/9", "fix #1"]) expect(() => refuseAutomaticClosure(t)).toThrow("plain issue links");
  refuseAutomaticClosure("See #12 and https://github.com/acme/app/issues/9; the fix is small.");
  expect(mentionedPeople("thanks @Bob and `@alice`, also &#64;carol")).toEqual(["bob", "alice", "carol"]);
  expect(() => mentionedPeople("cc @acme/core")).toThrow("Team mentions");
  expect(mentionedPeople("mail me at a@b.c")).toEqual(["b"]);
});

test("publication is refused without three clean verdicts on exactly this base and head", async () => {
  w.git.heads.set(work.cwd!, HEAD1);
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("three completed independent clean reviews");
  await cleanRound(HEAD1);
  // The head moved since the round.
  w.git.heads.set(work.cwd!, HEAD2);
  await expect(publish(w.ctx, work.id, work.session, req(HEAD2))).rejects.toThrow("three completed independent clean reviews");
  // The base moved on GitHub since the round.
  w.git.heads.set(work.cwd!, HEAD1);
  w.git.remoteBranches.set("main", "9".repeat(40));
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("three completed independent clean reviews");
  expect(w.git.pushes).toHaveLength(0);
  expect(w.gh.pulls).toHaveLength(0);
});

test("publication is refused for the wrong caller, actor, title text, body or commit messages", async () => {
  await cleanRound(HEAD1);
  await expect(publish(w.ctx, work.id, MAIN, req())).rejects.toThrow("Only this work's owner");
  await expect(publish(w.ctx, work.id, work.session, req(HEAD1, "x", "Fixes #1"))).rejects.toThrow("plain issue links");
  await expect(publish(w.ctx, work.id, work.session, req(HEAD1, "x", "ping @bob"))).rejects.toThrow("No local outreach consent");
  await expect(publish(w.ctx, work.id, work.session, req(HEAD1, "x", "cc @acme/core"))).rejects.toThrow("Team mentions");
  w.gh.login = "someone-else";
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("Publication credential changed");
  w.gh.login = ACTOR;
  w.git.commitMessages = "Closes #1\n\nDone.";
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("plain issue links");
  w.git.commitMessages = "Thanks @bob";
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("Commit messages contain targeted outreach");
  w.git.commitMessages = "Fine.";
  w.git.dirty.add(work.cwd!);
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("Candidate changed after review");
  expect(w.git.pushes).toHaveLength(0);
  expect(w.gh.pulls).toHaveLength(0);
});

test("a publication pushes, requests, claims the PR for the writer and arms its waits; the same request again only follows", async () => {
  await cleanRound(HEAD1);
  const out = await publish(w.ctx, work.id, work.session, req());
  expect(w.git.pushes).toEqual([`${HEAD1}:refs/heads/${work.branch}`]);
  expect(w.gh.pulls).toHaveLength(1);
  expect(w.gh.pulls[0]).toMatchObject({ title: "[Vulcan · Ada Lovelace] Fix the export", head: { ref: work.branch }, base: { ref: "main" } });
  expect(out.state).toBe("sent");
  expect(out.number).toBe(1);
  expect(out.owner).toBe(work.session!);
  expect(w.box.claims.get(`${REPO}#1`)).toBe(work.session!);
  const full = w.box.waits.find((x) => x.id === out.wait)!;
  expect(full.spec).toMatchObject({ kind: "pr", repo: REPO, number: 1, head: HEAD1, all: true, checks: ["build"] });
  // Main has no feedback wait yet: the one armed became a plain check wait and was cancelled, and the family says so.
  expect(out.feedbackWait).toBeNull();
  expect(out.note).toContain("CORE-NEEDS");
  expect(w.box.waits.filter((x) => x.ended === "cancelled")).toHaveLength(1);
  // Again: nothing pushed or requested twice; the existing full-check wait is reused.
  const again = await publish(w.ctx, work.id, work.session, req());
  expect(w.git.pushes).toHaveLength(1);
  expect(w.gh.pulls).toHaveLength(1);
  expect(again.wait).toBe(out.wait);
  // Follow rearms on a writer that still holds the PR, and refuses once it released it.
  expect((await followPublication(w.ctx, work.id, work.session)).wait).toBe(out.wait);
  w.box.claims.delete(`${REPO}#1`);
  await expect(followPublication(w.ctx, work.id, work.session)).rejects.toThrow("released the PR");
});

test("with the feedback wait in core, publication arms it separately from the check wait", async () => {
  w.box.feedbackWaits = true;
  await cleanRound(HEAD1);
  const out = await publish(w.ctx, work.id, work.session, req());
  expect(out.feedbackWait).not.toBeNull();
  expect(out.note).toBeUndefined();
  expect(w.box.waits.find((x) => x.id === out.feedbackWait)!.spec).toMatchObject({ kind: "pr", number: 1, head: HEAD1, feedback: true });
});

test("a failed push leaves the publication to reconcile, which restores the previous state and replays nothing", async () => {
  await cleanRound(HEAD1);
  w.git.failPush = true;
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("push failed");
  expect(w.ctx.store.work(work.id).publication).toMatchObject({ state: "uncertain", stage: "push" });
  await expect(publish(w.ctx, work.id, work.session, req())).rejects.toThrow("reconcile GitHub before retrying");
  const r = await reconcile(w.ctx, work.id, work.session);
  expect(r).toMatchObject({ state: "prepared" });
  expect(w.ctx.store.work(work.id).publication).toBeUndefined();
  expect(w.gh.pulls).toHaveLength(0);
  w.git.failPush = false;
  expect((await publish(w.ctx, work.id, work.session, req())).state).toBe("sent");
});
