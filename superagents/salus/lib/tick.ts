/** Each minute: read the source when its poll is due, start the triages the
 *  budget allows, read finished ones, follow fixes and verify merged ones. A
 *  failure on one crash is noted on it and never stops the others. */
import { ActionError } from "../../lib/sdk";
import type { Ctx } from "./ctx";
import { follow } from "./fix";
import { collectTriage, startTriage } from "./triage";
import type { Crash, Seen } from "./types";
import { verify } from "./verify";

export type Status = { at: number; ok: boolean; message: string };

export async function tick(ctx: Ctx, now = Date.now(), force = false): Promise<void> {
  const s = ctx.settings();
  if (!s.enabled) return;
  const src = ctx.source();
  const last = ctx.store.get<Status>("poll");
  if (src && (force || !last || now - last.at >= s.pollMinutes * 60_000)) {
    try {
      const seen = await src.recent(s.windowHours, 200);
      const added = record(ctx, seen, now);
      ctx.store.set("poll", { at: now, ok: true, message: `${seen.length} crashes in the last ${s.windowHours} hours${added ? `, ${added} new` : ""}` } satisfies Status);
    } catch (e) {
      ctx.store.set("poll", { at: now, ok: false, message: (e as Error).message } satisfies Status);
    }
  }

  const all = ctx.store.crashes();
  for (const c of all.filter((x) => x.state === "triaging")) await guard(ctx, c, () => (c.triage?.session ? collectTriage(ctx, c.id, now) : startTriage(ctx, c.id, now)));

  const running = ctx.store.crashes().filter((x) => x.state === "triaging").length;
  const today = all.filter((x) => x.triage && now - x.triage.startedAt < 86_400_000).length;
  const room = Math.max(0, Math.min(s.triageAtOnce - running, s.triagePerDay - today));
  const next = ctx.store
    .crashes()
    .filter((x) => x.state === "new")
    .sort((a, b) => b.count - a.count)
    .slice(0, room);
  for (const c of next) await guard(ctx, c, () => startTriage(ctx, c.id, now));

  for (const c of ctx.store.crashes()) {
    if (c.state === "handed" || c.state === "fixing") await guard(ctx, c, () => follow(ctx, c.id, now));
    else if (c.state === "merged") await guard(ctx, c, () => verify(ctx, c.id, now));
  }
}

/** Crashes the source saw: known ones updated, new ones above the threshold added. Returns how many were added. */
export function record(ctx: Ctx, seen: Seen[], now: number): number {
  const min = ctx.settings().minCount;
  let added = 0;
  for (const x of seen) {
    const old = ctx.store.find(x.key);
    if (old) {
      ctx.store.save({ ...old, count: x.count, lastSeen: Math.max(old.lastSeen, x.last), sample: x.sample ?? old.sample }, now);
    } else if (x.count >= min) {
      const title = x.sample ? `${x.sample.type}: ${x.sample.value.split("\n")[0]!.slice(0, 120)}` : x.key;
      ctx.store.save({ id: x.key, title, firstSeen: x.first, lastSeen: x.last, count: x.count, sample: x.sample, state: "new", createdAt: now, updatedAt: now }, now);
      added++;
    }
  }
  return added;
}

async function guard(ctx: Ctx, c: Crash, fn: () => Promise<Crash>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ActionError && e.status === 409 && /in progress/.test(e.message)) return;
    const now = ctx.store.find(c.id);
    if (now) ctx.store.save({ ...now, note: (e as Error).message.slice(0, 500) });
    console.error(`salus: ${c.id}: ${(e as Error).message}`);
  }
}
