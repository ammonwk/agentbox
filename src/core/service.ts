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

/** Where the user's own units live. */
const unitDir = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(userHome(), ".config"), "systemd", "user");

/** Whether the service is installed and enabled; null where systemd is not. */
export function serviceInstalled(): boolean | null {
  if (!Bun.which("systemctl")) return null;
  return Bun.spawnSync(["systemctl", "--user", "is-enabled", SERVICE_UNIT], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/**
 * Whether this user's systemd starts at boot rather than first login. The
 * unit alone is half the story: without lingering, `enable` starts the board
 * at the next login and it dies with that logout — the machine restarting
 * overnight brings nothing up. Probed, not assumed: it is a per-user setting
 * the user's machine may or may not have.
 */
export function lingering(): boolean | null {
  if (!Bun.which("loginctl")) return null;
  const uid = process.getuid?.() ?? 0;
  const r = Bun.spawnSync(["loginctl", "show-user", String(uid), "--property=Linger"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 && /Linger=yes/.test(r.stdout.toString());
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
 * Write the unit for this checkout, enable it now, and turn lingering on so
 * boot — not first login — starts it. Idempotent: rewriting the file and
 * re-enabling an enabled, running service change nothing. Returns what was
 * done, so the caller can say which half needed doing.
 */
export function installService(): { unit: string; lingering: boolean } {
  if (!Bun.which("systemctl")) throw new Error("systemd is not available on this machine");
  const dir = unitDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, SERVICE_UNIT);
  writeFileSync(path, unitText());
  const reload = Bun.spawnSync(["systemctl", "--user", "daemon-reload"], { stderr: "pipe" });
  if (reload.exitCode !== 0) throw new Error(`daemon-reload failed: ${reload.stderr.toString().trim()}`);
  const enable = Bun.spawnSync(["systemctl", "--user", "enable", "--now", SERVICE_UNIT], { stderr: "pipe" });
  if (enable.exitCode !== 0) throw new Error(`enable --now failed: ${enable.stderr.toString().trim()}`);
  // Boot-before-login is the point of the unit; a refusal here (some systems
  // gate it) is reported, not swallowed — the board would otherwise silently
  // start at first login and die with that logout.
  if (!Bun.which("loginctl")) {
    throw new Error("the service is installed, but loginctl is not available, so start-at-boot could not be checked — run `loginctl enable-linger` yourself");
  }
  const linger = Bun.spawnSync(["loginctl", "enable-linger"], { stderr: "pipe" });
  if (linger.exitCode !== 0 && lingering() !== true) {
    throw new Error(`the service is installed and running, but start-at-boot could not be turned on${linger.stderr.toString().trim() ? ` (${linger.stderr.toString().trim()})` : ""} — run \`loginctl enable-linger\` yourself`);
  }
  return { unit: path, lingering: true };
}
