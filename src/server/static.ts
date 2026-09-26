/** Serving the built web UI, and saying so clearly when it isn't built. */

import { existsSync, statSync } from "node:fs";
import { resolve, sep, extname } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** A Vite output name: `index-D8DOkHv4.js`, i.e. content-hashed. */
const HASHED = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/**
 * How long a file may be cached.
 *
 * `index.html` served with no `Cache-Control` at all is the bug this exists to
 * prevent: the browser applies heuristic caching, keeps the old document, and
 * keeps asking for the previous bundle — which is still on disk, so nothing
 * 404s and nothing looks wrong. The app silently runs stale code after every
 * `bun run web:build`, which is part of the everyday loop here.
 *
 * Content-hashed assets are the opposite case: their name changes whenever
 * their bytes do, so they can be cached forever and never go stale.
 */
function cacheControlFor(root: string, filePath: string): string {
  const assets = resolve(root, "assets") + sep;
  if (filePath.startsWith(assets) && HASHED.test(filePath)) {
    return "public, max-age=31536000, immutable";
  }
  // `no-cache` is "revalidate before use", not "do not store" — with
  // Last-Modified an unchanged file still costs one 304, not a re-download.
  return "no-cache";
}

/**
 * Resolve a URL path to an absolute path inside `root`, or null if it escapes.
 *
 * The old guard was `join(root, rel).startsWith(root)` computed after the
 * join, which lets `/dist-secrets/x` through when root is `…/dist`, and never
 * decoded the URL — so `%2e%2e%2f` walked straight out. Decode first, resolve
 * to an absolute path, then require a real directory boundary.
 */
export function safeStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding is never a file we have
  }
  if (decoded.includes("\0")) return null;

  const rootAbs = resolve(root);
  const candidate = resolve(rootAbs, "." + (decoded.startsWith("/") ? decoded : "/" + decoded));
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) return null;
  return candidate;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    // A path we cannot stat is a path we cannot serve; the 404 below says so.
    return false;
  }
}

export type StaticResult =
  | { kind: "file"; path: string }
  | { kind: "notBuilt" }
  | { kind: "notFound" };

/**
 * Pick the file to serve for a URL path.
 *
 * Unknown paths fall back to `index.html` because the UI is a single-page app
 * — but only when they don't look like an asset, so a missing bundle 404s
 * instead of silently returning HTML that the browser then fails to parse.
 */
export function resolveStatic(root: string, urlPath: string): StaticResult {
  const indexHtml = resolve(root, "index.html");
  if (!isFile(indexHtml)) return { kind: "notBuilt" };

  const candidate = safeStaticPath(root, urlPath === "/" ? "/index.html" : urlPath);
  if (candidate === null) return { kind: "notFound" };
  if (isFile(candidate)) return { kind: "file", path: candidate };
  if (extname(candidate) !== "") return { kind: "notFound" };
  return { kind: "file", path: indexHtml };
}

/**
 * Serve one file with the headers that make a rebuild visible.
 *
 * `Last-Modified` is what turns `no-cache` from "download it again every load"
 * into "ask, and usually get a 304".
 */
export function fileResponse(root: string, filePath: string, req: Request): Response {
  const mtimeMs = statSync(filePath).mtimeMs;
  const headers: Record<string, string> = {
    "content-type": contentTypeFor(filePath),
    "cache-control": cacheControlFor(root, filePath),
    "last-modified": new Date(mtimeMs).toUTCString(),
  };

  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifModifiedSince !== null) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates carry whole seconds, so the stored mtime must be floored to
    // the same resolution or every request looks newer by its milliseconds.
    if (!Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since) {
      return new Response(null, { status: 304, headers });
    }
  }
  return new Response(Bun.file(filePath), { headers });
}

/** A real page, not a 200 with plain text the browser renders as if it were the app. */
export function notBuiltPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>agentbox — UI not built</title>
<style>
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh;
         background: #0f1115; color: #e6e8ee; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  code { background: #1b1f27; padding: .15em .4em; border-radius: 4px; }
  p { color: #a9b0c0; }
</style>
</head>
<body><main>
  <h1>The agentbox web UI has not been built</h1>
  <p>The server is running and the API is live — only the static bundle is missing.</p>
  <p>Build it with <code>bun run web:build</code>, or run <code>bun run web:dev</code>
     for the Vite dev server, then reload this page.</p>
</main></body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
