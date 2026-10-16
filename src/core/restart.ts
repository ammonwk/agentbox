/**
 * Restart the server's own service, as AGENTS.md says to: launchd on macOS,
 * systemd on Linux. Never by killing the process on the port. The command
 * runs detached, because it stops the process that started it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./paths";

export function serviceRestart(): string[] | null {
  if (process.platform === "darwin" && existsSync(join(userHome(), "Library", "LaunchAgents", "local.agentbox.server.plist")))
    return ["launchctl", "kickstart", "-k", `gui/${process.getuid!()}/local.agentbox.server`];
  if (Bun.which("systemctl") && Bun.spawnSync(["systemctl", "--user", "cat", "agentbox.service"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0)
    return ["systemctl", "--user", "restart", "agentbox.service"];
  return null;
}

/** Start the restart without waiting for it; false when no service is installed. */
export function restartService(): boolean {
  const argv = serviceRestart();
  if (!argv) return false;
  Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
  return true;
}
