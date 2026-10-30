/**
 * Extensions: programs that run on agentbox, not in it (docs/extensions.md).
 *
 * An extension is a directory (or a link to one) in `<agentbox home>/extensions/`
 * holding an `extension.json`, or one that comes with agentbox in its
 * checkout's `extensions/`. It has a program, a client, or both. Agentbox keeps
 * the program running, gives it a port, and serves whatever it answers under
 * `/x/<name>/`; and it bundles the client, against the app's own React and
 * `agentbox/client`, for the app to load into itself (web/src/plugin/). That
 * is all: everything else it does — start sessions, talk to them, keep a
 * conversation, remember things — it does through the public HTTP API, like
 * any other client. Nothing here knows any extension by name, and nothing
 * here should.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Subprocess } from "bun";
import { agentboxBin, agentboxHome, packageRoot } from "./paths";
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
    run: z.array(z.string().min(1)).min(1).optional(),
    /** Its part in the app: a module (TypeScript, JSX) the app loads into itself. */
    client: z.string().min(1).optional(),
  })
  .passthrough()
  .refine((m) => m.run || m.client, { message: "say `run` (a program), `client` (a part in the app), or both" });
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

/** The ones that come with agentbox. One of yours by the same name is the one used. */
const builtInDir = join(packageRoot, "extensions");

function namesIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => NAME.test(n));
  } catch {
    return [];
  }
}

function names(): string[] {
  return [...new Set([...namesIn(builtInDir), ...namesIn(extensionsDir())])].sort();
}

const isBuiltIn = (name: string): boolean => !existsSync(join(extensionsDir(), name)) && existsSync(join(builtInDir, name));

function dirOf(name: string): string {
  if (!NAME.test(name)) throw new ExtensionError(400, "not an extension name");
  const dir = join(isBuiltIn(name) ? builtInDir : extensionsDir(), name);
  if (!existsSync(dir)) throw new ExtensionError(404, `no extension ${name}`);
  return dir;
}

const offFile = (name: string): string => join(extensionHome(name), "off");
const isOn = (name: string): boolean => !existsSync(offFile(name));

/** Turn it off (its program stops within seconds, and the app loads its client no more) or on again. */
export function setExtensionOn(name: string, on: boolean): void {
  dirOf(name);
  if (on) rmSync(offFile(name), { force: true });
  else {
    mkdirSync(extensionHome(name), { recursive: true, mode: 0o700 });
    writeFileSync(offFile(name), "");
  }
}

/** The JSON value its client keeps (`data.json` in its home), or null. */
export function extensionData(name: string): unknown {
  dirOf(name);
  try {
    return JSON.parse(readFileSync(join(extensionHome(name), "data.json"), "utf8"));
  } catch {
    return null;
  }
}

