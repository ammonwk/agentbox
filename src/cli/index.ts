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
import { listRepos, listAccounts } from "../core/db";
import { dependencies, type DepStatus } from "../deps";
import { VERSION } from "../version";
import { ApiError, apiClient, serverBase } from "../client";
import { CLI_GUIDE } from "../core/cli-guide";
import { fixPwaDesktop } from "../core/pwa";
import { deriveIdentity, ensureUserEnv, userEnvPath } from "../core/user";
import { serviceInstalled, lingering } from "../core/service";
import { voiceConfig } from "../voice/config";
import { pwaInstalled } from "../core/pwa";
import { identify } from "../core/accounts/identity";
import { onboardingItems } from "../core/onboarding";
import * as verbs from "./sessions";
import * as schedules from "./schedules";
import * as waits from "./waits";
import * as cards from "./cards";
import * as prs from "./prs";
import { handover, superagent, SUPERAGENT_USAGE } from "./superagents";
import { orgCommand, ORG_USAGE } from "./org";
import type { AppState, Placement, ProviderId, Session } from "../core/types";
import { accountProvider } from "../core/providers/account";
import type { RecoveryReport } from "../core/recovery";

const BASE = serverBase();
const PROVIDERS: ProviderId[] = ["claude", "codex", "devin", "omp", "opencode", "muse"];

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

/** Hand this terminal to tmux until you detach or the agent exits, then say
 *  how to get back: a detached terminal leaves no trace of which one it was. */
async function attach(id: string, argv: string[]): Promise<number> {
  const env = { ...process.env } as Record<string, string>;
  // Attaching from inside your own tmux would otherwise refuse to nest; ours
  // is a different server, so nesting is exactly what is wanted.
  delete env.TMUX;
  const p = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env });
  const code = await p.exited;
  // tmux has said why it could not attach.
  if (code !== 0) return code;
  const s = await api<Session>("GET", `/api/sessions/${id}`).catch(() => null);
  if (s && s.status !== "stopped" && s.status !== "closed") process.stderr.write(`detached from ${id} — agentbox attach ${id} to return\n`);
  else process.stderr.write(`${id} exited — agentbox resume ${id} to start it again\n`);
  return code;
}

// ----------------------------------------------------------------- commands

/** `agentbox claude [--account X] [--model M] [--claim PR] [--parent ID] [--org|--personal] [--repo R] [--ref REF] [--detach] [prompt…]`
 *
 *  A mistyped option is refused, not taken for a switch: `--acount work`
 *  would otherwise start on the balancer's pick with "work" in the prompt. */
async function startSession(provider: ProviderId, args: string[]): Promise<number> {
  const { flags, rest } = verbs.parseArgs(args, ["account", "model", "claim", "parent", "repo", "ref"], ["detach", "org", "personal", "help", "h"]);
  const str = (k: string): string | undefined => (typeof flags.get(k) === "string" ? (flags.get(k) as string) : undefined);
  // Asking how is not asking to start one.
  if (flags.has("help") || flags.has("h")) {
    console.log(usageOf(provider));
    return 0;
  }
  await ensureServer();

  let accountId: string | null = null;
  const wanted = flags.get("account");
  if (typeof wanted === "string") {
    const state = await api<AppState>("GET", "/api/state");
    const holder = accountProvider(provider);
    const match = state.accounts.find(
      (a) => a.provider === holder && (a.id === wanted || a.label === wanted || a.email === wanted),
    );
    if (!match) {
      console.error(`no ${holder} account "${wanted}" — have: ${state.accounts.filter((a) => a.provider === holder).map((a) => a.label).join(", ") || "none"}`);
      return 2;
    }
    accountId = match.id;
  }

  let out: { session: Session; placement: Placement };
  try {
    out = await api("POST", "/api/sessions", {
      provider,
      // A named repo is where it runs, not this directory.
      cwd: str("repo") ? undefined : process.cwd(),
      prompt: rest.join(" ") || undefined,
      model: str("model"),
      accountId,
      // In the org or on your own accounts; absent, its parent's, else your default.
      scope: flags.has("org") ? "org" : flags.has("personal") ? "personal" : undefined,
      // A repo by its owner/name, and a ref to read it at in a worktree of its own.
      repo: str("repo"),
      ref: str("ref"),
      claim: str("claim"),
      // Started from inside another session, it is that session's child;
      // `--parent` names it outright, for a program no session runs.
      callerPid: process.pid,
      parent: str("parent"),
    });
  } catch (e) {
    const err = e as ApiError;
    console.error(`agentbox: ${err.message}`);
    const placement = (err.data as { placement?: Placement } | null)?.placement;
    if (placement) printPlacement(placement);
    return 1;
  }

  const { session, placement } = out;
  const account = placement?.candidates.find((c) => c.accountId === placement.accountId);
  process.stderr.write(`${session.id} → ${account?.label ?? placement?.accountId ?? "?"}${placement ? `: ${placement.why}` : ""}\n`);
  if (flags.has("detach")) {
    console.log(session.id);
    return 0;
  }
  const { argv } = await api<{ argv: string[] }>("GET", `/api/sessions/${session.id}/attach`);
  return attach(session.id, argv);
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
    const have = a.usage.resets?.availableCount ?? 0;
    const resets = have > 0 ? `  ${have} usage reset${have === 1 ? "" : "s"} available` : "";
    console.log(`${a.provider.padEnd(6)} ${a.label.slice(0, 28).padEnd(28)} ${windows || "no reading"}${claims}${resets}${a.usage.stale ? `  [${a.usage.stale}]` : ""}`);
  }
  return 0;
}

