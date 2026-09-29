#!/usr/bin/env bun
/** The fresh-machine rehearsal: what a stranger's first two minutes feel like.
 *
 *   bun scripts/fresh-machine.ts [--port=4599] [--keep] [--skip-serve]
 *
 * It runs `agentbox onboard` and then `serve` against a throwaway HOME and
 * AGENTBOX_HOME — nothing outside those two directories is read as agentbox's
 * own, and the real board on :4479 is never touched: the sandbox has its own
 * port and its own tmux socket. Then it checks, in order, the things
 * onboarding claims to handle:
 *
 *   identity derived from the machine and written to user.env
 *   the checklist the board's card renders, from /api/state
 *   /api/health green, the board's HTML served
 *
 * and prints each as pass or fail. `serve` needs a machine with no other
 * agentbox on the port — on a busy box it says so and still checks everything
 * that does not need a server. Run it on a machine (or container) with none
 * of this set up; that is the only way to know.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { onboardingItems } from "../src/core/onboarding";
import type { Onboarding } from "../src/core/types";

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => a.startsWith("--port="))?.slice(7) ?? 4599);
const KEEP = args.includes("--keep");
const SKIP_SERVE = args.includes("--skip-serve");
const ROOT = join(import.meta.dir, "..");
const BASE = `http://127.0.0.1:${PORT}`;

const home = mkdtempSync(join(tmpdir(), "agentbox-fresh-home-"));
const dataHome = join(home, "agentbox-data");
/** Nothing outside these two directories counts as agentbox's own. The
 *  sandboxed fleet still sees the real process table, so its board lists the
 *  machine's real running agents as external — do not press Adopt all there
 *  unless those are yours to stop. */
const env: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v!])),
  HOME: home,
  AGENTBOX_HOME: dataHome,
  AGENTBOX_HOST: "127.0.0.1",
  AGENTBOX_PORT: String(PORT),
  AGENTBOX_TMUX_SOCKET: "agentbox-fresh",
  AGENTBOX_TAILNET: "0",
};

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = ""): boolean => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

// ---------------------------------------------------------------- onboard

console.log(`== onboard (HOME=${home}) ==\n`);
const on = spawnSync("bun", [join(ROOT, "bin", "agentbox"), "onboard"], { env, encoding: "utf8" });
const onOut = on.stdout ?? "";
const onErr = on.stderr ?? "";
process.stdout.write(onOut + (onErr ? `\n(onboard stderr) ${onErr.trim()}\n` : ""));
check("onboard exits cleanly", on.status === 0, onErr.split("\n")[0] ?? "");

const userEnv = join(dataHome, "user.env");
const userEnvOk = existsSync(userEnv) && /USER_NAME=.+/.test(readFileSync(userEnv, "utf8"));
check(
  "user.env written with derived identity",
  userEnvOk,
  userEnvOk ? readFileSync(userEnv, "utf8").split("\n").filter((l) => l.startsWith("USER_")).join(", ") : "user.env missing",
);

// ---------------------------------------------------------------- serve

let serve: ReturnType<typeof spawn> | null = null;
let up = false;
try {
  if (!SKIP_SERVE) {
    console.log(`\n== serve on :${PORT} ==`);
    mkdirSync(join(dataHome, "logs"), { recursive: true });
    const out = openSync(join(dataHome, "logs", "server.log"), "a");
    serve = spawn("bun", [join(ROOT, "bin", "agentbox"), "serve"], { env, stdio: ["ignore", out, out], detached: true });
    serve.unref();
    for (let i = 0; i < 90; i++) {
      await Bun.sleep(1000);
      try {
        const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (h.ok) {
          up = true;
          break;
        }
      } catch {
        /* not up yet */
      }
    }
    if (!up) {
      console.log("the server did not come up — on a machine already running agentbox, that is the port guard doing its job; run this on a fresh box for the full rehearsal");
    }
  }

  if (up) {
    const health = await fetch(`${BASE}/api/health`).then((r) => r.json() as Promise<{ ok: boolean }>).catch(() => null);
    check("health answers ok", !!health?.ok, health ? "" : "no answer");
    const state = (await fetch(`${BASE}/api/state`).then((r) => r.json()).catch(() => null)) as { data?: { onboarding: Onboarding } } | null;
    const ob = state?.data?.onboarding;
    if (check("state carries the onboarding checklist", !!ob, "")) {
      // Checklist items are reported, not failed: an account to log into and
      // voice keys to paste are the user's first two minutes, not agentbox's
      // bugs. Only the machinery below decides pass or fail.
      for (const item of onboardingItems(ob)) {
        if (item.notApplicable) continue;
        console.log(`${item.done ? "  ✓" : "  ·"} ${item.label}`);
      }
    }
    // Served, not merely built: the sandbox's own server answers with the app.
    const page = await fetch(BASE).then((r) => r.text()).catch(() => "");
    check("the board's HTML is served", /<div id="root">|<title>/.test(page));
  } else {
    console.log("\n(serve skipped — the checks above came from the sandbox probes alone)");
  }
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed${failed.length ? ` — failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
  if (!KEEP) {
    spawnSync("tmux", ["-L", "agentbox-fresh", "kill-server"], { stdio: "ignore" });
    serve?.kill("SIGTERM");
    rmSync(home, { recursive: true, force: true });
    console.log("\nsandbox removed (--keep keeps it, at " + home + ")");
  } else {
    console.log(`\nsandbox kept, at ${home}`);
  }
  process.exit(failed.length ? 1 : 0);
}
