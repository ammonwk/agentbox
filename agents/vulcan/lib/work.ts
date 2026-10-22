/** A work family: a set of issues one writer fixes together, on a branch cut
 *  from a pinned base, started once and never replayed. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ActionError, agentbox } from "../../lib/sdk";
import type { Repo, Session } from "../../../src/core/types";
import type { Ctx } from "./ctx";
import { authority, liveGrant } from "./grants";
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
      return prior;
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
      createdAt: now,
    };
    // Every issue or none: a second family on an issue of this one is told to extend it.
    ctx.store.transaction(() => {
      for (const i of issues) {
        const held = ctx.store.claimOf(i.key);
        if (held) throw new ActionError(`Issue already belongs to work family ${held}; extend that family instead of creating another writer`, 409);
        ctx.store.claim(i.key, w.id);
      }
      ctx.store.saveWork(w);
    });
    await launchWriter(ctx, w, now);
    return w;
  });
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
    const proven = w.launch ? await provenWriter(ctx, w, (await agentbox.state(false)).sessions) : null;
    if (proven) {
      if (!proven.session.agentSessionId) throw new ActionError("Existing launch is not yet proven by its provider transcript; inspect it without replaying the writer prompt", 409);
      w.session = proven.session.id;
      w.cwd = proven.cwd;
      w.state = "working";
      ctx.store.saveWork(w);
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
