/** The accent colour, chosen in Settings. Orange is the default.
 *
 *  The choice is kept in this browser only: the server's settings keep only
 *  the keys they know. Each colour has a value for each theme and the text
 *  colour that reads on it. These go on <html> as `--pick-*` properties with
 *  `data-accent`, and styles.css maps them onto `--accent`. index.html does
 *  the same from storage before first paint, so a reload does not flash
 *  orange. Another tab follows a change through the `storage` event. */

import { useSyncExternalStore } from "react";

export const ACCENT_KEY = "agentbox.accent";

export interface AccentPreset {
  id: string;
  label: string;
  /** On the dark theme's panels. */
  dark: string;
  /** On the light theme's panels. */
  light: string;
}

/** The first is the default, the stylesheet's own orange. Each value has a
 *  contrast of 4.5:1 or more on its theme's panels. */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "orange", label: "Orange", dark: "#f97316", light: "#c2410c" },
  { id: "amber", label: "Amber", dark: "#f59e0b", light: "#b45309" },
  { id: "rose", label: "Rose", dark: "#fb7185", light: "#be123c" },
  { id: "pink", label: "Pink", dark: "#f472b6", light: "#be185d" },
  { id: "violet", label: "Violet", dark: "#a78bfa", light: "#6d28d9" },
  { id: "blue", label: "Blue", dark: "#60a5fa", light: "#1d4ed8" },
  { id: "teal", label: "Teal", dark: "#2dd4bf", light: "#0f766e" },
  { id: "sage", label: "Sage", dark: "#6fae96", light: "#3d6b5b" },
];

const DEFAULT = ACCENT_PRESETS[0]!.id;

/** What storage holds: the pick (a preset id or a `#rrggbb`) and the values it gives. */
interface Stored {
  pick: string;
  dark: string;
  light: string;
  darkOn: string;
  lightOn: string;
}

// ------------------------------------------------------------- colour math

type Rgb = [number, number, number];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parse(hex: string): Rgb {
  let h = hex.slice(1);
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

function toHex(c: Rgb): string {
  return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: string, b: string, t: number): string {
  const x = parse(a);
  const y = parse(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as Rgb);
}

function luminance(hex: string): number {
  const [r, g, b] = parse(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const NEAR_BLACK = "#111113";

/** The text colour on a fill of `hex`: white or near-black, whichever reads better. */
function onColour(hex: string): string {
  return contrast(hex, "#ffffff") >= contrast(hex, NEAR_BLACK) ? "#ffffff" : NEAR_BLACK;
}

/** The darkest panel of the light theme and the lightest of the dark one. */
const LIGHT_PANEL = "#f6f6f7";
const DARK_PANEL = "#1c1c20";

/** `hex` moved toward `toward` until it has 4.5:1 on `panel`. */
function fit(hex: string, toward: string, panel: string): string {
  for (let t = 0; t <= 1; t += 0.05) {
    const c = mix(hex, toward, t);
    if (contrast(c, panel) >= 4.5) return c;
  }
  return toward;
}

/** The values for a pick, or null for the default (or one that cannot be read). */
function resolve(pick: string): Stored | null {
  if (pick === DEFAULT) return null;
  const preset = ACCENT_PRESETS.find((p) => p.id === pick);
  if (!preset && !HEX.test(pick)) return null;
  const dark = preset ? preset.dark : fit(pick, "#ffffff", DARK_PANEL);
  const light = preset ? preset.light : fit(pick, "#000000", LIGHT_PANEL);
  return { pick, dark, light, darkOn: onColour(dark), lightOn: onColour(light) };
}

// ------------------------------------------------------------------- state

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(ACCENT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Stored>;
    // Resolve again from the pick: a preset's values can change between builds.
    return typeof s.pick === "string" ? resolve(s.pick) : null;
  } catch {
    return null;
  }
}

let current: Stored | null = typeof window === "undefined" ? null : read();
const listeners = new Set<() => void>();

const PROPS = ["dark", "light", "darkOn", "lightOn"] as const;
const CSS_PROP: Record<(typeof PROPS)[number], string> = {
  dark: "--pick-dark",
  light: "--pick-light",
  darkOn: "--pick-dark-on",
  lightOn: "--pick-light-on",
};

/** The favicon as index.html draws it, with the default orange. */
let iconHref: string | null = null;

function apply(s: Stored | null): void {
  const root = document.documentElement;
  if (s) root.dataset.accent = s.pick;
  else delete root.dataset.accent;
  for (const p of PROPS) {
    if (s) root.style.setProperty(CSS_PROP[p], s[p]);
    else root.style.removeProperty(CSS_PROP[p]);
  }
  // The favicon is a data URI, which no stylesheet reaches: swap its colour in.
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (icon) {
    iconHref ??= icon.getAttribute("href");
    if (iconHref) icon.setAttribute("href", s ? iconHref.replace("%23f97316", encodeURIComponent(s.dark)) : iconHref);
  }
}

function set(next: Stored | null): void {
  current = next;
  apply(next);
  for (const fn of listeners) fn();
}

/** Applies the stored choice, and follows a change made in another tab. Once, at startup. */
export function startAccent(): void {
  apply(current);
  window.addEventListener("storage", (e) => {
    if (e.key === ACCENT_KEY || e.key === null) set(read());
  });
}

/** Choose a preset id or a `#rrggbb`. */
export function chooseAccent(pick: string): void {
  const next = resolve(pick);
  try {
    if (next) localStorage.setItem(ACCENT_KEY, JSON.stringify(next));
    else localStorage.removeItem(ACCENT_KEY);
  } catch {
    /* private mode: this tab keeps it until it closes */
  }
  set(next);
}

/** The current pick: a preset id or a `#rrggbb`. */
export function useAccent(): string {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current?.pick ?? DEFAULT,
    () => DEFAULT,
  );
}

/** The accent for the terminal, which is always dark. */
export function terminalAccent(): string {
  return current?.dark ?? ACCENT_PRESETS[0]!.dark;
}
