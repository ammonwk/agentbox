import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative } from "node:path";
import { repoCheckoutPath } from "./git";
import { startedAtOf } from "./providers/procs";
import { logDir, worktreeRoot } from "./paths";
import type { Repo } from "./types";

/**
 * A dev server for a session, started with it from New session's "Dev server"
 * toggle.
 *
 * A fresh worktree has no dependencies, and an install in each one is minutes
 * of CPU and a gigabyte of disk times every session. So the worktree borrows
 * the checkout's: every `node_modules` there is symlinked to the same place
 * in the worktree. A branch whose lockfile has moved past the checkout's runs
 * on the checkout's packages until somebody installs.
 *
 * The server runs in a process group of its own, so a server restart leaves it
 * up and closing the session stops all of it. What it is (pid, port, log) is a
 * small file per session; the URL is what it prints, or its port once that
 * answers.
 */

export interface DevServerInfo {
  pid: number;
  port: number;
  command: string;
  log: string;
  cwd: string;
  startedAt: number;
}

export interface DevServerStatus {
  state: "starting" | "ready" | "exited" | "none";
  url: string | null;
  command: string | null;
  log: string | null;
  /** The log's last lines, for a server that exited. */
  tail: string | null;
}

const devDir = () => join(logDir(), "dev");
const infoPath = (sessionId: string) => join(devDir(), `${sessionId}.json`);
export const devLog = (sessionId: string) => join(devDir(), `${sessionId}.log`);

/** How deep under the checkout to look for a workspace's `node_modules`. */
const LINK_DEPTH = 3;

/** Every `node_modules` in the checkout, relative to it, not ones inside another. */
export function depDirs(root: string, depth = LINK_DEPTH): string[] {
  const out: string[] = [];
  const walk = (dir: string, left: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.name === "node_modules") out.push(relative(root, p));
      else if (left > 0 && !e.name.startsWith(".")) walk(p, left - 1);
    }
  };
  walk(root, depth);
  return out.sort();
}

/**
 * Symlink the checkout's `node_modules` into the worktree. One the worktree
 * has already is left alone, and so is one whose package is not on this
 * branch. Returns what it did, a line each.
 */
export function linkDeps(source: string, worktree: string): string[] {
  const lines: string[] = [];
  const linked: string[] = [];
  for (const rel of depDirs(source)) {
    const to = join(worktree, rel);
    let present = false;
    try {
      lstatSync(to);
      present = true;
    } catch {
      /* not there */
    }
    if (present) lines.push(`not linked, already there: ${rel}`);
    else if (!existsSync(dirname(to))) lines.push(`not linked, not on this branch: ${rel}`);
    else {
      try {
        symlinkSync(join(source, rel), to, "dir");
        lines.push(`linked ${rel}`);
        linked.push(rel);
      } catch (e) {
        lines.push(`not linked, ${(e as Error).message}: ${rel}`);
      }
    }
  }
  if (linked.length) ignoreLinks(worktree, linked);
  return lines;
}

/** A `node_modules/` line in .gitignore matches only a directory, so a
 *  `git add -A` in the worktree would commit the link. The repo's exclude
 *  file takes each one, with no trailing slash. */
function ignoreLinks(worktree: string, rels: string[]): void {
  try {
    const p = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { stdout: "pipe", stderr: "ignore" });
    const file = p.stdout.toString().trim();
    if (p.exitCode !== 0 || !file) return;
    const have = existsSync(file) ? readFileSync(file, "utf8") : "";
    const add = rels.map((r) => `/${r}`).filter((l) => !have.split("\n").includes(l));
    if (!add.length) return;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${have && !have.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
  } catch {
    /* the links stay visible to git */
  }
}

function lockfilePm(dir: string): string {
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** The repo's dev command from Settings, else its package.json's `dev` script
 *  (or `start`), run with the package manager its lockfile names. */
export function devCommand(repo: Repo, cwd: string): string | null {
  if (repo.setup.dev?.trim()) return repo.setup.dev.trim();
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }
  const name = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  return name ? `${lockfilePm(cwd)} run ${name}` : null;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Link the deps (in a worktree agentbox cut) and start the dev server in
 * `cwd`. `PORT` is a free port, and `$PORT` in the command is that port, for a
 * server that takes a flag instead (Vite: `--port $PORT`). Never throws: the
 * session starts without a dev server, and the log says why.
 */
export async function startDevServer(repo: Repo, cwd: string, sessionId: string): Promise<DevServerInfo | null> {
  const log = devLog(sessionId);
  const lines: string[] = [];
  try {
    mkdirSync(devDir(), { recursive: true });
    const source = repoCheckoutPath(repo);
    if (cwd !== source && cwd.startsWith(worktreeRoot())) lines.push(...linkDeps(source, cwd));
    const command = devCommand(repo, cwd);
    if (!command) {
      writeFileSync(log, [...lines, "no dev server: no dev command in Settings, and no dev or start script in package.json", ""].join("\n"));
      return null;
    }
    const port = await freePort();
    writeFileSync(log, [...lines, `$ PORT=${port} ${command}`, ""].join("\n"));
    const fd = openSync(log, "a");
    const argv = ["sh", "-c", command];
    const scoped = Bun.which("systemd-run")
      ? ["systemd-run", "--user", "--scope", "--collect", "--quiet", `--unit=agentbox-dev-${sessionId}`, ...argv]
      : argv;
    const child = spawn(scoped[0]!, scoped.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, PORT: String(port), BROWSER: "none" },
    });
    closeSync(fd);
    child.unref();
    if (!child.pid) throw new Error("it did not start");
    const info: DevServerInfo = { pid: child.pid, port, command, log, cwd, startedAt: startedAtOf(child.pid) ?? Date.now() };
    writeFileSync(infoPath(sessionId), JSON.stringify(info));
    return info;
  } catch (e) {
    try {
      writeFileSync(log, [...lines, `could not start the dev server: ${(e as Error).message}`, ""].join("\n"));
    } catch {
      /* no log either */
    }
    return null;
  }
}

