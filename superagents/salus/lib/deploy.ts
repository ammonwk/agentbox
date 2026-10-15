/** Between the merge and verifying: when did the fix reach production? A
 *  merge lands on the base (staging); production runs `prodBranch`, deployed
 *  by a successful run of `deployWorkflow` on it. The first such run whose
 *  commit contains the merge is the deploy, and its finish starts the clock. */
import { agentbox } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { project, tag } from "./triage";
import { nameOf, type Crash } from "./types";

/** Looking through deploys more often than this finds nothing new. */
const RECHECK_MS = 30 * 60_000;
/** Not in production this long after its merge: a person is told. */
export const UNDEPLOYED_MS = 14 * 86_400_000;

type Run = { head_sha: string; updated_at: string; created_at: string; html_url: string };

export async function deploy(ctx: Ctx, id: string, now = Date.now()): Promise<Crash> {
  return ctx.lock(id, async () => {
    let c = ctx.store.crash(id);
    const pr = c.pr;
    if (c.state !== "merged" || !pr?.mergedAt || now - (pr.deployCheckedAt ?? 0) < RECHECK_MS) return c;
    const s = ctx.settings();
    if (!s.prodBranch) return ctx.store.save({ ...c, state: "deployed", pr: { ...pr, deploy: { at: pr.mergedAt, url: null, sha: pr.mergeSha ?? null } } }, now);
    c = ctx.store.save({ ...c, pr: { ...pr, deployCheckedAt: now } }, now);
    const run = pr.mergeSha ? await firstDeploy(ctx, pr.mergeSha, pr.mergedAt) : null;
    if (run) {
      return ctx.store.save(
        { ...c, state: "deployed", pr: { ...c.pr!, deploy: { at: Date.parse(run.updated_at), url: run.html_url, sha: run.head_sha } }, verify: c.verify && { ...c.verify, checkedAt: 0 }, note: undefined },
        now,
      );
    }
    if (now - pr.mergedAt >= UNDEPLOYED_MS && !pr.undeployedCard) {
      const days = Math.round((now - pr.mergedAt) / 86_400_000);
      const why = pr.mergeSha ? `no successful ${s.deployWorkflow} run on ${s.prodBranch} contains it` : "GitHub gave no merge commit to look for";
      const card = await agentbox.card({
        kind: "decision",
        title: `Salus: the fix for ${nameOf(c)} is not in production`,
        short: `#${pr.number} merged to ${pr.base ?? "its base"} ${days} days ago, and ${why}.`,
        recommend: "Check the release, or the production branch and deploy workflow in Salus's settings",
        pr: pr.url,
        key: `salus:${tag(c.id)}:undeployed:${pr.number}`,
      });
      c = ctx.store.save({ ...c, pr: { ...c.pr!, undeployedCard: card.id }, card: card.id, note: `Not in production ${days} days after its merge: ${why}` }, now);
    }
    return c;
  });
}

/** The earliest successful deploy run since the merge whose commit contains it, or null. */
async function firstDeploy(ctx: Ctx, mergeSha: string, mergedAt: number): Promise<Run | null> {
  const s = ctx.settings();
  const p = await project(ctx);
  const q = new URLSearchParams({ branch: s.prodBranch, status: "success", per_page: "50", created: `>=${new Date(mergedAt).toISOString()}` });
  // Newest first.
  const runs = (await ctx.tools.gh<{ workflow_runs: Run[] }>(`repos/${p.slug}/actions/workflows/${s.deployWorkflow}/runs?${q}`, undefined, "GET")).workflow_runs ?? [];
  const known = new Map<string, boolean>();
  const contains = async (sha: string): Promise<boolean> => {
    if (sha === mergeSha) return true;
    if (!known.has(sha)) {
      const cmp = await ctx.tools.gh<{ status: string }>(`repos/${p.slug}/compare/${mergeSha}...${sha}?per_page=1`, undefined, "GET");
      known.set(sha, cmp.status === "ahead" || cmp.status === "identical");
    }
    return known.get(sha)!;
  };
  // The newest run not containing it means none does yet; otherwise the oldest that does is the deploy.
  if (!runs.length || !(await contains(runs[0]!.head_sha))) return null;
  for (const r of [...runs].reverse()) if (await contains(r.head_sha)) return r;
  return null;
}
