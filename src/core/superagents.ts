/**
 * Superagents: programs that run on agentbox, not in it (docs/superagents.md).
 *
 * A superagent is a directory with a `superagent.json`. Agentbox knows its
 * name, keeps its program running when it has one, shows it on the Agents
 * page with its main conversation, and relays its page (a view of blocks) and
 * the actions taken on it. What the superagent does, when, and by what rules
 * is its own code, written against the same HTTP API and CLI any session uses.
 * Nothing here knows any superagent by name, and nothing here should: a rule
 * one superagent needs is that superagent's to write.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Subprocess } from "bun";
import { getDb, getSchedule } from "./db";
import { FleetError, type Fleet, type SpawnRequest } from "./fleet";
import { agentboxBin, agentboxHome, packageRoot, userHome } from "./paths";
import { submitWithReceipt } from "./send-receipts";
import type { ProviderId, SuperagentInfo } from "./types";

const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "devin", "omp", "opencode", "muse"];
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** How long a view or an action may take before the page is told it did not answer. */
const VIEW_MS = 8_000;
const ACTION_MS = 60_000;
const MAX_REPLY = 2 * 1024 * 1024;
const MAX_LOG = 4 * 1024 * 1024;
/** A program that lived this long before it exited starts again at once. */
const STEADY_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

