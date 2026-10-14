/**
 * Global MCP servers: one list agentbox owns, which every agent it starts is
 * given (src/core/mcp-reach.ts says how each CLI is given it).
 *
 * The list is a file of its own, `<agentbox home>/mcp/servers.json`, private
 * to the user (0600 in a 0700 directory): env and header values are tokens.
 * They are written to disk only there and in the files agentbox writes for
 * the CLIs, which are private the same way, and they never go back to the
 * page. Nothing here imports the database or the adapters, so the subagent
 * MCP, a process of its own, reads the same list (`acpServers`).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome, packageRoot, userHome } from "./paths";
import { environOf, findProcesses } from "./providers/procs";
import type { McpServerInput, McpTransport } from "./types";

export interface McpServer {
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  from?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Registry {
  version: 1;
  changedAt: number | null;
  servers: McpServer[];
}

/** A request this module refuses, and the HTTP status that says why. */
export class McpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export const mcpDir = (): string => join(agentboxHome(), "mcp");
export const registryPath = (): string => join(mcpDir(), "servers.json");

/** The directory the list and the CLIs' files live in, private. */
export function ensureMcpDir(): string {
  const dir = mcpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Write via rename, so a CLI starting meanwhile reads the old file or the new
 * one, never half; 0600 from the first byte. No backup is kept: a copy of the
 * old list would keep a rotated token on disk.
 */
export function writePrivate(path: string, text: string): void {
  const tmp = `${path}.agentbox-${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Mark a snapshot as just used, so `pruneMcpFiles` leaves it to the launch
 *  about to read it even when its content was written long ago. */
export function touch(path: string): void {
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    /* gone: the caller writes it again */
  }
}

export function readRegistry(): Registry {
  let raw: string;
  try {
    raw = readFileSync(registryPath(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read the global MCP registry at ${registryPath()}`);
    return { version: 1, changedAt: null, servers: [] };
  }
  let v: Partial<Registry>;
  try { v = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${registryPath()}`); }
  if (!v || !Array.isArray(v.servers)) throw new Error(`${registryPath()} is not a list of MCP servers`);
  return { version: 1, changedAt: typeof v.changedAt === "number" ? v.changedAt : null, servers: v.servers };
}

function writeRegistry(r: Registry): void {
  ensureMcpDir();
  writePrivate(registryPath(), `${JSON.stringify(r, null, 2)}\n`);
}

export function enabledServers(): McpServer[] {
  return readRegistry().servers.filter((s) => s.enabled);
}

/** Resolve once with the launching environment, as required by ACP. */
export function mcpExecutable(s: McpServer, cwd = userHome(), env: Record<string, string | undefined> = process.env): string {
  const command = Bun.which(s.command ?? "", { cwd, PATH: s.env?.PATH ?? env.PATH });
  if (!command) throw new Error(`MCP ${s.name}: command ${s.command} is not executable on the session PATH`);
  return command;
}

// ------------------------------------------------------------- validation

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_KEY = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
/**
 * The CLIs read their configs with different substitutions: Claude expands
 * `${VAR}`, opencode `{env:VAR}` and `{file:path}`, Muse refuses a secret
 * that is not a whole `${VAR}`. A value that looks like one would mean a
 * different thing to each, so none is taken: agentbox passes values as they
 * are.
 */
const SUBSTITUTION = /\$\{|\{(?:env|file):/;

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== "string") throw new McpError(400, `${what} must be text`);
  if (v.length > max) throw new McpError(400, `${what} is longer than ${max} characters`);
  if (/[\0\r\n]/.test(v)) throw new McpError(400, `${what} must be one line`);
  if (SUBSTITUTION.test(v)) throw new McpError(400, `${what} looks like a variable ("\${…}", "{env:…}" or "{file:…}"); write the value itself`);
  return v;
}

/**
 * A server from what the page sent, against the saved one it edits. An env
 * or header entry with no `value` keeps the saved value of that name, so an
 * edit never needs a secret the page was never shown.
 */
export function parseServer(body: McpServerInput, saved: McpServer | null, now: number): McpServer {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME.test(name)) throw new McpError(400, "the name must be 1–64 letters, digits, - or _, starting with a letter or digit");
  const transport = body.transport;
  if (transport !== "stdio" && transport !== "http") throw new McpError(400, 'how it runs must be "stdio" (a command) or "http" (a URL)');
  const base = { name, enabled: body.enabled ?? saved?.enabled ?? true, transport, from: saved?.from ?? null, createdAt: saved?.createdAt ?? now, updatedAt: now };
  if (typeof base.enabled !== "boolean") throw new McpError(400, "enabled must be true or false");
  if (transport === "stdio") {
    const command = text(body.command ?? "", "the command", 1024).trim();
    if (!command) throw new McpError(400, "give the command that starts the server");
    const args = body.args ?? [];
    if (!Array.isArray(args) || args.length > 64) throw new McpError(400, "arguments must be a list of at most 64");
    const env = pairs(body.env, saved?.env, ENV_KEY, "environment variable");
    return { ...base, command, args: args.map((a, i) => text(a, `argument ${i + 1}`, 4096)), env };
  }
  const url = text(body.url ?? "", "the URL", 2048).trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new McpError(400, `"${url}" is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new McpError(400, "the URL must start with http:// or https://");
  const headers = pairs(body.headers, saved?.headers, HEADER_KEY, "header");
  return { ...base, url, headers };
}

