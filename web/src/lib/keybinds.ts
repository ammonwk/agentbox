/** The board's keyboard shortcuts: one list of actions and their keys, which
 *  the handlers (useKeybinds), the `?` overlay and Settings → Keybinds all
 *  read. A key is written as its modifiers and its name, `Ctrl+Shift+Tab`,
 *  `Alt+J`, `?`, `Shift+ArrowRight`.
 *
 *  The keys you change are kept in this browser (`agentbox.keybinds`), as
 *  the accent colour is: which keys can work depends on the device and on
 *  the installed app. Only the changed actions are stored; another tab
 *  follows a change through the `storage` event.
 *
 *  Where a key works follows from the key. One with Ctrl, Alt or Meta works
 *  from anywhere, a text field and the terminal included: it is taken before
 *  the terminal sees it. One without leaves fields and the terminal their
 *  own keys. A key a browser tab keeps for itself (Ctrl+W, Ctrl+Tab, …) works
 *  only in the installed app (isInstalledApp). With a dialog open, none
 *  works. */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { isInstalledApp } from "./phone";

export type ActionId =
  | "app.newSession"
  | "app.search"
  | "app.help"
  | "project.next"
  | "project.prev"
  | "session.next"
  | "session.prev"
  | "session.cycleNext"
  | "session.cyclePrev"
  | "session.fold"
  | "session.unfold"
  | "session.timeline"
  | "session.terminal"
  | "session.load"
  | "session.close"
  | "session.reopen"
  | "review.answer"
  | "review.approve"
  | "review.later"
  | "review.read"
  | "review.undo";

export interface Action {
  id: ActionId;
  group: string;
  label: string;
  /** The keys it has until you change them: upstream's own. */
  defaults: readonly string[];
}

/** In the order the overlay and Settings list them. */
export const ACTIONS: readonly Action[] = [
  { id: "app.newSession", group: "Anywhere", label: "New session", defaults: ["N", "Ctrl+T"] },
  { id: "app.search", group: "Anywhere", label: "Search the list", defaults: ["/"] },
  { id: "app.help", group: "Anywhere", label: "These shortcuts", defaults: ["?"] },
  { id: "project.next", group: "Anywhere", label: "Next project tab", defaults: [] },
  { id: "project.prev", group: "Anywhere", label: "Previous project tab", defaults: [] },
  { id: "session.next", group: "Sessions", label: "Next session", defaults: ["J", "Alt+J"] },
  { id: "session.prev", group: "Sessions", label: "Previous session", defaults: ["K", "Alt+K"] },
  { id: "session.cycleNext", group: "Sessions", label: "Next session, round to the first after the last", defaults: ["Ctrl+Tab"] },
  { id: "session.cyclePrev", group: "Sessions", label: "Previous session, round to the last before the first", defaults: ["Ctrl+Shift+Tab"] },
  { id: "session.fold", group: "Sessions", label: "Fold a session's children; on a child, go up to its parent", defaults: ["H"] },
  { id: "session.unfold", group: "Sessions", label: "Unfold a session's children", defaults: ["L"] },
  { id: "session.timeline", group: "Sessions", label: "Timeline tab", defaults: ["1", "Alt+1"] },
  { id: "session.terminal", group: "Sessions", label: "Terminal tab", defaults: ["2", "Alt+2"] },
  { id: "session.load", group: "Sessions", label: "Load tab", defaults: ["3", "Alt+3"] },
  { id: "session.close", group: "Sessions", label: "Close the open session", defaults: ["Ctrl+W", "Alt+W"] },
  { id: "session.reopen", group: "Sessions", label: "Reopen the last closed session", defaults: ["Ctrl+Shift+T", "Alt+Shift+T"] },
  { id: "review.answer", group: "Review", label: "Answer the card", defaults: ["Shift+ArrowRight"] },
  { id: "review.approve", group: "Review", label: "Approve it", defaults: ["Shift+ArrowDown"] },
  { id: "review.later", group: "Review", label: "Later", defaults: ["Shift+ArrowLeft"] },
  { id: "review.read", group: "Review", label: "Read it whole", defaults: ["Shift+ArrowUp"] },
  { id: "review.undo", group: "Review", label: "Undo", defaults: ["U"] },
];

export const GROUPS = [...new Set(ACTIONS.map((a) => a.group))];

