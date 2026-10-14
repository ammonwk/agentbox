/** Where this machine's cloud settings live, all in the agentbox home and
 *  read at call time (paths.ts):
 *
 *  - `cloud.env`: the project to use, `AGENTBOX_CLOUD_URL` and
 *    `AGENTBOX_CLOUD_PUBLISHABLE_KEY` (the environment wins over the file).
 *    Without both, agentbox is local only and nothing here runs.
 *  - `cloud/installation.json` (0600): this machine's installation secret,
 *    bound to the URL it was minted for, so a changed URL never receives it.
 *  - `cloud/settings.json`: installation-only settings, never uploaded. */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkConfig, type CloudConfig } from "../../cloud/config";
import { INSTALLATION_SECRET_RE, InstallationSettings } from "../../cloud/protocol";
import { readEnvFile } from "../envfile";
import { agentboxHome } from "../paths";

export const cloudDir = (): string => join(agentboxHome(), "cloud");
export const cloudEnvPath = (): string => join(agentboxHome(), "cloud.env");
const credentialPath = (): string => join(cloudDir(), "installation.json");
const settingsPath = (): string => join(cloudDir(), "settings.json");

export function ensureCloudDir(): string {
  const d = cloudDir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** The configured project, null when there is none, or an error naming
 *  what is wrong with it (a secret key is refused here, before any use). */
export function cloudConfig(): { config: CloudConfig | null; error: string | null } {
  const file = readEnvFile(cloudEnvPath());
  const url = process.env.AGENTBOX_CLOUD_URL || file.AGENTBOX_CLOUD_URL;
  const key = process.env.AGENTBOX_CLOUD_PUBLISHABLE_KEY || file.AGENTBOX_CLOUD_PUBLISHABLE_KEY;
  if (!url && !key) return { config: null, error: null };
  if (!url || !key) return { config: null, error: `${cloudEnvPath()} needs both AGENTBOX_CLOUD_URL and AGENTBOX_CLOUD_PUBLISHABLE_KEY` };
  try {
    return { config: checkConfig({ url, publishableKey: key }), error: null };
  } catch (e) {
    return { config: null, error: (e as Error).message };
  }
}

export interface Credential {
  v: 1;
  url: string;
  installationId: string;
  workspaceId: string;
  workspaceSlug: string;
  name: string;
  secret: string;
  savedAt: string;
}

/** This machine's credential for `cfg`'s project, if it has one. */
export function readCredential(cfg: CloudConfig): Credential | null {
  const p = credentialPath();
  if (!existsSync(p)) return null;
  try {
    const c = JSON.parse(readFileSync(p, "utf8")) as Credential;
    if (c.v !== 1 || c.url !== cfg.url || !INSTALLATION_SECRET_RE.test(c.secret)) return null;
    return c;
  } catch {
    return null;
  }
}

export function writeCredential(c: Credential): void {
  ensureCloudDir();
  const p = credentialPath();
  writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
}

export function removeCredential(): void {
  rmSync(credentialPath(), { force: true });
}

export function readInstallationSettings(): InstallationSettings {
  try {
    return InstallationSettings.parse(JSON.parse(readFileSync(settingsPath(), "utf8")));
  } catch {
    return InstallationSettings.parse({});
  }
}

export function writeInstallationSettings(patch: Partial<InstallationSettings>): InstallationSettings {
  const next = InstallationSettings.parse({ ...readInstallationSettings(), ...patch });
  ensureCloudDir();
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2) + "\n");
  return next;
}
