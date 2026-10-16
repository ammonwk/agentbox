/** What a writer reports upward: a milestone to its coordinator, or the
 *  family's quality failure after the third round, with a deduplicated
 *  improvement issue where the grant names a repo for them. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ActionError, agentbox, me } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { authority } from "./grants";
import { ghLogin } from "./shell";
import { AGENT_NAME, CREDENTIAL, mentionedPeople, refuseAutomaticClosure } from "./text";
import { note, ROUND_CAP, type Failure } from "./types";

/** The writer tells the grant's requester, as an agent: throttled, never waking it. */
export async function milestone(ctx: Ctx, id: string, caller: string | null, input: unknown, now = Date.now()): Promise<unknown> {
  const w = ctx.store.work(id);
  const g = authority(ctx, w, caller, true, now);
  const { body } = z.object({ body: note }).strict().parse(input);
  return agentbox.send(g.requester, `[${AGENT_NAME} work ${w.id}] ${body}`, { from: w.session!, wake: false });
}

const FailureRequest = z
  .object({
    summary: note,
    feedback: z.object({ kind: z.enum(["review", "check"]), id: z.number().int().positive(), title: note, remedy: note }).strict().optional(),
  })
  .strict();

export async function failure(ctx: Ctx, id: string, caller: string | null, input: unknown, now = Date.now()): Promise<Failure & { result?: string }> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    authority(ctx, w, caller, false, now);
    const { summary, feedback } = FailureRequest.parse(input);
    const last = w.rounds.at(-1);
    if (w.rounds.length !== ROUND_CAP || !last || last.reviewers.some((r) => !r.verdict)) throw new ActionError("Complete the third bundled review before recording its quality failure", 409);
    const findings = last.reviewers.flatMap((r) => r.verdict!.findings);
    if (last.reviewers.every((r) => r.verdict?.verdict === "clean")) {
      // A clean third round fails only on blocking feedback GitHub confirms, on the published head of that round.
      if (!feedback || !w.publication?.number || w.publication.head !== last.head) throw new ActionError("Clean R3 requires verified subsequent blocking PR feedback to record a quality failure", 409);
      const remote = await ctx.tools.gh<{ commit_id?: string; head_sha?: string; state?: string; status?: string; conclusion?: string; html_url: string }>(
        feedback.kind === "review" ? `repos/${w.repo}/pulls/${w.publication.number}/reviews/${feedback.id}` : `repos/${w.repo}/check-runs/${feedback.id}`,
        undefined,
        "GET",
      );
      const head = w.publication.head;
      const blocking =
        feedback.kind === "review"
          ? remote.commit_id === head && remote.state === "CHANGES_REQUESTED"
          : remote.head_sha === head && remote.status === "completed" && ["failure", "timed_out", "action_required"].includes(remote.conclusion ?? "");
      if (!blocking) throw new ActionError("Feedback must be a blocking review or failed check on the published R3 head", 409);
      findings.push({ title: feedback.title, evidence: remote.html_url, remedy: feedback.remedy });
    }
    if (w.failure?.state === "sent") return w.failure;
    if (w.failure && (w.failure.summary !== summary || JSON.stringify(w.failure.findings) !== JSON.stringify(findings))) throw new ActionError("Failure evidence was already recorded; do not change it during reconciliation", 409);
    w.state = "quality_failed";
    w.failure ??= { summary, findings, state: "recorded" };
    ctx.store.saveWork(w);
    await agentbox.card({
      kind: "decision",
      notify: false,
      key: `${me.name}-quality:${w.id}`,
      session: w.session ?? undefined,
      title: `${AGENT_NAME}: quality cap reached`,
      short: "The review budget is exhausted and blocking findings remain. Code work has stopped. Review the missed edge case and proposed process correction.",
      long: JSON.stringify({ work: w.id, issues: w.input.issues, round: last, summary }, null, 2),
      recommend: `Keep this attempt stopped; use the recorded evidence to improve ${AGENT_NAME} before another attempt.`,
    });
    const g = authority(ctx, w, caller, false, now);
    if (!g.improvementRepo) return { ...w.failure, result: "Needs human: grant an improvement issue repository to file the recorded product defect" };
    const key = createHash("sha256")
      .update(JSON.stringify(findings.map((f) => [f.title, f.remedy]).sort()))
      .digest("hex")
      .slice(0, 24);
    const marker = `agentbox-quality:${key}`;
    const found = await ctx.tools.gh<{ items: { html_url: string; body?: string }[] }>(`search/issues?q=${encodeURIComponent(`repo:${g.improvementRepo} is:issue "${marker}" in:body`)}&per_page=100`, undefined, "GET");
    const existing = found.items.filter((i) => i.body?.includes(marker));
    if (existing.length) {
      w.failure = { ...w.failure, key, state: "sent", issue: existing[0]!.html_url };
      ctx.store.saveWork(w);
      return w.failure;
    }
    if (w.failure.state === "attempting" || w.failure.state === "uncertain") throw new ActionError("Improvement issue outcome is uncertain; reconcile the existing request before filing again", 409);
    const title = `${AGENT_NAME}: improve review preparation after the three-round cap`.slice(0, 256);
    const body = [
      marker,
      "",
      summary,
      "",
      `Attempt ${w.id}; configuration ${w.config}. Blocking findings remain after the third cumulative bundled review; no fourth round is allowed.`,
      "",
      "Affected issues:",
      ...w.input.issues.map((i) => i.source),
      "",
      "Missed findings and proposed process corrections:",
      ...findings.map((f) => `- ${f.title}\n  Evidence: ${f.evidence}\n  Correction: ${f.remedy}`),
      "",
      `This is a ${AGENT_NAME} product/process improvement; it does not count as a solved trial issue.`,
    ].join("\n");
    if (mentionedPeople(`${title}\n${body}`).length || CREDENTIAL.test(body)) throw new ActionError("Remove credentials or unconsented outreach from failure evidence before publication", 403);
    refuseAutomaticClosure(body);
    if ((await ghLogin(ctx.tools)) !== g.actor.toLowerCase()) throw new ActionError("Improvement publication actor changed", 403);
    authority(ctx, w, caller, false, now);
    w.failure = { ...w.failure, key, state: "attempting" };
    ctx.store.saveWork(w);
    try {
      const issue = await ctx.tools.gh<{ html_url: string }>(`repos/${g.improvementRepo}/issues`, { title, body });
      w.failure = { ...w.failure, state: "sent", issue: issue.html_url };
    } catch (e) {
      w.failure.state = "uncertain";
      ctx.store.saveWork(w);
      throw e;
    }
    ctx.store.saveWork(w);
    return w.failure;
  });
}