/** Keys a field, a dialog or the arrow navigation owns. They are listed with
 *  the rest but do not change. `app` marks one only the installed app has. */
export const FIXED: readonly { group: string; keys: string[]; label: string; app?: boolean }[] = [
  { group: "Anywhere", keys: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"], label: "Move through the sidebar, the list and the open pane" },
  { group: "Anywhere", keys: ["F6"], label: "Next pane, from a field or the terminal too" },
  { group: "Sessions", keys: ["Shift+Tab"], label: "Previous tab, in the terminal" },
  { group: "Sessions", keys: ["Escape"], label: "Stop the running turn (outside a field)" },
  { group: "Composer", keys: ["Enter"], label: "Send" },
  { group: "Composer", keys: ["Shift+Enter"], label: "New line" },
  { group: "Composer", keys: ["ArrowUp", "ArrowDown"], label: "In an empty box: what you said before" },
  { group: "Composer", keys: ["/"], label: "Skills" },
  { group: "Composer", keys: ["Escape"], label: "Stop a running turn; at rest, leave the box" },
  { group: "New session", keys: ["Alt+1 … Alt+6"], label: "Pick the agent" },
  { group: "New session", keys: ["Ctrl+Enter"], label: "Start" },
];

/** Keys nothing can be bound to: they move focus, send, or cancel. */
const RESERVED = new Set(["Tab", "Shift+Tab", "Enter", "Shift+Enter", "Escape", "Space", "F6", "Shift+F6", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** Keys a browser tab keeps for itself, so only the installed app gets them. */
const BROWSER_KEYS = new Set(
  ["T", "N", "W", "Q", "Tab", "Shift+T", "Shift+N", "Shift+W", "Shift+Q", "Shift+Tab"].flatMap((k) => [`Ctrl+${k}`, `Meta+${k}`]),
);

// ------------------------------------------------------------ key names

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MODIFIER_KEYS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta", "OS", "CapsLock", "Fn", "FnLock", "Hyper", "Super", "Dead", "Process", "Unidentified"]);

/** The key's name: a letter or digit as on the keycap, another character as
 *  typed, else the browser's name for it (Tab, ArrowUp, F6). With Alt (where
 *  macOS types another character: Alt+J is ∆) or on a layout without Latin
 *  letters, a letter or digit is read from where the key is. */
function keyName(e: KeyboardEvent): string | null {
  const k = e.key;
  if (!k || MODIFIER_KEYS.has(k)) return null;
  const place = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^Digit(\d)$/.exec(e.code)?.[1];
  if (place && (e.altKey || !/^[\x21-\x7e]$/.test(k))) return place;
  if (k === " ") return "Space";
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/** A character Shift makes (`?`, `!`) carries Shift in itself. */
function isSymbol(key: string): boolean {
  return key.length === 1 && !/[A-Z0-9]/.test(key);
}

/** The key an event is, as bindings write it; null for a lone modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  const key = keyName(e);
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && !isSymbol(key) && "Shift", e.metaKey && "Meta"];
  return [...mods.filter(Boolean), key].join("+");
}

const SHOWN: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Meta: MAC ? "Cmd" : "Meta", Alt: MAC ? "Option" : "Alt" };

/** A key as the overlay and Settings show it: `Ctrl+Shift+Tab`, `Shift+→`. */
export function showCombo(combo: string): string {
  if (combo.includes(" … ")) return combo.split(" … ").map(showCombo).join(" … ");
  return combo.split("+").map((p) => SHOWN[p] ?? p).join("+");
}

/** With Ctrl, Alt or Meta: works from a field and the terminal too. */
export function isChord(combo: string): boolean {
  return /(^|\+)(Ctrl|Alt|Meta)\+/.test(combo);
}

/** Only the installed app gets this key: a browser tab keeps it. */
export function isAppOnly(combo: string): boolean {
  return BROWSER_KEYS.has(combo);
}

/** Why a key cannot be bound, or null when it can. */
export function refusal(combo: string): string | null {
  return RESERVED.has(combo) ? `${showCombo(combo)} moves around the board, sends or cancels, so it stays as it is.` : null;
}

// ----------------------------------------------------------- storage

const KEY = "agentbox.keybinds";
type Overrides = Partial<Record<ActionId, string[]>>;

function read(): Overrides {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object") return {};
    const out: Overrides = {};
    for (const a of ACTIONS) {
      const keys = (v as Record<string, unknown>)[a.id];
      if (Array.isArray(keys)) out[a.id] = [...new Set(keys.filter((k): k is string => typeof k === "string" && !RESERVED.has(k)))];
    }
    return out;
  } catch {
    return {};
  }
}

let overrides = read();
const listeners = new Set<() => void>();
/** While Settings records a key, no shortcut runs. */
let recording = false;

function emit() {
  for (const fn of listeners) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    overrides = read();
    emit();
  });
}

function write(next: Overrides) {
  overrides = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode: this tab still remembers */
  }
  emit();
}

