/** `?mock=1`'s MCPs page: an in-memory list shaped like the server's (src/core/mcp.ts). */

import type { McpCheck, McpFound, McpReach, McpServerInput, McpServerView, McpState, ProviderId } from "../../src/core/types";

type Saved = Omit<McpServerView, "envKeys" | "headerKeys" | "reach" | "problem"> & { env: Record<string, string>; headers: Record<string, string> };

const T0 = Date.now();
let changedAt: number | null = T0 - 40 * 60_000;
let saved: Saved[] = [
  {
    name: "github",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "x" },
    url: null,
    headers: {},
    from: "Claude (~/.claude.json)",
    createdAt: T0 - 3 * 86_400_000,
    updatedAt: T0 - 40 * 60_000,
  },
  {
    name: "docs",
    enabled: false,
    transport: "http",
    command: null,
    args: [],
    env: {},
    url: "https://docs.example.com/mcp",
    headers: { Authorization: "x" },
    from: null,
    createdAt: T0 - 86_400_000,
    updatedAt: T0 - 86_400_000,
  },
];

const found: McpFound[] = [
  { id: "f1", provider: "claude", scope: "user", sources: ["~/.claude.json", "~/.local/share/agentbox/accounts/3f9a/.claude.json"], project: null, name: "github", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"], url: null, headerKeys: [], unsupported: null, global: "same" },
  { id: "f2", provider: "codex", scope: "user", sources: ["~/.codex/config.toml"], project: null, name: "playwright", transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"], envKeys: [], url: null, headerKeys: [], unsupported: null, global: "none" },
  { id: "f3", provider: "claude", scope: "project", sources: ["~/src/agentbox/.mcp.json"], project: "~/src/agentbox", name: "sentry", transport: "http", command: null, args: [], envKeys: [], url: "https://mcp.sentry.dev/mcp", headerKeys: ["Authorization"], unsupported: null, global: "none" },
  { id: "f4", provider: "opencode", scope: "user", sources: ["~/.config/opencode/opencode.json"], project: null, name: "linear", transport: null, command: null, args: [], envKeys: [], url: "https://mcp.linear.app/sse", headerKeys: [], unsupported: "an SSE server (agentbox carries commands and Streamable HTTP)", global: "none" },
];

const AGENTS: McpState["agents"] = [
  { provider: "claude", installed: true, supported: true, how: "Each session starts with --mcp-config and a file agentbox writes for its account" },
  { provider: "codex", installed: true, supported: true, how: "Adds global MCP overrides while preserving the selected profile" },
  { provider: "opencode", installed: true, supported: true, how: "Adds MCPs to the launch config, preserving explicit config and bridge settings" },
  { provider: "muse", installed: true, supported: true, how: "Each session starts with -c mcpServers.<name>; values go in the session's environment" },
  { provider: "devin", installed: false, supported: true, how: "Not installed on this computer" },
  { provider: "omp", installed: false, supported: true, how: "Not installed on this computer" },
];

function reach(s: Saved): McpReach[] {
  return AGENTS.map(({ provider, installed, supported }): McpReach => {
    const label: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", opencode: "opencode", muse: "Muse Code", devin: "Devin", omp: "omp" };
    if (!supported) return { provider, state: "unsupported", detail: `agentbox does not pass global servers to ${label[provider]} sessions yet` };
    if (!installed) return { provider, state: "unsupported", detail: `${label[provider]} is not installed` };
    if (provider === "claude" && s.name === "github") return { provider, state: "own", detail: "Claude keeps its enabled native server, even when the global entry is off" };
    if (!s.enabled) return { provider, state: "off", detail: "Global entry is off; native settings are unchanged" };
    if (provider === "codex" && s.name === "playwright") return { provider, state: "conflict", detail: "codex (default) has a different server named playwright, which Codex keeps there" };
    return { provider, state: "on", detail: provider === "opencode" ? "Passed to opencode sessions" : `Passed to 2 ${label[provider]} accounts` };
  });
}

function state(): McpState {
  const names = new Set(saved.map((s) => s.name));
  return {
    servers: saved.map(({ env, headers, ...s }) => ({ ...s, envKeys: Object.keys(env), headerKeys: Object.keys(headers), problem: null, reach: reach({ env, headers, ...s }) })),
    found: found.map((f) => ({ ...f, global: f.global === "same" || !names.has(f.name) ? (names.has(f.name) ? "same" : "none") : "different" })),
    agents: AGENTS,
    changedAt,
    sessions: [{ id: "a81c", title: "wham-usage · Add wham/usage fallback", provider: "codex", known: true, changedAt: T0 - 80 * 60_000, given: ["github"], kept: [] }],
    stale: changedAt ? [{ id: "a81c", title: "wham-usage · Add wham/usage fallback", provider: "codex", since: changedAt - 60_000 }] : [],
  };
}

function pairs(given: McpServerInput["env"], old: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of given ?? []) {
    if (!/^[A-Za-z0-9_.-]+$/.test(p.key)) throw new Error(`"${p.key}" is not a valid name`);
    if (p.value === undefined && !(p.key in old)) throw new Error(`give a value for ${p.key}`);
    out[p.key] = p.value ?? old[p.key]!;
  }
  return out;
}

function parse(b: McpServerInput, old: Saved | null): Saved {
  const name = (b.name ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("the name must be 1–64 letters, digits, - or _, starting with a letter or digit");
  if (b.transport === "stdio" && !b.command?.trim()) throw new Error("give the command that starts the server");
  if (b.transport === "http" && !/^https?:\/\//.test(b.url ?? "")) throw new Error("the URL must start with http:// or https://");
  const now = Date.now();
  return {
    name,
    enabled: b.enabled ?? old?.enabled ?? true,
    transport: b.transport,
    command: b.transport === "stdio" ? b.command!.trim() : null,
    args: b.transport === "stdio" ? (b.args ?? []) : [],
    env: b.transport === "stdio" ? pairs(b.env, old?.env ?? {}) : {},
    url: b.transport === "http" ? b.url!.trim() : null,
    headers: b.transport === "http" ? pairs(b.headers, old?.headers ?? {}) : {},
    from: old?.from ?? null,
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
  };
}

/** `rest` is the path after `/api/mcp`. */
export async function mockMcp(method: string, rest: string[], b: unknown): Promise<unknown> {
  const body = (b ?? {}) as Record<string, unknown>;
  const [kind, name, action] = rest;
  if (method === "GET") return state();
  const touch = () => {
    changedAt = Date.now();
  };
  if (kind === "servers" && !name && method === "POST") {
    const s = parse(body as unknown as McpServerInput, null);
    if (saved.some((x) => x.name === s.name)) throw new Error(`a global server named ${s.name} already exists`);
    saved = [...saved, s];
    touch();
    return state();
  }
  const old = saved.find((x) => x.name === name);
  if (kind === "servers" && name && !old) throw new Error(`no global server named ${name}`);
  if (kind === "servers" && method === "PUT") {
    const s = parse(body as unknown as McpServerInput, old!);
    saved = saved.map((x) => (x.name === name ? s : x));
    touch();
    return state();
  }
  if (kind === "servers" && action === "enabled") {
    saved = saved.map((x) => (x.name === name ? { ...x, enabled: body.enabled === true, updatedAt: Date.now() } : x));
    touch();
    return state();
  }
  if (kind === "servers" && method === "DELETE") {
    saved = saved.filter((x) => x.name !== name);
    touch();
    return state();
  }
  if (kind === "servers" && action === "check") {
    await new Promise((r) => setTimeout(r, 600));
    const check: McpCheck = old!.transport === "stdio" ? { ok: true, tools: ["create_issue", "get_pull_request", "search_code"], error: null, ms: 820 } : { ok: false, tools: [], error: "HTTP 401 Unauthorized", ms: 240 };
    return check;
  }
  if (kind === "import") {
    const f = found.find((x) => x.id === body.id);
    if (!f || f.unsupported) throw new Error("that server is no longer in the agent's config, or agentbox cannot carry it");
    if (f.scope === "project" && body.promote !== true) throw new Error("this server belongs to one project; promote it to make it global");
    const nm = typeof body.name === "string" && body.name.trim() ? body.name.trim() : f.name;
    if (saved.some((x) => x.name === nm)) throw new Error(`a global server named ${nm} already exists; import it under another name`);
    const now = Date.now();
    saved = [...saved, { name: nm, enabled: true, transport: f.transport!, command: f.command, args: f.args, env: Object.fromEntries(f.envKeys.map((k) => [k, "x"])), url: f.url, headers: Object.fromEntries(f.headerKeys.map((k) => [k, "x"])), from: `${f.provider} (${f.sources[0]})`, createdAt: now, updatedAt: now }];
    touch();
    return state();
  }
  throw new Error(`mock: no ${method} /api/mcp/${rest.join("/")}`);
}
