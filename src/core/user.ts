/** The person agentbox works for: their name and how to reach them. Lives in
 *  `<agentbox home>/user.env` — next to `voice.env`, outside any repository —
 *  so a published checkout never learns a name, an email or a GitHub login.
 *
 * Two reads, by cost:
 *  - `readUserIdentity()` runs on every voice connection: the file plus
 *    fallbacks that cost no subprocess (the passwd GECOS, $USER, the local
 *    timezone). Missing values degrade politely — the voice says "there"
 *    rather than a name.
 *  - `deriveIdentity()` is for onboarding: it asks git and gh, and reports
 *    where every value came from, so `agentbox onboard` can show its work
 *    instead of asking for what the machine already knows.
 *
 * Writing goes through `ensureUserEnv()`, which fills only the keys the file
 * does not have — a hand-edited `USER_CONTEXT` survives every re-onboard.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome } from "./paths";
import { readEnvFile } from "./envfile";

export interface UserIdentity {
  name: string;
  email: string;
  github: string;
  timezone: string;
  /** Free text about the user, for the voice agent to know them by. */
  context: string;
}

export const userEnvPath = (): string => join(agentboxHome(), "user.env");

const envKey = (k: keyof UserIdentity): string => `USER_${k.toUpperCase()}`;
const capitalize = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** The passwd GECOS field: the machine's own name for this user, no subprocess. */
function gecosName(): string {
  try {
    const uid = process.geteuid?.();
    if (uid === undefined) return "";
    const line = readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.startsWith(`${uid}:`));
    return line?.split(":")[4]?.split(",")[0]?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Identity for the hot paths. The file wins; then what the box already says
 * about its user. Never spawns a subprocess, because this runs per connection.
 */
export function readUserIdentity(): UserIdentity {
  const env = readEnvFile(userEnvPath());
  return {
    name: env.USER_NAME || gecosName() || capitalize(process.env.USER ?? "") || "there",
    email: env.USER_EMAIL || "",
    github: env.USER_GITHUB || "",
    timezone: env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    context: env.USER_CONTEXT || "",
  };
}

export type IdentitySource = "user.env" | "git config" | "gh" | "passwd" | "$USER" | "system" | "unset";

/** Where each value came from, alongside the value — onboarding's report. */
export interface DerivedIdentity {
  identity: UserIdentity;
  sources: Record<keyof UserIdentity, IdentitySource>;
}

function ghJson(field: string): string {
  if (!Bun.which("gh")) return "";
  const r = Bun.spawnSync(["gh", "api", "user", "--jq", field], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

function gitConfig(key: string): string {
  const r = Bun.spawnSync(["git", "config", "--global", key], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

/** Ask git and gh for everything the file does not say. Subprocesses: onboard only. */
export function deriveIdentity(): DerivedIdentity {
  const env = readEnvFile(userEnvPath());
  const ghLogin = ghJson(".login");
  const ghName = ghJson(".name");
  const ghEmail = ghJson(".email");
  const gitName = gitConfig("user.name");
  const gitEmail = gitConfig("user.email");
  const local = gecosName();
  const userName = capitalize(process.env.USER ?? "");

  const identity: UserIdentity = {
    name: env.USER_NAME || gitName || ghName || local || userName || "there",
    email: env.USER_EMAIL || gitEmail || ghEmail,
    github: env.USER_GITHUB || ghLogin,
    timezone: env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    context: env.USER_CONTEXT || "",
  };
  const sources: Record<keyof UserIdentity, IdentitySource> = {
    name: env.USER_NAME ? "user.env" : gitName ? "git config" : ghName ? "gh" : local ? "passwd" : userName ? "$USER" : "unset",
    email: env.USER_EMAIL ? "user.env" : gitEmail ? "git config" : ghEmail ? "gh" : "unset",
    github: env.USER_GITHUB ? "user.env" : ghLogin ? "gh" : "unset",
    timezone: env.USER_TIMEZONE ? "user.env" : "system",
    context: env.USER_CONTEXT ? "user.env" : "unset",
  };
  return { identity, sources };
}

/**
 * Fill `user.env` with derived values, leaving every key already present —
 * including ones the code does not know about — exactly as it was. Returns
 * the one-line summary of what was written, or null when there was nothing
 * to add (the boot-time no-op).
 */
export function ensureUserEnv(): string | null {
  const path = userEnvPath();
  const existing = readEnvFile(path);
  const keys = ["name", "email", "github", "timezone"] as const;
  // The boot-time case: every key there, and nothing to ask gh (a network
  // round trip each) or git for. It ran on every server start.
  if (keys.every((k) => existing[envKey(k)])) return null;
  const { identity, sources } = deriveIdentity();
  const missing = keys.filter((k) => !existing[envKey(k)] && identity[k]);
  if (!missing.length) return null;
  const written = missing.map((k) => `${envKey(k)}=${identity[k]}`);
  const prior = existsSync(path) ? readFileSync(path, "utf8") : "";
  const body = prior && prior.endsWith("\n") ? prior : prior ? `${prior}\n` : HEADER;
  writeFileSync(path, `${body}${written.join("\n")}\n`);
  return `wrote ${path}: ${missing.map((k) => `${k} (${sources[k]})`).join(", ")}`;
}

const HEADER = "# agentbox's identity, derived by `agentbox onboard` from this machine.\n# Edit freely; re-onboarding only fills keys still missing.\n";
