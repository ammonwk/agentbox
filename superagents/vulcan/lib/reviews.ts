/** Review rounds: three independent read-only reviewers of one exact
 *  base/head, at most three rounds per family, and verdicts read only from the
 *  reviewers' own transcripts. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ActionError, agentbox, call } from "../../lib/sdk";
import type { Session } from "../../../src/core/types";
import type { Ctx } from "./ctx";
import { authority } from "./grants";
import { RETRY_NUDGE, reviewerPrompt } from "./prompts";
import { remoteBase } from "./shell";
import { slugFromRemoteUrl } from "./text";
import { FOCUSES, ReviewVerdict, ROUND_CAP, type Reviewer, type Round, type Work } from "./types";

const ReviewRequest = z.object({ validation: z.array(z.string().min(1).max(2000)).min(1).max(50) }).strict();

/** The writer asks for a round of its committed head against the current remote base. */
export async function review(ctx: Ctx, id: string, caller: string | null, input: unknown, now = Date.now()): Promise<Round> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    authority(ctx, w, caller, true, now);
    if (w.state !== "working" || !w.cwd) throw new ActionError("Work is not runnable", 409);
    const { validation } = ReviewRequest.parse(input);
    if (await ctx.tools.git(w.cwd, "status", "--porcelain")) throw new ActionError("Commit the candidate before review", 409);
    const head = await ctx.tools.git(w.cwd, "rev-parse", "HEAD");
    const base = await remoteBase(ctx.tools, w.repo, w.input.base);
    await ctx.tools.git(w.cwd, "fetch", "--no-tags", "origin", `refs/heads/${w.input.base}:refs/agentbox/work/${id}/review-base`);
    if ((await ctx.tools.git(w.cwd, "merge-base", base, head)) !== base) throw new ActionError("Candidate must include the current base before review; no automatic merge is performed", 409);
    return startRound(ctx, w, base, head, validation, now);
  });
}

async function startRound(ctx: Ctx, w: Work, base: string, head: string, validation: string[], now: number): Promise<Round> {
  const last = w.rounds.at(-1);
  if (last && last.reviewers.some((r) => !r.verdict)) throw new ActionError("Collect the existing round before starting another", 409);
  if (last?.head === head && last.base === base) return last;
  if (w.rounds.length >= ROUND_CAP) throw new ActionError("Three-round cap reached; record the quality failure, never start R4", 409);
  const number = w.rounds.length + 1;
  const round: Round = {
    number,
    promptRevision: w.promptRevision,
    base,
    head,
    validation,
    reviewers: FOCUSES.map((focus) => ({ focus, session: null, cwd: join(dirname(w.cwd!), `vulcan-review-${w.id}-${number}-${focus}`), state: "reserved", retries: [] })),
  };
  w.rounds.push(round);
  ctx.store.saveWork(w);
  for (const r of round.reviewers) {
    try {
      await launchReviewer(ctx, w, round, r, now);
    } catch (e) {
      r.state = "uncertain";
      r.retries.push(String((e as Error).message ?? e).slice(0, 1000));
    }
    ctx.store.saveWork(w);
  }
  round.waits = await armWaits(w, round.reviewers);
  ctx.store.saveWork(w);
  return round;
}

/** The writer is told when each reviewer's turn ends: a durable wait per reviewer that started. */
async function armWaits(w: Work, reviewers: Reviewer[]): Promise<number[]> {
  const ids: number[] = [];
  for (const r of reviewers) {
    if (r.state !== "started" || !r.session) continue;
    ids.push((await agentbox.wait(w.session!, { kind: "session", ids: [r.session] })).wait.id);
  }
  return ids;
}

/** A session agentbox has in a reviewer's reserved checkout: a start whose answer was lost still landed. */
const proven = (r: Reviewer, sessions: Session[]): Session | undefined => sessions.find((s) => s.cwd === r.cwd && s.provider === "codex" && s.origin === "agentbox");

async function launchReviewer(ctx: Ctx, w: Work, round: Round, r: Reviewer, now: number): Promise<void> {
  if (r.session) throw new ActionError("Reviewer already has a recorded launch", 409);
  const had = proven(r, (await agentbox.state(false)).sessions);
  if (had) {
    r.session = had.id;
    r.state = "started";
    return;
  }
  if (!existsSync(r.cwd)) await ctx.tools.git(w.cwd!, "worktree", "add", "--detach", r.cwd, round.head);
  const slug = slugFromRemoteUrl(await ctx.tools.git(r.cwd, "remote", "get-url", "origin"))?.toLowerCase();
  if (slug !== w.repo || (await ctx.tools.git(r.cwd, "rev-parse", "HEAD")) !== round.head || (await ctx.tools.git(r.cwd, "status", "--porcelain")))
    throw new ActionError("Reserved reviewer checkout changed", 409);
  authority(ctx, w, w.session, true, now);
  const s = await agentbox.start({ provider: "codex", readOnly: true, notify: false, cwd: r.cwd, parent: w.session!, prompt: reviewerPrompt(w, round, r.focus, ctx.revision(round.promptRevision)) });
  r.session = s.id;
  r.state = "started";
}