function pairs(
  given: McpServerInput["env"],
  saved: Record<string, string> | undefined,
  key: RegExp,
  what: string,
): Record<string, string> {
  if (given === undefined) return { ...saved };
  if (!Array.isArray(given) || given.length > 64) throw new McpError(400, `${what}s must be a list of at most 64`);
  const out: Record<string, string> = {};
  for (const p of given) {
    const k = typeof p?.key === "string" ? p.key.trim() : "";
    if (!key.test(k)) throw new McpError(400, `"${k}" is not a valid ${what} name`);
    if (k in out) throw new McpError(400, `${what} ${k} is given twice`);
    if (p.value === undefined) {
      if (!saved || !(k in saved)) throw new McpError(400, `give a value for ${what} ${k}`);
      out[k] = saved[k]!;
    } else out[k] = text(p.value, `the value of ${k}`, 8192);
  }
  return out;
}

// ----------------------------------------------------------------- changes

function changed(servers: McpServer[], now: number): void {
  writeRegistry({ version: 1, changedAt: now, servers });
  try {
    pruneMcpFiles(now);
  } catch (e) {
    console.error("agentbox: pruning old MCP snapshots failed:", e);
  }
}

/** Launch snapshots (`claude-…`, `omp-…`, `proxy-…`, `devin-…`), named by a
 *  hash of what they hold, values included. */
const SNAPSHOT = /^(?:claude|omp|proxy|devin)-[0-9a-f]{24}(?:\.json)?$/;
/** A snapshot used this recently may be for a launch that has not started yet. */
const PRUNE_GRACE_MS = 10 * 60_000;

/**
 * Delete the snapshots nothing runs from, so a token taken off the list does
 * not stay on disk in them. A snapshot is kept while any process of ours
 * names it in its argv or environment (a CLI, or the proxy it started), with
 * whatever that one names in turn, and while it was used in the last
 * `PRUNE_GRACE_MS`. Without a process table to read, nothing is deleted.
 * The current list's snapshots are written again by the next launch.
 */