/** `superagent.json`. Fields agentbox does not know are the program's own and left alone. */
export const Manifest = z
  .object({
    name: z.string().regex(NAME, "a name is lowercase letters, digits and dashes, starting with a letter"),
    title: z.string().trim().min(1).max(80).optional(),
    description: z.string().max(2000).default(""),
    /** The program, run in the directory and kept running: argv, not a shell line. */
    run: z.array(z.string().min(1)).min(1).optional(),
    /** Where a program agentbox does not run answers (`/agentbox/view`, `/agentbox/action`). */
    url: z.string().url().optional(),
    main: z
      .object({
        /** A `POST /api/sessions` body: what agentbox starts on the first message when there is no main yet. */
        start: z.record(z.string(), z.unknown()).optional(),
        /** A file in the directory, said before that first message. */
        instructions: z.string().min(1).optional(),
        /** The main conversation is the session this schedule spoke to last. */
        schedule: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();
export type Manifest = z.infer<typeof Manifest>;

type Row = { name: string; dir: string; enabled: number; main: string | null; previous: string; main_send: string | null; created_at: number };

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
};

export type Caller = { session: string | null; via: "app" | "api" };

export const superagentHome = (name: string): string => join(agentboxHome(), "superagents", name);

function rowOf(name: string): Row | null {
  return getDb().query("SELECT * FROM superagents WHERE name = ?").get(name) as Row | null;
}

function rows(): Row[] {
  return getDb().query("SELECT * FROM superagents ORDER BY created_at").all() as Row[];
}

export function readManifest(dir: string): Manifest {
  const file = join(dir, "superagent.json");
  if (!existsSync(file)) throw new FleetError(400, `${file} does not exist`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new FleetError(400, `${file} is not JSON: ${(e as Error).message}`);
  }
  const m = Manifest.safeParse(raw);
  if (!m.success) throw new FleetError(400, `${file}: ${m.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  if (m.data.run && m.data.url) throw new FleetError(400, `${file}: give run or url, not both`);
  if (m.data.main?.schedule && m.data.main.start) throw new FleetError(400, `${file}: main is a schedule's session or one agentbox starts, not both`);
  return m.data;
}

/** The secret agentbox sends its program, so a page on another site cannot drive it. Same-user readable, like a session capability. */
export function superagentToken(name: string): string {
  const home = superagentHome(name);
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

async function readCapped(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length > MAX_REPLY) throw new FleetError(502, "the superagent answered with more than 2 MiB");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new FleetError(502, `the superagent did not answer with JSON (HTTP ${res.status})`);
  }
}

export class Superagents {
  private procs = new Map<string, Proc>();
  private starting = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly fleet: Fleet,
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

  list(): SuperagentInfo[] {
    return rows().map((r) => this.info(r));
  }

  get(name: string): SuperagentInfo {
    return this.info(this.row(name));
  }

  /** Add the superagent in `dir`, or read its manifest again. */
  async register(dir: string): Promise<SuperagentInfo> {
    if (!isAbsolute(dir)) throw new FleetError(400, "give the superagent's directory as an absolute path");
    const m = readManifest(dir);
    const old = rowOf(m.name);
    if (old && resolve(old.dir) !== resolve(dir))
      throw new FleetError(409, `a superagent named ${m.name} is already registered from ${old.dir}; remove it first`);
    if (!old) getDb().run("INSERT INTO superagents (name, dir, enabled, previous, created_at) VALUES (?, ?, 1, '[]', ?)", [m.name, resolve(dir), Date.now()]);
    superagentToken(m.name);
    // A changed program is started again with the manifest it has now.
    if (old) this.kill(m.name);
    await this.tick();
    this.changed();
    return this.get(m.name);
  }

  /** Forget it. Its directory and its home stay where they are. */
  remove(name: string): void {
    this.row(name);
    this.kill(name);
    this.procs.delete(name);
    getDb().run("DELETE FROM superagents WHERE name = ?", [name]);
    this.changed();
  }

  async patch(name: string, p: { enabled?: boolean; main?: string | null }): Promise<SuperagentInfo> {
    const r = this.row(name);
    if (p.enabled !== undefined) {
      getDb().run("UPDATE superagents SET enabled = ? WHERE name = ?", [p.enabled ? 1 : 0, name]);
      if (!p.enabled) this.kill(name);
    }
    if (p.main !== undefined) {
      if (p.main !== null && !this.fleet.sessions().some((s) => s.id === p.main)) throw new FleetError(404, `no session ${p.main}`);
      this.setMain(r, p.main);
    }
    await this.tick();
    this.changed();
    return this.get(name);
  }

  async restart(name: string): Promise<SuperagentInfo> {
    this.row(name);
    this.kill(name);
    const p = this.procs.get(name);
    if (p) p.backoffUntil = 0;
    await this.tick();
    return this.get(name);
  }

  /** The end of its program's output. */
  log(name: string, bytes = 64 * 1024): string {
    this.row(name);
    const file = join(superagentHome(name), "process.log");
    if (!existsSync(file)) return "";
    const all = readFileSync(file);
    return all.subarray(Math.max(0, all.length - bytes)).toString("utf8");
  }

  /** Its page: what its program answers at `/agentbox/view`. */
  async view(name: string, tab: string | null): Promise<unknown> {
    const ep = this.endpoint(name);
    if (!ep) return null;
    const url = `${ep}/agentbox/view${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`;
    const res = await this.call(name, url, { method: "GET" }, VIEW_MS);
    const body = await readCapped(res);
    if (!res.ok) throw new FleetError(502, `the superagent's view failed (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  }

  /** An action on its page, or one of its sessions calling it: relayed with who asked. */
  async action(name: string, body: Record<string, unknown>, caller: Caller): Promise<unknown> {
    const ep = this.endpoint(name);
    if (!ep) throw new FleetError(409, `${name} has no program answering: nothing to act on`);
    const res = await this.call(
      name,
      `${ep}/agentbox/action`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, caller }) },
      ACTION_MS,
    );
    const out = await readCapped(res);
    if (!res.ok) {
      const msg = out && typeof out === "object" && "error" in out ? String((out as { error: unknown }).error) : `HTTP ${res.status}`;
      throw new FleetError(res.status >= 400 && res.status < 500 ? res.status : 502, msg);
    }
    return out;
  }

  /**
   * Say something to its main conversation. With none yet, start it from the
   * manifest's `main.start`, its instructions before the message. A retry
   * with the same `sendId` never starts a second one.
   */
  async chat(name: string, text: string, sendId: string): Promise<{ session: string; started: boolean }> {
    const r = this.row(name);
    const main = this.mainOf(r);
    if (main) {
      await submitWithReceipt(main, sendId, "send", text, (attempt) => this.fleet.send(main, text, attempt));
      return { session: main, started: false };
    }
    if (r.main_send === sendId && r.main) return { session: r.main, started: true };
    const m = readManifest(r.dir);
    if (!m.main?.start) throw new FleetError(409, `${name} has no main conversation yet, and its manifest does not say how to start one`);
    if (this.starting.has(name)) throw new FleetError(409, `${name}'s main conversation is being started this moment`);
    this.starting.add(name);
    try {
      const spec = m.main.start;
      const provider = spec.provider;
      if (typeof provider !== "string" || !PROVIDERS.includes(provider as ProviderId)) throw new FleetError(400, `${name}: main.start.provider must be one of ${PROVIDERS.join(", ")}`);
      const instructions = m.main.instructions ? this.fill(readFileSync(join(r.dir, m.main.instructions), "utf8").trim(), r) : "";
      const cwd = typeof spec.cwd === "string" ? resolve(r.dir, spec.cwd.replace(/^~(?=\/|$)/, userHome())) : r.dir;
      mkdirSync(cwd, { recursive: true });
      const prompt = instructions ? `${instructions}\n\n---\n\n${text}` : text;
      const { session } = await this.fleet.spawn({ ...(spec as Partial<SpawnRequest>), provider: provider as ProviderId, cwd, prompt, parent: undefined, callerPid: undefined, id: undefined });
      getDb().run("UPDATE superagents SET main_send = ? WHERE name = ?", [sendId, name]);
      this.setMain(this.row(name), session.id);
      this.changed();
      return { session: session.id, started: true };
    } finally {
      this.starting.delete(name);
    }
  }

  // ------------------------------------------------------------- inside

  /** What instructions may name: its directory and home, and the agentbox checkout (its docs, its examples). */
  private fill(text: string, r: Row): string {
    return text.replaceAll("{{dir}}", r.dir).replaceAll("{{home}}", superagentHome(r.name)).replaceAll("{{agentbox}}", packageRoot).replaceAll("{{bin}}", agentboxBin());
  }

  private row(name: string): Row {
    if (!NAME.test(name)) throw new FleetError(400, "not a superagent name");
    const r = rowOf(name);
    if (!r) throw new FleetError(404, `no superagent ${name}`);
    return r;
  }

  private manifestOrError(r: Row): { m: Manifest | null; error: string | null } {
    try {
      return { m: readManifest(r.dir), error: null };
    } catch (e) {
      return { m: null, error: (e as Error).message };
    }
  }

  /**
   * Its main conversation now. Following each handover (`Fleet.heir`), so a
   * program that hands its main to a fresh session need not say so twice;
   * the one handed over from goes into `previous`.
   */
  private mainOf(r: Row, m?: Manifest | null): string | null {
    const manifest = m === undefined ? this.manifestOrError(r).m : m;
    const sched = manifest?.main?.schedule;
    if (sched) {
      const s = getSchedule(sched);
      return s?.lastSessionId ? this.fleet.heir(s.lastSessionId) : null;
    }
    if (!r.main) return null;
    const heir = this.fleet.heir(r.main);
    if (heir !== r.main) this.setMain(r, heir);
    return heir;
  }

  private setMain(r: Row, main: string | null): void {
    const prev = JSON.parse(r.previous) as string[];
    const next = r.main && r.main !== main ? [r.main, ...prev.filter((x) => x !== r.main && x !== main)] : prev.filter((x) => x !== main);
    getDb().run("UPDATE superagents SET main = ?, previous = ? WHERE name = ?", [main, JSON.stringify(next.slice(0, 200)), r.name]);
  }

  /** The sessions that were its main before this one, newest first. */
  private previousOf(r: Row, m: Manifest | null, main: string | null): string[] {
    if (!m?.main?.schedule) return JSON.parse(r.previous) as string[];
    // A schedule's sessions hand over one to the next: walk back from the current one.
    const out: string[] = [];
    const seen = new Set<string>();
    for (let at = main; at && out.length < 200; ) {
      const before = getDb().query("SELECT id FROM sessions WHERE successor = ? ORDER BY created_at DESC LIMIT 1").get(at) as { id: string } | null;
      if (!before || seen.has(before.id)) break;
      seen.add(before.id);
      out.push(before.id);
      at = before.id;
    }
    return out;
  }

  private info(r: Row): SuperagentInfo {
    const { m, error } = this.manifestOrError(r);
    const main = this.mainOf(r, m);
    const p = this.procs.get(r.name);
    return {
      name: r.name,
      title: m?.title ?? r.name,
      description: m?.description ?? "",
      dir: r.dir,
      enabled: r.enabled === 1,
      error,
      main,
      previous: this.previousOf(r, m, main),
      canStart: !main && !!m?.main?.start,
      hasPage: !!(m?.url || m?.run),
      process: m?.run
        ? {
            state: p?.child ? "running" : r.enabled !== 1 ? "stopped" : p && p.backoffUntil > Date.now() ? "backoff" : "starting",
            pid: p?.pid ?? null,
            since: p?.since ?? null,
            restarts: p?.restarts ?? 0,
            lastExit: p?.lastExit ?? null,
          }
        : null,
      createdAt: r.created_at,
    };
  }

  private endpoint(name: string): string | null {
    const r = this.row(name);
    const m = readManifest(r.dir);
    if (m.url) return m.url.replace(/\/$/, "");
    const p = this.procs.get(name);
    return m.run && p?.child ? `http://127.0.0.1:${p.port}` : null;
  }

  private async call(name: string, url: string, init: RequestInit, ms: number): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), "x-agentbox-superagent-token": superagentToken(name) },
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      const why = (e as Error).name === "TimeoutError" ? `did not answer within ${ms / 1000}s` : `could not be reached: ${(e as Error).message}`;
      throw new FleetError(502, `${name} ${why}`);
    }
  }

  /** Start what should run and is not, each after its backoff. */
  private async tick(): Promise<void> {
    const now = Date.now();
    for (const r of rows()) {
      if (r.enabled !== 1) continue;
      const { m } = this.manifestOrError(r);
      if (!m?.run) continue;
      const p = this.procs.get(r.name);
      if (p?.child || (p && p.backoffUntil > now)) continue;
      await this.spawn(r, m, p);
    }
  }

  private async spawn(r: Row, m: Manifest, old: Proc | undefined): Promise<void> {
    const home = superagentHome(r.name);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const logFile = join(home, "process.log");
    const pidFile = join(home, "pid");
    this.reap(r.name, pidFile);
    const port = await freePort();
    const p: Proc = old ?? { child: null, port, pid: null, since: 0, restarts: 0, backoffUntil: 0, lastExit: null, stopping: false };
    p.port = port;
    p.stopping = false;
    this.procs.set(r.name, p);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // The server's own environment may carry a session's id; the program is not that session.
    delete env.AGENTBOX_SESSION;
    Object.assign(env, {
      AGENTBOX_URL: this.serverUrl,
      AGENTBOX_BIN: agentboxBin(),
      AGENTBOX_SUPERAGENT: r.name,
      AGENTBOX_SUPERAGENT_DIR: r.dir,
      AGENTBOX_SUPERAGENT_HOME: home,
      AGENTBOX_SUPERAGENT_TOKEN: superagentToken(r.name),
      PORT: String(port),
    });
    const note = (line: string) => this.append(logFile, `[agentbox ${new Date().toISOString()}] ${line}\n`);
    let child: Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(m.run!, { cwd: r.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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
   *  never run at once. Only a process that is this superagent's program. */
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
      if (env.includes(`AGENTBOX_SUPERAGENT=${name}`)) process.kill(pid, "SIGTERM");
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
