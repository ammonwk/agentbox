/** An agent's views: the three header tabs, and the session list a phone
 *  shows first. Settings replaced About (#35), so an old `about` link opens
 *  Settings. Any other segment opens Chat. */
export type AgentTab = "chat" | "feed" | "settings";
export type AgentView = AgentTab | "sessions";
/** The header's tabs, left to right. */
export const AGENT_TABS: readonly AgentTab[] = ["chat", "feed", "settings"];

export function agentViewOf(segment: string): AgentView {
  if (segment === "about") return "settings";
  return segment === "feed" || segment === "settings" || segment === "sessions" ? segment : "chat";
}
