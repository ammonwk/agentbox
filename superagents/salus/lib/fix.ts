/** From a triage a person agreed with to a fix: the GitHub issue, the family
 *  the fixer works from, and the hand-off to Salus's main conversation, which
 *  starts it (a fixer's grant names a session, not a program). Then the fix is
 *  followed to its merge. */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError, agentbox, AgentboxError, call, me, type Caller } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { project, tag } from "./triage";
import { nameOf, type Crash } from "./types";

export function person(caller: Caller): void {
  if (caller.via !== "app" || caller.session) throw new ActionError("A person decides this, on Salus's page", 403);
}

/** The marker an issue Salus filed carries, so a retry finds it instead of filing another. */
export const marker = (c: Crash): string => `salus-crash:${tag(c.id)}`;

export async function fix(ctx: Ctx, id: string, caller: Caller, now = Date.now()): Promise<Crash> {
  person(caller);
  return ctx.lock(id, async () => {
    let c = ctx.store.crash(id);
    if (c.state !== "triaged" && c.state !== "filing") throw new ActionError(`This crash is ${c.state}, not waiting for a decision`, 409);
    const f = c.triage?.verdict?.fix;
    if (!f) throw new ActionError("Its triage proposed no fix; triage it again", 409);
    const p = await project(ctx);
    // The ids are fixed before anything leaves this machine, so a retry repeats nothing.
    if (c.state === "triaged") c = ctx.store.save({ ...c, state: "filing", family: c.family ?? { id: randomUUID(), file: "", sendId: randomUUID() } }, now);

    if (!c.issue) {
      const found = await ctx.tools.gh<{ items: { html_url: string; number: number; body?: string }[] }>(
        `search/issues?q=${encodeURIComponent(`repo:${p.slug} is:issue in:body "${marker(c)}"`)}`,
        undefined,
        "GET",
      );
      const had = found.items.find((i) => i.body?.includes(marker(c)));
      const issue = had ?? (await ctx.tools.gh<{ html_url: string; number: number }>(`repos/${p.slug}/issues`, { title: f.title, body: issueBody(ctx, c) }));
      c = ctx.store.save({ ...c, issue: { url: issue.html_url, number: issue.number } }, now);
    }

    const fam = c.family!;
    const file = join(ctx.home, "families", `${fam.id}.json`);
    mkdirSync(join(ctx.home, "families"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        { id: fam.id, base: p.base, issues: [{ source: c.issue!.url, repro: f.repro, acceptance: f.acceptance, evidence: f.evidence }], preparation: f.preparation },
        null,
        2,
      ) + "\n",
    );
    c = ctx.store.save({ ...c, family: { ...fam, file } }, now);

    await call("POST", `/api/superagents/${me.name}/chat`, { text: handoff(ctx, c), sendId: fam.sendId });
    return ctx.store.save({ ...c, state: "handed", family: { ...c.family!, sentAt: now }, note: undefined }, now);
  });
}

function issueBody(ctx: Ctx, c: Crash): string {
  const v = c.triage!.verdict!;
  const f = v.fix!;
  const src = ctx.source();
  return [
    `Salus found this in production: ${c.count} times in ${ctx.settings().windowHours} hours, first seen ${new Date(c.firstSeen).toISOString()}.${src ? ` [PostHog](${src.link(c.id)})` : ""}`,
    "",
    `**${v.severity}** · ${v.summary}`,
    "",
    "### Root cause",
    v.rootCause || "(see the evidence)",
    "",
    "### Reproduce",
    f.repro,
    "",
    "### Acceptance",
    f.acceptance,
    "",
    "### Evidence",
    f.evidence,
    "",
    `<!-- ${marker(c)} -->`,
  ].join("\n");
}

/** What the main conversation is told: one command to run, and what to do when it cannot. */
function handoff(ctx: Ctx, c: Crash): string {
  const fixer = ctx.settings().fixer;
  return `[Salus fix ${tag(c.id)}] A person approved fixing "${c.triage!.verdict!.fix!.title}" (${c.issue!.url}). Start ${fixer} on it, under a live ${fixer} grant whose requester is you:

${ctx.cli} superagent call ${fixer} work-start --json ${c.family!.file} --set grant=<grant id>

\`${ctx.cli} superagent view ${fixer} --tab grants\` lists the grants. If none is live and names you as requester, tell the person to create one on ${fixer}'s Grants tab with you as requester, then run the command. Salus follows the family itself once it exists; you need not report back.`;
}

type FixerWork = { state: string; publication?: { url?: string; number?: number }; failure?: { summary: string } };

/** Where a handed-off fix is: the family started, its PR, its merge. */
export async function follow(ctx: Ctx, id: string, now = Date.now()): Promise<Crash> {
  return ctx.lock(id, async () => {
    let c = ctx.store.crash(id);
    if (c.state !== "handed" && c.state !== "fixing") return c;
    const fixer = ctx.settings().fixer;
    let work: FixerWork;
    try {
      work = (await call<{ work: FixerWork }>("POST", `/api/superagents/${fixer}/action`, { action: "work-get", values: { id: c.family!.id } })).work;
    } catch (e) {
      if (e instanceof AgentboxError && e.status === 404) return c; // not started yet
      throw e;
    }
    if (c.state === "handed") c = ctx.store.save({ ...c, state: "fixing" }, now);
    if (work.failure && work.state === "quality_failed" && c.note !== `${fixer} gave up: ${work.failure.summary}`) {
      c = ctx.store.save({ ...c, note: `${fixer} gave up: ${work.failure.summary}` }, now);
      await agentbox.card({ kind: "note", title: `Salus: ${fixer} could not fix ${nameOf(c)}`, short: work.failure.summary.slice(0, 300), key: `salus:${tag(c.id)}:failed` });
    }
    const n = work.publication?.number;
    if (n && !c.pr) c = ctx.store.save({ ...c, pr: { url: work.publication!.url!, number: n } }, now);
    if (!c.pr) return c;
    const p = await project(ctx);
    const pr = await ctx.tools.gh<{ merged_at: string | null; closed_at: string | null; state: string }>(`repos/${p.slug}/pulls/${c.pr.number}`, undefined, "GET");
    if (pr.merged_at) {
      const mergedAt = Date.parse(pr.merged_at);
      const src = ctx.source();
      const before = src ? await src.count(c.id, mergedAt - 7 * 86_400_000, mergedAt) : { count: 0, last: null };
      return ctx.store.save(
        { ...c, state: "merged", pr: { ...c.pr, mergedAt }, verify: { before: before.count, beforeHours: 168, after: 0, lastAfter: null, needHours: needHours(before.count, 168), checkedAt: 0 }, note: undefined },
        now,
      );
    }
    if (pr.state === "closed" && !c.pr.closedAt) return ctx.store.save({ ...c, pr: { ...c.pr, closedAt: Date.parse(pr.closed_at ?? new Date(now).toISOString()) }, note: "Its PR was closed without merging" }, now);
    return c;
  });
}

/**
 * How long a crash must stay quiet to call it fixed: long enough that, at the
 * rate it happened before, a quiet stretch by chance is under 1% (e^-4.6), and
 * never under a day nor over two weeks.
 */
export function needHours(before: number, hours: number): number {
  const rate = before / hours;
  return Math.min(14 * 24, Math.max(24, rate > 0 ? 4.6 / rate : 14 * 24));
}
