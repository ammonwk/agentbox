/** Every action Salus takes, from its page or a session's `superagent call`.
 *  Deciding about a crash and changing settings are a person's, on the page. */
import { ActionError, type ActionReply, type ActionRequest } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { fix, person } from "./fix";
import { Settings, writeSettings } from "./settings";
import { tick } from "./tick";

const idOf = (values: Record<string, unknown>): string => {
  if (typeof values.id !== "string" || !values.id) throw new ActionError("Name the crash: id");
  return values.id;
};

export async function action(ctx: Ctx, req: ActionRequest): Promise<ActionReply> {
  const { caller, values } = req;
  switch (req.action) {
    case "crashes":
      return { crashes: ctx.store.crashes() };
    case "crash":
      return { crash: ctx.store.crash(idOf(values)) };
    case "fix": {
      const c = await fix(ctx, idOf(values), caller);
      return { message: `Filed ${c.issue!.url} and handed it to ${ctx.settings().fixer} through Salus's main conversation.`, crash: c };
    }
    case "dismiss": {
      person(caller);
      const id = idOf(values);
      const c = await ctx.lock(id, async () => ctx.store.save({ ...ctx.store.crash(id), state: "dismissed", note: undefined }));
      return { message: "Dismissed.", crash: c };
    }
    case "retriage": {
      person(caller);
      const id = idOf(values);
      const c = await ctx.lock(id, async () => {
        const old = ctx.store.crash(id);
        if (!["triaged", "dismissed", "recurred"].includes(old.state)) throw new ActionError(`This crash is ${old.state}`, 409);
        const { triage: _t, family: _f, issue: _i, pr: _p, verify: _v, card: _c, ...rest } = old;
        const why = old.state === "recurred" ? `It came back after #${old.pr?.number}.` : undefined;
        return ctx.store.save({ ...rest, state: "new", note: why });
      });
      return { message: "It will be triaged on the next pass the budget allows.", crash: c };
    }
    case "settings-save": {
      person(caller);
      const old = ctx.settings();
      const next: Record<string, unknown> = { ...old };
      for (const [k, was] of Object.entries(old)) {
        const v = values[k];
        if (v === undefined || v === null) continue;
        next[k] = typeof was === "number" ? (String(v).trim() === "" ? was : Number(v)) : typeof was === "boolean" ? v === true || v === "true" : String(v).trim();
      }
      const parsed = Settings.safeParse(next);
      if (!parsed.success) throw new ActionError(parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "));
      const saved = writeSettings(ctx.home, parsed.data);
      return { message: saved.enabled ? "Saved. Salus is on." : "Saved. Salus is off." };
    }
    case "poll": {
      await tick(ctx, Date.now(), true);
      return { message: "Polled." };
    }
    default:
      throw new ActionError(`Salus has no action ${req.action}`, 404);
  }
}
