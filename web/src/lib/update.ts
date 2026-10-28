/** Keeping an open page on the UI build that is on disk.
 *
 *  `bun run web:build` empties `web/dist`, so a page loaded before it asks for
 *  chunks that no longer exist the first time it opens a lazy view — the
 *  Timeline, the terminal, Accounts — and crashes there. The server says which
 *  build is on disk (`{type:"build"}` on the socket); a page on another one
 *  reloads when that loses nothing: while it is hidden, when you go to
 *  another page or session (whose composer draft is dropped anyway), or in
 *  the foreground after two seconds without input, when nothing on screen is
 *  in progress. Until then the rail offers the reload. A chunk that is already gone reloads at
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
/** A page left alone this long reloads in the foreground too, if `idle()`. */
const IDLE_MS = 2000;
let timer: ReturnType<typeof setTimeout> | undefined;
let composing = false;
let dragging = false;
/** Fields typed into: not every form keeps its edits as a composer does, so
 *  one stays safe until it is cleared or leaves the screen. */
const edited = new Set<HTMLElement>();

/** Start the idle wait again; each input restarts it. */
function scheduleReload(): void {
  clearTimeout(timer);
  if (!stale) return;
  timer = setTimeout(() => (idle() ? location.reload() : scheduleReload()), IDLE_MS);
}

/** From the socket: the build the server would serve a fresh load. */
export function noteServerBuild(entry: string | null): void {
  if (mine === null || entry === null) return;
  const next = entry !== mine;
  if (next === stale) return;
  stale = next;
  for (const fn of listeners) fn();
  if (stale && document.visibilityState === "hidden" && quiet()) location.reload();
  scheduleReload();
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

/** Nothing on screen a reload would throw away: a half-typed message, an open dialog, a voice call, a dictation. */
function quiet(): boolean {
  if (parseHash(location.hash).page === "voice") return false;
  if (document.querySelector(".modal-backdrop")) return false;
  if (document.querySelector('.dictation[data-phase="starting"], .dictation[data-phase="recording"], .dictation[data-phase="transcribing"]')) return false;
  return ![...document.querySelectorAll("textarea")].some((t) => t.value.trim() !== "");
}

/** Quiet, and nothing in progress a foreground reload would cut short: a
 *  dialog, a load, an attachment, a recording, a terminal, an edited field. */
function idle(): boolean {
  if (!quiet() || composing || dragging) return false;
  if (document.querySelector('[role="dialog"], [aria-busy="true"], .att-strip, .vn-rec, [data-rec], .xterm')) return false;
  for (const el of edited) {
    if (!el.isConnected) edited.delete(el);
    else if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value !== "" : el.textContent) return false;
  }
  return true;
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

document.addEventListener("input", (e) => {
  if (e.target instanceof HTMLElement && e.target.matches('input, select, [contenteditable="true"]')) edited.add(e.target);
  scheduleReload();
});
document.addEventListener("keydown", scheduleReload);
document.addEventListener("pointerdown", scheduleReload);
document.addEventListener("compositionstart", () => ((composing = true), scheduleReload()));
document.addEventListener("compositionend", () => ((composing = false), scheduleReload()));
document.addEventListener("dragstart", () => ((dragging = true), scheduleReload()));
document.addEventListener("dragend", () => ((dragging = false), scheduleReload()));

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

// ------------------------------------------------------- newer commits

/** Commits on the checkout's branch that the server does not run yet
 *  (`{type:"behind"}`). Never acted on by itself: a restart is a click. */
type Behind = { running: string; head: string; commits: number } | null;
let behind: Behind = null;
const behindListeners = new Set<() => void>();
export function noteServerBehind(next: Behind): void {
  if (JSON.stringify(next) === JSON.stringify(behind)) return;
  behind = next;
  for (const fn of behindListeners) fn();
}
export function useServerBehind(): Behind {
  return useSyncExternalStore(
    (fn) => {
      behindListeners.add(fn);
      return () => behindListeners.delete(fn);
    },
    () => behind,
  );
}
