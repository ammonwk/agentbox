/** The board's macOS login service. Chrome's installed app is only a URL;
 * launchd keeps its backend available without a terminal. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxBin, agentboxHome, userHome } from "./paths";

const LABEL = "local.agentbox.server";
const domain = () => `gui/${process.getuid!()}`;
const target = () => `${domain()}/${LABEL}`;
const plistPath = () => join(userHome(), "Library", "LaunchAgents", `${LABEL}.plist`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function launchctl(...args: string[]) {
  return Bun.spawnSync(["/bin/launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
}
function run(...args: string[]) {
  const result = launchctl(...args);
  if (result.exitCode !== 0) throw new Error(`launchctl ${args[0]} failed: ${result.stderr.toString().trim()}`);
}

export function macServiceInstalled(): boolean {
  if (!existsSync(plistPath())) return false;
  const disabled = launchctl("print-disabled", domain());
  return disabled.exitCode === 0 && !disabled.stdout.toString().includes(`"${LABEL}" => true`);
}

/** A login shell supplies the same PATH and tool setup as a terminal. Only
 * agentbox's configuration is written here, never credentials or session IDs.
 * AbandonProcessGroup keeps tmux/agents alive across server restarts. */
export function macServiceText(): string {
  const env: Record<string, string> = { AGENTBOX_HOME: agentboxHome() };
  for (const name of ["AGENTBOX_PORT", "AGENTBOX_HOST", "AGENTBOX_TAILNET", "AGENTBOX_TMUX_SOCKET"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]!;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  const command = `exec ${quote(Bun.which("bun") || process.execPath)} ${quote(agentboxBin())} serve`;
  const log = join(agentboxHome(), "logs", "server.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(shell)}</string><string>-lc</string><string>${xml(command)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(userHome())}</string>
  <key>EnvironmentVariables</key><dict>
${Object.entries(env).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>20</integer>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export function startMacService(): boolean {
  if (!existsSync(plistPath())) return false;
  run("enable", target());
  if (launchctl("print", target()).exitCode !== 0) run("bootstrap", domain(), plistPath());
  // Without -k this starts a stopped job and leaves a running one alone.
  run("kickstart", target());
  return true;
}

export function stopMacService(): boolean {
  if (launchctl("print", target()).exitCode !== 0) return false;
  run("bootout", target());
  return true;
}

export function installMacService(): { unit: string; lingering: boolean } {
  const path = plistPath();
  mkdirSync(join(userHome(), "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(agentboxHome(), "logs"), { recursive: true });
  writeFileSync(path, macServiceText(), { mode: 0o600 });
  startMacService();
  return { unit: path, lingering: false };
}
