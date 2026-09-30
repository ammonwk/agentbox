/** Images an agent shows you.
 *
 * An agent shows an image by naming its file in Markdown — `![what it
 * is](/tmp/shot.png)` — and the timeline asks for it here. The transcript
 * keeps only the path, so an image overwritten or deleted since shows as it is
 * now, or not at all; nothing is copied. Any path is served, as the terminal
 * next to the timeline can already read anything, but only files whose bytes
 * are a raster image: never a page or a script, and never an SVG, which can
 * carry one.
 */

import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { userHome } from "./paths";

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** The first bytes of each type an agent can show. */
const MAGIC: { mime: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: "image/png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => ascii(b, 0, 4) === "GIF8" },
  { mime: "image/webp", test: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
];

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export interface ShownImage {
  path: string;
  mime: string;
  size: number;
  mtimeMs: number;
}

/** The image `ref` names, read as the agent wrote it: absolute, `~/…`,
 *  `file://…`, or relative to the session's `cwd`. Throws with the reason. */
export function shownImage(ref: string, cwd: string | null): ShownImage {
  let p = ref.trim();
  if (p.startsWith("file://")) p = p.slice("file://".length);
  if (p === "~" || p.startsWith("~/")) p = userHome() + p.slice(1);
  if (!isAbsolute(p)) {
    if (!cwd) throw new Error("a relative path needs the session's directory");
    p = resolve(cwd, p);
  }
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new Error(`no such file: ${p}`);
  }
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`not a file: ${p}`);
  if (st.size > MAX_IMAGE_BYTES) throw new Error(`over ${MAX_IMAGE_BYTES / 1024 / 1024} MB: ${p}`);
  const head = new Uint8Array(12);
  const fd = openSync(real, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const mime = MAGIC.find((m) => m.test(head))?.mime;
  if (!mime) throw new Error(`not a png, jpeg, gif or webp image: ${p}`);
  return { path: real, mime, size: st.size, mtimeMs: st.mtimeMs };
}
