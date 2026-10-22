/** Publication: the push and the PR request are separate durable stages, each
 *  guarded, nothing replayed; then the PR is claimed for the writer and its
 *  checks and feedback are waited on. */
import { z } from "zod";
import { ActionError, agentbox, call } from "../../lib/sdk";
import type { Wait } from "../../../src/core/types";
import type { Ctx } from "./ctx";
import { authority } from "./grants";
import { assertReviewed } from "./reviews";
import { ghLogin, remoteBase } from "./shell";
import { AGENT_NAME, agentPrTitle, mentionedPeople, refuseAutomaticClosure, slugFromRemoteUrl } from "./text";
import { sha, type Publication, type Work } from "./types";

const PublishRequest = z.object({ head: sha, title: z.string().min(1).max(500), body: z.string().min(1).max(24000) }).strict();

type RemotePr = { number: number; html_url: string; state: string; title: string; body: string | null; head: { sha: string; ref: string }; base: { ref: string }; user: { login: string } };

export type Followed = Publication & { owner: string; wait: number | null; waitEnded: string | null; feedbackWait: number | null; note?: string };

export async function publish(ctx: Ctx, id: string, caller: string | null, input: unknown, now = Date.now()): Promise<Followed> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    const g = authority(ctx, w, caller, true, now);
    const p = PublishRequest.parse(input);
    if (!w.cwd || !w.session) throw new ActionError("Work has no writer", 409);
    if (w.publication?.state === "attempting" || w.publication?.state === "uncertain") throw new ActionError("Publication outcome is uncertain; reconcile GitHub before retrying", 409);
    const title = agentPrTitle(AGENT_NAME, g.human.name, p.title);
    const body = p.body;
    refuseAutomaticClosure(`${title}\n${body}`);
    if (mentionedPeople(`${title}\n${body}`).length) throw new ActionError("No local outreach consent is configured; remove targeted mentions and surface needs-human in Agentbox", 403);
    if ((await ghLogin(ctx.tools)) !== g.actor.toLowerCase()) throw new ActionError("Publication credential changed", 403);
    const base = await remoteBase(ctx.tools, w.repo, w.input.base);
    assertReviewed(w, base, p.head);
    const commitMessages = await ctx.tools.git(w.cwd, "log", "--format=%B", `${base}..${p.head}`);
    refuseAutomaticClosure(commitMessages);
    if (mentionedPeople(commitMessages).length) throw new ActionError("Commit messages contain targeted outreach without consent", 403);
    if ((await ctx.tools.git(w.cwd, "rev-parse", "HEAD")) !== p.head || (await ctx.tools.git(w.cwd, "status", "--porcelain"))) throw new ActionError("Candidate changed after review", 409);
    if (w.publication?.state === "sent" && w.publication.head === p.head && w.publication.title === title && w.publication.body === body) return follow(ctx, w, now);
    const origin = slugFromRemoteUrl(await ctx.tools.git(w.cwd, "remote", "get-url", "origin"))?.toLowerCase();
    if (origin !== w.repo || (await ctx.tools.git(w.cwd, "branch", "--show-current")) !== w.branch) throw new ActionError("Repository or writer branch changed", 409);
    const old = w.publication;
    const remoteHead = (await ctx.tools.git(w.cwd, "ls-remote", "--heads", "origin", `refs/heads/${w.branch}`)).split(/\s+/)[0] || null;
    if ((remoteHead && (!old || remoteHead !== old.head)) || (old?.stage === "branch" && remoteHead !== old.head))
      throw new ActionError("Publication branch changed; reconcile its owner and result before writing", 409);
    if (old?.number) {
      const pr = await ctx.tools.gh<RemotePr>(`repos/${w.repo}/pulls/${old.number}`, undefined, "GET");
      if (pr.state !== "open" || pr.head.sha !== old.head || pr.head.ref !== w.branch || pr.base.ref !== w.input.base || pr.user.login.toLowerCase() !== g.actor.toLowerCase())
        throw new ActionError("Published PR identity or head changed", 409);
    }
    authority(ctx, w, caller, true, now);
    w.publication = {
      state: "attempting",
      stage: "push",
      remoteBefore: remoteHead,
      ...(old ? { previous: { state: old.state as "sent" | "prepared", ...(old.stage === "branch" ? { stage: "branch" as const } : {}), head: old.head, title: old.title, body: old.body, number: old.number, url: old.url } } : {}),
      head: p.head,
      title,
      body,
      ...(old?.number ? { number: old.number, url: old.url } : {}),
    };
    ctx.store.saveWork(w);
    try {
      await ctx.tools.git(w.cwd, "push", "origin", `${p.head}:refs/heads/${w.branch}`);
      w.publication.stage = "branch";
      w.publication.state = "prepared";
      ctx.store.saveWork(w);
      // Between the push and the request everything is checked again: the base may have moved, the actor changed.
      authority(ctx, w, caller, true, now);
      assertReviewed(w, await remoteBase(ctx.tools, w.repo, w.input.base), p.head);
      if (mentionedPeople(`${title}\n${body}`).length || mentionedPeople(await ctx.tools.git(w.cwd, "log", "--format=%B", `${base}..${p.head}`)).length) throw new ActionError("Outreach is not authorized", 403);
      if ((await ghLogin(ctx.tools)) !== g.actor.toLowerCase()) throw new ActionError("Publication actor changed before dispatch", 403);
      w.publication.stage = "request";
      w.publication.state = "attempting";
      ctx.store.saveWork(w);
      const pr = old?.number
        ? await ctx.tools.gh<{ number: number; html_url: string }>(`repos/${w.repo}/pulls/${old.number}`, { title, body }, "PATCH")
        : await ctx.tools.gh<{ number: number; html_url: string }>(`repos/${w.repo}/pulls`, { title, body, base: w.input.base, head: w.branch, draft: false });
      w.publication = { ...w.publication, state: "sent", number: pr.number, url: pr.html_url };
      ctx.store.saveWork(w);
    } catch (e) {
      w.publication.state = w.publication.stage === "branch" ? "prepared" : "uncertain";
      ctx.store.saveWork(w);
      throw e;
    }
    return follow(ctx, w, now);
  });
}

