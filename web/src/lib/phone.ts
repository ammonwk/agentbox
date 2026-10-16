import { useSyncExternalStore } from "react";
import type { SessionTab } from "../route";

/** Phone widths: the shell trades its rail for a tab bar along the bottom.
 *  Must match the `@media (max-width: 640px)` blocks in the stylesheets. */
export const PHONE_PX = 640;

export function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia(`(max-width: ${PHONE_PX}px)`).matches;
}

const subscribePhone = (onChange: () => void) => {
  const mql = window.matchMedia(`(max-width: ${PHONE_PX}px)`);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
};

/** isPhone(), and a render again when the window crosses the width. */
export function useIsPhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

/**
 * The tab a session opens on: the timeline, which reads top to bottom and
 * reflows to any width (a phone-sized terminal would also shrink the agent's
 * tmux window for the desktop, `window-size latest`). A blocked session still
 * opens on the terminal: the prompt it is waiting on is only there. Unless
 * the prompt is a question, which is answered under the timeline.
 */
export function openingTab(s?: { status: string; question?: unknown }): SessionTab {
  return s?.status === "blocked" && !s.question ? "terminal" : "timeline";
}

/**
 * Running as the installed app or the desktop app rather than in a browser
 * tab. Only there can the page have Ctrl+W, Ctrl+T and Ctrl+Shift+T: a Chrome tab keeps those
 * for itself, and elsewhere they would be surprising.
 */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  // The desktop app (desktop/) is a window of its own too, with no browser keys.
  if (/\bElectron\//.test(navigator.userAgent)) return true;
  return window.matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay)").matches;
}