async function onSession(verb: "attach" | "resume" | "adopt", given: string | undefined): Promise<number> {
  if (!given) {
    console.error(`agentbox ${verb}: a session id is required (see \`agentbox ls\`)`);
    return 2;
  }
  await ensureServer();
  try {
    // A unique prefix, as `show` and `close` take.
    const id = (await verbs.resolveIds(api, [given])).ids[0]!;
    if (verb === "resume") await api("POST", `/api/sessions/${id}/resume`, {});
    if (verb === "adopt") await api("POST", `/api/sessions/${id}/adopt`, {});
    const { argv } = await api<{ argv: string[] }>("GET", `/api/sessions/${id}/attach`);
    return await attach(id, argv);
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
 * from, and the only advice left is what could not be derived. The checklist
 * is the server's own computed state (the same object the board's first-run
 * card renders), so the two cannot disagree about what is still missing.
 */
async function onboard(): Promise<number> {
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
  // The checklist is computed from the same probes the server puts on the
  // cold state — no server needed, so this works before the first serve too.
  // An account counts only when its credentials read as ok: registered is
  // not logged in.
  const deps = dependencies(false);
  const accounts = listAccounts();
  const identities = await Promise.allSettled(accounts.map((a) => identify(a)));
  const items = onboardingItems({
    identity,
    depsOk: deps.tmux.state === "ok" && deps.git.state === "ok",
    ghReady: deps.gh.state === "ok",
    accountsReady: accounts.length > 0 && identities.some((r) => r.status === "fulfilled" && r.value.auth.state === "ok"),
    voiceReady: !("missing" in voiceConfig()),
    serviceInstalled: serviceInstalled(),
    lingering: lingering(),
    pwaInstalled: pwaInstalled(),
  });
  for (const it of items) {
    if (it.notApplicable) continue;
    console.log(`${it.done ? "✓" : "✗"} ${it.label}`);
  }
  const undone = items.filter((it) => !it.done && !it.notApplicable);
  if (undone.length === 0) console.log("\nnothing left to set up");
  else {
    console.log("\nstill to set up:");
    for (const it of undone) console.log(`  ${it.label}`);
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

  const voice = voiceConfig();
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
    {
      name: "service",
      ok: serviceInstalled() !== false,
      detail: serviceInstalled() === null ? "systemd not available" : serviceInstalled() ? "installed" : "not installed — the board's first-run card can install it",
      fatal: false,
    },
    { name: "linger", ok: lingering() !== false, detail: lingering() === null ? "no systemd" : lingering() ? "starts at boot" : "off — run `loginctl enable-linger`", fatal: false },
    { name: "voice", ok: !("missing" in voice), detail: "missing" in voice ? `missing ${voice.missing}` : "keys present", fatal: false },
    {
      name: "accounts",
      ok: listAccounts().length > 0,
      detail: listAccounts().length ? `${listAccounts().length} registered` : "none — add one in the web UI",
      fatal: false,
    },
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
  claude|codex|devin|omp|opencode|muse [--account NAME] [--model M] [--parent ID] [--detach]
         [--org|--personal] [--repo OWNER/NAME [--ref REF]] [prompt…]
                        start a session here, on the account with the most room,
                        and attach this terminal to it (detach: Ctrl-b d);
                        --parent puts it under that session (default: the one this runs in);
                        --org runs it on the org's accounts, where its members see it, --personal
                        on yours (default: its parent's, else \`agentbox org default\`);
                        --repo runs in that registered repo instead of here, --ref at that
                        branch, tag or commit in a worktree of its own (detached)
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
  send <id> [--wake] <text…|->   type a message into it; from an agent, refused when it would wake a
                        cold or stopped session (--wake: waking it is the point) or is one too many
  watch [<id>...|-] [--status blocked,waiting,running,stopped] [--once] [--now]
                        a line each time one starts asking, finishes its turn
                        (with the end of its last message), or stops; until killed
  close <id>...         stop it and take it, and the sessions it started, off the list; resumable
  reopen <id>...        put a closed one back on the list (still stopped)
  stop <id>...          end its process; it stays resumable
  resume|adopt <id>... [--detach]   one id on a terminal attaches; --detach or many do not
  move <id> [--account NAME] [--force] [text…]
                        continue it on another account, conversation and all: for one
                        stopped at its account's limit (agentbox moves each once by
                        itself). The account with room unless named; refused when
                        none can take it, or it is warm and not at a limit (--force)
  label <id> [name]     rename it on the board (no name clears)
  recover [--last | --dry-run] [<id>...]
                        after a crash agentbox resumes what was working and parks
                        the rest by itself; this shows the last recovery (--last),
                        what one would do now (no ids), or recovers stopped ids

waiting (the one way a session waits on anything outside its own turn: it is typed into the
session when it happened, when it can no longer happen, when the wait itself failed, or at its
timeout, each saying which; a parked session is resumed to hear it):
  wait pr <n|owner/repo#n|url> [--require 'Reviewed head'] [--only 'Build,API Tests'] [--head <sha>]
                        its checks concluding on that head (a failure ends it at once):
                        every check; --require names ones that must be among them;
                        --only waits for just those; Merge gate is excluded
  wait pr <n> --merged  its merge
  wait run <run id|url> [-R owner/repo]      a GitHub Actions run concluding
  wait job [--name N] -- <command…>          start a long command as a unit of its own, which
                        outlives this session's process, and be told how it ended
  wait session <id>...  the first of those sessions to end its turn or stop
  wait until [--every 2m] -- <command>       asked again and again: exit 0 is the event, 1 not yet
  wait time <45m>       nothing but the time
  waits [--session ID | --mine] [--all] [--json]   what is waited on, and how the rest ended
  unwait <id>...        cancel one; its session is not told

org (a team's shared accounts and skills, its members' sessions on their own machines: docs/org.md):
${ORG_USAGE.replace(/^agentbox /gm, "  ")}

superagents (programs that run on agentbox: docs/superagents.md):
${SUPERAGENT_USAGE.replace(/^agentbox /gm, "  ")}
  handover <from> <to> [--close]       what <from> started, its cards, PRs and their waits go to <to>; messages to <from> reach <to>

pull requests (who has one: no two sessions work the same PR):
  pr claim <n|owner/repo#n|url> [--for ID]   this session has it, and it says "you hold"; refused, naming the other session, if another live one does
  pr release [<n|…>]                 let go of what this session claimed (one, or all); its
                                     checks waits go too, a --merged wait stays
  pr who <n|…> [--json]              the session that has it ("(you)" after your own id), or "nobody" (exit 1)
  pr claims [--json]                 every PR a live session has
  claude|codex|… --claim <n|…> …     start a session that has the PR from its first moment, or does not start

cards (what a session hands the user to decide or to know; the app's Review page shows them):
  card add --kind decision|merged|note --title T --short S [--long L | --long-file F] [--pr URL]
           [--recommend R] [--default D --default-at <when>] [--key K] [--for <session>]
                        prints the card's id; the answer is typed into the session that
                        added it, as "[card N “title”] …". --key adds it once
  card list [--open|--later|--answered [--unread]|--closed] [--session ID] [--json]
  card show <id>        all of it, with the answer
  card ack <id>...      you have the answer that was waiting on it (--unread no longer lists it)
  card close <id> <why> withdraw it: the question went away

scheduled sessions (one-time ones show in the app as sessions; recurring ones in Settings):
  schedule <when> [--agent claude] [--fallback omp,codex] [--cwd DIR] [--account A] [--model M] [--effort E] [--name N] <prompt…|->
                        start one later, in DIR (default: here). <when> is one quoted
                        argument: "in 4 hours", "tomorrow at 9am", "friday 5pm",
                        "every weekday at 8:30", "every 2 hours"; --fallback: the
                        providers to start it on, in order, when --agent has no
                        account with room
           [--note-cmd CMD] [--same-session [--fresh-over 150k]]
                        for a recurring one: run CMD in DIR each time it comes due and
                        say what it prints before the prompt, nothing when it prints
                        nothing; --same-session says it to the session it started last,
                        and starts afresh once that holds over --fresh-over tokens
           [--org|--personal]
                        on the org's accounts or your own; absent, your default when it starts
  schedules [--json]    what is set to start, soonest first
  unschedule <id>...    delete one; it will not start (sessions it started stay)
  mcp                   run the fleet MCP server on stdio (for a conductor session)
  subagent-mcp          run the omp/devin subagent MCP server on stdio (needs no server)
  devin-bridge [status|start|restart|check]
                        the bridge that runs other providers' models in devin
                        (docs/devin-bridge.md); check tests it end to end
  doctor                check that everything agentbox needs is present
  onboard               derive who agentbox works for (git, gh, the system),
                        write user.env, and say what is still missing
  guide                 how an agent drives the fleet with this CLI
  version               print the version`;

/** Other names for commands USAGE lists, which it does not mention itself. */
const ALIASES: Record<string, string> = { list: "ls", cards: "card", prs: "pr", superagents: "superagent", archive: "close", unarchive: "reopen" };

/** USAGE's entries for one command: each line that starts with it (`resume|adopt`
 *  counts for both) and the lines indented under it. All of USAGE when it has none. */
function usageOf(cmd: string): string {
  const name = ALIASES[cmd] ?? cmd;
  const out: string[] = [];
  let taking = false;
  for (const line of USAGE.split("\n")) {
    const m = /^  (\S+)/.exec(line);
    if (m) taking = m[1]!.split("|").includes(name);
    else if (!line.startsWith("   ")) taking = false;
    if (taking) out.push(line);
  }
  return out.length ? `usage: agentbox\n${out.join("\n")}` : USAGE;
}

/** The command USAGE lists that is fewest edits from a mistyped one, if any is close. */
function closest(cmd: string): string | null {
  const names = new Set([...USAGE.split("\n").flatMap((l) => /^  (\S+)/.exec(l)?.[1]!.split("|") ?? []), ...Object.keys(ALIASES)]);
  const edits = (a: string, b: string): number => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length]!;
  };
  let best: string | null = null;
  let least = Math.max(2, Math.floor(cmd.length / 3)) + 1;
  for (const n of names) {
    const d = edits(cmd, n);
    if (d < least) [best, least] = [n, d];
  }
  return best;
}

/** `agentbox devin-bridge [status|start|restart|check|run]`. */
async function devinBridge(verb = "status"): Promise<number | null> {
  const service = await import("../bridge/service");
  const { bridgeUrl } = await import("../bridge/models");
  switch (verb) {
    case "run": {
      const { appendFileSync } = await import("node:fs");
      const { startBridge } = await import("../bridge/devin");
      startBridge({
        log: (line) => {
          const stamped = `${new Date().toISOString()} ${line}`;
          console.log(stamped);
          try {
            appendFileSync(service.bridgeLog(), stamped + "\n");
          } catch {}
        },
      });
      return null;
    }
    case "start":
    case "restart":
    case "status": {
      if (verb === "start") service.ensureBridge();
      if (verb === "restart") service.restartBridge();
      if (verb !== "status" && !(await service.bridgeUp())) {
        console.error(`agentbox: the devin bridge did not come up on ${bridgeUrl()}; \`agentbox devin-bridge run\` shows why`);
        return 1;
      }
      const res = await fetch(`${bridgeUrl()}/healthz`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
      if (!res?.ok) {
        console.log(`not running (${bridgeUrl()}); it starts with the first session on a bridged model, or \`agentbox devin-bridge start\``);
        return 1;
      }
      const h = (await res.json()) as { pid: number; upstream: string; chats: number; failed: number; lastChatAt: string | null; models: { uid: string; contextTokens: number; compaction: { spawn: number; apply: number; hard: number }; key: boolean }[] };
      console.log(`running on ${bridgeUrl()} (pid ${h.pid}) in front of ${h.upstream}; log ${service.bridgeLog()}`);
      console.log(`${h.chats} replies served, ${h.failed} failed${h.lastChatAt ? `, last ${h.lastChatAt}` : ""}`);
      for (const m of h.models) {
        console.log(`  ${m.uid}  window ${m.contextTokens}, summary from ${m.compaction.spawn}, swapped in at ${m.compaction.apply}${m.key ? "" : "  (no key)"}`);
      }
      return 0;
    }
    case "check": {
      const { checkBridge } = await import("../bridge/check");
      return await checkBridge();
    }
    default:
      console.error("usage: agentbox devin-bridge [status|start|restart|check|run]");
      return 2;
  }
}