/** Rearm the follow-up waits of a confirmed publication: after a disposition, or for a family published before. */
export async function followPublication(ctx: Ctx, id: string, caller: string | null, now = Date.now()): Promise<Followed> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    authority(ctx, w, caller, false, now);
    if (w.publication?.state !== "sent" || !w.publication.number) throw new ActionError("No confirmed published PR to follow", 409);
    return follow(ctx, w, now);
  });
}

const sameChecks = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Claim the PR for the writer, then wait on it twice: every check on the head
 * (reusing the wait already armed for this head, so unchanged failed CI does
 * not wake it again), and feedback on the head, separately.
 */
async function follow(ctx: Ctx, w: Work, now: number): Promise<Followed> {
  const p = w.publication!;
  const prRef = `${w.repo}#${p.number}`;
  const who = await agentbox.prWho(prRef);
  // Once claimed for the writer, a hold that is gone was released or lost: rearming would hand it back unasked.
  if (p.follow?.claimedAt && who.claim?.sessionId !== w.session) throw new ActionError("This work owner released the PR; explicitly reclaim it before rearming", 409);
  await agentbox.claimPr(prRef, w.session!);
  const prior = (await call<Wait[]>("GET", `/api/waits?session=${w.session}&all=1`))
    .reverse()
    .find((x) => x.ended !== "cancelled" && x.spec.kind === "pr" && !("feedback" in x.spec) && !x.spec.merged && x.spec.all && x.spec.repo.toLowerCase() === w.repo && x.spec.number === p.number && x.spec.head === p.head && sameChecks(x.spec.checks, w.grant.requiredChecks));
  const wait = prior ?? (await agentbox.wait(w.session!, { kind: "pr", repo: w.repo, number: p.number, head: p.head, all: true, checks: w.grant.requiredChecks, merged: false })).wait;
  // The feedback wait is the shape PR #4's parseSpec takes (CORE-NEEDS.md). A
  // core without it would arm a second full-check wait instead: that one is
  // cancelled, and the family records that feedback is not watched.
  const fb = (await agentbox.wait(w.session!, { kind: "pr", repo: w.repo, number: p.number, head: p.head, feedback: true })).wait;
  let feedbackWait: number | null = fb.id;
  let note: string | undefined;
  if (!("feedback" in fb.spec && (fb.spec as { feedback?: boolean }).feedback)) {
    if (fb.id !== wait.id) await call("DELETE", `/api/waits/${fb.id}`);
    feedbackWait = null;
    note = "agentbox has no feedback wait yet: review feedback on this PR is not watched (CORE-NEEDS.md)";
  }
  p.follow = { claimedAt: p.follow?.claimedAt ?? now, wait: wait.id, feedbackWait, ...(note ? { note } : {}) };
  ctx.store.saveWork(w);
  return { ...p, owner: w.session!, wait: wait.id, waitEnded: wait.ended, feedbackWait, ...(note ? { note } : {}) };
}

