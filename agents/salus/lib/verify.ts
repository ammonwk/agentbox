/** After the deploy: did the crash stop? Counted from the source, not taken
 *  from anyone's word. Quiet for long enough at its old rate is verified;
 *  still happening `deployLagHours` after it reached production is recurred. */
import { agentbox } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { tag } from "./triage";
import { nameOf, type Crash } from "./types";

/** Counting again more often than this tells nothing new. */
const RECHECK_MS = 30 * 60_000;

export async function verify(ctx: Ctx, id: string, now = Date.now()): Promise<Crash> {
  return ctx.lock(id, async () => {
    let c = ctx.store.crash(id);
    const v = c.verify;
    const deployedAt = c.pr?.deploy?.at;
    if (c.state !== "deployed" || !v || !deployedAt || now - v.checkedAt < RECHECK_MS) return c;
    const src = ctx.source();
    if (!src) return c;
    const after = await src.count(c.id, deployedAt, now);
    c = ctx.store.save({ ...c, verify: { ...v, after: after.count, lastAfter: after.last, checkedAt: now } }, now);
    const lagMs = ctx.settings().deployLagHours * 3_600_000;
    if (after.last && after.last > deployedAt + lagMs) {
      c = ctx.store.save({ ...c, state: "recurred", note: `Still happening ${Math.round((after.last - deployedAt) / 3_600_000)} hours after #${c.pr!.number} reached production: not fixed` }, now);
      const card = await agentbox.card({
        kind: "decision",
        title: `Salus: ${nameOf(c)} still happens after its fix`,
        short: `${after.count} times since #${c.pr!.number} reached production, the last ${new Date(after.last).toISOString()}.`,
        recommend: "Triage it again on Salus's page",
        pr: c.pr!.url,
        key: `salus:${tag(c.id)}:recurred:${c.pr!.number}`,
      });
      return ctx.store.save({ ...c, card: card.id }, now);
    }
    const quietSince = Math.max(after.last ?? deployedAt, deployedAt);
    if (now - quietSince >= v.needHours * 3_600_000 && now - deployedAt >= 24 * 3_600_000) {
      c = ctx.store.save({ ...c, state: "verified", note: undefined }, now);
      const card = await agentbox.card({
        kind: "note",
        title: `Salus: ${nameOf(c)} is fixed`,
        short: `Quiet for ${Math.round((now - quietSince) / 3_600_000)} hours since #${c.pr!.number}; before it, ${v.before} in ${v.beforeHours} hours.`,
        pr: c.pr!.url,
        key: `salus:${tag(c.id)}:verified`,
        notify: false,
      });
      return ctx.store.save({ ...c, card: card.id }, now);
    }
    return c;
  });
}