export async function main(argv: string[]): Promise<number | null> {
  const cmd = argv[0] ?? "serve";
  // `agentbox <any verb> --help` asks how, and does nothing.
  if (argv[1] === "--help" || argv[1] === "-h") {
    console.log(usageOf(cmd));
    return 0;
  }
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
      case "go-login": {
        // The OpenCode Console sign-in for one OpenCode Go account, run by
        // the login manager in a terminal it reads (accounts/godevice.ts).
        if (!argv[1]) throw new Error("usage: agentbox go-login <account home>");
        const { runGoLogin } = await import("../core/accounts/godevice");
        return await runGoLogin(argv[1]);
      }
      case "claude":
      case "codex":
      case "devin":
      case "omp":
      case "opencode":
      case "muse":
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
      case "move":
      case "watch":
        await ensureServer();
        return await verbs[cmd](api, argv.slice(1));
      case "close":
      case "reopen":
      case "stop":
        await ensureServer();
        return await verbs.each(api, cmd, argv.slice(1));
      // The old names, for scripts and agents that learnt them.
      case "card":
      case "cards":
        await ensureServer();
        return await cards.card(api, argv.slice(1));
      case "pr":
      case "prs":
        await ensureServer();
        return await prs.pr(api, argv.slice(1));
      case "schedule":
        await ensureServer();
        return await schedules.schedule(api, argv.slice(1));
      case "schedules":
        await ensureServer();
        return await schedules.list(api, argv.slice(1));
      case "unschedule":
        await ensureServer();
        return await schedules.unschedule(api, argv.slice(1));
      case "superagent":
      case "superagents":
        await ensureServer();
        return await superagent(api, argv.slice(1));
      case "handover":
        await ensureServer();
        return await handover(api, argv.slice(1));
      case "org":
        return await orgCommand(api, ensureServer, argv.slice(1));
      case "wait":
        await ensureServer();
        return await waits.wait(api, argv.slice(1));
      case "waits":
        await ensureServer();
        return await waits.list(api, argv.slice(1));
      case "unwait":
        await ensureServer();
        return await waits.unwait(api, argv.slice(1));
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
      // A server of its own too: devin sessions on a bridged model talk to it.
      case "devin-bridge":
        return await devinBridge(argv[1]);
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
      default: {
        const near = closest(cmd);
        console.error(`agentbox: unknown command "${cmd}"${near ? ` — did you mean ${near}?` : ""}\nsee \`agentbox --help\` for every command`);
        return 2;
      }
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
