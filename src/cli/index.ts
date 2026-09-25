/** The agentbox CLI, in a file TypeScript can see.
 *
 * `bin/agentbox` has no extension, so `tsc` skips it however `include` is
 * written; everything with logic in it lives here and the shim stays empty.
 *
 * Most commands are thin clients of the running server: the server owns the
 * fleet and the balancer, so `agentbox claude` asks it where a new session
 * should go rather than deciding locally with stale numbers. If the server is
 * not running, the CLI starts it.
 */

import { existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT, agentboxBin, agentboxHome, ensureDirs, webDist } from "../core/paths";
import { listRepos } from "../core/db";
import { dependencies, type DepStatus } from "../deps";
import { VERSION } from "../version";
import { ApiError, apiClient, serverBase } from "../client";
import type { AppState, Placement, ProviderId, Session } from "../core/types";

const BASE = serverBase();
const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp"];

// ------------------------------------------------------------------ client

const api = apiClient(BASE);

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Start the server in the background if it is not already up. Detached into
 * its own session, so closing the terminal that happened to start it does not
 * take the board down with it.
 */
async function ensureServer(): Promise<void> {
  if (await reachable()) return;
  ensureDirs();
  const logDir = join(agentboxHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, "server.log"), "a");
  const p = Bun.spawn(["setsid", "bun", agentboxBin(), "serve"], {
    stdio: ["ignore", log, log],
    env: process.env,
  });
  p.unref();
  process.stderr.write("starting agentbox server…");
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(250);
    if (await reachable()) {
      process.stderr.write(" up\n");
      return;
    }
  }
  process.stderr.write("\n");
  throw new ApiError(`the server did not come up; see ${join(logDir, "server.log")}`);
}

/** Hand this terminal to tmux until you detach or the agent exits. */
async function attach(argv: string[]): Promise<number> {
  const env = { ...process.env } as Record<string, string>;
  // Attaching from inside your own tmux would otherwise refuse to nest; ours
  // is a different server, so nesting is exactly what is wanted.
  delete env.TMUX;
  const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env });
  return await p.exited;
}

// ----------------------------------------------------------------- commands

function parseFlags(args: string[]): { flags: Map<string, string | true>; rest: string[] } {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) {
      rest.push(a);
      continue;
    }
    const [, key, inline] = m;
    const takesValue = key === "account" || key === "model";
    if (inline !== undefined) flags.set(key!, inline);
    else if (takesValue && args[i + 1] !== undefined) flags.set(key!, args[++i]!);
    else flags.set(key!, true);
  }
  return { flags, rest };
}

/** `agentbox claude [--big] [--account X] [--model M] [--detach] [prompt…]` */
async function startSession(provider: ProviderId, args: string[]): Promise<number> {
  const { flags, rest } = parseFlags(args);
  await ensureServer();

  let accountId: string | null = null;
  const wanted = flags.get("account");
  if (typeof wanted === "string") {
    const state = await api<AppState>("GET", "/api/state");
    const match = state.accounts.find(
      (a) => a.provider === provider && (a.id === wanted || a.label === wanted || a.email === wanted),
    );
    if (!match) {
      console.error(`no ${provider} account "${wanted}" — have: ${state.accounts.filter((a) => a.provider === provider).map((a) => a.label).join(", ") || "none"}`);
      return 2;
    }
    accountId = match.id;
  }

  let out: { session: Session; placement: Placement };
  try {
    out = await api("POST", "/api/sessions", {
      provider,
      cwd: process.cwd(),
      prompt: rest.join(" ") || undefined,
      model: typeof flags.get("model") === "string" ? flags.get("model") : undefined,
      big: flags.has("big"),
      accountId,
    });
  } catch (e) {
    const err = e as ApiError;
    console.error(`agentbox: ${err.message}`);
    const placement = (err.data as { placement?: Placement } | null)?.placement;
    if (placement) printPlacement(placement);
    return 1;
  }

  const { session, placement } = out;
  const account = placement.candidates.find((c) => c.accountId === placement.accountId);
  process.stderr.write(`${session.id} → ${account?.label ?? placement.accountId}: ${placement.why}\n`);
  if (flags.has("detach")) {
    console.log(session.id);
    return 0;
  }
  const { argv } = await api<{ argv: string[] }>("GET", `/api/sessions/${session.id}/attach`);
  return attach(argv);
}

function printPlacement(p: Placement): void {
  for (const c of p.candidates) {
    const wk = c.weekly === null ? "   ?" : `${String(c.weekly).padStart(4)}%`;
    const eff = c.weeklyEffective === null ? "" : ` (+claims ${c.weeklyEffective}%)`;
    const sh = c.short === null ? "" : `  5h ${c.short}%`;
    console.error(`  ${c.eligible ? "✓" : "✗"} ${c.label.padEnd(24)} weekly ${wk}${eff}${sh}${c.reason ? `  — ${c.reason}` : ""}`);
  }
}

async function list(args: string[]): Promise<number> {
  const { flags } = parseFlags(args);
  await ensureServer();
  const state = await api<AppState>("GET", "/api/state");
  const accountLabel = new Map(state.accounts.map((a) => [a.id, a.label]));
  const rows = state.sessions.filter((s) => flags.has("all") || s.status !== "archived");
  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const s of rows) {
    const acct = s.accountId ? accountLabel.get(s.accountId) ?? "?" : "-";
    const where = s.host === "tmux" ? "box" : s.host === "external" ? "ext" : "   ";
    console.log(`${s.id}  ${s.status.padEnd(8)} ${where}  ${s.provider.padEnd(6)} ${acct.slice(0, 18).padEnd(18)}  ${s.title.slice(0, 70)}`);
  }
  return 0;
}

