/** Local files an agent names, read for the board's viewer.
 *
 * A clicked path opens in the app rather than on this machine's desktop, so
 * it can be read from a phone as well. Any path is served, as the terminal
 * next to the timeline can already read anything; nothing is copied, written
 * or run here. The raw bytes go out sandboxed (`rawHeaders`): a page an agent
 * wrote runs in an origin of its own, never as the board.
 */

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";
import { userHome } from "./paths";
import { localFileLink } from "./filelinks";

export class FileError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Text past this is cut, with the viewer saying so: a phone renders a
 *  megabyte of lines, not a log of a hundred. */
export const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;

/** The file or directory `ref` names, as an agent wrote it: absolute, `~/…`,
 *  `file://…`, or relative, with any `:line` suffix dropped. A relative path
 *  is tried in each of `dirs` in turn, and is the first that holds it
 *  (`readDirs`). Symlinks are followed, so what is classified is what is read. */
export function resolveLocal(ref: string, dirs: readonly string[]): { path: string; suffix: string; stat: Stats } {
  const link = localFileLink(ref.trim(), true);
  if (!link) throw new FileError(400, "not a local file path");
  const path = home(link.path);
  if (!isAbsolute(path) && dirs.length === 0) throw new FileError(400, "a relative path needs the session's directory");
  const tries = isAbsolute(path) ? [path] : dirs.map((d) => resolve(d, path));
  for (const p of tries) {
    let real: string, stat: Stats;
    try {
      real = realpathSync(p);
      stat = statSync(real);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isDirectory()) throw new FileError(400, `not a regular file or directory: ${real}`);
    return { path: real, suffix: link.suffix, stat };
  }
  throw new FileError(404, `no such file: ${tries[0]}`);
}

/** Where a session's relative path is read: where the agent was when it
 *  wrote it (`dirs`, the board's reading of its last `cd`s, latest first),
 *  then the session's own directory, as its shell may be back there. */
export function readDirs(cwd: string | null, dirs: readonly string[] = []): string[] {
  const out = dirs.map((d) => (cwd ? resolve(cwd, home(d)) : home(d)));
  if (cwd) out.push(cwd);
  return out.filter((d) => isAbsolute(d));
}

const home = (p: string) => (p === "~" || p.startsWith("~/") ? userHome() + p.slice(1) : p);

export type FileKind = "markdown" | "text" | "pdf" | "html" | "image" | "binary" | "directory";

export interface FileView {
  path: string;
  name: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  /** Markdown and text: the first `MAX_TEXT_BYTES`, cut at a line. */
  text?: string;
  truncated?: boolean;
  entries?: { name: string; dir: boolean; size: number }[];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function kindByName(path: string): FileKind | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".md" || ext === ".markdown" || ext === ".mdx") return "markdown";
  if (ext === ".pdf") return "pdf";
  if (ext === ".html" || ext === ".htm") return "html";
  if (/^\.(?:png|jpe?g|gif|webp|svg)$/.test(ext)) return "image";
  return null;
}

/** Text is UTF-8 with no NUL in its first 8 KB; a multi-byte character cut by
 *  the sample's end does not count against it. */
function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)));
    return true;
  } catch {
    return false;
  }
}

function readHead(path: string, bytes: number): Uint8Array {
  const buf = new Uint8Array(bytes);
  const fd = openSync(path, "r");
  try {
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

export function viewFile(ref: string, dirs: readonly string[]): FileView {
  const { path, stat } = resolveLocal(ref, dirs);
  const base = { path, name: basename(path) || path, size: stat.size, mtimeMs: stat.mtimeMs };
  if (stat.isDirectory()) {
    let names: Dirent[];
    try {
      names = readdirSync(path, { withFileTypes: true });
    } catch (e) {
      throw new FileError(403, `cannot list ${path}: ${(e as Error).message}`);
    }
    const entries = names.slice(0, MAX_ENTRIES).map((d) => {
      let dir = d.isDirectory();
      let size = 0;
      try {
        const st = statSync(`${path}/${d.name}`);
        dir = st.isDirectory();
        size = st.size;
      } catch {
        /* a dangling link: listed as it is */
      }
      return { name: d.name, dir, size };
    });
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { ...base, kind: "directory", entries, truncated: names.length > MAX_ENTRIES };
  }
  const kind = kindByName(path);
  if (kind && kind !== "markdown") return { ...base, kind };
  const head = readHead(path, Math.min(stat.size, MAX_TEXT_BYTES));
  if (!looksLikeText(head.subarray(0, 8192))) return { ...base, kind: "binary" };
  let text = new TextDecoder().decode(head);
  const truncated = stat.size > head.length;
  if (truncated) text = text.slice(0, text.lastIndexOf("\n") + 1 || text.length);
  return { ...base, kind: kind ?? "text", text, truncated };
}

/** The bytes of a file the viewer shows in a frame: a PDF, a page and what
 *  it links beside it, an image, a download. */
export function rawFile(ref: string): { path: string; mime: string; size: number; mtimeMs: number } {
  const { path, stat } = resolveLocal(ref, []);
  if (!stat.isFile()) throw new FileError(400, `not a file: ${path}`);
  return { path, mime: MIME[extname(path).toLowerCase()] ?? (looksLikeText(readHead(path, 8192)) ? "text/plain; charset=utf-8" : "application/octet-stream"), size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Everything but a PDF is sandboxed into an opaque origin: its scripts run,
 *  but cannot read the board or pass its CSRF checks (an Origin of `null`).
 *  Chrome refuses to draw a PDF in a sandbox, and a PDF carries no script
 *  the board's origin would run. */
export function rawHeaders(mime: string, name: string, download: boolean): Record<string, string> {
  const h: Record<string, string> = { "content-type": mime, "x-content-type-options": "nosniff", "cache-control": "private, no-cache" };
  if (mime !== "application/pdf") h["content-security-policy"] = "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads";
  if (download) h["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  return h;
}
