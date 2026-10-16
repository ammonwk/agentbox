/** A work family: a set of issues one writer fixes together, on a branch cut
 *  from a pinned base, started once and never replayed. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ActionError, agentbox, AgentboxError, me, type ClaimHolder, type WorkClaim } from "../../lib/sdk";
import type { Repo, Session } from "../../../src/core/types";
import type { Ctx } from "./ctx";
import { authority, liveGrant, sessionsOf } from "./grants";
import { writerPrompt } from "./prompts";
import { AGENT_NAME, canonicalSource, slugFromRemoteUrl } from "./text";
import { sha, WorkInput, type Work } from "./types";

/** Where a registered repo's checkout is: a local repo is its path; a GitHub one agentbox cloned under its home. */
export function checkoutOf(repo: Repo): string {
  // agentbox says where; the derivation is for a server older than checkoutRoot.
  if (repo.checkoutRoot) return repo.checkoutRoot;
  if (repo.kind === "local") return repo.ref;
  const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".local", "share", "agentbox");
  return join(home, "repos", repo.ref.replace(/[^A-Za-z0-9._-]/g, "_"));
}

/** `owner/name` of a checkout's origin, lower-cased; null when origin is not GitHub. */
async function slugOf(ctx: Ctx, cwd: string): Promise<string | null> {
  try {
    return slugFromRemoteUrl(await ctx.tools.git(cwd, "remote", "get-url", "origin"))?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

async function projectOf(ctx: Ctx, w: Pick<Work, "repoId" | "repo">): Promise<{ repo: Repo; checkout: string }> {
  const repo = (await agentbox.state(false)).repos.find((r) => r.id === w.repoId);
  if (!repo) throw new ActionError("Project is no longer registered", 404);
  const checkout = checkoutOf(repo);
  if (!existsSync(checkout) || (await slugOf(ctx, checkout)) !== w.repo) throw new ActionError("Project identity changed", 409);
  return { repo, checkout };
}

export async function startWork(ctx: Ctx, caller: string | null, input: unknown, now = Date.now()): Promise<Work> {
  const p = WorkInput.parse(input);
  const g = liveGrant(ctx, p.grant, now);
  if (!caller || caller !== g.requester) throw new ActionError("This grant belongs to another coordinator", 403);
  return ctx.lock(p.id, async () => {
    const prior = ctx.store.works().find((w) => w.id === p.id);
    if (prior) {
      if (JSON.stringify(prior.input) !== JSON.stringify(p)) throw new ActionError("Work ID already used", 409);
      return prior.claiming && !prior.stoppedAt ? finishStart(ctx, prior, now) : prior;
    }
    const state = await agentbox.state(false);
    const project = state.repos.find((r) => r.id === g.project);
    if (!project) throw new ActionError("Project is no longer registered", 404);
    const checkout = checkoutOf(project);
    const repo = existsSync(checkout) ? await slugOf(ctx, checkout) : null;
    if (!repo || repo !== project.fullName?.toLowerCase()) throw new ActionError("Registered repository identity changed", 409);
    const issues = p.issues.map((i) => canonicalSource(i.source));
    if (issues.some((i) => i.repo !== repo) || new Set(issues.map((i) => i.key)).size !== issues.length)
      throw new ActionError("Each issue must be a distinct canonical issue in this project");
    for (const i of issues) {
      const issue = await ctx.tools.gh<{ state: string; pull_request?: unknown }>(`repos/${repo}/issues/${i.number}`, undefined, "GET");
      if (issue.state !== "open" || issue.pull_request) throw new ActionError("Trial issues must be real open issues", 409);
    }
    const main = (await agentbox.self()).main ?? g.requester;
    const ref = `refs/agentbox/work/${p.id}/base`;
    await ctx.tools.git(checkout, "fetch", "--no-tags", "origin", `refs/heads/${p.base}:${ref}`);
    const base = sha.parse(await ctx.tools.git(checkout, "rev-parse", ref));
    const provider = p.provider ?? ctx.config.writerProvider;
    const promptRevision = ctx.config.promptRevision;
    const w: Work = {
      id: p.id,
      input: p,
      grant: g,
      promptRevision,
      provider,
      config: createHash("sha256").update(JSON.stringify({ name: AGENT_NAME, provider, promptRevision, revision: ctx.revision(promptRevision), repo })).digest("hex"),
      repo,
      repoId: project.id,
      checkout,
      base,
      branch: `agentbox/work-${p.id}`,
      main,
      cwd: null,
      session: null,
      state: "starting",
      rounds: [],
      claiming: true,
      createdAt: now,
    };
    // The family is recorded before its claim: a claim whose answer is lost
    // is then still found, by its note, and never leaks.
    ctx.store.saveWork(w);
    return finishStart(ctx, w, now);
  });
}

/**
 * Claim every issue or none, in one claim, then start the writer. A refusal
 * removes the family, because it did not start anything: a second family on
 * an issue of another family is told to extend that family.
 */
async function finishStart(ctx: Ctx, w: Work, now: number): Promise<Work> {
  try {
    w.claims = await claimIssues(ctx, w.id, w.input.issues.map((i) => canonicalSource(i.source).url));
  } catch (e) {
    if (e instanceof ActionError && e.status === 409) ctx.store.dropWork(w.id);
    throw e;
  }
  delete w.claiming;
  ctx.store.saveWork(w);
  await launchWriter(ctx, w, now);
  return w;
}

const NOTE = `${AGENT_NAME} work `;
/** The note on each claim of a family. It names the family, so that Vulcan finds a claim again when its answer was lost. */
export const claimNote = (id: string): string => `${NOTE}${id}`;
const keyOf = (source: string): string => (/^https?:\/\//.test(source) ? canonicalSource(source).key : source);
const fences = (cs: WorkClaim[]): { key: string; fence: number }[] => cs.map((c) => ({ key: c.key, fence: c.fence }));

/**
 * Claim the sources in agentbox for a family (docs/superagents.md, Claims).
 * When the answer is lost, or agentbox says that Vulcan itself holds a source,
 * Vulcan reads its claims back: the ones whose note names this family are its
 * own. Any other holder is a refusal that names the family or the holder.
 */
async function claimIssues(ctx: Ctx, id: string, sources: string[], session?: string): Promise<{ key: string; fence: number }[]> {
  const note = claimNote(id);
  try {
    return fences(await agentbox.claim(sources, { session, note }));
  } catch (e) {
    const held = e instanceof AgentboxError && e.status === 409 ? (e.data as { key: string; holder: ClaimHolder } | null) : null;
    if (held && held.holder.superagent !== me.name) throw refusal(ctx, held, null);
    const rows = await agentbox.claims({ superagent: me.name });
    const mine = sources.map((s) => rows.find((r) => r.key === keyOf(s) && r.note === note));
    if (mine.every((r): r is WorkClaim => !!r)) return fences(mine);
    if (held) throw refusal(ctx, held, rows.find((r) => r.key === held.key)?.note ?? null);
    throw e;
  }
}

function refusal(ctx: Ctx, held: { key: string; holder: ClaimHolder }, note: string | null): ActionError {
  const byNote = note?.startsWith(NOTE) ? note.slice(NOTE.length) : null;
  const family = byNote ?? ctx.store.works().find((x) => x.claims?.some((c) => c.key === held.key))?.id;
  if (family) return new ActionError(`Issue already belongs to work family ${family}; extend that family instead of creating another writer`, 409);
  const who = `${held.holder.superagent ?? "a person"}${held.holder.session ? ` (session ${held.holder.session})` : ""}`;
  return new ActionError(`Issue ${held.key} is already claimed by ${who}; do not start a second writer on it`, 409);
}

/** The writer holds the family's claims from here: agentbox renews them while it runs. An attach whose answer was lost is read back, never repeated. */
async function attachWriter(ctx: Ctx, w: Work, session: string): Promise<void> {
  if (!w.claims?.length) return;
  const now = await agentbox.claims();
  const out: { key: string; fence: number }[] = [];
  for (const c of w.claims) {
    const at = now.find((x) => x.key === c.key);
    if (at?.holder.session === session) out.push({ key: c.key, fence: at.fence });
    else {
      const r = await agentbox.attachClaim(c.key, c.fence, session);
      out.push({ key: r.key, fence: r.fence });
    }
  }
  w.claims = out;
  ctx.store.saveWork(w);
}

/**
 * The family is over (stopped): its issues are free for another family. A
 * claim already gone is no error. A handover or a takeover changes the fence,
 * so a refused release reads the claim again. When Vulcan still holds it,
 * Vulcan releases it with the fence it has now. When another holds it, it is
 * not Vulcan's to release: Vulcan forgets it and notes it on the family.
 * The result is the change to save on the family.
 */
export async function releaseClaims(w: Work): Promise<Pick<Work, "claims" | "claiming" | "notes">> {
  const kept: { key: string; fence: number }[] = [];
  const notes = [...(w.notes ?? [])];
  let claims = w.claims ?? [];
  let claiming = w.claiming;
  if (claiming) {
    // The claim answer was lost: the claims this family has are the ones whose note names it.
    try {
      const rows = await agentbox.claims({ superagent: me.name });
      claims = [...claims, ...fences(rows.filter((r) => r.note === claimNote(w.id) && !claims.some((c) => c.key === r.key)))];
      claiming = undefined;
    } catch (e) {
      console.error(`work ${w.id}: its claims were not read back: ${(e as Error).message}`);
    }
  }
  for (const c of claims) {
    try {
      const other = await releaseOne(c);
      if (other) notes.push(`Vulcan no longer holds ${c.key}: ${other} holds it now, so Vulcan does not release it.`);
    } catch (e) {
      console.error(`work ${w.id}: ${c.key} not released: ${(e as Error).message}`);
      kept.push(c);
    }
  }
  return { claims: kept, claiming, notes: notes.length ? notes : undefined };
}

/** Release one claim. The result is the other holder that has it now, or null. */
async function releaseOne(c: { key: string; fence: number }): Promise<string | null> {
  try {
    await agentbox.releaseClaim(c.key, c.fence);
    return null;
  } catch (e) {
    if (e instanceof AgentboxError && e.status === 404) return null;
    // 409 is a stale fence. 403 is a holder that is not Vulcan.
    if (!(e instanceof AgentboxError) || (e.status !== 409 && e.status !== 403)) throw e;
  }
  const now = (await agentbox.claims({ key: c.key })).find((x) => x.key === c.key);
  if (!now) return null;
  if (now.holder.superagent !== me.name) return `${now.holder.superagent ?? "a person"}${now.holder.session ? ` (session ${now.holder.session})` : ""}`;
  try {
    await agentbox.releaseClaim(c.key, now.fence);
  } catch (e) {
    if (!(e instanceof AgentboxError) || e.status !== 404) throw e;
  }
  return null;
}

/** Stop what a family runs, then free its issues. */
export async function stopWork(ctx: Ctx, id: string, now = Date.now()): Promise<string[]> {
  const w = ctx.store.work(id);
  const live = (await agentbox.state(false)).sessions;
  const stopped: string[] = [];
  for (const s of sessionsOf(w)) {
    const l = live.find((x) => x.id === s);
    if (l && l.host !== "none") {
      await agentbox.stop(s);
      stopped.push(s);
    }
  }
  const after = ctx.store.work(id);
  ctx.store.saveWork({ ...after, stoppedAt: after.stoppedAt ?? now, ...(await releaseClaims(after)) });
  return stopped;
}

/**
 * Issue claims from before agentbox kept them: each live family's issues are
 * claimed once in agentbox, for its writer when it still has one, and then
 * forgotten here. A family whose claim is refused keeps its rows for the next start.
 */
export async function adoptLegacyClaims(ctx: Ctx): Promise<void> {
  const legacy = ctx.store.legacyClaims();
  if (!legacy.size) return;
  const sessions = (await agentbox.state(false)).sessions;
  for (const [id, keys] of legacy) {
    const w = ctx.store.works().find((x) => x.id === id);
    try {
      if (w && !w.stoppedAt && !w.claims) {
        const session = sessions.some((s) => s.id === w.session) ? w.session! : undefined;
        // When the claim answer is lost, the next start reads the claims back by their note.
        const claims = await claimIssues(ctx, id, keys, session);
        ctx.store.saveWork({ ...ctx.store.work(id), claims });
      }
      ctx.store.dropLegacyClaims(id);
    } catch (e) {
      console.error(`work ${id}: its issue claims stay here for now: ${(e as Error).message}`);
    }
  }
}

/** The worktree git has for a branch, from the checkout's list. */
async function worktreeOfBranch(ctx: Ctx, checkout: string, branch: string): Promise<string | null> {
  const out = await ctx.tools.git(checkout, "worktree", "list", "--porcelain");
  for (const block of out.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const b = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && b === branch) return path;
  }
  return null;
}

/**
 * The session agentbox started as this family's writer, if it did: the one
 * running in the branch's worktree under Vulcan's main. Found this way, never
 * by assumption, because a start whose answer was lost may still have landed.
 */
async function provenWriter(ctx: Ctx, w: Work, sessions: Session[]): Promise<{ session: Session; cwd: string } | null> {
  const cwd = await worktreeOfBranch(ctx, w.checkout, w.branch);
  if (!cwd) return null;
  const found = sessions.find((s) => (s.cwd === cwd || s.worktree === cwd) && s.parent === w.main && s.provider === w.provider);
  return found ? { session: found, cwd } : null;
}

async function launchWriter(ctx: Ctx, w: Work, now = Date.now()): Promise<void> {
  const sessions = (await agentbox.state(false)).sessions;
  if (w.launch && (await provenWriter(ctx, w, sessions))) throw new ActionError("A launch was already recorded; inspect or resume its existing session, never replay its prompt", 409);
  const { repo, checkout } = await projectOf(ctx, w);
  try {
    // The branch at the pinned base, and its checkout untouched if it already has one.
    let at: string | null = null;
    try {
      at = await ctx.tools.git(checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`);
    } catch {
      at = null;
    }
    if (at === null) await ctx.tools.git(checkout, "branch", w.branch, w.base);
    else if (at !== w.base) throw new ActionError("Reserved writer branch changed; do not retry its launch", 409);
    const wt = await worktreeOfBranch(ctx, checkout, w.branch);
    if (wt && ((await ctx.tools.git(wt, "rev-parse", "HEAD")) !== w.base || (await ctx.tools.git(wt, "status", "--porcelain", "--untracked-files=no"))))
      throw new ActionError("Reserved writer checkout changed; do not retry its launch", 409);
    authority(ctx, w, w.grant.requester, false, now);
    w.launch = { at: now };
    w.state = "starting";
    ctx.store.saveWork(w);
    const s = await agentbox.start({ provider: w.provider, notify: false, repoId: repo.id, branch: w.branch, parent: w.main, prompt: writerPrompt(w, ctx.config.cli, ctx.revision(w.promptRevision)) });
    w.session = s.id;
    w.cwd = s.cwd;
    w.state = "working";
    ctx.store.saveWork(w);
    await attachWriter(ctx, w, s.id);
  } catch (e) {
    w.state = "uncertain";
    ctx.store.saveWork(w);
    throw e;
  }
}

/** A family still starting, or whose start is uncertain: take the writer agentbox has, or start one. */
export async function retryStart(ctx: Ctx, id: string, caller: string | null, now = Date.now()): Promise<Work> {
  return ctx.lock(id, async () => {
    const w = ctx.store.work(id);
    authority(ctx, w, caller, false, now);
    if (w.state !== "starting" && w.state !== "uncertain") throw new ActionError("Work is not awaiting launch recovery", 409);
    if (w.claiming) {
      if (w.stoppedAt) throw new ActionError("Work is stopped", 409);
      return finishStart(ctx, w, now);
    }
    const proven = w.launch ? await provenWriter(ctx, w, (await agentbox.state(false)).sessions) : null;
    if (proven) {
      if (!proven.session.agentSessionId) throw new ActionError("Existing launch is not yet proven by its provider transcript; inspect it without replaying the writer prompt", 409);
      w.session = proven.session.id;
      w.cwd = proven.cwd;
      w.state = "working";
      ctx.store.saveWork(w);
      await attachWriter(ctx, w, proven.session.id);
    } else await launchWriter(ctx, w, now);
    return w;
  });
}

/** The family a session belongs to, as its writer or one of its reviewers. */
export function familyOf(ctx: Ctx, session: string | null): Work | undefined {
  if (!session) return undefined;
  return ctx.store.works().find((w) => w.session === session || w.rounds.some((r) => r.reviewers.some((x) => x.session === session || x.retired?.includes(session))));
}

/** The family a session writes for, while it may: working, and its authority standing. */
export function writable(ctx: Ctx, session: string | null, now = Date.now()): Work | null {
  if (!session) return null;
  const w = ctx.store.works().find((w) => w.session === session && w.state === "working" && !w.stoppedAt);
  if (!w) return null;
  try {
    authority(ctx, w, session, true, now);
    return w;
  } catch {
    return null;
  }
}
