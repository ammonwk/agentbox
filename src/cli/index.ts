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
import { CLI_GUIDE } from "../core/cli-guide";
import { fixPwaDesktop } from "../core/pwa";
import { deriveIdentity, ensureUserEnv, userEnvPath } from "../core/user";
import { serviceInstalled } from "../core/service";
import { voiceConfig } from "../voice/config";
import * as verbs from "./sessions";
import * as schedules from "./schedules";
import type { AppState, Placement, ProviderId, Session } from "../core/types";
import type { RecoveryReport } from "../core/recovery";

const BASE = serverBase();
const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp"];

// ------------------------------------------------------------------ client

const api = apiClient(BASE);

/**
 * The server's CPU and IO share against its sibling scopes. Every agent pane
 * is a scope of its own with the default 100, so with a hundred agents busy an
 * unweighted server got a hundredth of the machine: 30 seconds to take a
 * phone's photo, and a message that took 5s to send and 5s more to appear.
 * It is light, and it is what you are looking at.
 */
const SERVER_WEIGHT = ["CPUWeight=2000", "IOWeight=1000"];

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Start the server in the background if it is not already up: its service
 * when that is installed, else detached into its own session, so closing the
 * terminal that happened to start it does not take the board down with it —
 * and, where systemd is there, into its own scope, with SERVER_WEIGHT.
 */
