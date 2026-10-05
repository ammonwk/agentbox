/** A clicked local link opens on this machine's desktop. HTML and PDF open
 * in the browser; other files are revealed, never executed or edited.
 * Nothing is served on the board's origin or copied out of its directory. */
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { userHome } from "./paths";
import { BROWSER_FILE, localFileLink } from "./filelinks";

export class DesktopError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function launch(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", timeout: 10_000 });
  const [code, detail] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(detail.trim().slice(0, 400) || `${argv[0]} exited ${code}`);
}

async function output(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}`);
  return out.trim();
}

/** A tab in the browser window the user last had, brought forward unless
 * `background`, so several can be opened from the app in a row. Chrome
 * given a URL by another program opens a new window whenever the window it
 * used last can't hold tabs, which is always the case for a click in the
 * installed app; chromectl's extension names the window instead. Without
 * it the default browser gets the URL, so a PDF isn't left to a viewer. */
async function openInBrowser(url: string, background: boolean): Promise<void> {
  if (Bun.which("chromectl")) {
    try {
      return await launch(["chromectl", "open", ...(background ? ["-w", "current"] : ["--focus"]), url]);
    } catch {
      // Extension not loaded: fall through to launching the browser.
    }
  }
  try {
    const browser = await output(["xdg-settings", "get", "default-web-browser"]);
    return await launch(["gtk-launch", browser, url]);
  } catch {
    await launch(["xdg-open", url]);
  }
}

export async function openLocalFile(ref: string, cwd: string | null, background = false): Promise<{ path: string; action: "open" | "reveal" }> {
  const link = localFileLink(ref, true);
  if (!link) throw new DesktopError(400, "not a local file path");
  let path = link.path;
  if (path.startsWith("~/")) path = userHome() + path.slice(1);
  if (!isAbsolute(path)) {
    if (!cwd) throw new DesktopError(400, "a relative path needs the session's directory");
    path = resolve(cwd, path);
  }
  let directory: boolean;
  try {
    path = realpathSync(path);
    const stat = statSync(path);
    directory = stat.isDirectory();
    if (!directory && !stat.isFile()) throw new DesktopError(400, "not a regular file or directory");
  } catch (e) {
    if (e instanceof DesktopError) throw e;
    throw new DesktopError(404, `no such file: ${path}`);
  }
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new DesktopError(503, "no desktop session is available on this machine");
  const uri = pathToFileURL(path).href;
  // Classify the resolved file, so a source file named by an .html symlink
  // is still only revealed, and an HTML file reached by a symlink opens.
  const browser = !directory && BROWSER_FILE.test(path);
  try {
    if (browser) {
      await openInBrowser(uri + link.suffix, background);
    } else if (directory) {
      await launch(["xdg-open", uri]);
    } else {
      try {
        await launch(["gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", JSON.stringify([uri]), ""]);
      } catch {
        // Desktops without ShowItems still open the containing folder.
        await launch(["xdg-open", pathToFileURL(dirname(path)).href]);
      }
    }
  } catch (e) {
    throw new DesktopError(502, `could not ${browser ? "open the browser" : "open the file explorer"}: ${(e as Error).message}`);
  }
  return { path, action: browser ? "open" : "reveal" };
}
