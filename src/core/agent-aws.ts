/** AWS defaults for agents, not a sandbox: the same Unix user can still read
 * ~/.aws directly. Never copy an admin profile or a credential_process here. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentboxHome, userHome } from "./paths";

/** Higher-priority credentials and alternate credential providers must not
 * bypass the restricted shared files inherited by an agent. */
export const AWS_CREDENTIAL_ENV = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
  "AWS_ACCESS_KEY", "AWS_SECRET_KEY", "AWS_DEFAULT_PROFILE",
  "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
];

function section(path: string, name: string, keys: string[]): Record<string, string> {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  const values: Record<string, string> = {};
  let active = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(?:[#;].*)?$/.exec(line);
    if (header) { active = header[1]!.trim() === name; continue; }
    if (!active) continue;
    const entry = /^\s*([\w]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (entry && keys.includes(entry[1]!.toLowerCase())) values[entry[1]!.toLowerCase()] = entry[2]!;
  }
  return values;
}

const credentials = ["aws_access_key_id", "aws_secret_access_key", "aws_session_token"];
const ini = (name: string, values: Record<string, string>): string =>
  `[${name}]\n${Object.entries(values).map(([k, v]) => `${k} = ${v}\n`).join("")}\n`;

/** The same fence for the agent process and a CLI's explicit tool environment.
 * Reading the paths must not refresh credential files a second time. */
export function agentAwsSettings(): Record<string, string> {
  const dir = join(agentboxHome(), "agent-aws");
  return {
    AWS_PROFILE: "agent-readonly",
    AWS_CONFIG_FILE: join(dir, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

/** Refresh at launch from the person's files, never their AWS_* overrides.
 * Missing read-only credentials yield empty files, never the normal defaults.
 * Only a static source key is supported; no SSO, process or ambient sources. */
export function agentAwsEnv(): Record<string, string> {
  const aws = join(userHome(), ".aws");
  const profile = section(join(aws, "config"), "profile agent-readonly", [
    "role_arn", "source_profile", "region", "output", "role_session_name", "duration_seconds", "external_id",
  ]);
  let shared = ini("agent-readonly", section(join(aws, "credentials"), "agent-readonly", credentials));
  const source = profile.source_profile;
  if (source) {
    if (!/^[\w.-]+$/.test(source) || source === "agent-readonly") throw new Error("Invalid agent-readonly source_profile");
    shared += ini(source, section(join(aws, "credentials"), source, credentials));
  }
  const dir = join(agentboxHome(), "agent-aws");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [name, text] of [["config", ini("profile agent-readonly", profile)], ["credentials", shared]] as const) {
    const path = join(dir, name);
    const temp = `${path}.${crypto.randomUUID()}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  }
  return agentAwsSettings();
}
