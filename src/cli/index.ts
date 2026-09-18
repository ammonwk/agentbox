/** The agentbox CLI, in a file TypeScript can see.
 *
 * `bin/agentbox` has no extension, so `tsc` silently skips it however the
 * `include` globs are written — the one file the user actually runs was
 * invisible to every gate in the project, and a correct refactor of paths.ts
 * shipped a boot-time `SyntaxError` past a clean typecheck, a full test run and
 * a successful UI build. Everything with logic in it lives here; `bin/agentbox`
 * is a shim with nothing left to break.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../core/git";
import { DEFAULT_PORT, agentboxHome, ensureDirs, webDist } from "../core/paths";
import { getSettings, listRepos } from "../core/db";
import { insertMember, removeMember, validates } from "./jsonc";
import { dependencies } from "../deps";
import type { DepStatus } from "../deps";
import { VERSION } from "../version";

/** `new URL(..).pathname` leaves spaces and non-ASCII percent-encoded. */
const AGENTBOX_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const OPENCODE_CONFIG =
  process.env.AGENTBOX_OPENCODE_CONFIG ?? join(homedir(), ".config", "opencode", "opencode.jsonc");

const MCP_KEY = "agentbox";
const MCP_PATH = ["mcp"];

function mcpEntry() {
  return {
    type: "local",
    command: ["bun", join(AGENTBOX_ROOT, "bin", "agentbox"), "mcp"],
  };
}

// ------------------------------------------------------------------ install

/** Copy the config aside before touching it, and say where the copy went. */
function backup(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${path}.agentbox-backup-${stamp}`;
  copyFileSync(path, dest);
  return dest;
}

/** Print the block to paste when we will not edit the file ourselves. */
function printManualBlock(reason: string): void {
  console.log(`✗ not editing ${OPENCODE_CONFIG}: ${reason}`);
  console.log(`\nAdd this inside the "mcp" object yourself:\n`);
  console.log(`    ${JSON.stringify(MCP_KEY)}: ${JSON.stringify(mcpEntry(), null, 2).split("\n").join("\n    ")}`);
}

function installMcp(): number {
  if (!existsSync(OPENCODE_CONFIG)) {
    printManualBlock("no config found at that path");
    return 1;
  }
  const raw = readFileSync(OPENCODE_CONFIG, "utf8");

  let next: string;
  try {
    next = insertMember(raw, MCP_PATH, MCP_KEY, mcpEntry());
  } catch (e) {
    const message = (e as Error).message;
    if (/already/.test(message)) {
      console.log("agentbox MCP is already registered in opencode.");
      return 0;
    }
    printManualBlock(message);
    return 1;
  }

  if (!validates(next, MCP_PATH)) {
    printManualBlock("the edit did not re-parse — refusing to write a file we cannot read back");
    return 1;
  }

  const saved = backup(OPENCODE_CONFIG);
  writeFileSync(OPENCODE_CONFIG, next);
  console.log(`✓ registered the agentbox MCP server in ${OPENCODE_CONFIG}`);
  console.log(`  backup: ${saved}`);
  console.log("  Restart opencode for it to take effect.");
  return 0;
}

function uninstallMcp(): number {
  if (!existsSync(OPENCODE_CONFIG)) {
    console.log(`nothing to do — no config at ${OPENCODE_CONFIG}`);
    return 0;
  }
  const raw = readFileSync(OPENCODE_CONFIG, "utf8");

  let next: string | null;
  try {
    next = removeMember(raw, MCP_PATH, MCP_KEY);
  } catch (e) {
    printManualBlock((e as Error).message);
    return 1;
  }
  if (next === null) {
    console.log("agentbox MCP is not registered — nothing to remove.");
    return 0;
  }
  if (!validates(next, MCP_PATH)) {
    printManualBlock("the edit did not re-parse — refusing to write a file we cannot read back");
    return 1;
  }

  const saved = backup(OPENCODE_CONFIG);
  writeFileSync(OPENCODE_CONFIG, next);
  console.log(`✓ removed the agentbox MCP server from ${OPENCODE_CONFIG}`);
  console.log(`  backup: ${saved}`);
  return 0;
}

// ------------------------------------------------------------------- doctor

type Check = { name: string; ok: boolean; detail: string; fatal: boolean };

/** Is `selector` a model omp can actually reach? */
function modelAvailable(selector: string, ompUsable: boolean): { ok: boolean; detail: string } {
  if (!ompUsable) return { ok: false, detail: "cannot check — omp is not usable (see above)" };
  // `find` takes a substring; the id after the provider prefix is the narrowest
  // one that still matches, and we compare full selectors below.
  const pattern = selector.includes("/") ? selector.slice(selector.lastIndexOf("/") + 1) : selector;
  const res = run(["omp", "models", "find", pattern, "--json"]);
  if (res.code !== 0) return { ok: false, detail: `omp models failed: ${res.stderr.trim().slice(0, 120)}` };
  let models: { selector: string }[];
  try {
    models = (JSON.parse(res.stdout) as { models: { selector: string }[] }).models;
  } catch {
    return { ok: false, detail: "could not parse `omp models --json` output" };
  }
  return models.some((m) => m.selector === selector)
    ? { ok: true, detail: selector }
    : { ok: false, detail: `${selector} is not in omp's model catalog` };
}