function readInfo(sessionId: string): DevServerInfo | null {
  try {
    return JSON.parse(readFileSync(infoPath(sessionId), "utf8")) as DevServerInfo;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Still the process the info names, not a later one given its pid. */
function ours(info: DevServerInfo): boolean {
  if (!alive(info.pid)) return false;
  const started = startedAtOf(info.pid);
  return started === null || Math.abs(started - info.startedAt) < 2000;
}

/** The first local URL the server printed. ANSI colour is stripped first:
 *  Vite prints its port in bold. */
export function urlFromLog(text: string): string | null {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const m = plain.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+[^\s'"]*/);
  return m ? m[0].replace("0.0.0.0", "localhost") : null;
}

async function answers(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(500), redirect: "manual" });
      return true;
    } catch {
      /* not this one */
    }
  }
  return false;
}

export async function devServerStatus(sessionId: string): Promise<DevServerStatus> {
  const info = readInfo(sessionId);
  const log = existsSync(devLog(sessionId)) ? devLog(sessionId) : null;
  let text = "";
  try {
    if (log) text = readFileSync(log, "utf8");
  } catch {
    /* unreadable */
  }
  const tail = text.split("\n").slice(-20).join("\n").trim() || null;
  if (!info) return { state: log ? "exited" : "none", url: null, command: null, log, tail };
  if (!ours(info)) return { state: "exited", url: null, command: info.command, log, tail };
  const printed = urlFromLog(text);
  if (printed) return { state: "ready", url: printed, command: info.command, log, tail: null };
  if (await answers(info.port)) return { state: "ready", url: `http://localhost:${info.port}/`, command: info.command, log, tail: null };
  return { state: "starting", url: null, command: info.command, log, tail: null };
}

/** Stop the session's dev server, all of its process group. */
export function stopDevServer(sessionId: string): void {
  const info = readInfo(sessionId);
  if (!info) return;
  rmSync(infoPath(sessionId), { force: true });
  // A pid the server no longer holds may be another process's now.
  if (!ours(info)) return;
  try {
    process.kill(-info.pid, "SIGTERM");
  } catch {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
}

/**
 * The page New session opens in a new tab: it waits for the server and then
 * goes to it. The URL keeps this page's host, so a board opened from another
 * machine opens the dev server on the machine that runs it.
 */
export function devServerPage(sessionId: string): string {
  // `<` escaped, so no id can close the script element.
  const id = JSON.stringify(sessionId).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dev server</title>
<style>:root{color-scheme:light dark}body{font:15px system-ui,sans-serif;margin:0;padding:48px 16px;background:Canvas;color:CanvasText}
main{max-width:640px;margin:0 auto}pre{white-space:pre-wrap;font-size:12px;opacity:.8}</style></head>
<body><main><h1 style="font-size:18px">Starting the dev server…</h1><p id="s">Waiting for it to answer.</p><pre id="t"></pre></main>
<script>
const id=${id};
async function poll(){
  try{
    const r=await fetch("/api/sessions/"+encodeURIComponent(id)+"/dev");
    const d=(await r.json()).data;
    if(d.state==="ready"&&d.url){
      const u=new URL(d.url);
      if(["localhost","127.0.0.1","[::1]"].includes(u.hostname))u.hostname=location.hostname;
      location.replace(u.href);return;
    }
    if(d.state==="exited"||d.state==="none"){
      document.querySelector("h1").textContent="The dev server is not running";
      document.getElementById("s").textContent=d.log?"Its log: "+d.log:"This session has no dev server.";
      document.getElementById("t").textContent=d.tail||"";return;
    }
    if(d.command)document.getElementById("s").textContent="Waiting for: "+d.command;
  }catch(e){}
  setTimeout(poll,1000);
}
poll();
</script></body></html>`;
}
