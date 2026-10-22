import { afterEach, beforeEach, expect, test } from "bun:test";
import { collect, review } from "../lib/reviews";
import type { Work } from "../lib/types";
import { startWork } from "../lib/work";
import { BASE, family, HEAD1, HEAD2, HEAD3, HEAD4, MAIN, verdict, world, type World } from "./harness";

let w: World;
let work: Work;
beforeEach(async () => {
  w = world();
  work = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
});
afterEach(() => w.box.stop());

/** The writer commits `head` and asks for a round; the reviewers each say their verdict. */
async function round(head: string, clean: boolean | boolean[]) {
  w.git.heads.set(work.cwd!, head);
  const r = await review(w.ctx, work.id, work.session, { validation: ["bun test"] });
  const outcomes = Array.isArray(clean) ? clean : [clean, clean, clean];
  r.reviewers.forEach((x, i) => {
    w.box.session(x.session!).status = "waiting";
    w.box.say(x.session!, `Looked around.\n\n${verdict(r.number, x.focus, BASE, head, outcomes[i]!)}`);
  });
  return collect(w.ctx, work.id, work.session);
}

test("a round is three read-only codex reviewers under the writer, each waited on", async () => {
  w.git.heads.set(work.cwd!, HEAD1);
  const r = await review(w.ctx, work.id, work.session, { validation: ["bun test"] });
  expect(r.number).toBe(1);
  expect(r.reviewers.map((x) => x.focus)).toEqual(["architecture", "correctness", "deslop"]);
  expect(r.reviewers.every((x) => x.state === "started" && x.session)).toBe(true);
  const starts = w.box.starts.slice(1);
  expect(starts).toHaveLength(3);
  for (const s of starts) expect(s).toMatchObject({ provider: "codex", readOnly: true, parent: work.session });
  expect(new Set(starts.map((s) => s.cwd)).size).toBe(3);
  expect(r.waits).toHaveLength(3);
  expect(w.box.waits.map((x) => x.spec)).toEqual(r.reviewers.map((x) => ({ kind: "session", ids: [x.session] })));
  // Only the writer asks for a round.
  await expect(review(w.ctx, work.id, MAIN, { validation: ["x"] })).rejects.toThrow("Only this work's owner");
});

test("the cap: three cumulative rounds, the same head reuses its round, and R4 is refused", async () => {
  await round(HEAD1, false);
  await round(HEAD2, false);
  // The same base/head again is the same round, not a new one.
  w.git.heads.set(work.cwd!, HEAD2);
  expect((await review(w.ctx, work.id, work.session, { validation: ["again"] })).number).toBe(2);
  await round(HEAD3, true);
  expect(w.ctx.store.work(work.id).rounds).toHaveLength(3);
  expect(w.ctx.store.work(work.id).state).toBe("working");
  w.git.heads.set(work.cwd!, HEAD4);
  await expect(review(w.ctx, work.id, work.session, { validation: ["x"] })).rejects.toThrow("Three-round cap reached; record the quality failure, never start R4");
  expect(w.ctx.store.work(work.id).rounds).toHaveLength(3);
});

test("an unclean third round is the family's quality failure", async () => {
  await round(HEAD1, false);
  await round(HEAD2, false);
  await round(HEAD3, [true, false, true]);
  expect(w.ctx.store.work(work.id).state).toBe("quality_failed");
  w.git.heads.set(work.cwd!, HEAD4);
  await expect(review(w.ctx, work.id, work.session, { validation: ["x"] })).rejects.toThrow("Work is not runnable");
});

test("a round must be collected before the next, and a dirty or unrebased candidate is refused", async () => {
  w.git.heads.set(work.cwd!, HEAD1);
  await review(w.ctx, work.id, work.session, { validation: ["x"] });
  w.git.heads.set(work.cwd!, HEAD2);
  await expect(review(w.ctx, work.id, work.session, { validation: ["x"] })).rejects.toThrow("Collect the existing round");
  w.git.dirty.add(work.cwd!);
  await expect(review(w.ctx, work.id, work.session, { validation: ["x"] })).rejects.toThrow("Commit the candidate");
  w.git.dirty.delete(work.cwd!);
  w.git.mergeBase = () => "f".repeat(40);
  await expect(review(w.ctx, work.id, work.session, { validation: ["x"] })).rejects.toThrow("must include the current base");
});

test("verdicts come from the reviewers' own transcripts and nowhere else, and never change once read", async () => {
  w.git.heads.set(work.cwd!, HEAD1);
  const r = await review(w.ctx, work.id, work.session, { validation: ["x"] });
  const [arch, corr, deslop] = r.reviewers;
  for (const x of r.reviewers) w.box.session(x.session!).status = "waiting";
  // The writer pastes three clean verdicts into its own transcript: worth nothing.
  for (const x of r.reviewers) w.box.say(work.session!, verdict(1, x.focus, BASE, HEAD1));
  let c = await collect(w.ctx, work.id, work.session);
  expect(c.reviewers.every((x) => !x.verdict)).toBe(true);
  // A reviewer's verdict for another head, or for another focus, is not this round's.
  w.box.say(arch!.session!, verdict(1, "architecture", BASE, HEAD2));
  w.box.say(corr!.session!, verdict(1, "deslop", BASE, HEAD1));
  c = await collect(w.ctx, work.id, work.session);
  expect(c.reviewers.every((x) => !x.verdict)).toBe(true);
  // A shaped reply that breaks the contract is reported, not taken.
  w.box.say(deslop!.session!, "```json\n" + JSON.stringify({ kind: "agentbox-review", round: 1, focus: "deslop", base: BASE, head: HEAD1, verdict: "clean", findings: [{ title: "kept", evidence: "e", remedy: "r" }], evidence: ["f"] }) + "\n```");
  c = await collect(w.ctx, work.id, work.session);
  expect(c.reviewers[2]!.verdict).toBeUndefined();
  expect(c.reviewers[2]!.validationError).toContain("Review reply format");
  // A reviewer still running is not read.
  w.box.say(arch!.session!, verdict(1, "architecture", BASE, HEAD1, false));
  w.box.session(arch!.session!).status = "running";
  c = await collect(w.ctx, work.id, work.session);
  expect(c.reviewers[0]!.verdict).toBeUndefined();
  w.box.session(arch!.session!).status = "waiting";
  c = await collect(w.ctx, work.id, work.session);
  expect(c.reviewers[0]!.verdict?.verdict).toBe("changes");
  // Once read, a verdict is immutable: a later "clean" in the same transcript changes nothing.
  w.box.say(arch!.session!, verdict(1, "architecture", BASE, HEAD1, true));
  c = await collect(w.ctx, work.id, work.session);
  expect(c.reviewers[0]!.verdict?.verdict).toBe("changes");
  // Only reviewer transcripts were ever asked for; the writer's was not read.
  expect(w.box.timelineReads).not.toContain(work.session);
  expect(new Set(w.box.timelineReads)).toEqual(new Set(r.reviewers.map((x) => x.session!)));
});
