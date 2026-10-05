/** Pages and documents a browser shows itself: these open in a tab, keeping
 * a query or fragment such as a PDF's `#page=3`. */
export const BROWSER_FILE = /\.(?:html?|pdf)$/i;

/** Local links in agent prose. Shared by the renderer and desktop opener;
 * no filesystem or browser globals here. Line references name the file too. */
export function localFileLink(ref: string, explicit = false): { path: string; browser: boolean; suffix: string } | null {
  let path = ref;
  let suffix = "";
  if (path.startsWith("file://")) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = url.pathname;
      suffix = url.search + url.hash;
    } catch {
      return null;
    }
  } else {
    const end = path.search(/[?#]/);
    if (end !== -1) {
      suffix = path.slice(end);
      path = path.slice(0, end);
    }
    path = path.replace(/(?::\d+(?:-\d+)?){1,2}$/, "");
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(path)) return null;
    if (!explicit && !/^(?:\/|~\/|\.{1,2}\/)/.test(path) && !/\.[a-z][a-z\d]*(?::\d+(?:-\d+)?){0,2}$/i.test(path)) return null;
  }
  path = path.replace(/(?::\d+(?:-\d+)?){1,2}$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path || path.includes("\0")) return null;
  const browser = BROWSER_FILE.test(path);
  return { path, browser, suffix: browser ? suffix : "" };
}
