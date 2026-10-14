import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { approve, dismiss, guide, recommend, reconcileDelivery } from "../lib/feed";
import type { Work } from "../lib/types";
import { startWork } from "../lib/work";
import { family, MAIN, world, type World } from "./harness";

let w: World;
let work: Work;
beforeEach(async () => {
  w = world();
  work = await startWork(w.ctx, MAIN, family(w.grant.id, [1]));
});
afterEach(() => w.box.stop());

const proposal = (request = randomUUID()) => ({ request, title: "Rename the flag", finding: "The flag is misnamed.", reason: "Users trip on it.", next: "Rename it in the next release.", evidence: [{ url: "https://github.com/acme/app/issues/1", label: "issue" }] });
const app = { session: null, via: "app" as const };
const as = (session: string) => ({ session, via: "api" as const });

test("a recommendation comes from the writer or the main conversation, once per request id, with a card that does not push", async () => {
  const p = proposal();
  const a = await recommend(w.ctx, as(work.session!), p);
  expect(a).toMatchObject({ id: p.request, run: work.session, work: work.id, state: "open" });
  expect(w.box.cards).toHaveLength(1);
  expect(w.box.cards[0]).toMatchObject({ kind: "note", notify: false, key: `vulcan-proposal:${p.request}`, session: work.session });
  expect(await recommend(w.ctx, as(work.session!), p)).toEqual(a);
  expect(w.box.cards).toHaveLength(1);
  await expect(recommend(w.ctx, as(work.session!), { ...p, next: "Something else" })).rejects.toThrow("already names another recommendation");
  expect((await recommend(w.ctx, as(MAIN), proposal())).work).toBeNull();
  await expect(recommend(w.ctx, as("stranger"), proposal())).rejects.toThrow("Only Vulcan's main conversation or a working writer");
  await expect(recommend(w.ctx, { session: null, via: "api" }, proposal())).rejects.toThrow("comes from a session");
});

test("approval is decided once and delivered at most once, by a person", async () => {
  const p = proposal();
  await recommend(w.ctx, as(work.session!), p);
  await expect(approve(w.ctx, as(work.session!), p.request)).rejects.toThrow("made by a person");
  const a = await approve(w.ctx, app, p.request);
  expect(a.state).toBe("approved");
  expect(a.delivery).toMatchObject({ state: "sent" });
  expect(w.box.sends).toHaveLength(1);
  expect(w.box.sends[0]).toMatchObject({ id: work.session, sendId: a.delivery!.request });
  expect(w.box.sends[0]!.text).toContain(`Approved recommendation ${p.request}: Rename it in the next release.`);
  expect(w.box.cards[0]!.state).toBe("closed");
  // Approving again changes nothing and sends nothing.
  expect(await approve(w.ctx, app, p.request)).toEqual(a);
  expect(w.box.sends).toHaveLength(1);
  await expect(dismiss(w.ctx, app, p.request)).rejects.toThrow("Already decided");
});

test("a delivery queued when the process died is never sent after a restart", async () => {
  const p = proposal();
  await recommend(w.ctx, as(work.session!), p);
  // The decision was recorded and the process died before the send: what a restart finds.
  const stored = w.ctx.store.proposal(p.request)!;
  stored.state = "approved";
  stored.delivery = { request: randomUUID(), state: "queued", result: "" };
  w.ctx.store.saveProposal(stored);
  const r = await reconcileDelivery(w.ctx, stored);
  expect(r.delivery).toMatchObject({ state: "uncertain", result: "Decision recorded; delivery not confirmed. It will not be replayed." });
  expect(w.box.sends).toHaveLength(0);
  // Approve again: the decision stands, still nothing is sent.
  expect((await approve(w.ctx, app, p.request)).delivery?.state).toBe("uncertain");
  expect(w.box.sends).toHaveLength(0);
  // Had the send reached agentbox before the crash, its receipt is the answer.
  const q = proposal();
  await recommend(w.ctx, as(work.session!), q);
  const s2 = w.ctx.store.proposal(q.request)!;
  s2.state = "approved";
  s2.delivery = { request: "receipt-1", state: "queued", result: "" };
  w.ctx.store.saveProposal(s2);
  w.box.receipts.set("receipt-1", { id: "receipt-1", sessionId: work.session!, state: "sent", error: null });
  expect((await reconcileDelivery(w.ctx, s2)).delivery?.state).toBe("sent");
  expect(w.box.sends).toHaveLength(0);
});

test("an approval for a writer that may no longer write is refused; dismiss closes the card; guidance composes", async () => {
  const p = proposal();
  await recommend(w.ctx, as(work.session!), p);
  const g = await guide(w.ctx, p.request);
  expect(g.compose).toBe(`Regarding "Rename the flag" (${p.request}): `);
  w.ctx.store.saveGrant({ ...w.grant, revokedAt: Date.now() });
  await expect(approve(w.ctx, app, p.request)).rejects.toThrow("earlier conversation");
  await expect(guide(w.ctx, p.request)).rejects.toThrow("earlier conversation");
  const d = await dismiss(w.ctx, app, p.request);
  expect(d.state).toBe("dismissed");
  expect(w.box.cards[0]!.state).toBe("closed");
  expect(w.box.sends).toHaveLength(0);
});