export function saveExtensionData(name: string, value: unknown): void {
  dirOf(name);
  const home = extensionHome(name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = join(home, `data.json.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(value ?? null, null, 2));
  renameSync(tmp, join(home, "data.json"));
}

/** What `react`, `react-dom` and the JSX runtimes export, so an extension's import of each can be pointed at the app's. */
let shared: Promise<Record<string, string>> | null = null;
function sharedModules(): Promise<Record<string, string>> {
  return (shared ??= (async () => {
    const keys = async (m: string) => Object.keys(await import(m)).filter((k) => k !== "default" && /^[A-Za-z_$][\w$]*$/.test(k));
    const from = (ns: string, names: string[]) =>
      `import * as H from "agentbox/client"; const M = H.${ns}; export default M; export const { ${names.join(", ")} } = M;`;
    return {
      react: from("React", await keys("react")),
      "react-dom": from("ReactDOM", await keys("react-dom")),
      "react/jsx-runtime": `import * as H from "agentbox/client"; export const { jsx, jsxs, Fragment } = H.JSX;`,
      // What a bundler's development JSX calls: the same elements, without the dev-only checks.
      "react/jsx-dev-runtime": `import * as H from "agentbox/client"; export const { Fragment } = H.JSX; export const jsxDEV = (type, props, key) => H.JSX.jsx(type, props, key);`,
    };
  })());
}

/**
 * Its client, bundled for the app: everything it imports is bundled in except
 * `agentbox/client`, which is `host` (this build's own entry, so the client
 * runs with the page's React and parts), and React itself, read from there.
 * Its CSS goes in a `<style>` it adds. A failure to bundle is a module that
 * throws why, so the app can say so beside the extension.
 */
export async function bundleClient(name: string, host: string): Promise<string> {
  const dir = dirOf(name);
  const m = readManifest(dir);
  if (!m.client) throw new ExtensionError(404, `${name} has no client`);
  const mods = await sharedModules();
  const r = await Bun.build({
    entrypoints: [resolve(dir, m.client)],
    target: "browser",
    format: "esm",
    throw: false,
    plugins: [
      {
        name: "agentbox-shared",
        setup(b) {
          b.onResolve({ filter: /^agentbox\/client$/ }, () => ({ path: host, external: true }));
          b.onResolve({ filter: /^(react|react-dom|react\/jsx-(dev-)?runtime)$/ }, (a) => ({ path: a.path, namespace: "agentbox-shared" }));
          b.onLoad({ filter: /.*/, namespace: "agentbox-shared" }, (a) => ({ contents: mods[a.path]!, loader: "js" }));
        },
      },
    ],
  });
  if (!r.success) return `throw new Error(${JSON.stringify(`${name}'s client did not build: ${r.logs.map((l) => String(l.message ?? l)).join("; ")}`)});`;
  const js = await r.outputs.find((o) => o.kind === "entry-point")!.text();
  const css = (await Promise.all(r.outputs.filter((o) => o.path.endsWith(".css")).map((o) => o.text()))).join("\n");
  if (!css) return js;
  const style = `{ const s = document.createElement("style"); s.dataset.extension = ${JSON.stringify(name)}; s.textContent = ${JSON.stringify(css)}; document.head.append(s); }\n`;
  return style + js;
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
  if (isBuiltIn(name)) throw new ExtensionError(409, `${name} comes with agentbox: turn it off instead (agentbox ext off ${name})`);
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
      const dir = dirOf(name);
      let m: Manifest | null = null;
      let error: string | null = null;
      try {
        m = readManifest(dir);
      } catch (e) {
        error = (e as Error).message;
      }
      const p = this.procs.get(name);
      const enabled = isOn(name);
      return {
        name,
        title: m?.title ?? name,
        description: m?.description ?? "",
        dir,
        error,
        builtIn: isBuiltIn(name),
        enabled,
        run: !!m?.run,
        client: !!m?.client,
        state: p?.child ? "running" : !m?.run || !enabled ? "none" : p && p.backoffUntil > Date.now() ? "backoff" : error ? "stopped" : "starting",
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
      // A redirect is passed as it is: one to its own pages is relative (`./other`), as `/` is agentbox's.
      if (v) out.set(h, v);
    }
    return new Response(res.body, { status: res.status, headers: out });
  }

  // ------------------------------------------------------------- inside

  /** Start what should run and is not, each after its backoff; stop what has gone. */
  private async tick(): Promise<void> {
    const now = Date.now();
    // What has a program to run, and is on.
    const here = new Set(names().filter(isOn));
    for (const name of [...this.procs.keys()]) {
      if (here.has(name)) continue;
      this.kill(name);
      this.procs.delete(name);
      this.changed();
    }
    for (const name of here) {
      let m: Manifest;
      try {
        m = readManifest(dirOf(name));
      } catch {
        continue;
      }
      const p = this.procs.get(name);
      if (!m.run) {
        this.kill(name);
        continue;
      }
      // A changed manifest starts it again with the one it has now.
      if (p?.child && p.run !== JSON.stringify(m.run)) this.kill(name);
      if (p?.child || (p && p.backoffUntil > now)) continue;
      await this.spawn(name, { ...m, run: m.run }, p);
    }
  }

  private async spawn(name: string, m: Manifest & { run: string[] }, old: Proc | undefined): Promise<void> {
    const dir = resolve(dirOf(name));
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
