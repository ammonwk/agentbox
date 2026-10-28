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

const LAST_TAB = "agentbox.lastTab";
let lastTab: SessionTab = (() => {
  try { return localStorage.getItem(LAST_TAB) === "terminal" ? "terminal" : "timeline"; } catch { return "timeline"; }
})();
const tabListeners = new Set<() => void>();

/** On a computer, the tab you last picked (the timeline or the terminal) is
 *  the one the next session opens on. */
export function pickedTab(tab: SessionTab): void {
  if ((tab !== "timeline" && tab !== "terminal") || tab === lastTab) return;
  lastTab = tab;
  try { localStorage.setItem(LAST_TAB, tab); } catch { /* private mode: this tab remembers it */ }
  for (const fn of tabListeners) fn();
}

/** A link drawn with openingTab draws again when the picked tab changes. */
export function usePickedTab(): SessionTab {
  return useSyncExternalStore((fn) => (tabListeners.add(fn), () => tabListeners.delete(fn)), () => lastTab);
}

/**
 * The tab a session opens on. On a phone the timeline, which reads top to
 * bottom and reflows to any width (a phone-sized terminal would also shrink
 * the agent's tmux window for the desktop, `window-size latest`); on a
 * computer the one you last picked. A blocked session still opens on the
 * terminal: the prompt it is waiting on is only there. Unless the prompt is a
 * question, which is answered under the timeline.
 */
export function openingTab(s?: { status: string; question?: unknown }): SessionTab {
  if (s?.status === "blocked" && !s.question) return "terminal";
  return isPhone() ? "timeline" : lastTab;
}

/**
 * Running as the installed app or the desktop app (desktop/) rather than in
 * a browser tab. Only there can the page have Ctrl+W, Ctrl+Tab and
 * Ctrl+Shift+T: a Chrome tab keeps those for itself, and elsewhere they would
 * be surprising.
 */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  if (/\bElectron\//.test(navigator.userAgent)) return true;
  return window.matchMedia("(display-mode: standalone), (display-mode: window-controls-overlay)").matches;
}