export function pruneMcpFiles(now = Date.now()): void {
  const dir = mcpDir();
  rmSync(`${registryPath()}.bak`, { force: true });
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => SNAPSHOT.test(n));
  } catch {
    return;
  }
  if (!names.length) return;
  const procs = findProcesses(() => true);
  if (!procs.length) return;
  const ref = new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([A-Za-z0-9._-]+)`, "g");
  const keep = new Set<string>();
  const pending: string[] = [];
  const scan = (text: string) => {
    for (const m of text.matchAll(ref)) {
      const name = m[1]!;
      if (!keep.has(name)) { keep.add(name); pending.push(name); }
    }
  };
  for (const p of procs) {
    scan(p.argv.join("\0"));
    const env = environOf(p.pid);
    if (env) for (const v of env.values()) if (v.includes(dir)) scan(v);
  }
  // A kept snapshot's own files name the proxies it starts.
  while (pending.length) {
    const name = pending.pop()!;
    if (!name.endsWith(".json")) keep.add(`${name}.json`);
    for (const f of name.endsWith(".json") ? [name] : [`${name}.json`, `${name}/mcp.json`, `${name}/devin/mcp_config.json`]) {
      try { scan(readFileSync(join(dir, f), "utf8")); } catch { /* not this kind */ }
    }
  }
  for (const name of names) {
    if (keep.has(name)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < PRUNE_GRACE_MS) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* gone already */
    }
  }
}

export function addServer(body: McpServerInput, now = Date.now()): McpServer {
  const r = readRegistry();
  const s = parseServer(body, null, now);
  if (r.servers.some((x) => x.name === s.name)) throw new McpError(409, `a global server named ${s.name} already exists`);
  changed([...r.servers, s], now);
  return s;
}

/** `name` is the saved one; the body may rename it. */
export function updateServer(name: string, body: McpServerInput, now = Date.now()): McpServer {
  const r = readRegistry();
  const saved = r.servers.find((x) => x.name === name);
  if (!saved) throw new McpError(404, `no global server named ${name}`);
  const s = parseServer(body, saved, now);
  if (s.name !== name && r.servers.some((x) => x.name === s.name)) throw new McpError(409, `a global server named ${s.name} already exists`);
  changed(r.servers.map((x) => (x.name === name ? s : x)), now);
  return s;
}

export function setEnabled(name: string, enabled: boolean, now = Date.now()): McpServer {
  const r = readRegistry();
  const saved = r.servers.find((x) => x.name === name);
  if (!saved) throw new McpError(404, `no global server named ${name}`);
  const s = { ...saved, enabled, updatedAt: now };
  changed(r.servers.map((x) => (x.name === name ? s : x)), now);
  return s;
}

export function removeServer(name: string, now = Date.now()): void {
  const r = readRegistry();
  if (!r.servers.some((x) => x.name === name)) throw new McpError(404, `no global server named ${name}`);
  changed(r.servers.filter((x) => x.name !== name), now);
}

/** Add a definition found in an agent's own config, values and all. */
export function importServer(def: Omit<McpServer, "createdAt" | "updatedAt" | "enabled">, now = Date.now()): McpServer {
  const r = readRegistry();
  if (r.servers.some((x) => x.name === def.name)) throw new McpError(409, `a global server named ${def.name} already exists; import it under another name`);
  const env = Object.entries(def.env ?? {}).map(([key, value]) => ({ key, value }));
  const headers = Object.entries(def.headers ?? {}).map(([key, value]) => ({ key, value }));
  const s = { ...parseServer({ ...def, env, headers, enabled: true }, null, now), from: def.from ?? null };
  changed([...r.servers, s], now);
  return s;
}

/** Two definitions that start the same server. */
export function sameServer(a: Pick<McpServer, "transport" | "command" | "args" | "env" | "url" | "headers">, b: typeof a): boolean {
  const norm = (s: typeof a) =>
    JSON.stringify(
      s.transport === "stdio"
        ? [s.command ?? "", s.args ?? [], Object.entries(s.env ?? {}).sort()]
        : [s.url ?? "", Object.entries(s.headers ?? {}).sort()],
    );
  return a.transport === b.transport && norm(a) === norm(b);
}

// --------------------------------------------------------------------- ACP

/** A literal configuration snapshot for clients whose native value syntax
 * would reinterpret secrets, or whose ACP transport support lacks HTTP. */
export function mcpProxy(s: McpServer, cwd = userHome()): { command: string; args: string[]; env: Record<string, string> } {
  const text = JSON.stringify({ ...s, cwd });
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 24);
  const file = join(ensureMcpDir(), `proxy-${hash}.json`);
  if (!existsSync(file)) writePrivate(file, text);
  else touch(file);
  return { command: process.execPath, args: [join(packageRoot, "src/core/mcp-proxy.ts"), file], env: {} };
}

/** Every ACP agent supports stdio; use it for HTTP when needed. A server
 *  that cannot be given (its command is not on the PATH) is left out and
 *  logged: the session opens with the rest. */
export function acpServers(caps: { http?: boolean } | undefined, cwd = userHome(), env: Record<string, string | undefined> = process.env): Record<string, unknown>[] {
  return enabledServers().flatMap((s): Record<string, unknown>[] => {
    try {
      if (s.transport === "stdio") {
        return [{ name: s.name, command: mcpExecutable(s, cwd, env), args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) }];
      }
      if (caps?.http) return [{ type: "http", name: s.name, url: s.url, headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })) }];
      const proxy = mcpProxy(s, cwd);
      return [{ name: s.name, command: proxy.command, args: proxy.args, env: [] }];
    } catch (e) {
      console.error(`agentbox: global MCP server ${s.name} is left out of this session: ${(e as Error).message}`);
      return [];
    }
  });
}
