/** Keeping the devin bridge running.
 *
 * The bridge is a process of its own, not part of `agentbox serve`: a devin
 * session talks to it on every model request, and restarting the server must
 * not cut a reply off (the server owns no agents). It runs as a transient
 * unit of the user's systemd, `agentbox-devin-bridge.service`, started the
 * first time a session needs it and restarted by systemd if it dies; where
 * there is no systemd it is a detached process. Nothing is installed, and a
 * reboot simply starts it again with the first session that is resumed.
 *
 * After changing `src/bridge/`, restart it yourself
 * (`agentbox devin-bridge restart`): a reply in flight is retried by devin.
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { logDir } from "../core/paths";
import { bridgePort } from "./models";

export const BRIDGE_UNIT = "agentbox-devin-bridge";

/** Settings of this process the bridge has to share: its port and thresholds
 *  are compiled into what sessions are told, it reads the same homes, and it
 *  asks the server where an omp that names no account goes. */
const PASSED = /^(AGENTBOX_DEVIN_|AGENTBOX_LONGCAT_|AGENTBOX_HOME$|AGENTBOX_PORT$|XDG_DATA_HOME$|HOME$)/;

export const bridgeLog = (): string => join(logDir(), "devin-bridge.log");

function systemctl(...args: string[]): number {
  try {
    return Bun.spawnSync(["systemctl", "--user", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode;
  } catch {
    return -1;
  }
}

/** Whether something answers on the bridge's port. Synchronous, since the
 *  adapters that need to know build their commands synchronously. */
export function bridgeListening(): boolean {
  try {
    const r = Bun.spawnSync(["curl", "-s", "-m", "1", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${bridgePort()}/healthz`], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return r.stdout.toString() === "200";
  } catch {
    return false;
  }
}

function argv(): string[] {
  return [process.execPath, join(import.meta.dir, "..", "..", "bin", "agentbox"), "devin-bridge", "run"];
}

function start(): void {
  const env = Object.entries(process.env).filter(([k, v]) => PASSED.test(k) && v !== undefined) as [string, string][];
  // A unit left over from a bridge that failed for good holds the name.
  systemctl("reset-failed", `${BRIDGE_UNIT}.service`);
  try {
    const r = Bun.spawnSync(
      [
        "systemd-run", "--user", "--quiet", "--collect", `--unit=${BRIDGE_UNIT}`,
        "-p", "Restart=on-failure", "-p", "RestartSec=1",
        ...env.map(([k, v]) => `--setenv=${k}=${v}`),
        ...argv(),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    if (r.exitCode === 0) return;
  } catch {
    // No systemd-run on this machine.
  }
  const log = openSync(bridgeLog(), "a");
  // macOS has no setsid(1); a detached child calls setsid() itself.
  if (process.platform === "darwin") {
    const [cmd, ...args] = argv();
    spawn(cmd!, args, { detached: true, stdio: ["ignore", log, log] }).unref();
    return;
  }
  Bun.spawn(["setsid", ...argv()], { stdin: "ignore", stdout: log, stderr: log }).unref();
}

/** Start the bridge unless it is already answering. Returns at once: devin
 *  takes seconds to make its first request and retries one that fails. */
export function ensureBridge(): void {
  if (bridgeListening()) return;
  if (systemctl("is-active", "--quiet", `${BRIDGE_UNIT}.service`) === 0) return; // still coming up
  start();
}

/** Stop it and start it again, for new code or new settings. */
export function restartBridge(): void {
  systemctl("stop", `${BRIDGE_UNIT}.service`);
  if (bridgeListening()) {
    // One started without systemd: ask whoever holds the port to go.
    try {
      const out = Bun.spawnSync(["ss", "-ltnpH", `sport = :${bridgePort()}`], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
      const pid = Number(/pid=(\d+)/.exec(out)?.[1]);
      if (pid) process.kill(pid, "SIGTERM");
    } catch {}
    Bun.sleepSync(500);
  }
  start();
}

/** Wait for the bridge to answer, for a caller about to use it itself. */
export async function bridgeUp(timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (bridgeListening()) return true;
    await Bun.sleep(200);
  }
  return false;
}
