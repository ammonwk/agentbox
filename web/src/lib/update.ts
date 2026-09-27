/** Keeping an open page on the UI build that is on disk.
 *
 *  `bun run web:build` empties `web/dist`, so a page loaded before it asks for
 *  chunks that no longer exist the first time it opens a lazy view — the
 *  Timeline, the terminal, Accounts — and crashes there. The server says which
 *  build is on disk (`{type:"build"}` on the socket); a page on another one
 *  reloads when that loses nothing: while it is hidden, or when you go to
 *  another page or session (whose composer draft is dropped anyway). Until
 *  then the rail offers the reload. A chunk that is already gone reloads at
 *  once, which is the most a crash would have kept. */

import { useSyncExternalStore } from "react";
import { parseHash, type Route } from "../route";

/** The entry script this page was loaded from, e.g. `index-D3v4lAc3.js`; null under the dev server. */
function ownEntry(): string | null {
  if (import.meta.env.DEV) return null;
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s?.src.split("/").pop() ?? null;
}

const mine = ownEntry();
let stale = false;
const listeners = new Set<() => void>();

/** From the socket: the build the server would serve a fresh load. */
export function noteServerBuild(entry: string | null): void {
  if (mine === null || entry === null) return;
  const next = entry !== mine;
  if (next === stale) return;
  stale = next;
  for (const fn of listeners) fn();
  if (stale && document.visibilityState === "hidden" && quiet()) location.reload();
}

export function useUpdateReady(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => stale,
  );
}

/** Nothing on screen a reload would throw away: a half-typed message, an open dialog, a voice call. */
function quiet(): boolean {
  if (parseHash(location.hash).page === "voice") return false;
  if (document.querySelector(".modal-backdrop")) return false;
  return ![...document.querySelectorAll("textarea")].some((t) => t.value.trim() !== "");
}

function samePlace(a: Route, b: Route): boolean {
  if (a.page !== b.page) return false;
  return a.page !== "session" || (b.page === "session" && a.id === b.id);
}

document.addEventListener("visibilitychange", () => {
  if (stale && document.visibilityState === "hidden" && quiet()) location.reload();
});

// Tab switches inside a session replace the history entry and never get here.
addEventListener("hashchange", (e) => {
  if (stale && !samePlace(parseHash(new URL((e as HashChangeEvent).oldURL).hash), parseHash(location.hash))) location.reload();
});

// ------------------------------------------------------ a chunk already gone

const RELOADED_AT = "agentbox:chunk-reload";
/** One automatic reload a minute, so a build that is really broken shows its error instead of looping. */
const RELOAD_GUARD_MS = 60_000;

/** Chrome, Firefox and Safari's words for a lazy chunk that would not load. */
export function isMissingChunk(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(msg);
}

/** Reload to pick up the build on disk; false if one was just tried. */
export function reloadForMissingChunk(): boolean {
  const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
  if (Date.now() - last < RELOAD_GUARD_MS) return false;
  sessionStorage.setItem(RELOADED_AT, String(Date.now()));
  location.reload();
  return true;
}
