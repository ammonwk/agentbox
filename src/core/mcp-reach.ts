/**
 * How the global MCP servers (src/core/mcp.ts) reach each agent, and what
 * each agent's own config already defines.
 *
 * agentbox never edits a CLI's own config to do it. Each CLI takes a layer
 * on top of its config at launch, and agentbox writes that layer itself:
 *
 * - claude: `--mcp-config <agentbox>/mcp/claude-<account>.json`. Claude lets
 *   that file's server replace a user-scope server of the same name, silently,
 *   so a name the account already defines is left out of it.
 * - codex: `-p agentbox`, which layers `$CODEX_HOME/agentbox.config.toml` over
 *   `config.toml`. The file is agentbox's (its first line says so); one that
 *   is not is never touched.
 * - opencode: `OPENCODE_CONFIG=<agentbox>/mcp/opencode.json`, unless the
 *   server's own environment sets OPENCODE_CONFIG.
 * - muse: `-c mcpServers.<name>=<json>` per server. Muse takes an env or
 *   header value only as a whole `${VAR}`, so each value is passed in a
 *   variable of the session's environment, `AGENTBOX_MCP_<n>`.
 *
 * A server whose name the agent's own config already uses is not passed to
 * that agent: the agent keeps its own, and the page says so. Devin and omp
 * sessions get none (not proven here); their ACP subagents are offered the
 * list by the subagent pool (`acpServers`).
 *
 * The layers are written when a session starts or resumes and whenever the
 * list changes, so a running agent keeps the set it started with until its
 * next start.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { listAccounts, listRepos } from "./db";
import { claudeJsonPath, detectCli } from "./accounts/homes";
import { setsFlag } from "./launch";
import { enabledServers, ensureMcpDir, readRegistry, sameServer, writePrivate, type McpServer } from "./mcp";
import { userHome } from "./paths";
import type { Command } from "./providers/types";
import type { Account, McpAgent, McpCheck, McpFound, McpReach, McpServerView, McpTransport, ProviderId } from "./types";

/** What one entry of an agent's own config says, as far as agentbox can carry it. */
interface Native {
  name: string;
  def: Pick<McpServer, "transport" | "command" | "args" | "env" | "url" | "headers"> | null;
  /** Why `def` is null: a shape agentbox does not carry. */
  unsupported: string | null;
}

