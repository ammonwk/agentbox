/**
 * The board installs as a PWA, and Chrome writes its .desktop entry with
 * `StartupWMClass=crx_<id>`. On native Wayland — Chrome's default now — the
 * window it opens for that entry carries the app id `chrome-<id>-<profile>`,
 * the same string Chrome puts in `Icon=`. GNOME matches a window to its
 * launcher by that class, finds nothing, and groups the board with Chrome.
 * The right value is already in the file, so patch it in place; Chrome
 * rewrites the entry whenever the PWA is installed again, so this keeps
 * watching rather than fixes once. Only entries naming agentbox are touched,
 * and only where the class is the broken `crx_` one. Under X11 the `crx_`
 * class is correct, so nothing is patched without a Wayland session.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./paths";

const POLL_MS = 60_000;

function onWayland(): boolean {
  if (process.env.WAYLAND_DISPLAY) return true;
  try {
    const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`;
    return readdirSync(runtime).some((n) => n.startsWith("wayland-"));
  } catch {
    return false;
  }
}

/** The agentbox PWA entries fixed by this call; empty when none needed it. */
export function fixPwaDesktop(): string[] {
  if (!onWayland()) return [];
  const dir = join(process.env.XDG_DATA_HOME || join(userHome(), ".local", "share"), "applications");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const fixed: string[] = [];
  for (const name of names) {
    if (!name.startsWith("chrome-") || !name.endsWith(".desktop")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    if (!/^Name=agentbox$/m.test(text) || !text.includes("--app-id=")) continue;
    const icon = /^Icon=(\S+)$/m.exec(text)?.[1];
    const wmClass = /^StartupWMClass=(\S*)$/m.exec(text)?.[1];
    if (!icon || icon.includes("/") || !wmClass?.startsWith("crx_") || wmClass === icon) continue;
    try {
      writeFileSync(join(dir, name), text.replace(/^StartupWMClass=.*$/m, `StartupWMClass=${icon}`));
      fixed.push(name);
    } catch {
      // Unwritable: the entry stays grouped with Chrome until the next pass.
    }
  }
  return fixed;
}

/** Fix at boot and after every PWA install; each fix says so in the log. */
export function watchPwaDesktop(): void {
  const fix = () => {
    for (const name of fixPwaDesktop()) console.log(`pwa: patched ${name} — StartupWMClass now Chrome's Wayland app id`);
  };
  fix();
  setInterval(fix, POLL_MS).unref?.();
}
