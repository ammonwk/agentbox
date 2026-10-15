/** A grant is a human's standing permission for one project: who answers for
 *  the work, which gh login publishes it, what checks it must pass, and until
 *  when. Created only from Vulcan's page, by a person; its id is never reused. */
import { ActionError, agentbox, type Caller } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { ghLogin } from "./shell";
import { GrantInput, MAX_GRANT_MS, type Grant, type Work } from "./types";
import { releaseClaims } from "./work";

export async function createGrant(ctx: Ctx, caller: Caller, input: unknown, now = Date.now()): Promise<Grant> {
  if (caller.via !== "app") throw new ActionError("A grant is created by a person on Vulcan's page, not from a session or the API", 403);
  const g = GrantInput.parse(input);
  if (g.expires <= now || g.expires > now + MAX_GRANT_MS) throw new ActionError("Grant expiry must be within seven days");
  const state = await agentbox.state(false);
  if (!state.repos.some((r) => r.id === g.project)) throw new ActionError("Register the project first", 404);
  if (!state.sessions.some((s) => s.id === g.requester)) throw new ActionError(`No session ${g.requester} to be the requester`, 404);
  if ((await ghLogin(ctx.tools)) !== g.actor.toLowerCase()) throw new ActionError("Explicit publication actor does not match the current gh login", 403);
  await ctx.tools.gh(`users/${g.human.github}`, undefined, "GET");
  const old = ctx.store.grant(g.id);
  if (old) throw new ActionError("Grant ID already used; revoke and create a new grant", 409);
  const grant: Grant = { ...g, createdAt: now };
  ctx.store.saveGrant(grant);
  return grant;
}

export function revokeGrant(ctx: Ctx, id: string, now = Date.now()): Grant {
  const g = ctx.store.grant(id);
  if (!g) throw new ActionError("No such grant", 404);
  if (!g.revokedAt) ctx.store.saveGrant({ ...g, revokedAt: now });
  return ctx.store.grant(id)!;
}

/** The grant as it stands, or why it does not. */
export function liveGrant(ctx: Ctx, id: string, now = Date.now()): Grant {
  const g = ctx.store.grant(id);
  if (!g || g.revokedAt) throw new ActionError("No operator grant for this work", 403);
  if (g.expires <= now) throw new ActionError("Work authority expired or revoked", 403);
  return g;
}

/** What a grant promised, apart from when it was made or revoked: a change is a changed authority. */
const terms = (g: Grant): string => {
  const { createdAt: _c, revokedAt: _r, ...t } = g;
  return JSON.stringify(t);
};

/**
 * Who may operate a family: its writer, or (unless `writerOnly`) the grant's
 * requester; and only while the grant stands as it did when the work began.
 */
export function authority(ctx: Ctx, w: Work, caller: string | null, writerOnly = false, now = Date.now()): Grant {
  const g = standing(ctx, w, now);
  if (!caller || (caller !== w.session && (writerOnly || caller !== g.requester))) throw new ActionError("Only this work's owner or authorized coordinator may operate it", 403);
  return g;
}

/** The family's grant, live and unchanged since the work began. */
export function standing(ctx: Ctx, w: Work, now = Date.now()): Grant {
  const g = liveGrant(ctx, w.grant.id, now);
  if (terms(g) !== terms(w.grant)) throw new ActionError("Work authority changed; review the assignment", 409);
  return g;
}

/** Each tick: a family whose authority is gone has its writer and reviewers stopped. */
export async function enforceAuthority(ctx: Ctx, now = Date.now()): Promise<string[]> {
  const stopped: string[] = [];
  let sessions: Awaited<ReturnType<typeof agentbox.state>>["sessions"] | null = null;
  for (const w of ctx.store.works()) {
    try {
      standing(ctx, w, now);
      continue;
    } catch {
      /* authority gone: stop what runs, this tick and every tick after */
    }
    sessions ??= (await agentbox.state(false)).sessions;
    for (const id of sessionsOf(w)) {
      const live = sessions.find((s) => s.id === id);
      if (live && live.host !== "none") {
        await agentbox.stop(id);
        stopped.push(id);
      }
    }
    // Its issues are free once what ran on them has stopped.
    const after = ctx.store.work(w.id);
    if (!after.stoppedAt || after.claims?.length) ctx.store.saveWork({ ...after, stoppedAt: after.stoppedAt ?? now, claims: await releaseClaims(after) });
  }
  return stopped;
}

/** Every session a family has: the writer and each reviewer, retired ones too. */
export function sessionsOf(w: Work): string[] {
  const ids = [w.session, ...w.rounds.flatMap((r) => r.reviewers.flatMap((x) => [x.session, ...(x.retired ?? [])]))];
  return [...new Set(ids.filter((x): x is string => !!x))];
}
