/** Global MCP launch layers and native config discovery.
 * Layers belong to agentbox; original config, profiles and credentials stay
 * where their CLI owns them. The layer never stops an agent from starting: a
 * server that cannot be given is left out, a layer that cannot be built is
 * left off, and either is logged and recorded in the session's
 * AGENTBOX_MCP_STATE for the MCPs page.
 */

import { existsSync, readFileSync, realpathSync, statSync, mkdirSync, readdirSync, symlinkSync, lstatSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { listAccounts, listRepos } from "./db";
import { claudeJsonPath, detectCli } from "./accounts/homes";
import { setsFlag, type Launch } from "./launch";
import { mcpDir, mcpExecutable, mcpProxy, ensureMcpDir, readRegistry, sameServer, touch, writePrivate, type McpServer } from "./mcp";
import { userHome } from "./paths";
import type { Command } from "./providers/types";
import type { Account, McpAgent, McpCheck, McpFound, McpReach, McpServerView, McpTransport, ProviderId } from "./types";

/** What one entry of an agent's own config says, as far as agentbox can carry it. */
interface Native {
  name: string;
  def: Pick<McpServer, "transport" | "command" | "args" | "env" | "url" | "headers"> | null;
  /** Why `def` is null: a shape agentbox does not carry. */
  unsupported: string | null;
  enabled?: boolean;
}

const PASSED: readonly ProviderId[] = ["claude", "codex", "opencode", "muse", "devin", "omp"];
const LABEL: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", devin: "Devin", omp: "omp", opencode: "opencode", muse: "Muse Code" };
const VARIABLE = /\$\{|\{(?:env|file):/;

// ------------------------------------------------------------ own configs

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read MCP configuration: ${path}`);
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const t = readText(path);
  if (t === null) return null;
  try {
    const v = JSON.parse(stripJsonComments(t));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid MCP configuration: ${path}`);
  }
}

/** JSONC to JSON: comments and trailing commas out, strings left alone. */
function stripJsonComments(t: string): string {
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"') j += t[j] === "\\" ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j;
    } else if (c === "/" && t[i + 1] === "/") {
      while (i < t.length && t[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && t[i + 1] === "*") {
      i = t.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else if (c === "," && /^\s*[}\]]/.test(t.slice(i + 1))) continue;
    else out += c;
  }
  return out.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, closing) => closing ?? match);
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
function strMap(v: unknown): Record<string, string> | null {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = obj(v);
  return Object.values(o).every((x) => typeof x === "string") ? (o as Record<string, string>) : null;
}

/** One definition, or why agentbox cannot carry it. */
function native(name: string, def: NonNullable<Native["def"]> | string): Native {
  if (typeof def === "string") return { name, def: null, unsupported: def };
  const values = [def.command ?? "", ...(def.args ?? []), def.url ?? "", ...Object.values(def.env ?? {}), ...Object.values(def.headers ?? {})];
  if (values.some((v) => VARIABLE.test(v))) return { name, def: null, unsupported: "a value refers to a variable, which each agent reads its own way" };
  return { name, def, unsupported: null };
}

/** Claude's and Muse's shape: `{command, args, env}` or `{type: "http", url, headers}`. */
function fromJsonShape(name: string, v: unknown, httpType: boolean): Native {
  const n = jsonShape(name, v, httpType);
  return { ...n, enabled: obj(v).enabled !== false && obj(v).disabled !== true };
}

function jsonShape(name: string, v: unknown, httpType: boolean): Native {
  const o = obj(v);
  const type = o.type ?? o.transport;
  if (o.oauth || o.auth || o.oauthClientId || o.oauthClientSecret || o.oauthResource !== undefined) return native(name, "its OAuth sign-in stays with this agent");
  if (typeof o.command === "string" && (type === undefined || type === "stdio")) {
    const args = o.args === undefined ? [] : strs(o.args);
    const env = strMap(o.env);
    if (!args || !env) return native(name, "its arguments or environment are not plain text");
    return native(name, { transport: "stdio", command: o.command, args, env });
  }
  if (typeof o.url === "string" && (httpType ? type === "http" || type === "streamable-http" : type === undefined || type === "http" || type === "streamable-http")) {
    const headers = strMap(o.headers);
    if (!headers) return native(name, "its headers are not plain text");
    return native(name, { transport: "http", url: o.url, headers });
  }
  if (type === "sse") return native(name, "an SSE server (agentbox carries commands and Streamable HTTP)");
  return native(name, "a kind of server agentbox does not carry");
}

function claudeServers(map: unknown): Native[] {
  return Object.entries(obj(map)).map(([name, v]) => fromJsonShape(name, v, true));
}