/** An action's keys now: yours, else its defaults. */
export function keysOf(id: ActionId, from: Overrides = overrides): readonly string[] {
  return from[id] ?? ACTIONS.find((a) => a.id === id)!.defaults;
}

export function isDefault(id: ActionId): boolean {
  return overrides[id] === undefined;
}

export function setKeys(id: ActionId, keys: readonly string[]): void {
  const defaults = ACTIONS.find((a) => a.id === id)!.defaults;
  const next = { ...overrides };
  if (keys.length === defaults.length && keys.every((k, i) => k === defaults[i])) delete next[id];
  else next[id] = [...keys];
  write(next);
}

export function resetKeys(id?: ActionId): void {
  if (!id) return write({});
  const next = { ...overrides };
  delete next[id];
  write(next);
}

export function setRecording(on: boolean): void {
  recording = on;
}

/** The overrides, and a render again when they change. */
export function useKeybindings(): Overrides {
  return useSyncExternalStore((fn) => (listeners.add(fn), () => listeners.delete(fn)), () => overrides);
}

/** Each key bound to more than one action, and those actions. */
export function conflicts(from: Overrides = overrides): Map<string, ActionId[]> {
  const by = new Map<string, ActionId[]>();
  for (const a of ACTIONS) for (const k of keysOf(a.id, from)) by.set(k, [...(by.get(k) ?? []), a.id]);
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

// ----------------------------------------------------------- handlers

/** What a handler says: false when the key was not for it here, so it goes on. */
export type Handler = (e: KeyboardEvent) => boolean | void;

/** A field or the terminal, where a key without Ctrl, Alt or Meta is typed. */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t?.closest) return false;
  if (t.closest(".xterm")) return true; // the terminal owns every key it gets
  return ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable;
}

/** The handlers of each mounted useKeybinds, latest render's. */
const mounted = new Set<{ current: Partial<Record<ActionId, Handler>> }>();

/** One dispatcher for the whole board, so that of two actions on one key
 *  the first in ACTIONS wins wherever their handlers live. A chord is taken
 *  in the capture phase, before the terminal and fields; a plain key
 *  bubbles, so a widget with its own use for it goes first. */
function dispatch(capture: boolean) {
  return (e: KeyboardEvent) => {
    if (recording || e.defaultPrevented || e.isComposing) return;
    const combo = comboOf(e);
    if (!combo) return;
    const chord = e.ctrlKey || e.altKey || e.metaKey;
    if (chord !== capture || (!chord && isTyping(e))) return;
    const appOnly = isAppOnly(combo);
    if (appOnly && !isInstalledApp()) return;
    const handlers = ACTIONS.filter((a) => keysOf(a.id).includes(combo)).flatMap((a) => [...mounted].map((m) => m.current[a.id]).filter((h): h is Handler => !!h));
    if (!handlers.length) return;
    if (document.querySelector(".modal-backdrop, .fv-backdrop")) {
      // The app's window would act on it itself (Ctrl+W closes it).
      if (appOnly) e.preventDefault();
      return;
    }
    for (const handler of handlers) {
      if (handler(e) === false) continue;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
  };
}

let listening = false;

/** Runs these handlers when a key of their action is pressed. The handlers
 *  may change every render. */
export function useKeybinds(handlers: Partial<Record<ActionId, Handler>>): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!listening) {
      listening = true;
      addEventListener("keydown", dispatch(true), true);
      addEventListener("keydown", dispatch(false));
    }
    mounted.add(ref);
    return () => void mounted.delete(ref);
  }, []);
}
