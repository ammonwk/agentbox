/**
 * Extensions: programs that run on agentbox, not in it (docs/extensions.md).
 *
 * An extension is a directory (or a link to one) in `<agentbox home>/extensions/`
 * holding an `extension.json` that says how to run it. Agentbox keeps that
 * program running, gives it a port, and serves whatever it answers under
 * `/x/<name>/`, which the app shows in a frame of its own. That is all:
 * everything else it does — start sessions, talk to them, keep a
 * conversation, remember things — it does through the public HTTP API, like
 * any other client. Nothing here knows any extension by name, and nothing
 * here should.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Subprocess } from "bun";
import { agentboxBin, agentboxHome } from "./paths";
import type { ExtensionInfo } from "./types";

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** A program that lived this long before it exited starts again at once. */
const STEADY_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_LOG = 4 * 1024 * 1024;
const PROXY_MS = 120_000;

/** `extension.json`. Fields agentbox does not know are the program's own. */
const Manifest = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(2000).optional(),
    /** The program, run in the directory and kept running: argv, not a shell line. */
    run: z.array(z.string().min(1)).min(1),
  })
  .passthrough();
type Manifest = z.infer<typeof Manifest>;

type Proc = {
  child: Subprocess | null;
  port: number;
  pid: number | null;
  since: number;
  restarts: number;
  /** Not started again before this. */
  backoffUntil: number;
  lastExit: { code: number | null; at: number } | null;
  stopping: boolean;
  /** The manifest it was started with: a changed one starts it again. */
  run: string;
};

export class ExtensionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Where extensions are: one entry each, a directory or a link to one. */
export const extensionsDir = (): string => join(agentboxHome(), "extensions");
/** Each one's own state: its log, its pid, its token, and whatever it keeps. */
export const extensionHome = (name: string): string => join(extensionsDir(), ".state", name);

function names(): string[] {
  try {
    return readdirSync(extensionsDir())
      .filter((n) => NAME.test(n))
      .sort();
  } catch {
    return [];
  }
}

function dirOf(name: string): string {
  if (!NAME.test(name)) throw new ExtensionError(400, "not an extension name");
  const dir = join(extensionsDir(), name);
  if (!existsSync(dir)) throw new ExtensionError(404, `no extension ${name}`);
  return dir;
}