function codexServers(path: string): Native[] {
  const t = readText(path);
  if (t === null) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(t) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid MCP configuration: ${path}`);
  }
  return codexMap(parsed.mcp_servers);
}

function codexMap(map: unknown): Native[] {
  return Object.entries(obj(map)).map(([name, v]) => {
    const o = obj(v);
    if (typeof o.command === "string") {
      const args = o.args === undefined ? [] : strs(o.args);
      const env = strMap(o.env);
      if (!args || !env) return native(name, "its arguments or environment are not plain text");
      if (o.env_vars !== undefined || o.cwd !== undefined) return native(name, "it forwards variables or sets a directory, which other agents do not take");
      return native(name, { transport: "stdio", command: o.command, args, env });
    }
    if (typeof o.url === "string") {
      if (o.bearer_token_env_var !== undefined || o.env_http_headers !== undefined) return native(name, "its token comes from an environment variable");
      const headers = strMap(o.http_headers);
      if (!headers) return native(name, "its headers are not plain text");
      return native(name, { transport: "http", url: o.url, headers });
    }
    return native(name, "a kind of server agentbox does not carry");
  }).map((n) => ({ ...n, enabled: obj(obj(map)[n.name]).enabled !== false }));
}

function opencodeServers(cfg: Record<string, unknown> | null): Native[] {
  return Object.entries(obj(cfg?.mcp)).map(([name, v]) => {
    const o = obj(v);
    if (o.type === "local") {
      const command = strs(o.command);
      const env = strMap(o.environment);
      if (!command?.length || !env) return native(name, "its command or environment are not plain text");
      return native(name, { transport: "stdio", command: command[0]!, args: command.slice(1), env });
    }
    if (o.type === "remote" && typeof o.url === "string") {
      if (o.oauth !== undefined && o.oauth !== false) return native(name, "it signs in with OAuth, which stays with opencode");
      const headers = strMap(o.headers);
      if (!headers) return native(name, "its headers are not plain text");
      return native(name, { transport: "http", url: o.url, headers });
    }
    return native(name, "a kind of server agentbox does not carry");
  }).map((n) => ({ ...n, enabled: obj(obj(cfg?.mcp)[n.name]).enabled !== false }));
}

const xdgConfig = (): string => process.env.XDG_CONFIG_HOME || join(userHome(), ".config");
const opencodeConfigFiles = (): string[] => ["opencode.json", "opencode.jsonc", "config.json"].map((f) => join(xdgConfig(), "opencode", f));
const museSettings = (home: string): string => join(home, "muse", "settings.json");
const codexConfig = (home: string): string => join(home, "config.toml");

interface Context { cwd: string; carry: string[]; env: Record<string, string | undefined> }
const context = (): Context => ({ cwd: userHome(), carry: [], env: process.env });
function values(args: string[], ...flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (flags.includes(a) && args[i + 1] !== undefined) out.push(args[++i]!);
    else for (const flag of flags) if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  }
  return out;
}
function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  for (let d = resolve(cwd); ; d = dirname(d)) { dirs.unshift(d); if (dirname(d) === d) return dirs; }
}
const configRoot = (c: Context) => c.env.XDG_CONFIG_HOME || join(userHome(), ".config");
function ompHome(c: Context): string {
  const root = resolve(userHome(), c.env.PI_CONFIG_DIR || ".omp");
  const profile = values(c.carry, "--profile").at(-1) ?? c.env.OMP_PROFILE ?? c.env.PI_PROFILE;
  return profile ? join(root, "profiles", profile, "agent") : c.env.PI_CODING_AGENT_DIR || join(root, "agent");
}
function tomlConfig(path: string): Record<string, unknown> {
  const t = readText(path);
  if (t === null) return {};
  try { return Bun.TOML.parse(t) as Record<string, unknown>; } catch { throw new Error(`Invalid MCP configuration: ${path}`); }
}
function explicitClaude(c: Context): string[] {
  const out: string[] = [];
  for (let i = 0; i < c.carry.length; i++) {
    const a = c.carry[i]!;
    if (a === "--mcp-config") while (c.carry[i + 1] && !c.carry[i + 1]!.startsWith("-")) out.push(c.carry[++i]!);
    else if (a.startsWith("--mcp-config=")) out.push(a.slice(13));
  }
  return out;
}
function jsonArgument(arg: string, c: Context): Record<string, unknown> {
  if (arg.trim().startsWith("{")) {
    try { return obj(JSON.parse(arg)); } catch { throw new Error("Invalid explicit MCP JSON"); }
  }
  const path = resolve(c.cwd, arg);
  const cfg = readJson(path);
  if (!cfg) throw new Error(`Missing explicit MCP config: ${path}`);
  return cfg;
}

/** Native definitions in increasing precedence. Keeping even a disabled
 * name prevents a global entry from bypassing the user's choice. */
function ownServers(provider: ProviderId, account: Account | null, c = context()): Native[] {
  const dirs = ancestors(c.cwd);
  switch (provider) {
    case "claude": {
      const cfg = account ? readJson(claudeJsonPath(account)) : null;
      const own = setsFlag(c.carry, "--strict-mcp-config") ? [] : [
        ...claudeServers(cfg?.mcpServers),
        ...dirs.flatMap((d) => claudeServers(readJson(join(d, ".mcp.json"))?.mcpServers)),
        ...claudeServers(obj(obj(cfg?.projects)[c.cwd]).mcpServers),
      ];
      return [...own, ...explicitClaude(c).flatMap((v) => claudeServers(jsonArgument(v, c).mcpServers))];
    }
    case "codex": {
      if (!account) return [];
      const cfg = tomlConfig(codexConfig(account.home));
      const selected = values(c.carry, "-p", "--profile").at(-1) ?? (typeof cfg.profile === "string" ? cfg.profile : undefined);
      const own = [...codexMap(cfg.mcp_servers), ...dirs.flatMap((d) => codexServers(join(d, ".codex/config.toml")))];
      if (selected) own.push(...codexMap(obj(obj(cfg.profiles)[selected]).mcp_servers), ...codexServers(join(account.home, `${selected}.config.toml`)));
      for (const v of values(c.carry, "-c", "--config")) {
        try { own.push(...codexMap(obj(Bun.TOML.parse(v)).mcp_servers)); } catch { /* CLI validates non-MCP overrides */ }
      }
      return own;
    }
    case "muse": {
      const own = account ? Object.entries(obj(readJson(museSettings(account.home))?.mcpServers)).map(([n, v]) => fromJsonShape(n, v, false)) : [];
      for (const v of values(c.carry, "-c", "--config")) {
        const m = /^mcpServers\.([^.=]+)(?:\.[^=]+)?=(.*)$/.exec(v);
        if (m) { try { own.push(fromJsonShape(m[1]!, JSON.parse(m[2]!), false)); } catch { own.push(native(m[1]!, "an explicit config override")); } }
      }
      return own;
    }
    case "opencode": {
      const files = ["config.json", "opencode.json", "opencode.jsonc"].map((f) => join(configRoot(c), "opencode", f));
      if (c.env.OPENCODE_CONFIG) files.push(resolve(c.cwd, c.env.OPENCODE_CONFIG));
      for (const d of dirs) files.push(...["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"].map((f) => join(d, f)));
      if (c.env.OPENCODE_CONFIG_DIR) files.push(...["opencode.json", "opencode.jsonc"].map((f) => join(c.env.OPENCODE_CONFIG_DIR!, f)));
      const own = files.flatMap((f) => opencodeServers(readJson(f)));
      if (c.env.OPENCODE_CONFIG_CONTENT) own.push(...opencodeServers(jsonArgument(c.env.OPENCODE_CONFIG_CONTENT, c)));
      return own;
    }
    case "devin": {
      const files = [join(configRoot(c), "devin/config.json"), join(configRoot(c), "devin/mcp_config.json"),
        ...["config.json", "mcp_config.json", "config.local.json", "mcp_config.local.json"].map((f) => join(c.cwd, ".devin", f))];
      return files.flatMap((f) => Object.entries(obj(readJson(f)?.mcpServers)).map(([n, v]) => fromJsonShape(n, v, false)));
    }
    case "omp": {
      // Native OMP entries take precedence over extension MCPs. Imported
      // sources are also left alone where their names can be discovered.
      const own = ["claude", "codex", "opencode"].flatMap((p) => ownServers(p as ProviderId,
        p === "codex" ? { home: join(userHome(), ".codex") } as Account : p === "claude" ? { home: c.env.CLAUDE_CONFIG_DIR || join(userHome(), ".claude"), isDefault: !c.env.CLAUDE_CONFIG_DIR } as Account : account, { ...c, carry: [] }));
      const files = [join(c.cwd, ".mcp.json"), join(c.cwd, "mcp.json"),
        ...values(c.carry, "-e", "--extension").flatMap((d) => [join(resolve(c.cwd, d), ".mcp.json"), join(resolve(c.cwd, d), "mcp.json")]),
        join(ompHome(c), ".mcp.json"), join(ompHome(c), "mcp.json"), join(c.cwd, ".omp/.mcp.json"), join(c.cwd, ".omp/mcp.json")];
      own.push(...files.flatMap((f) => claudeServers(readJson(f)?.mcpServers)));
      const denied = strs(readJson(join(ompHome(c), "mcp.json"))?.disabledServers) ?? [];
      for (const name of denied) own.push({ ...native(name, "disabled in omp's own config"), enabled: false });
      return own;
    }
  }
}

// ---------------------------------------------------------------- layers

/** The servers an agent is given, and those its own config keeps instead. */
function split(own: Native[], servers: McpServer[]): { give: McpServer[]; kept: { server: McpServer; same: boolean }[] } {
  const byName = new Map(own.map((n) => [n.name, n]));
  const give: McpServer[] = [];
  const kept: { server: McpServer; same: boolean }[] = [];
  for (const s of servers) {
    const n = byName.get(s.name);
    if (!n) give.push(s);
    else kept.push({ server: s, same: !!n.def && sameServer(n.def, s) });
  }
  return { give, kept };
}

function writeIfChanged(path: string, text: string): void {
  if (readText(path) === text) touch(path);
  else writePrivate(path, text);
}

function claudeDef(s: McpServer): Record<string, unknown> {
  return s.transport === "stdio" ? { type: "stdio", command: s.command, args: s.args ?? [], env: s.env ?? {} } : { type: "http", url: s.url, headers: s.headers ?? {} };
}

const CODEX_MARK = "# Written by agentbox: its global MCP servers (the MCPs page). Changes here are replaced.";
const toml = (v: string): string => JSON.stringify(v);
const digest = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");

/** Content-addressed snapshots cannot change under a running session. */
function snapshot(kind: string, body: unknown): string {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const file = join(ensureMcpDir(), `${kind}-${digest(text).slice(0, 24)}.json`);
  writeIfChanged(file, text);
  return file;
}
/** Which global servers a launch gets, decided without writing anything. */
interface Plan {
  give: McpServer[];
  kept: { server: McpServer; same: boolean; enabled?: boolean }[];
  /** Enabled servers left out of this launch, and why (a command not on its PATH). */
  skipped: { name: string; why: string }[];
}
interface Layer extends Plan {
  args: string[];
  env: Record<string, string>;
  /** Names in `env` whose values hold server env or header values. */
  secret: string[];
}

/** Symlink the same config location, never credentials into another account.
 * Only Devin's MCP file differs; XDG_DATA_HOME and its auth remain untouched. */
function devinLayer(c: Context, give: McpServer[]): string {
  const source = configRoot(c);
  const native = obj(readJson(join(source, "devin/mcp_config.json"))?.mcpServers);
  const mcpServers = { ...Object.fromEntries(give.map((s) => [s.name, s.transport === "stdio" ? { command: s.command, args: s.args ?? [], env: s.env ?? {} } : { transport: "http", url: s.url, headers: s.headers ?? {} }])), ...native };
  const dir = join(ensureMcpDir(), `devin-${digest(JSON.stringify([source, mcpServers])).slice(0, 24)}`);
  mkdirSync(join(dir, "devin"), { recursive: true, mode: 0o700 });
  const linkOthers = (from: string, to: string, except: string) => {
    if (!existsSync(from)) return;
    for (const name of readdirSync(from)) {
      if (name === except) continue;
      const target = join(to, name);
      try { lstatSync(target); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        symlinkSync(join(from, name), target);
      }
    }
  };
  linkOthers(source, dir, "devin");
  linkOthers(join(source, "devin"), join(dir, "devin"), "mcp_config.json");
  writeIfChanged(join(dir, "devin/mcp_config.json"), JSON.stringify({ mcpServers }));
  touch(dir);
  return dir;
}

/** Reads the agent's own configs, so it throws when one cannot be read: the
 *  caller cannot tell which names it would keep. */
function plan(provider: ProviderId, account: Account | null, servers: McpServer[], c = context()): Plan {
  if (!servers.length) return { give: [], kept: [], skipped: [] };
  const own = ownServers(provider, account, c);
  const { give: pending, kept } = split(own, servers);
  const byName = new Map(own.map((n) => [n.name, n]));
  const give: McpServer[] = [];
  const skipped: Plan["skipped"] = [];
  for (const s of pending) {
    if (!s.enabled) continue;
    if (s.transport !== "stdio") give.push(s);
    else {
      try { give.push({ ...s, command: mcpExecutable(s, c.cwd, c.env) }); }
      catch (e) { skipped.push({ name: s.name, why: (e as Error).message }); }
    }
  }
  return { give, kept: kept.map((k) => ({ ...k, enabled: byName.get(k.server.name)?.enabled !== false })), skipped };
}

/** A URL whose query may carry a token: argv would show it. */
const queried = (s: McpServer): boolean => {
  try { return s.transport === "http" && !!new URL(s.url!).search; } catch { return false; }
};

/** The files and flags that hand `p.give` to the CLI. Writes private snapshots. */
function layer(provider: ProviderId, p: Plan, c: Context): Layer {
  const none: Layer = { ...p, args: [], env: {}, secret: [] };
  const give = p.give;
  if (!give.length) return none;
  switch (provider) {
    case "claude": {
      const file = snapshot("claude", { mcpServers: Object.fromEntries(give.map((s) => [s.name, claudeDef(s)])) });
      return { ...none, args: ["--mcp-config", file, ...explicitClaude(c)] };
    }
    case "codex": {
      const args: string[] = [];
      for (const s of give) {
        // CLI overrides preserve any selected profile. Keep secret values
        // (and a URL's query) in a private proxy snapshot, never in the
        // process's argument list.
        const secret = Object.keys(s.env ?? {}).length > 0 || Object.keys(s.headers ?? {}).length > 0 || queried(s);
        const def = secret ? { transport: "stdio", ...mcpProxy(s, c.cwd) } : s;
        const fields = def.transport === "stdio" ? `command = ${toml(def.command!)}, args = [${(def.args ?? []).map(toml).join(", ")}]` : `url = ${toml(s.url!)}`;
        args.push("-c", `mcp_servers.${toml(s.name)}={ ${fields} }`);
      }
      return { ...none, args };
    }
    case "opencode": {
      const existing = c.env.OPENCODE_CONFIG_CONTENT ? jsonArgument(c.env.OPENCODE_CONFIG_CONTENT, c) : {};
      const mcp = Object.fromEntries(give.map((s) => [s.name, s.transport === "stdio" ? { type: "local", command: [s.command!, ...(s.args ?? [])], environment: s.env ?? {}, enabled: true } : { type: "remote", url: s.url, headers: s.headers ?? {}, oauth: false, enabled: true }]));
      return { ...none, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...existing, mcp: { ...mcp, ...obj(existing.mcp) } }) }, secret: ["OPENCODE_CONFIG_CONTENT"] };
    }
    case "muse": {
      const args: string[] = [];
      const env: Record<string, string> = {};
      let n = 0;
      const vars = (m: Record<string, string> | undefined) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => {
        const name = `AGENTBOX_MCP_${++n}`; env[name] = v; return [k, `\${${name}}`];
      }));
      for (const s of give) {
        const def = queried(s) ? { ...mcpProxy(s, c.cwd), env: {} }
          : s.transport === "stdio" ? { command: s.command, args: s.args ?? [], env: vars(s.env) } : { url: s.url, headers: vars(s.headers) };
        args.push("-c", `mcpServers.${s.name}=${JSON.stringify(def)}`);
      }
      return { ...none, args, env, secret: Object.keys(env) };
    }
    case "devin": return { ...none, env: { XDG_CONFIG_HOME: devinLayer(c, give) } };
    case "omp": {
      if (setsFlag(c.carry, "--trusted-extension")) throw new Error("omp --trusted-extension cannot be combined with the global MCP extension; use --extension for this session");
      // OMP interprets bare env names and !commands in values. A private
      // stdio proxy passes literal values, including empty strings, unchanged.
      const file = snapshot("omp", { mcpServers: Object.fromEntries(give.map((s) => [s.name, { type: "stdio", ...mcpProxy(s, c.cwd) }])) });
      const dir = file.slice(0, -5);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeIfChanged(join(dir, "mcp.json"), readFileSync(file, "utf8"));
      writeIfChanged(join(dir, "package.json"), JSON.stringify({ name: "agentbox-global-mcp", version: "1.0.0", type: "module", main: "index.js" }));
      writeIfChanged(join(dir, "index.js"), "export default function () {}\n");
      touch(dir);
      return { ...none, args: ["--extension", dir] };
    }
  }
}

interface ManagedLaunch { args: string[]; restoreArgs: string[]; env: Record<string, string | null> }
/** Strip only the exact arguments previously injected by agentbox. Called
 * before persisting adopt/recovery flags, while the process env is available. */
export function cleanMcpLaunch(provider: ProviderId, launch: Launch, original?: ReadonlyMap<string, string>): Launch {
  let args = [...launch.args];
  const env = { ...launch.env };
  const marker = original?.get("AGENTBOX_MCP_LAUNCH");
  let managed: ManagedLaunch | null = null;
  if (marker) {
    try {
      const v = JSON.parse(marker);
      if (Array.isArray(v?.args) && Array.isArray(v.restoreArgs) && v.env && typeof v.env === "object") managed = v;
    } catch { /* below */ }
    // Resume as it was carried rather than not at all; the args the next
    // layer adds come after, so they still take effect.
    if (!managed) console.error("agentbox: a session's MCP launch metadata is unreadable; its flags are carried as they are");
  }
  if (managed) {
    for (const hash of managed.args) {
      for (let i = 0; i + 1 < args.length; i++) {
        if (digest(JSON.stringify(args.slice(i, i + 2))) === hash) { args.splice(i, 2); break; }
      }
    }
    // Claude's variadic flag is stored as one sequence hash.
    for (let size = args.length; size > 2; size--) for (let i = 0; i + size <= args.length; i++) {
      if (managed.args.includes(digest(JSON.stringify(args.slice(i, i + size))))) { args.splice(i, size); break; }
    }
    args.push(...managed.restoreArgs);
    for (const [k, v] of Object.entries(managed.env)) { if (v === null) delete env[k]; else env[k] = v; }
  }
  // Compatibility with launches made before metadata was introduced.
  const codexHome = original?.get("CODEX_HOME") || process.env.CODEX_HOME || join(userHome(), ".codex");
  const legacyCodex = !marker && readText(join(codexHome, "agentbox.config.toml"))?.startsWith(CODEX_MARK);
  args = args.filter((a, i, all) => {
    if (legacyCodex && provider === "codex" && (a === "-p" || a === "--profile") && all[i + 1] === "agentbox") return false;
    if (legacyCodex && provider === "codex" && a === "agentbox" && ["-p", "--profile"].includes(all[i - 1] ?? "")) return false;
    if (provider === "claude" && a === "--mcp-config" && all[i + 1]?.startsWith(`${mcpDir()}/claude-`) && (i + 2 === all.length || all[i + 2]!.startsWith("-"))) return false;
    if (provider === "claude" && a.startsWith(`${mcpDir()}/claude-`)) return false;
    if (provider === "muse" && ["-c", "--config"].includes(a) && /^mcpServers\..*AGENTBOX_MCP_/.test(all[i + 1] ?? "")) return false;
    if (provider === "muse" && /^mcpServers\..*AGENTBOX_MCP_/.test(a)) return false;
    return true;
  });
  if (env.OPENCODE_CONFIG === join(mcpDir(), "opencode.json")) delete env.OPENCODE_CONFIG;
  for (const k of Object.keys(env)) if (k.startsWith("AGENTBOX_MCP_")) delete env[k];
  return { args, env };
}

/** Anything an earlier agentbox MCP launch left in what this one carries. */
function carriesManaged(carry: string[], inherited: Record<string, string>): boolean {
  const dir = `${mcpDir()}/`;
  return Object.entries(inherited).some(([k, v]) => k.startsWith("AGENTBOX_MCP_") || v.includes(dir)) || carry.some((a) => a.includes(dir));
}

/**
 * `cmd` with the global MCP layer for its CLI, account and directory. With no
 * server enabled it is `cmd` itself, unchanged. It never throws: a server
 * that cannot be given is left out and the rest are given; a layer that
 * cannot be built (an agent config that does not parse, a snapshot that
 * cannot be written, a whole-map override) is left off. Either is logged and
 * recorded in AGENTBOX_MCP_STATE, which the MCPs page reads. Env values that
 * carry server secrets are named in `secret`, for a private launch.
 */
export function withGlobalMcp<C extends Command>(provider: ProviderId, account: Account, cmd: C, carry: string[] = [], cwd = userHome(), inherited: Record<string, string> = {}): C {
  let registry: ReturnType<typeof readRegistry>;
  try {
    registry = readRegistry();
  } catch (e) {
    return withoutLayer(provider, cmd, null, (e as Error).message);
  }
  if (!registry.servers.some((s) => s.enabled) && !carriesManaged(carry, inherited)) return cmd;
  if (registry.servers.some((s) => s.enabled) && (provider === "codex" || provider === "muse") && values(carry, "-c", "--config").some((v) => /^(?:mcp_servers|mcpServers)\s*=/.test(v))) {
    return withoutLayer(provider, cmd, registry.changedAt, "an explicit whole-map MCP override (-c mcp_servers=…) replaces the global list; per-server overrides keep both");
  }
  let l: Layer;
  let base = cmd;
  try {
    // The adopted shell's own OPENCODE_CONFIG_CONTENT is kept under the
    // adapter's (its bridge and briefing win, as without a layer) so its
    // MCP entries count as the agent's own.
    let merged = cmd;
    if (provider === "opencode" && inherited.OPENCODE_CONFIG_CONTENT) {
      const c = { cwd, carry, env: process.env };
      const native = jsonArgument(inherited.OPENCODE_CONFIG_CONTENT, c);
      const generated = cmd.env.OPENCODE_CONFIG_CONTENT ? jsonArgument(cmd.env.OPENCODE_CONFIG_CONTENT, c) : {};
      const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
        const result = { ...a };
        for (const [k, v] of Object.entries(b)) result[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(obj(a[k]), obj(v)) : v;
        return result;
      };
      const cfg = { ...native, ...generated, provider: merge(obj(native.provider), obj(generated.provider)), mcp: { ...obj(native.mcp), ...obj(generated.mcp) }, instructions: [...new Set([...(strs(native.instructions) ?? []), ...(strs(generated.instructions) ?? [])])] };
      merged = { ...cmd, env: { ...cmd.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) } };
    }
    const effective = { ...process.env, ...inherited, ...merged.env };
    for (const k of merged.unset ?? []) delete effective[k];
    const c: Context = { cwd, carry, env: effective };
    l = layer(provider, plan(provider, account, registry.servers, c), c);
    if (l.give.length) base = merged;
  } catch (e) {
    return withoutLayer(provider, cmd, registry.changedAt, (e as Error).message);
  }
  for (const s of l.skipped) console.error(`agentbox: global MCP server ${s.name} is left out of this ${LABEL[provider]} launch: ${s.why}`);
  let argv = [...base.argv];
  const restoreArgs: string[] = [];
  if (provider === "claude" && l.args.length) {
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--") break;
      if (argv[i] === "--mcp-config") {
        let end = i + 1;
        while (argv[end] && !argv[end]!.startsWith("-")) end++;
        restoreArgs.push(...argv.splice(i, end - i)); i--;
      } else if (argv[i]!.startsWith("--mcp-config=")) { restoreArgs.push(...argv.splice(i, 1)); i--; }
    }
  }
  const injected = provider === "claude" && l.args.length ? [l.args] : Array.from({ length: l.args.length / 2 }, (_, i) => l.args.slice(i * 2, i * 2 + 2));
  const managed: ManagedLaunch = { args: injected.map((a) => digest(JSON.stringify(a))), restoreArgs, env: {} };
  for (const k of Object.keys(l.env)) managed.env[k] = inherited[k] ?? process.env[k] ?? null;
  const state = mcpState(registry.changedAt, l, null);
  // Provider-supplied variables (OpenCode bridge settings) remain in cmd.env.
  const env = { ...base.env, ...l.env, AGENTBOX_MCP_LAUNCH: JSON.stringify(managed), AGENTBOX_MCP_STATE: state };
  argv.splice(provider === "muse" && ["resume", "exec"].includes(argv[1] ?? "") ? 2 : 1, 0, ...l.args, ...(provider === "claude" && l.args.length && !argv[1]?.startsWith("-") ? ["--"] : []));
  const secret = [...new Set([...(base.secret ?? []), ...l.secret])];
  return { ...base, argv, env, ...(secret.length ? { secret } : {}) };
}

/** What a session was handed, for the MCPs page (src/server/index.ts reads it back). */
function mcpState(changedAt: number | null, p: Plan, error: string | null): string {
  return JSON.stringify({ changedAt, given: p.give.map((s) => s.name), kept: p.kept.map((k) => ({ name: k.server.name, same: k.same, enabled: k.enabled })), skipped: p.skipped, error });
}

/** `cmd` launched without the global layer, and why, logged and recorded. */
function withoutLayer<C extends Command>(provider: ProviderId, cmd: C, changedAt: number | null, why: string): C {
  console.error(`agentbox: ${LABEL[provider]} launches without the global MCP servers: ${why}`);
  return { ...cmd, env: { ...cmd.env, AGENTBOX_MCP_STATE: mcpState(changedAt, { give: [], kept: [], skipped: [] }, why) } };
}

function targets(provider: ProviderId): (Account | null)[] {
  return provider === "opencode" || provider === "omp" || provider === "devin" ? [null] : listAccounts(provider);
}
const accountName = (a: Account | null): string => a ? a.label || a.email || a.id : "the agent's config";

/** Defaults for future launches. Project, profile and explicit settings are
 * resolved again in the session's own context; live snapshots are separate. */
export async function reachAll(): Promise<{ agents: McpAgent[]; reach: Map<string, McpReach[]> }> {
  const servers = readRegistry().servers;
  const reach = new Map<string, McpReach[]>(servers.map((s) => [s.name, []]));
  const agents: McpAgent[] = [];
  for (const provider of PASSED) {
    const installed = (await detectCli(provider)).installed;
    // Planned only: the page never writes the snapshots, which hold values.
    const layers = targets(provider).map((a) => {
      try { return { a, l: { ...plan(provider, a, servers), error: null as string | null } }; }
      catch (e) { return { a, l: { give: [], kept: [], skipped: [], error: (e as Error).message } }; }
    });
    const error = layers.map((x) => x.l.error).filter(Boolean).join("; ") || null;
    agents.push({ provider, installed, supported: true, how: error ?? howOf(provider, installed), error });
    for (const s of servers) reach.get(s.name)!.push(reachOne(provider, s, installed, layers));
  }
  return { agents, reach };
}
function reachOne(provider: ProviderId, s: McpServer, installed: boolean, layers: { a: Account | null; l: Plan & { error: string | null } }[]): McpReach {
  if (!installed) return { provider, state: "unsupported", detail: `${LABEL[provider]} is not installed; the launch integration is available` };
  if (!layers.length) return { provider, state: "unsupported", detail: "No accounts yet; new ones get the global list" };
  const errors = layers.filter((x) => x.l.error);
  if (errors.length) return { provider, state: "error", detail: `${errors.map((x) => x.l.error).join("; ")}. Sessions start without the global servers until this is fixed.` };
  const skipped = layers.flatMap((x) => x.l.skipped.filter((k) => k.name === s.name));
  if (skipped.length) return { provider, state: "error", detail: `${skipped[0]!.why}. Sessions start without this server; the others are given.` };
  const own = layers.flatMap((x) => x.l.kept.filter((k) => k.server.name === s.name).map((k) => ({ ...k, account: accountName(x.a) })));
  if (own.length) return { provider, state: own.every((k) => k.same && k.enabled) ? "own" : "conflict", detail: `${own.map((k) => `${k.account}: ${k.enabled ? (k.same ? "same native server remains enabled" : "different native server remains enabled") : "native server is disabled"}`).join("; ")}. ${s.enabled ? "Native settings take precedence." : "Turning off the global entry does not turn off native definitions."}` };
  if (!s.enabled) return { provider, state: "off", detail: "Global entry is off; project or profile definitions can still provide this name" };
  return { provider, state: "on", detail: "Configured for the next start or resume. Project, profile and explicit settings take precedence; connection is checked by the agent." };
}
function howOf(provider: ProviderId, installed: boolean): string {
  if (!installed) return "Launch integration available; CLI not installed on this computer";
  switch (provider) {
    case "claude": return "Adds --mcp-config alongside explicit MCP files";
    case "codex": return "Adds MCP config overrides while keeping the selected profile";
    case "opencode": return "Adds MCPs to the launch config, keeping existing files and bridge settings";
    case "muse": return "Adds MCP config overrides; secrets go in the session environment";
    case "devin": return "Uses a generated MCP config directory; existing settings and authentication stay in place";
    case "omp": return "Adds an MCP extension alongside the active profile and native config";
  }
}

// --------------------------------------------------------- what is there

interface FoundDef extends McpFound {
  def: Native["def"];
}

/**
 * Every MCP server the agents' own configs define, found by reading files
 * only: nothing is started. The same definition in several files (Claude
 * copies the default account's into each new one) is one entry.
 */
export function discover(): FoundDef[] {
  const out = new Map<string, FoundDef>();
  const registry = readRegistry().servers;
  const add = (provider: ProviderId, scope: McpFound["scope"], source: string, project: string | null, n: Native) => {
    const key = JSON.stringify([provider, scope, project, n.name, n.def, n.unsupported]);
    const id = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16);
    const hit = out.get(id);
    if (hit) {
      if (!hit.sources.includes(source)) hit.sources.push(source);
      return;
    }
    const g = registry.find((s) => s.name === n.name);
    out.set(id, {
      id,
      provider,
      scope,
      sources: [source],
      project,
      name: n.name,
      transport: (n.def?.transport ?? null) as McpTransport | null,
      command: n.def?.command ?? null,
      args: n.def?.args ?? [],
      envKeys: Object.keys(n.def?.env ?? {}),
      url: n.def?.url ?? null,
      headerKeys: Object.keys(n.def?.headers ?? {}),
      unsupported: n.enabled === false ? "disabled in the agent’s own settings; enable it there before importing" : n.unsupported,
      global: !g ? "none" : n.def && sameServer(n.def, g) ? "same" : "different",
      def: n.def,
    });
  };
  const seen = new Set<string>();
  const once = (path: string) => {
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      return false;
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  };

  const claudeFiles = [join(userHome(), ".claude.json"), ...listAccounts("claude").map(claudeJsonPath)];
  for (const f of claudeFiles) {
    if (!once(f)) continue;
    const cfg = readJson(f);
    for (const n of claudeServers(cfg?.mcpServers)) add("claude", "user", f, null, n);
    for (const [dir, p] of Object.entries(obj(cfg?.projects))) {
      for (const n of claudeServers(obj(p).mcpServers)) add("claude", "project", f, dir, n);
    }
  }
  for (const repo of listRepos()) {
    if (repo.kind !== "local") continue;
    const f = join(repo.ref, ".mcp.json");
    if (existsSync(f) && once(f)) for (const n of claudeServers(readJson(f)?.mcpServers)) add("claude", "project", f, repo.ref, n);
  }
  for (const home of [join(userHome(), ".codex"), ...listAccounts("codex").map((a) => a.home)]) {
    const f = codexConfig(home);
    if (once(f)) for (const n of codexServers(f)) add("codex", "user", f, null, n);
  }
  for (const a of listAccounts("codex")) {
    if (!existsSync(a.home)) continue;
    for (const f of readdirSync(a.home).filter((f) => f.endsWith(".config.toml"))) {
      const path = join(a.home, f);
      if (readText(path)?.startsWith(CODEX_MARK) || !once(path)) continue;
      for (const n of codexServers(path)) add("codex", "user", path, null, n);
    }
  }
  for (const repo of listRepos()) {
    if (repo.kind !== "local") continue;
    const codex = join(repo.ref, ".codex/config.toml");
    if (once(codex)) for (const n of codexServers(codex)) add("codex", "project", codex, repo.ref, n);
    for (const rel of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]) {
      const path = join(repo.ref, rel);
      if (once(path)) for (const n of opencodeServers(readJson(path))) add("opencode", "project", path, repo.ref, n);
    }
  }
  for (const f of opencodeConfigFiles()) if (once(f)) for (const n of opencodeServers(readJson(f))) add("opencode", "user", f, null, n);
  for (const a of listAccounts("muse")) {
    const f = museSettings(a.home);
    if (once(f)) for (const [name, v] of Object.entries(obj(readJson(f)?.mcpServers))) add("muse", "user", f, null, fromJsonShape(name, v, false));
  }
  for (const provider of ["devin", "omp"] as const) {
    const c = context();
    const files = provider === "devin" ? [join(configRoot(c), "devin/config.json"), join(configRoot(c), "devin/mcp_config.json")] : [join(ompHome(c), ".mcp.json"), join(ompHome(c), "mcp.json")];
    for (const f of files) if (once(f)) for (const [name, v] of Object.entries(obj(readJson(f)?.mcpServers))) add(provider, "user", f, null, fromJsonShape(name, v, false));
    for (const repo of listRepos()) {
      if (repo.kind !== "local") continue;
      const files = provider === "devin" ? [".devin/config.json", ".devin/mcp_config.json", ".devin/config.local.json", ".devin/mcp_config.local.json"] : [".omp/.mcp.json", ".omp/mcp.json", ".mcp.json", "mcp.json"];
      for (const rel of files) {
        const f = join(repo.ref, rel);
        if (!existsSync(f)) continue;
        for (const [name, v] of Object.entries(obj(readJson(f)?.mcpServers))) add(provider, "project", f, repo.ref, fromJsonShape(name, v, false));
      }
    }
  }
  return [...out.values()];
}

/** A found definition, with its values, to import. */
export function foundDefinition(id: string): (Native["def"] & { name: string; from: string; scope: McpFound["scope"] }) | null {
  const f = discover().find((x) => x.id === id);
  if (!f?.def || f.unsupported) return null;
  return { ...f.def, name: f.name, from: `${LABEL[f.provider]} (${f.sources[0]})`, scope: f.scope };
}

/** Without the values. */
export function publicFound(f: FoundDef): McpFound {
  const { def: _def, ...rest } = f;
  return rest;
}

// -------------------------------------------------------------- the page

/** What is wrong with a server that shows without starting it. */
function problemOf(s: McpServer): string | null {
  if (s.transport !== "stdio") return null;
  const cmd = s.command ?? "";
  if (cmd.includes("/")) {
    try {
      return statSync(cmd).isFile() ? null : `${cmd} is not a file`;
    } catch {
      return `${cmd} does not exist`;
    }
  }
  return Bun.which(cmd) ? null : `${cmd} is not on agentbox's PATH`;
}