async function ensureServer(): Promise<void> {
  if (await reachable()) return;
  ensureDirs();
  const logDir = join(agentboxHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  // The service (systemd/agentbox.service), where it is installed: started
  // there, the server has the environment it has at boot, not this shell's.
  const service = Bun.which("systemctl") && Bun.spawnSync(["systemctl", "--user", "cat", "agentbox.service"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  if (service) Bun.spawnSync(["systemctl", "--user", "start", "agentbox.service"], { stdout: "ignore", stderr: "inherit" });
  else {
    const log = openSync(join(logDir, "server.log"), "a");
    const serve = ["setsid", "bun", agentboxBin(), "serve"];
    const scoped = Bun.which("systemd-run")
      ? ["systemd-run", "--user", "--scope", "--collect", "--quiet", "--unit=agentbox-serve", ...SERVER_WEIGHT.flatMap((w) => ["-p", w])]
      : [];
    const p = Bun.spawn([...scoped, ...serve], {
      stdio: ["ignore", log, log],
      env: process.env,
    });
    p.unref();
  }
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
      // Started from inside another session, it is that session's child.
      callerPid: process.pid,
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

async function usage(): Promise<number> {
  await ensureServer();
  const state = await api<AppState>("GET", "/api/state");
  for (const a of state.accounts) {
    const windows = a.usage.windows
      .map((w) => `${w.label} ${Math.round(w.usedPct)}%`)
      .join(" · ");
    // Weekly points its live sessions are expected to spend on top of the
    // reading; the balancer counts them as already used.
    const claimed = Math.round(a.claims.reduce((n, c) => n + c.outstanding, 0));
    const n = a.claims.filter((c) => c.outstanding > 0).length;
    const claims = claimed ? `  +${claimed}% weekly claimed by ${n} session${n === 1 ? "" : "s"}` : "";
    console.log(`${a.provider.padEnd(6)} ${a.label.slice(0, 28).padEnd(28)} ${windows || "no reading"}${claims}${a.usage.stale ? `  [${a.usage.stale}]` : ""}`);
  }
  return 0;
}

async function onSession(verb: "attach" | "resume" | "adopt", id: string | undefined): Promise<number> {
  if (!id) {
    console.error(`agentbox ${verb}: a session id is required (see \`agentbox ls\`)`);
    return 2;
  }
  await ensureServer();
  try {
    if (verb === "resume") await api("POST", `/api/sessions/${id}/resume`, {});
    if (verb === "adopt") await api("POST", `/api/sessions/${id}/adopt`, {});
    const { argv } = await api<{ argv: string[] }>("GET", `/api/sessions/${id}/attach`);
    return attach(argv);
  } catch (e) {
    console.error(`agentbox ${verb}: ${(e as Error).message}`);
    return 1;
  }
}

// ------------------------------------------------------------------ onboarding

/**
 * Derive who agentbox works for from the machine — git, gh, the passwd entry,
 * the timezone — write what is missing to `user.env`, and report. The point is
 * to ask for nothing the box already knows: every line says where it came
 * from, and the only advice left is what could not be derived.
 */
function onboard(): number {
  ensureDirs();
  // Derive before writing: after ensureUserEnv the file holds every key, and
  // re-deriving would report "user.env" for values that came from git and gh.
  const { identity, sources } = deriveIdentity();
  const wrote = ensureUserEnv();
  if (wrote) console.log(wrote);
  else console.log(`already onboarded: ${userEnvPath()}`);
  console.log("");
  const row = (k: string, v: string, from: string) => console.log(`  ${k.padEnd(9)} ${v.padEnd(30)} ${from}`);
  row("name", identity.name, sources.name);
  row("email", identity.email || "—", sources.email);
  row("github", identity.github || "—", sources.github);
  row("timezone", identity.timezone, sources.timezone);
  console.log("");
  const missing: string[] = [];
  const deps = dependencies(false);
  for (const n of ["tmux", "git", "gh"] as const) {
    if (deps[n].state !== "ok") missing.push(`${n}: ${deps[n].detail ?? deps[n].state}`);
  }
  const voice = voiceConfig();
  if ("missing" in voice) missing.push(`voice: missing ${voice.missing}`);
  if (serviceInstalled() === false) missing.push("service: not installed — the board's first-run card can install it");
  if (!missing.length) console.log("dependencies: all good");
  else {
    console.log("still to set up:");
    for (const m of missing) console.log(`  ${m}`);
  }
  if (!identity.context) {
    console.log(`\noptional: add USER_CONTEXT=<a line about you> to ${userEnvPath()} — the voice agent reads it to know who it is talking to.`);
  }
  return 0;
}

// ------------------------------------------------------------------- doctor

type Check = { name: string; ok: boolean; detail: string; fatal: boolean };

/** Doctor fixes what it finds, and says so: the PWA entry's launcher class. */
function pwaDetail(): string {
  const fixed = fixPwaDesktop();
  return fixed.length ? `patched ${fixed.join(", ")} (Chrome's Wayland app-id bug)` : "ok";
}

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
    { name: "pwa", ok: true, detail: pwaDetail(), fatal: false },
  ];
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  const fatal = checks.filter((c) => !c.ok && c.fatal);
  console.log(`\nagentbox ${VERSION} · home: ${agentboxHome()}`);
  return fatal.length > 0 ? 1 : 0;
}

// --------------------------------------------------------------------- main

/** One recovery step per line: what was done to each session, and why. */
function printReport(r: RecoveryReport): void {
  const when = (at: number) => new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  console.log(`${r.dryRun ? "would recover" : "recovered"} after ${r.cause} · last seen ${when(r.lastSeen)}${r.dryRun ? "" : ` · at ${when(r.at)}`}`);
  if (r.steps.length === 0) console.log("  nothing to do");
  // Only an outcome that is not what the action says: a resume that failed.
  const expected: Record<string, string> = { resume: "resumed", park: "parked", revive: "comes back with its caller", leave: "nothing to bring back" };
  for (const s of r.steps) {
    const outcome = s.outcome && s.outcome !== expected[s.action] ? ` [${s.outcome}]` : "";
    console.log(`  ${s.id}  ${s.action.padEnd(6)}  ${s.title.slice(0, 60)} — ${s.why}${outcome}`);
  }
  for (const t of r.trouble) console.log(`  ! ${t.id} came back unable to act: ${t.what}`);
}

async function recover(args: string[]): Promise<number> {
  const ids = args.filter((a) => !a.startsWith("-"));
  if (ids.length) {
    printReport(await api<RecoveryReport>("POST", "/api/recovery", { ids, dryRun: args.includes("--dry-run") }));
    return 0;
  }
  const { last, preview } = await api<{ last: RecoveryReport | null; preview: RecoveryReport }>("GET", "/api/recovery");
  if (args.includes("--last")) {
    if (!last) console.log("agentbox has not recovered from a crash yet");
    else printReport(last);
  } else printReport(preview);
  return 0;
}

const USAGE = `usage: agentbox <command>
  serve                 run the server on port ${DEFAULT_PORT} (default command)
  claude|codex|devin|omp [--big] [--account NAME] [--model M] [--detach] [prompt…]
                        start a session here, on the account with the most room,
                        and attach this terminal to it (detach: Ctrl-b d)
  usage                 each account's limits and what running sessions claim
  attach <id>           attach this terminal to a session in agentbox

sessions (ids first on every line; verbs taking ids read them from stdin with -):
  ls [--status s,s] [--idle '>2h'] [--repo x] [--provider p] [--all] [--roots] [-q] [--json]
                        a session another started follows it, its title indented;
                        --roots leaves those out while their parent is on the board
  show <id>...          where it is, model, context, first/last prompt, last reply
  log <id> [-n turns] [--tools] [--thinking]    the conversation, oldest first
  grep <regex> [-i] [--all]                     search every conversation
  screen <id>...        what its terminal shows now
  diff <id>... [--stat] its worktree's changes
  send <id> <text…|->   type a message into it
  watch [<id>...|-] [--status blocked,waiting,running,stopped] [--once] [--now]
                        a line each time one starts asking, finishes its turn
                        (with the end of its last message), or stops; until killed
  close <id>...         stop it and take it, and the sessions it started, off the list; resumable
  reopen <id>...        put a closed one back on the list (still stopped)
  stop <id>...          end its process; it stays resumable
  resume|adopt <id>... [--detach]   one id on a terminal attaches; --detach or many do not
  label <id> [name]     rename it on the board (no name clears)
  recover [--last | --dry-run] [<id>...]
                        after a crash agentbox resumes what was working and parks
                        the rest by itself; this shows the last recovery (--last),
                        what one would do now (no ids), or recovers stopped ids

scheduled sessions (one-time ones show in the app as sessions; recurring ones in Settings):
  schedule <when> [--agent claude] [--cwd DIR] [--big] [--account A] [--model M] [--effort E] [--name N] <prompt…|->
                        start one later, in DIR (default: here). <when> is one quoted
                        argument: "in 4 hours", "tomorrow at 9am", "friday 5pm",
                        "every weekday at 8:30", "every 2 hours"
  schedules [--json]    what is set to start, soonest first
  unschedule <id>...    delete one; it will not start (sessions it started stay)
  mcp                   run the fleet MCP server on stdio (for a conductor session)
  subagent-mcp          run the omp/devin subagent MCP server on stdio (needs no server)
  doctor                check that everything agentbox needs is present
  onboard               derive who agentbox works for (git, gh, the system),
                        write user.env, and say what is still missing
  guide                 how an agent drives the fleet with this CLI
  version               print the version`;

export async function main(argv: string[]): Promise<number | null> {
  const cmd = argv[0] ?? "serve";
  try {
    switch (cmd) {
      case "serve": {
        ensureDirs();
        const wrote = ensureUserEnv();
        if (wrote) console.log(`agentbox: ${wrote}`);
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
        await ensureServer();
        return await verbs.ls(api, argv.slice(1));
      case "show":
      case "log":
      case "grep":
      case "screen":
      case "diff":
      case "send":
      case "label":
      case "watch":
        await ensureServer();
        return await verbs[cmd](api, argv.slice(1));
      case "close":
      case "reopen":
      case "stop":
        await ensureServer();
        return await verbs.each(api, cmd, argv.slice(1));
      // The old names, for scripts and agents that learnt them.
      case "schedule":
        await ensureServer();
        return await schedules.schedule(api, argv.slice(1));
      case "schedules":
        await ensureServer();
        return await schedules.list(api, argv.slice(1));
      case "unschedule":
        await ensureServer();
        return await schedules.unschedule(api, argv.slice(1));
      case "archive":
      case "unarchive":
        await ensureServer();
        return await verbs.each(api, cmd === "archive" ? "close" : "reopen", argv.slice(1));
      case "resume":
      case "adopt": {
        const rest = argv.slice(1);
        const ids = rest.filter((a) => !a.startsWith("-"));
        if (ids.length === 1 && !rest.includes("--detach") && process.stdout.isTTY) return await onSession(cmd, ids[0]);
        await ensureServer();
        return await verbs.each(api, cmd, rest.filter((a) => a !== "--detach"));
      }
      case "recover":
        await ensureServer();
        return await recover(argv.slice(1));
      case "usage":
        return await usage();
      case "attach":
        return await onSession(cmd, argv[1]);
      case "mcp": {
        const { runMcp } = await import("../mcp/fleet");
        await runMcp(BASE);
        return null;
      }
      // Not a client of the server, unlike `mcp`: it owns its agents
      // itself and must work whether or not `agentbox serve` is running.
      case "subagent-mcp": {
        const { runSubagentMcp } = await import("../mcp/subagent");
        await runSubagentMcp();
        return null;
      }
      case "doctor":
        return doctor();
      case "onboard":
        return onboard();
      case "guide":
        console.log(CLI_GUIDE);
        return 0;
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
    // An API refusal or a bad argument is a message, not a stack trace.
    if (e instanceof ApiError || e instanceof Error) {
      console.error(`agentbox ${cmd}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