function readManifest(dir: string): Manifest {
  const file = join(dir, "extension.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ExtensionError(400, `${file}: ${(e as Error).message}`);
  }
  const m = Manifest.safeParse(raw);
  if (!m.success) throw new ExtensionError(400, `${file}: ${m.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  return m.data;
}

/** The secret agentbox sends its program with every request, so a page on another site cannot drive it. */
function token(name: string): string {
  const home = extensionHome(name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "token");
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return readFileSync(file, "utf8").trim();
}

async function freePort(): Promise<number> {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** Link `dir` in as an extension called `name` (its directory's name unless given). */
export function addExtension(dir: string, name?: string): string {
  if (!isAbsolute(dir)) throw new ExtensionError(400, "give the extension's directory as an absolute path");
  readManifest(dir);
  const n = name ?? dir.replace(/\/+$/, "").split("/").pop()!;
  if (!NAME.test(n)) throw new ExtensionError(400, `${n} is not an extension name: lowercase letters, digits and dashes, starting with a letter`);
  mkdirSync(extensionsDir(), { recursive: true });
  const at = join(extensionsDir(), n);
  if (existsSync(at)) throw new ExtensionError(409, `an extension called ${n} is already there (${at})`);
  symlinkSync(resolve(dir), at);
  return n;
}

/** Unlink it: a link goes, a directory stays where it is (move it out yourself). */
export function removeExtension(name: string): void {
  const at = dirOf(name);
  if (!lstatSync(at).isSymbolicLink()) throw new ExtensionError(409, `${at} is a directory, not a link: move it out of ${extensionsDir()} to remove it`);
  unlinkSync(at);
}

export class Extensions {
  private procs = new Map<string, Proc>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** The server's own address, for the programs. */
    private readonly serverUrl: string,
    private readonly changed: () => void = () => {},
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3_000);
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    for (const name of this.procs.keys()) this.kill(name);
  }

  list(): ExtensionInfo[] {
    return names().map((name) => {
      const dir = join(extensionsDir(), name);
      let m: Manifest | null = null;
      let error: string | null = null;
      try {
        m = readManifest(dir);
      } catch (e) {
        error = (e as Error).message;
      }
      const p = this.procs.get(name);
      return {
        name,
        title: m?.title ?? name,
        description: m?.description ?? "",
        dir,
        error,
        state: p?.child ? "running" : p && p.backoffUntil > Date.now() ? "backoff" : error ? "stopped" : "starting",
        pid: p?.pid ?? null,
        since: p?.since ?? null,
        restarts: p?.restarts ?? 0,
        lastExit: p?.lastExit ?? null,
      };
    });
  }

  async restart(name: string): Promise<void> {
    dirOf(name);
    this.kill(name);
    const p = this.procs.get(name);
    if (p) p.backoffUntil = 0;
  }

  /** The end of its program's output. */
  log(name: string, bytes = 64 * 1024): string {
    dirOf(name);
    const file = join(extensionHome(name), "process.log");
    if (!existsSync(file)) return "";
    const all = readFileSync(file);
    return all.subarray(Math.max(0, all.length - bytes)).toString("utf8");
  }

  /**
   * `/x/<name>/<rest>` from the app, a session or anything else on this
   * machine, passed to the program as `/<rest>`. It is told who asked in
   * `x-agentbox-caller`: `session:<id>` for a session that proved itself with
   * its capability, `app` for a browser, `api` otherwise; and it is sent its
   * token, so it can refuse what did not come through here.
   */
  async proxy(req: Request, name: string, rest: string, caller: string): Promise<Response> {
    dirOf(name);
    const p = this.procs.get(name);
    if (!p?.child) throw new ExtensionError(503, `${name} is not running (agentbox ext log ${name})`);
    const url = new URL(req.url);
    const headers = new Headers();
    for (const h of ["content-type", "accept", "accept-language"]) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("x-agentbox-caller", caller);
    headers.set("x-agentbox-ext-token", token(name));
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${p.port}/${rest}${url.search}`, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_MS),
      });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? `did not answer within ${PROXY_MS / 1000}s` : `could not be reached: ${(e as Error).message}`;
      throw new ExtensionError(502, `${name} ${why}`);
    }
    const out = new Headers();
    for (const h of ["content-type", "cache-control", "location", "last-modified", "etag"]) {
      const v = res.headers.get(h);
      // A redirect to its own root stays under its prefix.
      if (v) out.set(h, h === "location" && v.startsWith("/") && !v.startsWith("//") ? `/x/${name}${v}` : v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  }

  // ------------------------------------------------------------- inside

  /** Start what should run and is not, each after its backoff; stop what has gone. */
  private async tick(): Promise<void> {
    const now = Date.now();
    const here = new Set(names());
    for (const name of [...this.procs.keys()]) {
      if (here.has(name)) continue;
      this.kill(name);
      this.procs.delete(name);
      this.changed();
    }
    for (const name of here) {
      let m: Manifest;
      try {
        m = readManifest(join(extensionsDir(), name));
      } catch {
        continue;
      }
      const p = this.procs.get(name);
      // A changed manifest starts it again with the one it has now.
      if (p?.child && p.run !== JSON.stringify(m.run)) this.kill(name);
      if (p?.child || (p && p.backoffUntil > now)) continue;
      await this.spawn(name, m, p);
    }
  }

  private async spawn(name: string, m: Manifest, old: Proc | undefined): Promise<void> {
    const dir = resolve(join(extensionsDir(), name));
    const home = extensionHome(name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const logFile = join(home, "process.log");
    const pidFile = join(home, "pid");
    this.reap(name, pidFile);
    const port = await freePort();
    const p: Proc = old ?? { child: null, port, pid: null, since: 0, restarts: 0, backoffUntil: 0, lastExit: null, stopping: false, run: "" };
    p.port = port;
    p.stopping = false;
    p.run = JSON.stringify(m.run);
    this.procs.set(name, p);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // The server's own environment may carry a session's id; the program is not that session.
    delete env.AGENTBOX_SESSION;
    Object.assign(env, {
      AGENTBOX_URL: this.serverUrl,
      AGENTBOX_BIN: agentboxBin(),
      AGENTBOX_EXT: name,
      AGENTBOX_EXT_DIR: dir,
      AGENTBOX_EXT_HOME: home,
      AGENTBOX_EXT_TOKEN: token(name),
      PORT: String(port),
    });
    const note = (line: string) => this.append(logFile, `[agentbox ${new Date().toISOString()}] ${line}\n`);
    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(m.run, { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      note(`could not start ${JSON.stringify(m.run)}: ${(e as Error).message}`);
      p.lastExit = { code: null, at: Date.now() };
      p.backoffUntil = Date.now() + this.backoff(p);
      p.restarts++;
      return;
    }
    p.child = child;
    p.pid = child.pid;
    writeFileSync(pidFile, String(child.pid));
    p.since = Date.now();
    note(`started ${JSON.stringify(m.run)} as pid ${child.pid} on port ${port}`);
    void this.pipe(child.stdout, logFile);
    void this.pipe(child.stderr, logFile);
    void child.exited.then((code) => {
      const lived = Date.now() - p.since;
      p.child = null;
      p.pid = null;
      p.lastExit = { code, at: Date.now() };
      note(`exited with ${code}${p.stopping ? " (stopped)" : ""}`);
      if (lived >= STEADY_MS) p.restarts = 0;
      p.backoffUntil = p.stopping ? 0 : Date.now() + this.backoff(p);
      if (!p.stopping) p.restarts++;
      this.changed();
    });
    this.changed();
  }

  /** A program a server before this one started and did not see out (a
   *  crash, not a restart: systemd stops the whole unit) is stopped, so two
   *  never run at once. Only a process that is this extension's program. */
  private reap(name: string, pidFile: string): void {
    let pid: number;
    try {
      pid = Number(readFileSync(pidFile, "utf8"));
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 1 || this.procs.get(name)?.pid === pid) return;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.includes(`AGENTBOX_EXT=${name}`)) process.kill(pid, "SIGTERM");
    } catch {
      // Gone, or not ours to read (macOS has no /proc): nothing to stop.
    }
  }

  private backoff(p: Proc): number {
    return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(p.restarts, 6));
  }

  private kill(name: string): void {
    const p = this.procs.get(name);
    const child = p?.child;
    if (!p || !child) return;
    p.stopping = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (p.child === child) child.kill("SIGKILL");
    }, 5_000);
  }

  private async pipe(stream: ReadableStream<Uint8Array>, file: string): Promise<void> {
    const dec = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) this.append(file, dec.decode(r.value, { stream: true }));
    } catch {
      // The process went away mid-write: what it said is in the file.
    }
  }

  private append(file: string, text: string): void {
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG) renameSync(file, `${file}.1`);
      appendFileSync(file, text);
    } catch {
      // A full disk loses log lines, not the program.
    }
  }
}
