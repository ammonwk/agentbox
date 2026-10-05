/** A clicked local link opens on this machine's desktop. HTML uses its
 * browser association; other files are revealed, never executed or edited.
 * Nothing is served on the board's origin or copied out of its directory. */
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { userHome } from "./paths";
import { localFileLink } from "./filelinks";

export class DesktopError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function launch(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", timeout: 10_000 });
  const [code, detail] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(detail.trim().slice(0, 400) || `${argv[0]} exited ${code}`);
}

export async function openLocalFile(ref: string, cwd: string | null): Promise<{ path: string; action: "open" | "reveal" }> {
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
  const html = !directory && /\.html?$/i.test(path);
  try {
    if (html || directory) {
      await launch(["xdg-open", uri + (html ? link.suffix : "")]);
    } else {
      try {
        await launch(["gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1", "--method", "org.freedesktop.FileManager1.ShowItems", JSON.stringify([uri]), ""]);
      } catch {
        // Desktops without ShowItems still open the containing folder.
        await launch(["xdg-open", pathToFileURL(dirname(path)).href]);
      }
    }
  } catch (e) {
    throw new DesktopError(502, `could not ${html ? "open the browser" : "open the file explorer"}: ${(e as Error).message}`);
  }
  return { path, action: html ? "open" : "reveal" };
}
