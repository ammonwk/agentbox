/** Every action Vulcan takes, from its page (`caller.via === "app"`) or from a
 *  session (`agentbox superagent call vulcan <action>`). */
import { randomUUID } from "node:crypto";
import { ActionError, agentbox, type ActionReply, type ActionRequest, type Caller } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { approve, dismiss, guide, recommend } from "./feed";
import { createGrant, enforceAuthority, revokeGrant, sessionsOf } from "./grants";
import { failure, milestone } from "./outcomes";
import { followPublication, publish, reconcile } from "./publish";
import { collect, retryReview, review } from "./reviews";
import type { Work } from "./types";
import { retryStart, startWork } from "./work";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function needId(values: Record<string, unknown>): { id: string; rest: Record<string, unknown> } {
  const { id, ...rest } = values;
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id)) throw new ActionError("this action needs the work family's id: --set id=<uuid>");
  return { id, rest };
}

/** A decision is a person's: the page, or the API with no session behind it. */
function person(caller: Caller): void {
  if (caller.session) throw new ActionError("This is a person's action, taken on Vulcan's page", 403);
}

/** Who a work action is for: the session calling, or the family's requester when a person acts from the page. */
const operator = (ctx: Ctx, id: string, caller: Caller): string | null => caller.session ?? (caller.via === "app" ? ctx.store.work(id).grant.requester : null);

/** A family as the API shows it: everything but the prompts, which live in the transcripts. */
export const shown = (w: Work) => w;

export async function action(ctx: Ctx, req: ActionRequest): Promise<ActionReply> {
  const { caller, values } = req;
  switch (req.action) {
    case "grant-create": {
      const days = Number(str(values.days) || 7);
      const input = {
        id: randomUUID(),
        requester: str(values.requester) || (await agentbox.self()).main || "",
        project: str(values.project),
        human: { name: str(values.humanName), github: str(values.humanGithub) },
        actor: str(values.actor),
        requiredChecks: str(values.requiredChecks)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        ...(str(values.improvementRepo) ? { improvementRepo: str(values.improvementRepo) } : {}),
        expires: Date.now() + Math.min(7, Math.max(1, days)) * 86_400_000,
      };
      if (!input.requester) throw new ActionError("Name the requester session: Vulcan has no main conversation yet, so send it a message first or give a session id");
      const g = await createGrant(ctx, caller, input);
      return { message: `Grant ${g.id} created for ${g.human.name}; it expires ${new Date(g.expires).toISOString()}.`, grant: g };
    }
    case "grant-revoke": {
      person(caller);
      const g = revokeGrant(ctx, str(values.id));
      const stopped = await enforceAuthority(ctx);
      return { message: `Grant ${g.id} revoked${stopped.length ? `; stopped ${stopped.join(", ")}` : ""}.`, grant: g, stopped };
    }
    case "work-start":
      return { work: shown(await startWork(ctx, caller.session, values)) };
    case "work-retry-start": {
      const { id } = needId(values);
      const w = await retryStart(ctx, id, operator(ctx, id, caller));
      return { message: `Family ${id.slice(0, 8)} is ${w.state}${w.session ? `, writer ${w.session}` : ""}.`, work: shown(w) };
    }
    case "work-stop": {
      person(caller);
      const { id } = needId(values);
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
      ctx.store.saveWork({ ...ctx.store.work(id), stoppedAt: Date.now() });
      return { message: stopped.length ? `Stopped ${stopped.join(", ")}.` : "Nothing was running.", stopped };
    }
    case "work":
    case "work-list":
      return { works: ctx.store.works().map(shown) };
    case "work-get":
      return { work: shown(ctx.store.work(needId(values).id)) };
    case "review": {
      const { id, rest } = needId(values);
      return { round: await review(ctx, id, caller.session, rest) };
    }
    case "collect":
    case "work-collect": {
      const { id } = needId(values);
      return { round: await collect(ctx, id, operator(ctx, id, caller)) };
    }
    case "retry-review": {
      const { id, rest } = needId(values);
      return await retryReview(ctx, id, caller.session, rest);
    }
    case "publish": {
      const { id, rest } = needId(values);
      return await publish(ctx, id, caller.session, rest);
    }
    case "reconcile":
    case "work-reconcile": {
      const { id } = needId(values);
      return await reconcile(ctx, id, operator(ctx, id, caller));
    }
    case "follow": {
      const { id } = needId(values);
      return await followPublication(ctx, id, caller.session);
    }
    case "milestone": {
      const { id, rest } = needId(values);
      return { sent: await milestone(ctx, id, caller.session, rest) };
    }
    case "failure": {
      const { id, rest } = needId(values);
      return await failure(ctx, id, caller.session, rest);
    }
    case "recommend":
      return { proposal: await recommend(ctx, caller, values) };
    case "feed-approve": {
      const p = await approve(ctx, caller, str(values.id));
      return { message: `Approved; delivery ${p.delivery?.state}${p.delivery?.result ? `: ${p.delivery.result}` : ""}.`, proposal: p };
    }
    case "feed-dismiss":
      return { message: "Dismissed.", proposal: await dismiss(ctx, caller, str(values.id)) };
    case "feed-guide":
      return await guide(ctx, str(values.id));
    default:
      throw new ActionError(`Vulcan takes no action "${req.action}"`, 404);
  }
}