function doctor(): number {
  ensureDirs();
  const settings = getSettings();

  // `doctor` is an explicit "check now", so it forces a fresh probe rather
  // than reading whatever the cache last saw.
  const deps = dependencies(true);
  const uiBuilt = existsSync(join(webDist, "index.html"));

  const dep = (name: string, d: DepStatus, fatal: boolean): Check => ({
    name,
    ok: d.state === "ok",
    detail: d.detail ?? d.state,
    fatal,
  });

  const checks: Check[] = [
    { name: "data dir", ok: true, detail: agentboxHome(), fatal: false },
    // omp and git missing stop agentbox working; gh missing only makes PRs
    // invisible, which is a real problem but not a fatal one.
    dep("omp", deps.omp, true),
    dep("git", deps.git, true),
    dep("gh", deps.gh, false),
    {
      name: "web ui",
      ok: uiBuilt,
      detail: uiBuilt
        ? `built at ${webDist}`
        : "not built — run `bun run web:build` (the API works without it; the board does not)",
      fatal: false,
    },
  ];

  // A model that omp cannot reach is why a supervisor silently never fires.
  if (settings.supervisor.enabled) {
    checks.push({
      name: "supervisor model",
      ...modelAvailable(settings.supervisor.model, deps.omp.state === "ok"),
      fatal: false,
    });
  } else {
    checks.push({ name: "supervisor", ok: true, detail: "disabled", fatal: false });
  }
  if (settings.advisor.enabled) {
    checks.push({
      name: "advisor model",
      ...modelAvailable(settings.advisor.model, deps.omp.state === "ok"),
      fatal: false,
    });
  } else {
    checks.push({ name: "advisor", ok: true, detail: "disabled", fatal: false });
  }

  const repos = listRepos();
  checks.push({
    name: "repos",
    ok: true,
    detail: repos.length === 0 ? "none registered yet — add one in Settings" : `${repos.length} registered`,
    fatal: false,
  });

  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);

  const broken = checks.filter((c) => !c.ok);
  const fatal = broken.filter((c) => c.fatal);
  console.log(`\nagentbox ${VERSION} · home: ${agentboxHome()}`);
  if (broken.length === 0) {
    console.log("All good.");
  } else {
    console.log(
      `${broken.length} problem(s)${fatal.length > 0 ? `, ${fatal.length} of which stop agentbox working` : " — none fatal, but some features are off"}.`,
    );
  }
  return fatal.length > 0 ? 1 : 0;
}

// --------------------------------------------------------------------- main

const USAGE = `usage: agentbox [serve|watch|doctor|compact|install|uninstall|mcp|subagent-mcp|version]
  serve       start the server on port ${DEFAULT_PORT} (default)
  watch       live roster of running subagents; \`watch <name>\` for one in full
              (--once prints a frame and exits; --interrupt/--stop act on one)
  doctor      check that everything agentbox needs is present and configured
  compact     list oversized transcripts; \`compact --apply\` rewrites them without
              the subagent progress heartbeats that made them oversized
  install     register the MCP server with opencode
  uninstall   remove that registration
  mcp         run the board MCP server on stdio (opencode invokes this)
  subagent-mcp  run the subagent MCP server on stdio (Claude Code invokes this)
  host        run one session's agent (the server spawns these; not for hand use)
  version     print the version`;

/**
 * Run one command.
 *
 * Returns the exit code, or null when the command is a long-running process
 * that must be left alive — exiting on `serve` would stop the server it just
 * started.
 */
export async function main(argv: string[]): Promise<number | null> {
  const cmd = argv[0] ?? "serve";
  switch (cmd) {
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

    case "mcp":
      await import("../mcp/index");
      return null;

    /**
     * Watch the subagents, from outside the process that owns them.
     *
     * Reads the record on disk and talks to nothing, which is the only design
     * that can work: an agent's owner is an MCP server on somebody else's
     * stdio, with no address and a lifetime measured in one client session.
     */
    case "watch": {
      ensureDirs();
      const { watch } = await import("./watch");
      return watch(argv.slice(1));
    }

    /**
     * The subagent MCP server — a different surface from `mcp`, not a second
     * copy of it. `mcp` hands a conductor the board; this hands any MCP client
     * agents it calls like functions, in its own cwd, off the board entirely.
     */
    case "subagent-mcp":
      ensureDirs();
      await import("../mcp/subagent");
      return null;

    /**
     * Reclaim the disk a fan-out's progress heartbeats took, from transcripts
     * written before they stopped going to the log.
     */
    case "compact": {
      ensureDirs();
      const { compact } = await import("./compact");
      return compact(argv.slice(1));
    }

    case "install":
      ensureDirs();
      return installMcp();

    case "uninstall":
      return uninstallMcp();

    case "serve": {
      ensureDirs();
      const { startServer } = await import("../server/index");
      await startServer();
      return null;
    }

    /**
     * Run one session's agent. Spawned by the server, not by a person.
     *
     * This is the process that actually owns an omp child. It is a command
     * rather than something the server forks internally so that the agent is a
     * plain OS process with no tie to whoever started it: the server can be
     * restarted, upgraded or killed and this keeps running.
     */
    case "host": {
      const sessionId = argv[1];
      if (!sessionId) {
        console.error("agentbox host: a session id is required");
        return 2;
      }
      const flag = argv.indexOf("--first-message");
      const firstMessage = flag === -1 ? null : (argv[flag + 1] ?? null);
      ensureDirs();
      const { runHost } = await import("../core/host");
      return await runHost(sessionId, firstMessage);
    }

    default:
      console.error(`agentbox: unknown command "${cmd}"`);
      console.error(USAGE);
      return 2;
  }
}