export function viewOf(s: McpServer, reach: McpReach[]): McpServerView {
  return {
    name: s.name,
    enabled: s.enabled,
    transport: s.transport,
    command: s.command ?? null,
    args: s.args ?? [],
    envKeys: Object.keys(s.env ?? {}),
    url: s.url ?? null,
    headerKeys: Object.keys(s.headers ?? {}),
    from: s.from ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    problem: problemOf(s),
    reach,
  };
}

/**
 * Start the server the way an agent would, ask for its tools and stop it.
 * Only ever on the page's own request: finding servers never runs them.
 */
export async function checkServer(name: string, timeoutMs = 20_000): Promise<McpCheck> {
  const s = readRegistry().servers.find((x) => x.name === name);
  if (!s) throw new Error(`no global server named ${name}`);
  const started = Date.now();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "agentbox-check", version: "1" });
  let transport;
  if (s.transport === "stdio") {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const env = { ...(process.env as Record<string, string>), ...s.env };
    transport = new StdioClientTransport({ command: s.command!, args: s.args ?? [], env, cwd: userHome(), stderr: "ignore" });
  } else {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    transport = new StreamableHTTPClientTransport(new URL(s.url!), { requestInit: { headers: s.headers ?? {} } });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs / 1000}s`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: tools.map((t) => t.name).sort(), error: null, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, tools: [], error: (e as Error).message || String(e), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}
