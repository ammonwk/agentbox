/** The order of the agents sidebar. Kept apart from AgentBrowser so that it
 *  can be tested without a page. */
import { ranksOf } from "./manualorder";

export type AgentActivity = "working" | "approval" | "waiting" | "idle" | "paused";
export type AgentOption = { id: string; name: string; detail: string; role: string; creator?: boolean; avatar?: string | null; activity: AgentActivity };

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
