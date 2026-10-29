/** A local file opened on this machine's desktop, from a browser on it: an
 * HTML page clicked in prose, or the viewer's own buttons. HTML and PDF open
 * in the browser; other files are revealed, never executed or edited. */
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { BROWSER_FILE } from "./filelinks";
import { FileError, resolveLocal } from "./files";

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

/** Whether a web link opened from this machine can go in behind the window
 * in front: only chromectl can say which window, and that it isn't active. */
export function backgroundTabs(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !!Bun.which("chromectl");
}

export async function openUrlBehind(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) throw new FileError(400, "not a web link");
  if (!backgroundTabs()) throw new FileError(503, "background tabs need chromectl on this machine's desktop");
  try {
    await launch(["chromectl", "open", "-w", "current", url]);
  } catch (e) {
    throw new FileError(502, `could not open the browser: ${(e as Error).message}`);
  }
}

export async function openLocalFile(ref: string, dirs: readonly string[], background = false): Promise<{ path: string; action: "open" | "reveal" }> {
  const { path, suffix, stat } = resolveLocal(ref, dirs);
  const directory = stat.isDirectory();
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) throw new FileError(503, "no desktop session is available on this machine");
  const uri = pathToFileURL(path).href;
  // Classify the resolved file, so a source file named by an .html symlink
  // is still only revealed, and an HTML file reached by a symlink opens.
  const browser = !directory && BROWSER_FILE.test(path);
  try {
    if (browser) {
      await openInBrowser(uri + suffix, background);
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
    throw new FileError(502, `could not ${browser ? "open the browser" : "open the file explorer"}: ${(e as Error).message}`);
  }
  return { path, action: browser ? "open" : "reveal" };
}