/** After an uncertain publication: read GitHub and the remote branch, and restore or confirm; never replay. */
export async function reconcile(ctx: Ctx, id: string, caller: string | null, now = Date.now()): Promise<Followed | (Partial<Publication> & { result: string })> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    authority(ctx, w, caller, false, now);
    const p = w.publication;
    if (!p || !w.cwd) throw new ActionError("No publication to reconcile", 409);
    const owner = w.repo.split("/")[0]!;
    const rows = await ctx.tools.gh<RemotePr[]>(`repos/${w.repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${w.branch}`)}&base=${encodeURIComponent(w.input.base)}&per_page=100`, undefined, "GET");
    const actor = w.grant.actor.toLowerCase();
    // A branch push and a PR request are separate effects. If the request
    // boundary was never crossed, a confirmed owned branch is safe to resume.
    if (p.stage === "push" || p.stage === "branch") {
      const actual = (await ctx.tools.git(w.cwd, "ls-remote", "--heads", "origin", `refs/heads/${w.branch}`)).split(/\s+/)[0] || null;
      if (p.stage === "push" && p.remoteBefore !== undefined && actual === p.remoteBefore && actual !== p.head) {
        const prior = p.previous;
        const unchanged = p.number
          ? rows.length === 1 && rows[0]!.number === p.number && rows[0]!.head.sha === prior?.head && rows[0]!.title === prior?.title && (rows[0]!.body ?? "") === prior?.body && rows[0]!.state === "open" && rows[0]!.user.login.toLowerCase() === actor
          : rows.length === 0;
        if (!unchanged) throw new ActionError("Previous publication changed; no push or request will be replayed", 409);
        w.publication = prior;
        ctx.store.saveWork(w);
        return { state: "prepared", result: "Branch is unchanged and no PR request was attempted; retry after current authority and candidate validation" };
      }
      if (actual !== p.head || (p.number ? rows.length !== 1 || rows[0]!.number !== p.number || rows[0]!.head.sha !== p.head || rows[0]!.state !== "open" || rows[0]!.user.login.toLowerCase() !== actor : rows.length !== 0))
        throw new ActionError("Branch outcome or prior PR is not confirmed; no publication will be replayed", 409);
      w.publication = { ...p, stage: "branch", state: "prepared" };
      ctx.store.saveWork(w);
      return { ...w.publication, result: "Branch confirmed; PR request was not attempted. Revalidate current candidate and reviews before publish." };
    }
    if (rows.length !== 1) throw new ActionError("Publication is not uniquely confirmed; inspect the branch and GitHub result before any further write", 409);
    const r = rows[0]!;
    if (r.state !== "open" || r.head.sha !== p.head || r.head.ref !== w.branch || r.base.ref !== w.input.base || r.title !== p.title || (r.body ?? "") !== p.body || r.user.login.toLowerCase() !== actor)
      throw new ActionError("Remote publication does not match the attempted action", 409);
    w.publication = { ...p, state: "sent", url: r.html_url, number: r.number };
    ctx.store.saveWork(w);
    return follow(ctx, w, now);
  });
}
