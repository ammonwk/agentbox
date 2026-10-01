import type { SessionTab } from "../route";

/** Phone widths: the shell trades its rail for a tab bar along the bottom.
 *  Must match the `@media (max-width: 640px)` blocks in the stylesheets. */
export const PHONE_PX = 640;

export function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia(`(max-width: ${PHONE_PX}px)`).matches;
}

/**
 * The tab a session opens on: the timeline, which reads top to bottom and
 * reflows to any width (a phone-sized terminal would also shrink the agent's
 * tmux window for the desktop, `window-size latest`). A blocked session still
 * opens on the terminal: the prompt it is waiting on is only there.
 */
export function openingTab(status?: string): SessionTab {
  return status === "blocked" ? "terminal" : "timeline";
}

/**
 * Running as the installed app rather than in a browser tab. Only there can
 * the page have Ctrl+W, Ctrl+Tab and Ctrl+Shift+T: a Chrome tab keeps those
 * for itself, and elsewhere they would be surprising.
 */
export function isInstalledApp(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay)").matches;
}
