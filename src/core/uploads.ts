/** Images pasted into a prompt.
 *
 * Every agent CLI can read an image file from disk (claude's Read, codex's
 * view_image, omp's read), and none takes image bytes on its command line or
 * through a tmux paste. So a pasted image is written here and the prompt
 * names its path. Kept for 30 days: long enough for a session that refers to
 * one to be resumed and look at it again.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { agentboxHome } from "./paths";

const KEEP_MS = 30 * 86_400_000;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const MIME = Object.fromEntries(Object.entries(TYPES).map(([m, e]) => [e, m]));
const NAME = /^\d{8}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

export const uploadsRoot = (): string => join(agentboxHome(), "uploads");

export function saveUpload(bytes: Uint8Array, mime: string): { name: string; path: string } {
  const ext = TYPES[mime.split(";")[0]!.trim().toLowerCase()];
  if (!ext) throw new Error(`not an image agents can read: ${mime || "no content type"} (png, jpeg, gif or webp)`);
  if (bytes.byteLength === 0) throw new Error("the image is empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error(`the image is over ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const dir = uploadsRoot();
  mkdirSync(dir, { recursive: true });
  prune(dir);
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const name = `${day}-${randomBytes(6).toString("hex")}.${ext}`;
  const path = join(dir, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { name, path };
}

/** The file for a name `saveUpload` returned, or null. Names are checked
 *  against the shape it makes, so nothing outside the directory is reachable. */
export function uploadFile(name: string): { path: string; mime: string } | null {
  if (!NAME.test(name)) return null;
  const path = join(uploadsRoot(), name);
  return existsSync(path) ? { path, mime: MIME[name.split(".").pop()!]! } : null;
}

let lastPrune = 0;
function prune(dir: string): void {
  const now = Date.now();
  if (now - lastPrune < 3_600_000) return;
  lastPrune = now;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    try {
      if (NAME.test(n) && now - statSync(p).mtimeMs > KEEP_MS) rmSync(p);
    } catch {
      /* gone */
    }
  }
}
