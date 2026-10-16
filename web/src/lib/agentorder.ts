/** The order of the agents sidebar. Kept apart from AgentBrowser so that it
 *  can be tested without a page. */
import type { AgentIcon } from "../../../src/core/types";
import { placeIn, ranksOf } from "./manualorder";

export type AgentActivity = "working" | "approval" | "waiting" | "idle" | "paused";
/** A superagent as the sidebar shows it: `id` is its name, `name` its title,
 *  `role` its description (its default icon comes from it). */
export type AgentOption = { id: string; name: string; detail: string; role: string; icon?: AgentIcon | null; avatar?: string | null; activity: AgentActivity };

/** A paused or disabled agent: listed after the others (#27), never landed on first (#31). */
export const resting = (a: AgentOption) => a.activity === "paused";

/** The agents as the sidebar lists them: the active ones, then the paused and
 *  disabled ones, each part in your order (`ids`, the manual order). */
export function sidebarOrder(options: readonly AgentOption[], ids: readonly string[]): AgentOption[] {
  const ranks = ranksOf(ids);
  const rank = (a: AgentOption) => ranks.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  return [...options].sort((a, b) => Number(resting(a)) - Number(resting(b)) || rank(a) - rank(b));
}

/** The first active agent in the sidebar, or the first agent when all are paused. */
export function firstActiveIn(options: readonly AgentOption[], ids: readonly string[]): AgentOption | undefined {
  const ordered = sidebarOrder(options, ids);
  return ordered.find((a) => !resting(a)) ?? ordered[0];
}

/** A drag of `moved` dropped before or after `target`, which can be any
 *  agent, active or paused: your order with it placed there among all the
 *  agents, and the row its line goes on, where the agent will be drawn. As
 *  paused agents stay last, a drop among the other part lands it at the
 *  nearest end of its own; no line when it is drawn where it was. */
export function dropAgent(options: readonly AgentOption[], ids: readonly string[], moved: string, target: string, where: "before" | "after"): { ids: string[]; line: { id: string; at: "before" | "after" } | null } {
  const shown = sidebarOrder(options, ids).map((a) => a.id);
  const next = placeIn(ids, shown, moved, target, where);
  const then = sidebarOrder(options, next).map((a) => a.id), i = then.indexOf(moved);
  if (i === -1 || then.every((id, j) => id === shown[j])) return { ids: next, line: null };
  return { ids: next, line: i > 0 ? { id: then[i - 1]!, at: "after" } : { id: then[1]!, at: "before" } };
}

/** What the sidebar's icon says of an agent or a thread: from its sessions'
 *  statuses (`shownStatus`), and whether the agent is enabled. */
export function agentActivity(enabled: boolean, statuses: readonly string[]): AgentActivity {
  if (statuses.includes("paused")) return "paused";
  if (statuses.some((s) => s === "blocked" || s === "uncertain")) return "approval";
  if (statuses.some((s) => ["running", "retrying", "starting", "queued"].includes(s))) return "working";
  if (!enabled) return "paused";
  return statuses.includes("waiting") ? "waiting" : "idle";
}
