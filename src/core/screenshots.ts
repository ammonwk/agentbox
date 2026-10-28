/** Recent desktop screenshots, for the paperclip's picker.
 *
 * The folders are read only when someone opens the picker. The browser gets
 * an opaque id for each of the newest three, never a path, and an id serves
 * only the file it was listed for, unchanged, for ten minutes.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { userHome } from "./paths";
import { shownImage } from "./images";
import { MAX_UPLOAD_BYTES } from "./uploads";

type Directory = { path: string; screenshotsOnly: boolean };
export type Screenshot = { id: string; name: string; at: number };

const listed = new Map<string, { path: string; at: number; size: number; expires: number }>();

/** macOS: the folder `defaults` names (Desktop by default). Elsewhere:
 *  Pictures/Screenshots, and screenshot-named files on the Desktop. */
export function screenshotDirectories(): Directory[] {
  const home = userHome();
  if (process.platform === "darwin") {
    let path = join(home, "Desktop");
    try {
      const configured = execFileSync("defaults", ["read", "com.apple.screencapture", "location"], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (configured) path = configured.startsWith("~/") ? join(home, configured.slice(2)) : configured;
    } catch {
      // Not set: macOS saves to the Desktop.
    }
    return [{ path, screenshotsOnly: true }];
  }
  return [join(home, "Pictures", "Screenshots"), join(home, "Pictures", "screenshots"), join(home, "Desktop")].map((path) => ({
    path,
    screenshotsOnly: basename(path) === "Desktop",
  }));
}

export function recentScreenshots(directories = screenshotDirectories()): Screenshot[] {
  const now = Date.now();
  for (const [id, item] of listed) if (item.expires < now) listed.delete(id);
  const candidates: { path: string; at: number; size: number }[] = [];
  for (const directory of directories) {
    try {
      const root = realpathSync(directory.path);
      for (const name of readdirSync(root).sort().reverse().slice(0, 5000)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) continue;
        if (directory.screenshotsOnly && !/^(screenshot|screen shot|screen capture)[ _-]/i.test(name)) continue;
        const path = join(root, name);
        const stat = lstatSync(path);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_UPLOAD_BYTES) candidates.push({ path, at: stat.mtimeMs, size: stat.size });
      }
    } catch {
      // A missing or unreadable folder is an empty picker.
    }
  }
  const result: Screenshot[] = [];
  for (const item of candidates.sort((a, b) => b.at - a.at)) {
    if (!isImage(item.path)) continue;
    const id = createHash("sha256").update(`${item.path}:${item.at}:${item.size}`).digest("hex");
    if (result.some((s) => s.id === id)) continue;
    listed.set(id, { ...item, expires: now + 10 * 60_000 });
    result.push({ id, name: basename(item.path), at: item.at });
    if (result.length === 3) break;
  }
  while (listed.size > 30) listed.delete(listed.keys().next().value!);
  return result;
}

/** No client path is accepted, and a listed file cannot be swapped for another. */
export function screenshotImage(id: string) {
  const item = listed.get(id);
  if (!item || item.expires < Date.now()) throw new Error("Screenshot preview expired; reopen the picker");
  const stat = lstatSync(item.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs !== item.at || stat.size !== item.size)
    throw new Error("Screenshot changed; reopen the picker");
  return image(item.path);
}

// As a file URL: `shownImage` reads its argument as a link, where a `#` or
// `%` in a screenshot's name would mean something else.
const image = (path: string) => shownImage(pathToFileURL(path).href, null);

function isImage(path: string): boolean {
  try {
    image(path);
    return true;
  } catch {
    return false;
  }
}
