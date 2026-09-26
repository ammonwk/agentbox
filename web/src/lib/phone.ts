import type { SessionTab } from "../route";

/** Phone widths: the shell trades its rail for a tab bar along the bottom.
 *  Must match the `@media (max-width: 640px)` blocks in the stylesheets. */
export const PHONE_PX = 640;

export function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia(`(max-width: ${PHONE_PX}px)`).matches;
}

/**
 * The tab a session opens on. The terminal on a desktop; on a phone the
 * timeline, which reflows to the width — and attaching a phone-sized terminal
 * would shrink the agent's tmux window for the desktop too (`window-size
 * latest`). A blocked session still opens on the terminal: the prompt it is
 * waiting on is only there.
 */
export function openingTab(status?: string): SessionTab {
  return isPhone() && status !== "blocked" ? "timeline" : "terminal";
}