const PASSED: readonly ProviderId[] = ["claude", "codex", "opencode", "muse"];
const LABEL: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", devin: "Devin", omp: "omp", opencode: "opencode", muse: "Muse Code" };
const VARIABLE = /\$\{|\{(?:env|file):/;

// ------------------------------------------------------------ own configs

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  const t = readText(path);
  if (t === null) return null;
  try {
    const v = JSON.parse(path.endsWith(".jsonc") ? stripJsonComments(t) : t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
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
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
function strMap(v: unknown): Record<string, string> | null {
  if (v === undefined) return {};
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
  const o = obj(v);
  const type = o.type;
  if (typeof o.command === "string" && (type === undefined || type === "stdio")) {
    const args = o.args === undefined ? [] : strs(o.args);
    const env = strMap(o.env);
    if (!args || !env) return native(name, "its arguments or environment are not plain text");
    return native(name, { transport: "stdio", command: o.command, args, env });
  }
  if (typeof o.url === "string" && (httpType ? type === "http" || type === "streamable-http" : type === undefined)) {
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
    return [];
  }
  return Object.entries(obj(parsed.mcp_servers)).map(([name, v]) => {
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
  });
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
  });
}

const xdgConfig = (): string => process.env.XDG_CONFIG_HOME || join(userHome(), ".config");
const opencodeConfigFiles = (): string[] => ["opencode.json", "opencode.jsonc", "config.json"].map((f) => join(xdgConfig(), "opencode", f));
const museSettings = (home: string): string => join(home, "muse", "settings.json");
const codexConfig = (home: string): string => join(home, "config.toml");

/** The servers an account's own config gives every session of it. */
function ownServers(provider: ProviderId, account: Account | null): Native[] {
  switch (provider) {
    case "claude":
      return account ? claudeServers(readJson(claudeJsonPath(account))?.mcpServers) : [];
    case "codex":
      return account ? codexServers(codexConfig(account.home)) : [];
    case "muse":
      return account ? Object.entries(obj(readJson(museSettings(account.home))?.mcpServers)).map(([n, v]) => fromJsonShape(n, v, false)) : [];
    case "opencode":
      return opencodeConfigFiles().flatMap((f) => opencodeServers(readJson(f)));
    default:
      return [];
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
  if (readText(path) === text) return;
  writePrivate(path, text);
}

function claudeDef(s: McpServer): Record<string, unknown> {
  return s.transport === "stdio" ? { type: "stdio", command: s.command, args: s.args ?? [], env: s.env ?? {} } : { type: "http", url: s.url, headers: s.headers ?? {} };
}

const CODEX_PROFILE = "agentbox";
const CODEX_MARK = "# Written by agentbox: its global MCP servers (the MCPs page). Changes here are replaced.";
const toml = (v: string): string => JSON.stringify(v);
const tomlTable = (m: Record<string, string>): string => `{ ${Object.entries(m).map(([k, v]) => `${toml(k)} = ${toml(v)}`).join(", ")} }`;

function codexLayer(servers: McpServer[]): string {
  const parts = [CODEX_MARK, ""];
  for (const s of servers) {
    parts.push(`[mcp_servers.${toml(s.name)}]`);
    if (s.transport === "stdio") {
      parts.push(`command = ${toml(s.command!)}`, `args = [${(s.args ?? []).map(toml).join(", ")}]`);
      if (Object.keys(s.env ?? {}).length) parts.push(`env = ${tomlTable(s.env!)}`);
    } else {
      parts.push(`url = ${toml(s.url!)}`);
      if (Object.keys(s.headers ?? {}).length) parts.push(`http_headers = ${tomlTable(s.headers!)}`);
    }
    parts.push("");
  }
  return parts.join("\n");
}

const codexLayerPath = (home: string): string => join(home, `${CODEX_PROFILE}.config.toml`);

/** A layer file at that path that is not agentbox's: never touched. */
function foreign(path: string): boolean {
  const t = readText(path);
  return t !== null && !t.startsWith(CODEX_MARK);
}

interface Layer {
  give: McpServer[];
  kept: { server: McpServer; same: boolean }[];
  /** The flags and variables that hand `give` to the CLI. */
  args: string[];
  env: Record<string, string>;
  error: string | null;
}

/**
 * Write the layer an account's sessions start with, and say how to hand it
 * to the CLI. Written even when it gives nothing, so a server taken off the
 * list leaves the file too.
 */
function layer(provider: ProviderId, account: Account | null, servers = enabledServers()): Layer {
  const { give, kept } = split(ownServers(provider, account), servers);
  const none: Layer = { give, kept, args: [], env: {}, error: null };
  switch (provider) {
    case "claude": {
      if (!account) return none;
      const file = join(ensureMcpDir(), `claude-${account.id}.json`);
      writeIfChanged(file, `${JSON.stringify({ mcpServers: Object.fromEntries(give.map((s) => [s.name, claudeDef(s)])) }, null, 2)}\n`);
      return { ...none, args: give.length ? ["--mcp-config", file] : [] };
    }
    case "codex": {
      if (!account || !existsSync(account.home)) return none;
      const file = codexLayerPath(account.home);
      if (foreign(file)) return { ...none, error: `${file} is not agentbox's, so it is left alone` };
      writeIfChanged(file, codexLayer(give));
      return { ...none, args: give.length ? ["-p", CODEX_PROFILE] : [] };
    }
    case "opencode": {
      if (process.env.OPENCODE_CONFIG) return { ...none, error: "agentbox's own environment sets OPENCODE_CONFIG, which it keeps" };
      const file = join(ensureMcpDir(), "opencode.json");
      const mcp = Object.fromEntries(
        give.map((s) => [s.name, s.transport === "stdio" ? { type: "local", command: [s.command!, ...(s.args ?? [])], environment: s.env ?? {}, enabled: true } : { type: "remote", url: s.url, headers: s.headers ?? {}, enabled: true }]),
      );
      writeIfChanged(file, `${JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2)}\n`);
      return { ...none, env: give.length ? { OPENCODE_CONFIG: file } : {} };
    }
    case "muse": {
      const args: string[] = [];
      const env: Record<string, string> = {};
      let n = 0;
      const vars = (m: Record<string, string> | undefined) =>
        Object.fromEntries(
          Object.entries(m ?? {}).map(([k, v]) => {
            const name = `AGENTBOX_MCP_${++n}`;
            env[name] = v;
            return [k, `\${${name}}`];
          }),
        );
      for (const s of give) {
        const def = s.transport === "stdio" ? { command: s.command, args: s.args ?? [], env: vars(s.env) } : { url: s.url, headers: vars(s.headers) };
        args.push("-c", `mcpServers.${s.name}=${JSON.stringify(def)}`);
      }
      return { ...none, args, env };
    }
    default:
      return none;
  }
}

/**
 * A session's command with the global servers added: right after the CLI's
 * name, where the flag that follows is always one of ours (so a variadic
 * `--mcp-config` cannot take the prompt). Never throws: a broken list or an
 * unwritable layer starts the session without them.
 */
export function withGlobalMcp<C extends Command>(provider: ProviderId, account: Account, cmd: C, carry?: string[]): C {
  if (!PASSED.includes(provider)) return cmd;
  try {
    const l = layer(provider, account);
    if (l.error) console.error(`agentbox: global MCP servers not passed to ${provider}: ${l.error}`);
    let args = l.args;
    // A session adopted from another terminal keeps the profile it ran with.
    if (provider === "codex" && carry && setsFlag(carry, "-p", "--profile")) args = [];
    if (provider === "claude" && carry && args[1] && carry.includes(args[1])) args = [];
    const at = provider === "opencode" ? cmd.argv.length : 1;
    return { ...cmd, argv: [...cmd.argv.slice(0, at), ...args, ...cmd.argv.slice(at)], env: { ...cmd.env, ...l.env } };
  } catch (e) {
    console.error(`agentbox: global MCP servers not passed to a ${provider} session:`, e);
    return cmd;
  }
}

// ---------------------------------------------------------- what reaches

/** The accounts whose sessions an agent's layer is written for. */
function targets(provider: ProviderId): (Account | null)[] {
  if (provider === "opencode") return [null];
  if (provider === "claude" || provider === "codex" || provider === "muse") return listAccounts(provider);
  return [];
}

const accountName = (a: Account | null): string => (a ? a.label || a.email || a.id : "");

/** For each server, how far it reaches; and every layer written now. */
export async function reachAll(): Promise<{ agents: McpAgent[]; reach: Map<string, McpReach[]> }> {
  const servers = readRegistry().servers;
  const enabled = servers.filter((s) => s.enabled);
  const reach = new Map<string, McpReach[]>(servers.map((s) => [s.name, []]));
  const agents: McpAgent[] = [];
  for (const provider of ["claude", "codex", "opencode", "muse", "devin", "omp"] as ProviderId[]) {
    const installed = (await detectCli(provider)).installed;
    const supported = PASSED.includes(provider);
    agents.push({ provider, installed, supported, how: howOf(provider, installed) });
    const layers = supported && installed ? targets(provider).map((a) => ({ a, l: layer(provider, a, enabled) })) : [];
    for (const s of servers) {
      reach.get(s.name)!.push(reachOne(provider, s, installed, supported, layers));
    }
  }
  return { agents, reach };
}

function reachOne(provider: ProviderId, s: McpServer, installed: boolean, supported: boolean, layers: { a: Account | null; l: Layer }[]): McpReach {
  const L = LABEL[provider];
  if (!supported) return { provider, state: "unsupported", detail: `agentbox does not pass global servers to ${L} sessions yet` };
  if (!installed) return { provider, state: "unsupported", detail: `${L} is not installed` };
  if (!s.enabled) return { provider, state: "off", detail: "Turned off" };
  if (layers.length === 0) return { provider, state: "unsupported", detail: `No ${L} accounts yet; new ones get it` };
  const errors = layers.filter((x) => x.l.error);
  if (errors.length) return { provider, state: "error", detail: errors.map((x) => x.l.error).join("; ") };
  const differ = layers.filter((x) => x.l.kept.some((k) => k.server.name === s.name && !k.same));
  const same = layers.filter((x) => x.l.kept.some((k) => k.server.name === s.name && k.same));
  const where = (xs: typeof layers) => (provider === "opencode" ? `opencode's config` : xs.map((x) => accountName(x.a)).join(", "));
  if (differ.length) {
    return { provider, state: "conflict", detail: `${where(differ)} ${differ.length === 1 ? "has" : "have"} a different server named ${s.name}, which ${L} keeps there` };
  }
  if (same.length === layers.length) return { provider, state: "own", detail: `${L} already has this server in its own config` };
  const n = layers.length - same.length;
  return { provider, state: "on", detail: provider === "opencode" ? "Passed to opencode sessions" : `Passed to ${n} ${L} account${n === 1 ? "" : "s"}${same.length ? `; ${where(same)} already ${same.length === 1 ? "has" : "have"} it` : ""}` };
}

function howOf(provider: ProviderId, installed: boolean): string {
  if (!installed) return "Not installed on this computer";
  switch (provider) {
    case "claude": return "Each session starts with --mcp-config and a file agentbox writes for its account";
    case "codex": return "Each session starts with -p agentbox, which adds agentbox.config.toml in the account's Codex home";
    case "opencode": return "Each session starts with OPENCODE_CONFIG set to a file agentbox writes";
    case "muse": return "Each session starts with -c mcpServers.<name>; values go in the session's environment";
    case "devin": return "Not passed to Devin sessions. Devin subagents over ACP are offered the servers (not checked on this computer)";
    case "omp": return "Not passed to omp sessions. omp subagents over ACP are offered the servers (not checked on this computer)";
    default: return "";
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
      unsupported: n.unsupported,
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
  for (const f of opencodeConfigFiles()) if (once(f)) for (const n of opencodeServers(readJson(f))) add("opencode", "user", f, null, n);
  for (const a of listAccounts("muse")) {
    const f = museSettings(a.home);
    if (once(f)) for (const [name, v] of Object.entries(obj(readJson(f)?.mcpServers))) add("muse", "user", f, null, fromJsonShape(name, v, false));
  }
  return [...out.values()];
}

/** A found definition, with its values, to import. */
export function foundDefinition(id: string): (Native["def"] & { name: string; from: string; scope: McpFound["scope"] }) | null {
  const f = discover().find((x) => x.id === id);
  if (!f?.def) return null;
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
