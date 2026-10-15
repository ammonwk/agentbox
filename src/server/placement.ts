/** Where a hub starts a session given `node: "auto"` (docs/hub.md,
 *  Placement): a machine that takes starts, below its limit, with the repo
 *  registered, and with the most room on an account it may use for the
 *  provider. The hub itself is one of them. Pure: it takes what the hub knows
 *  and returns the pick with every machine's reason, as the balancer does. */

import type { AccountProvider, Lend, NodeHeadroom, NodeRepo } from "../core/types";

export type Machine = {
  /** A node's name, or null for the hub itself. */
  node: string | null;
  reachable: boolean;
  lend: Pick<Lend, "acceptStarts" | "maxSessions">;
  /** Its accounts (a node's lent ones) and their use; null when it does not share them. */
  headroom: NodeHeadroom[] | null;
  repos: NodeRepo[];
  /** Open sessions the hub started there. */
  placed: number;
};

export type Considered = { node: string | null; room: number | null; why: string | null };

export type Choice =
  | { ok: true; node: string | null; room: number; considered: Considered[] }
  | { ok: false; why: string; considered: Considered[] };

/** Percent of an account left: what its fuller window leaves. */
export const roomOf = (h: Pick<NodeHeadroom, "weekly" | "short">): number => Math.max(0, 100 - Math.max(h.weekly ?? 0, h.short ?? 0));

/** Whether a machine has a repo, named as a start names it: its GitHub `owner/name`. */
export const hasRepo = (repos: readonly NodeRepo[], name: string): boolean => repos.some((r) => !!r.fullName && r.fullName.toLowerCase() === name.toLowerCase());

export function choose(machines: readonly Machine[], want: { provider: AccountProvider; repo: string | null }): Choice {
  const considered: Considered[] = machines.map((m) => {
    const out = (why: string | null, room: number | null = null): Considered => ({ node: m.node, room, why });
    if (!m.reachable) return out("it is away");
    if (!m.lend.acceptStarts) return out("it does not take starts from the hub");
    if (m.lend.maxSessions !== null && m.placed >= m.lend.maxSessions) return out(`it is at its limit (${m.placed} of ${m.lend.maxSessions} open)`);
    // A session on a node runs in a repo it has: a directory of the hub's means nothing there.
    if (m.node !== null && !want.repo) return out("the start names a directory here, not a repo");
    if (want.repo && !hasRepo(m.repos, want.repo)) return out(`it has no ${want.repo} registered`);
    if (!m.headroom) return out("it does not share its accounts' use");
    const rooms = m.headroom.filter((h) => h.provider === want.provider && h.eligible).map(roomOf);
    if (!rooms.length) return out(`it has no ${want.provider} account with room${m.node ? " that it lends" : ""}`);
    return out(null, Math.max(...rooms));
  });
  let best: Considered | null = null;
  // The first of equals wins, and the hub is listed first: no hop for nothing.
  for (const c of considered) if (c.why === null && (!best || c.room! > best.room!)) best = c;
  if (best) return { ok: true, node: best.node, room: best.room!, considered };
  const why = considered.map((c) => `${c.node ?? "the hub"}: ${c.why}`).join("; ");
  return { ok: false, why: `no machine can take it: ${why || "there are none"}`, considered };
}
