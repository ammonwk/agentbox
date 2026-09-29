/** The systemd user service (systemd/agentbox.service): whether it is
 *  installed, and installing it for real paths.
 *
 * The shipped unit names `%h/Documents/agentbox`, which is only right for a
 * checkout that lives there. Onboarding writes the unit itself, with the
 * running build's own root baked in, so the recipe works from any clone path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome, userHome, packageRoot } from "./paths";

export const SERVICE_UNIT = "agentbox.service";

/** The unit's name, as `systemctl --user` says it. */
const unitDir = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(userHome(), ".config"), "systemd", "user");

/** Whether the service is installed and enabled; null where systemd is not. */
export function serviceInstalled(): boolean | null {
  if (!Bun.which("systemctl")) return null;
  return Bun.spawnSync(["systemctl", "--user", "is-enabled", SERVICE_UNIT], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/**
 * The unit, with this checkout's own paths in place of the shipped file's
 * `%h/Documents/agentbox`. A login shell still runs the server, so every
 * agent inherits the environment your terminals have (PATH, nvm, GH_TOKEN).
 */
export function unitText(): string {
  // Quoted, so a checkout under a path with spaces survives systemd's parser;
  // the log path follows AGENTBOX_HOME rather than assuming the default home.
  return `# agentbox's server as a service of your user's systemd, so it starts at boot
# (with lingering on, before anyone logs in) and a crash is recovered from
# without anyone there to restart it (src/core/recovery.ts). Written by
# \`agentbox onboard\` for the checkout at ${packageRoot}.

[Unit]
Description=agentbox: the board, the balancer and crash recovery for your agents
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory='${packageRoot}'
ExecStart=/bin/bash -lc 'exec "${process.execPath}" "${packageRoot}/bin/agentbox" serve'
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
# Ahead of the agents: each tmux pane is a scope of its own at the default 100.
CPUWeight=2000
IOWeight=1000
StandardOutput=append:${logPath()}
StandardError=append:${logPath()}

[Install]
WantedBy=default.target
`;
}

/** The server log, wherever AGENTBOX_HOME points — not assumed to be the default. */
const logPath = (): string => join(agentboxHome(), "logs", "server.log");

/**
 * Write the unit for this checkout and enable it now. Idempotent: rewriting
 * the file and re-enabling an enabled, running service change nothing.
 * Returns the unit path it wrote.
 */
export function installService(): string {
  if (!Bun.which("systemctl")) throw new Error("systemd is not available on this machine");
  const dir = unitDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SERVICE_UNIT);
  writeFileSync(path, unitText());
  const reload = Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stderr: "pipe" });
  if (reload.exitCode !== 0) throw new Error(`daemon-reload failed: ${reload.stderr.toString().trim()}`);
  const enable = Bun.spawnSync(["systemctl", "--user", "enable", "--now", SERVICE_UNIT], { stderr: "pipe" });
  if (enable.exitCode !== 0) throw new Error(`enable --now failed: ${enable.stderr.toString().trim()}`);
  return path;
}