async function usage(): Promise<number> {
  await ensureServer();
  const state = await api<AppState>("GET", "/api/state");
  for (const a of state.accounts) {
    const windows = a.usage.windows
      .map((w) => `${w.label} ${Math.round(w.usedPct)}%`)
      .join(" · ");
    const claimed = a.claims.reduce((n, c) => n + c.outstanding, 0);
    console.log(`${a.provider.padEnd(6)} ${a.label.slice(0, 28).padEnd(28)} ${windows || "no reading"}${claimed ? `  (+${claimed} claimed)` : ""}${a.usage.stale ? `  [${a.usage.stale}]` : ""}`);
  }
  return 0;
}

async function onSession(verb: "attach" | "resume" | "adopt" | "stop", id: string | undefined): Promise<number> {
  if (!id) {
    console.error(`agentbox ${verb}: a session id is required (see \`agentbox ls\`)`);
    return 2;
  }
  await ensureServer();
  try {
    if (verb === "resume") await api("POST", `/api/sessions/${id}/resume`, {});
    if (verb === "adopt") await api("POST", `/api/sessions/${id}/adopt`, {});
    if (verb === "stop") {
      await api("POST", `/api/sessions/${id}/stop`, {});
      return 0;
    }
    const { argv } = await api<{ argv: string[] }>("GET", `/api/sessions/${id}/attach`);
    return attach(argv);
  } catch (e) {
    console.error(`agentbox ${verb}: ${(e as Error).message}`);
    return 1;
  }
}

// ------------------------------------------------------------------- doctor

type Check = { name: string; ok: boolean; detail: string; fatal: boolean };

function doctor(): number {
  ensureDirs();
  const deps = dependencies(true);
  const uiBuilt = existsSync(join(webDist, "index.html"));
  const dep = (name: string, d: DepStatus, fatal: boolean): Check => ({ name, ok: d.state === "ok", detail: d.detail ?? d.state, fatal });
  const which = (bin: string) => Bun.spawnSync(["sh", "-c", `command -v ${bin}`]).exitCode === 0;

  const checks: Check[] = [
    { name: "data dir", ok: true, detail: agentboxHome(), fatal: false },
    dep("tmux", deps.tmux, true),
    dep("git", deps.git, true),
    dep("gh", deps.gh, false),
    ...PROVIDERS.map((p) => ({ name: p, ok: which(p), detail: which(p) ? "on PATH" : "not installed", fatal: false })),
    {
      name: "web ui",
      ok: uiBuilt,
      detail: uiBuilt ? `built at ${webDist}` : "not built — run `bun run web:build`",
      fatal: false,
    },
    { name: "repos", ok: true, detail: `${listRepos().length} registered`, fatal: false },
  ];
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  const fatal = checks.filter((c) => !c.ok && c.fatal);
  console.log(`\nagentbox ${VERSION} · home: ${agentboxHome()}`);
  return fatal.length > 0 ? 1 : 0;
}

// --------------------------------------------------------------------- main

const USAGE = `usage: agentbox <command>
  serve                 run the server on port ${DEFAULT_PORT} (default command)
  claude|codex|devin|omp [--big] [--account NAME] [--model M] [--detach] [prompt…]
                        start a session here, on the account with the most room,
                        and attach this terminal to it (detach: Ctrl-b d)
  ls [--all] [--json]   list sessions
  usage                 each account's limits and what running sessions claim
  attach <id>           attach this terminal to a session in agentbox
  resume <id>           resume a stopped session (same account) and attach
  adopt <id>            move a session running in another terminal into agentbox
  stop <id>             end a session's process; it stays resumable
  mcp                   run the fleet MCP server on stdio (for a conductor session)
  subagent-mcp          run the omp subagent MCP server on stdio (needs no server)
  doctor                check that everything agentbox needs is present
  version               print the version`;

export async function main(argv: string[]): Promise<number | null> {
  const cmd = argv[0] ?? "serve";
  try {
    switch (cmd) {
      case "serve": {
        ensureDirs();
        const { startServer } = await import("../server/index");
        await startServer();
        return null;
      }
      case "claude":
      case "codex":
      case "devin":
      case "omp":
        return await startSession(cmd, argv.slice(1));
      case "ls":
      case "list":
        return await list(argv.slice(1));
      case "usage":
        return await usage();
      case "attach":
      case "resume":
      case "adopt":
      case "stop":
        return await onSession(cmd, argv[1]);
      case "mcp": {
        const { runMcp } = await import("../mcp/fleet");
        await runMcp(BASE);
        return null;
      }
      // Not a client of the server, unlike `mcp`: it owns its omp agents
      // itself and must work whether or not `agentbox serve` is running.
      case "subagent-mcp": {
        const { runSubagentMcp } = await import("../mcp/subagent");
        await runSubagentMcp();
        return null;
      }
      case "doctor":
        return doctor();
      case "version":
      case "--version":
      case "-v":
        console.log(`agentbox ${VERSION}`);
        return 0;
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      default:
        console.error(`agentbox: unknown command "${cmd}"\n`);
        console.error(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error(`agentbox: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
