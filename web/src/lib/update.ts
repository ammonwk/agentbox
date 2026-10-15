/** Keeping an open page on the UI build that is on disk.
 *
 *  `bun run web:build` empties `web/dist`, so a page loaded before it asks for
 *  chunks that no longer exist the first time it opens a lazy view — the
 *  Timeline, the terminal, Accounts — and crashes there. The server says which
 *  build is on disk (`{type:"build"}` on the socket); a page on another one
 *  reloads after a short pause in interaction, including in the foreground.
 *  Drafts, in-flight actions, recording and open dialogs defer the update;
 *  it retries automatically when they finish. The rail also offers a manual
 *  reload. A chunk that is already gone reloads at
 *  once, which is the most a crash would have kept. */

import { useSyncExternalStore } from "react";
import { parseHash } from "../route";

/** The entry script this page was loaded from, e.g. `index-D3v4lAc3.js`; null under the dev server. */
function ownEntry(): string | null {
  if (import.meta.env.DEV) return null;
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s?.src.split("/").pop() ?? null;
}

const mine = ownEntry();
let stale = false;
const listeners = new Set<() => void>();
const IDLE_MS = 2000;
let timer: ReturnType<typeof setTimeout> | undefined;
let composing = false;
let dragging = false;
// Other forms do not all persist their edits as composers do. Keep an edited
// control safe until it is cleared or its form leaves the screen.
const edited = new Set<HTMLElement>();

function scheduleReload(): void {
  clearTimeout(timer);
  if (!stale) return;
  timer = setTimeout(() => {
    if (quiet()) location.reload();
    else scheduleReload();
  }, IDLE_MS);
}

/** From the socket: the build the server would serve a fresh load. */
export function noteServerBuild(entry: string | null): void {
  if (mine === null || entry === null) return;
  const next = entry !== mine;
  if (next === stale) return;
  stale = next;
  for (const fn of listeners) fn();
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

/** Nothing on screen a reload would interrupt or throw away. */
function quiet(): boolean {
  if (composing || dragging) return false;
  if (document.querySelector('.dictation[data-phase="starting"], .dictation[data-phase="recording"], .dictation[data-phase="transcribing"]')) return false;
  if (parseHash(location.hash).page === "voice") return false;
  if (document.querySelector('.modal-backdrop, [role="dialog"], [aria-busy="true"], .att-strip, [data-rec], .xterm, [data-phase="starting"], [data-phase="recording"], [data-phase="transcribing"]')) return false;
  for (const el of edited) {
    if (!el.isConnected) { edited.delete(el); continue; }
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      if (el.value !== "") return false;
    } else if (el.textContent) return false;
  }
  return ![...document.querySelectorAll("textarea")].some((t) => t.value.trim() !== "");
}

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el instanceof HTMLElement && el.matches('input, select, [contenteditable="true"]')) edited.add(el);
  scheduleReload();
});
document.addEventListener("keydown", scheduleReload);
document.addEventListener("pointerdown", scheduleReload);
document.addEventListener("compositionstart", () => { composing = true; scheduleReload(); });
document.addEventListener("compositionend", () => { composing = false; scheduleReload(); });
document.addEventListener("dragstart", () => { dragging = true; scheduleReload(); });
document.addEventListener("dragend", () => { dragging = false; scheduleReload(); });
document.addEventListener("visibilitychange", scheduleReload);
// Navigation gets the same safety checks as a build announcement: a new
// route can restore a saved draft or open another form.
addEventListener("hashchange", scheduleReload);

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
