/** The Feed: recommendations a writer or Vulcan's main makes for a person to
 *  decide. A decision is recorded, with its delivery receipt, before anything is
 *  sent; an approval is delivered at most once and never again after a restart. */
import { randomUUID } from "node:crypto";
import { ActionError, AgentboxError, agentbox, call, type Caller } from "../../lib/sdk";
import type { SendReceipt } from "../../../src/core/types";
import type { Ctx } from "./ctx";
import { ProposalInput, type Proposal } from "./types";
import { familyOf, writable } from "./work";

const cardKey = (id: string) => `vulcan-proposal:${id}`;

/** The sessions whose word reaches the Feed: Vulcan's main, and a family's writer while it may write. */
async function mayRecommend(ctx: Ctx, session: string | null): Promise<string | null> {
  if (!session) return null;
  const main = (await agentbox.self()).main;
  if (session === main) return null;
  if (writable(ctx, session)) return familyOf(ctx, session)!.id;
  throw new ActionError("Only Vulcan's main conversation or a working writer can curate this Feed", 403);
}

export async function recommend(ctx: Ctx, caller: Caller, input: unknown, now = Date.now()): Promise<Proposal> {
  if (!caller.session) throw new ActionError("A recommendation comes from a session: run this with agentbox superagent call from inside one", 403);
  const work = await mayRecommend(ctx, caller.session);
  const p = ProposalInput.parse(input);
  const item: Proposal = { id: p.request, run: caller.session, work, title: p.title, finding: p.finding, reason: p.reason, next: p.next, evidence: p.evidence, state: "open", card: null, createdAt: now };
  const old = ctx.store.proposal(p.request);
  if (old) {
    for (const k of ["title", "finding", "reason", "next", "evidence"] as const)
      if (JSON.stringify(old[k]) !== JSON.stringify(item[k])) throw new ActionError("This proposal ID already names another recommendation", 409);
    return old;
  }
  ctx.store.saveProposal(item);
  // A Review card that does not push: the Feed is where it is decided.
  const card = await agentbox.card({ kind: "note", key: cardKey(item.id), title: p.title, short: `${p.finding}\n\nDecide this recommendation on Vulcan's Feed.`, long: JSON.stringify(item, null, 2), session: caller.session, notify: false, recommend: p.next });
  item.card = card.id;
  ctx.store.saveProposal(item);
  return item;
}

type DeliveryState = NonNullable<Proposal["delivery"]>["state"];
const deliveryState = (r: SendReceipt | null): DeliveryState => (r?.state === "sent" ? "sent" : r?.state === "failed" ? "refused" : "uncertain");

/** A decision is a person's: not a session's, least of all the one that recommended. */
function person(caller: Caller): void {
  if (caller.session) throw new ActionError("Feed decisions are made by a person on Vulcan's page", 403);
}

export async function approve(ctx: Ctx, caller: Caller, id: string, now = Date.now()): Promise<Proposal> {
  person(caller);
  const main = (await agentbox.self()).main;
  let fresh = false;
  const p = ctx.store.transaction(() => {
    const p = ctx.store.proposal(id);
    if (!p) throw new ActionError("Recommendation not found", 404);
    if (p.state === "approved") return p;
    if (p.state !== "open") throw new ActionError("Already decided", 409);
    if (p.run !== main && !writable(ctx, p.run, now)) throw new ActionError("Recommendation belongs to an earlier conversation; ask the agent to review it in the current workspace", 409);
    p.state = "approved";
    p.decidedAt = now;
    // The receipt id is written before the send it names: a retry finds it and sends nothing new.
    p.delivery = { request: randomUUID(), state: "queued", result: "" };
    ctx.store.saveProposal(p);
    fresh = true;
    return p;
  });
  if (fresh) {
    const text = `Approved recommendation ${id}: ${p.next}. Only this next step is authorized; other actions and outreach keep their existing requirements.`;
    try {
      const r = await call<SendReceipt>("POST", `/api/sessions/${p.run}/send`, { text, sendId: p.delivery!.request });
      p.delivery = { request: p.delivery!.request, state: deliveryState(r), result: r.error ?? "" };
    } catch (e) {
      const refused = e instanceof AgentboxError && e.status >= 400 && e.status < 500;
      p.delivery = { request: p.delivery!.request, state: refused ? "refused" : "uncertain", result: (e as Error).message };
    }
    ctx.store.saveProposal(p);
    if (p.delivery.state === "sent") await closeCard(p, "Approved in Feed and delivered");
    return p;
  }
  return reconcileDelivery(ctx, p);
}

export async function dismiss(ctx: Ctx, caller: Caller, id: string, now = Date.now()): Promise<Proposal> {
  person(caller);
  const p = ctx.store.proposal(id);
  if (!p) throw new ActionError("Recommendation not found", 404);
  if (p.state === "dismissed") return p;
  if (p.state !== "open") throw new ActionError("Already decided", 409);
  p.state = "dismissed";
  p.decidedAt = now;
  ctx.store.saveProposal(p);
  await closeCard(p, "Dismissed in Feed");
  return p;
}

/** Guidance goes into the chat box, addressed to the recommendation; the person sends it. */
export async function guide(ctx: Ctx, id: string, now = Date.now()): Promise<{ compose: string; message: string }> {
  const p = ctx.store.proposal(id);
  if (!p) throw new ActionError("Recommendation not found", 404);
  const main = (await agentbox.self()).main;
  if (p.run !== main && !writable(ctx, p.run, now)) throw new ActionError("This recommendation belongs to an earlier conversation. Review it before sending new guidance.", 409);
  return { compose: `Regarding "${p.title}" (${p.id}): `, message: p.run === main ? "Say it to Vulcan's chat." : `Say it to the writer, session ${p.run}.` };
}

/**
 * A delivery still queued was lost with the process that queued it (a
 * restart). Agentbox's receipt says what reached the session; without one, the
 * decision stands and is not sent again.
 */
export async function reconcileDelivery(ctx: Ctx, p: Proposal): Promise<Proposal> {
  if (p.delivery?.state !== "queued") return p;
  let r: SendReceipt | null = null;
  try {
    r = await call<SendReceipt | null>("GET", `/api/sessions/${p.run}/submissions/${p.delivery.request}`);
  } catch {
    r = null;
  }
  const current = ctx.store.proposal(p.id);
  if (current?.delivery?.state !== "queued") return current ?? p;
  current.delivery = { ...current.delivery, state: deliveryState(r), result: r?.error ?? (r ? "" : "Decision recorded; delivery not confirmed. It will not be replayed.") };
  ctx.store.saveProposal(current);
  if (current.delivery.state === "sent") await closeCard(current, "Approved in Feed and delivered");
  return current;
}

/** Its card withdrawn. */
async function closeCard(p: Proposal, why: string): Promise<void> {
  if (p.card === null) return;
  try {
    await agentbox.closeCard(p.card, why);
  } catch (e) {
    // Gone, or already closed: the decision stands either way.
    if (!(e instanceof AgentboxError && (e.status === 404 || e.status === 409))) throw e;
  }
}