/** Read each reviewer's verdict from its own transcript. Nothing a writer can say stands in for it. */
export async function collect(ctx: Ctx, id: string, caller: string | null, now = Date.now()): Promise<Round> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    authority(ctx, w, caller, false, now);
    const round = w.rounds.at(-1);
    if (!round) throw new ActionError("No review round", 409);
    const sessions = (await agentbox.state(false)).sessions;
    for (const r of round.reviewers) {
      if (r.verdict && r.state === "started") continue;
      if (!r.session) {
        const had = proven(r, sessions);
        if (!had) continue;
        r.session = had.id;
      }
      const live = sessions.find((s) => s.id === r.session);
      if (!live || live.status === "running" || live.status === "blocked") continue;
      if (r.state !== "started") {
        if (live.provider !== "codex" || live.cwd !== r.cwd || live.origin !== "agentbox" || !live.agentSessionId) continue;
        r.state = "started";
      }
      if (r.verdict) continue;
      const page = await agentbox.timeline(r.session, undefined, 200);
      const replies = page.events.filter((e): e is Extract<typeof e, { kind: "assistant" }> => e.kind === "assistant").reverse();
      for (const e of replies) {
        const text = String(e.text ?? "");
        const candidates = [...text.matchAll(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g)].map((m) => m[1]!).concat(text.trim());
        for (const raw of candidates) {
          try {
            const v = ReviewVerdict.parse(JSON.parse(raw));
            if (v.round === round.number && v.focus === r.focus && v.head === round.head && v.base === round.base) {
              r.verdict = v;
              delete r.validationError;
              break;
            }
          } catch (err) {
            // Prose that is not JSON is not a verdict; a shaped reply that fails the contract is reported.
            if (err instanceof z.ZodError) r.validationError = `Review reply format: ${err.issues.slice(0, 5).map((x) => `${x.path.join(".")}: ${x.code}`).join("; ")}`;
          }
        }
        if (r.verdict) break;
      }
    }
    if (round.number === ROUND_CAP && round.reviewers.every((r) => r.verdict) && round.reviewers.some((r) => r.verdict?.verdict !== "clean")) w.state = "quality_failed";
    ctx.store.saveWork(w);
    return round;
  });
}

/** Three started reviewers of distinct focus and session, each clean, on exactly this base and head. */
export function assertReviewed(w: Work, base: string, head: string): void {
  const r = w.rounds.at(-1);
  if (
    w.state !== "working" ||
    !r ||
    r.head !== head ||
    r.base !== base ||
    r.reviewers.length !== 3 ||
    new Set(r.reviewers.map((x) => x.focus)).size !== 3 ||
    new Set(r.reviewers.map((x) => x.session)).size !== 3 ||
    r.reviewers.some((x) => !x.session || x.state !== "started" || x.verdict?.verdict !== "clean")
  )
    throw new ActionError("Publication requires three completed independent clean reviews of this exact base/head", 409);
}

/** An incomplete reviewer that is not live: started again, or nudged on if it already has a transcript. Verdicts are never replaced. */
export async function retryReview(ctx: Ctx, id: string, caller: string | null, input: unknown, now = Date.now()): Promise<{ reviewer: Reviewer; wait: number | null }> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    authority(ctx, w, caller, false, now);
    const { focus } = z.object({ focus: z.enum(FOCUSES) }).strict().parse(input);
    const round = w.rounds.at(-1);
    const r = round?.reviewers.find((x) => x.focus === focus);
    if (!round || !r || r.verdict) throw new ActionError("Only an incomplete recorded reviewer can retry; completed verdicts cannot be replaced", 409);
    let sessions = (await agentbox.state(false)).sessions;
    if (!r.session) r.session = proven(r, sessions)?.id ?? null;
    let live = sessions.find((s) => s.id === r.session);
    if (live && (live.status === "running" || live.status === "blocked")) throw new ActionError("The reviewer is still active", 409);
    if (existsSync(r.cwd) && (await ctx.tools.git(r.cwd, "rev-parse", "HEAD")) !== round.head) throw new ActionError("Reviewer checkout changed", 409);
    r.retries.push(new Date(now).toISOString());
    ctx.store.saveWork(w);
    if (r.session && live && !live.agentSessionId) {
      // Started but never wrote a transcript: proven stopped, then replaced.
      if (live.provider !== "codex" || live.cwd !== r.cwd || live.origin !== "agentbox") throw new ActionError("Unproven reviewer identity; do not replace it", 409);
      await agentbox.stop(r.session);
      sessions = (await agentbox.state(false)).sessions;
      const stopped = sessions.find((s) => s.id === r.session);
      if (stopped && stopped.host !== "none") throw new ActionError("Old reviewer has not stopped", 409);
      r.retired = [...(r.retired ?? []), r.session];
      r.session = null;
      r.state = "reserved";
      live = undefined;
      ctx.store.saveWork(w);
    }
    if (!r.session) await launchReviewer(ctx, w, round, r, now);
    else await call("POST", `/api/sessions/${r.session}/send`, { text: RETRY_NUDGE, sendId: `vulcan-retry-${w.id}-${round.number}-${focus}-${r.retries.length}` });
    r.state = "started";
    ctx.store.saveWork(w);
    const [wait] = await armWaits(w, [r]);
    round.waits = [...(round.waits ?? []), ...(wait ? [wait] : [])];
    ctx.store.saveWork(w);
    return { reviewer: r, wait: wait ?? null };
  });
}
