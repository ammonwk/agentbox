/** AWS defaults for agents, not a sandbox: the same Unix user can still read
 * ~/.aws directly. Never copy an admin profile or a credential_process here.
 * The one way past `agent-readonly` is a grant (`grantAws`): short-lived
 * credentials minted from the person's MFA code, in one session's files only. */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "./envfile";
import { agentboxHome, userHome } from "./paths";

/** Higher-priority credentials and alternate credential providers must not
 * bypass the restricted files inherited by an agent. */
export const AWS_CREDENTIAL_ENV = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
  "AWS_ACCESS_KEY", "AWS_SECRET_KEY", "AWS_DEFAULT_PROFILE",
  "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
];

/** The profile a grant adds, named as in ~/.aws/config. */
export const GRANT_PROFILE = "mfa";
/** A grant is meant to last until its session closes (`dropAgentAws`); this
 * caps it at STS's longest for an IAM user. 4h, the first choice, kept an
 * approval from outliving its task, but a release that outlasts it must ask
 * for a second code mid-release, the cost `aws-mfa` minted 36h to avoid.
 * Closing the session ends the grant, so 36h no longer means sharing it. */
export const GRANT_HOURS = 36;

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
const granted = [...credentials, "expiration"];
const ini = (name: string, values: Record<string, string>): string =>
  `[${name}]\n${Object.entries(values).map(([k, v]) => `${k} = ${v}\n`).join("")}\n`;

/** Each session's own files, so a grant reaches that session alone.
 * Subagents share one directory: nothing is ever granted to them. */
function fenceDir(session: string | null): string {
  if (session !== null && !/^[\w-]{1,64}$/.test(session)) throw new Error("invalid session identity");
  return join(agentboxHome(), "agent-aws", session === null ? "subagents" : join("sessions", session));
}

/** The same fence for the agent process and a CLI's explicit tool environment.
 * Reading the paths must not refresh credential files a second time. */
export function agentAwsSettings(session: string | null): Record<string, string> {
  const dir = fenceDir(session);
  return {
    AWS_PROFILE: "agent-readonly",
    AWS_CONFIG_FILE: join(dir, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
  };
}

/** The session's grant while it has not expired. */
function liveGrant(dir: string): Record<string, string> | null {
  const g = section(join(dir, "credentials"), GRANT_PROFILE, granted);
  return credentials.every((k) => g[k]) && Date.parse(g.expiration ?? "") > Date.now() ? g : null;
}

/** Write the fence from the person's files, with `grant` (or the session's
 * live one) as the `mfa` profile. Only a static source key is supported for
 * `agent-readonly`; no SSO, process or ambient sources. */
function writeFence(session: string | null, grant?: Record<string, string>): Record<string, string> {
  const aws = join(userHome(), ".aws");
  const dir = fenceDir(session);
  const profile = section(join(aws, "config"), "profile agent-readonly", [
    "role_arn", "source_profile", "region", "output", "role_session_name", "duration_seconds", "external_id",
  ]);
  let config = ini("profile agent-readonly", profile);
  let shared = ini("agent-readonly", section(join(aws, "credentials"), "agent-readonly", credentials));
  const source = profile.source_profile;
  if (source) {
    if (!/^[\w.-]+$/.test(source) || source === "agent-readonly" || source === GRANT_PROFILE) throw new Error("Invalid agent-readonly source_profile");
    shared += ini(source, section(join(aws, "credentials"), source, credentials));
  }
  const g = grant ?? (session === null ? null : liveGrant(dir));
  if (g) {
    config += ini(`profile ${GRANT_PROFILE}`, section(join(aws, "config"), `profile ${GRANT_PROFILE}`, ["region", "output"]));
    shared += ini(GRANT_PROFILE, g);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (const [name, text] of [["config", config], ["credentials", shared]] as const) {
    const path = join(dir, name);
    const temp = `${path}.${crypto.randomUUID()}`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
  }
  return agentAwsSettings(session);
}

/** Refresh at launch from the person's files, never their AWS_* overrides.
 * Missing read-only credentials yield empty files, never the normal defaults.
 * A session's unexpired grant survives its resume. */
export function agentAwsEnv(session: string | null): Record<string, string> {
  return writeFence(session);
}

/** A closed session's files, grant and all. */
export function dropAgentAws(session: string): void {
  rmSync(fenceDir(session), { recursive: true, force: true });
}

/** STS credentials for an MFA code, as the credentials file keys them. */
export type Minter = (code: string, seconds: number) => Promise<Record<string, string>>;

/** Where the long-term key and the MFA device are named: never in the repo,
 * and never in a session's files. */
export const mfaSourcePath = (): string => join(agentboxHome(), "aws-mfa.env");

/** `aws sts get-session-token` on the person's own ~/.aws, as `aws-mfa` mints. */
export const stsMint: Minter = async (code, seconds) => {
  const { AWS_MFA_SOURCE_PROFILE: source, AWS_MFA_SERIAL: serial } = readEnvFile(mfaSourcePath());
  if (!source || !serial) throw new Error(`no MFA device set up: name AWS_MFA_SOURCE_PROFILE and AWS_MFA_SERIAL in ${mfaSourcePath()}`);
  // Every AWS_* variable would outrank or redirect the profile being asked for.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AWS_")));
  const proc = Bun.spawn(["aws", "sts", "get-session-token", "--profile", source, "--serial-number", serial,
    "--token-code", code, "--duration-seconds", String(seconds), "--query", "Credentials", "--output", "json"],
  { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit !== 0) throw new Error(err.trim() || `aws exited ${exit}`);
  const c = JSON.parse(out) as Record<string, string>;
  return { aws_access_key_id: c.AccessKeyId!, aws_secret_access_key: c.SecretAccessKey!, aws_session_token: c.SessionToken!, expiration: c.Expiration! };
};

/** Mint from `code` and give the credentials to `session` alone. The code is
 * the approval: only the person holds the authenticator. Nothing is printed. */
export async function grantAws(session: string, code: string, mint: Minter = stsMint): Promise<{ profile: string; expiration: string; settings: Record<string, string> }> {
  if (!/^\d{6}$/.test(code)) throw new Error("an MFA code is six digits");
  const grant = await mint(code, GRANT_HOURS * 3600);
  if (!credentials.every((k) => grant[k]) || !(Date.parse(grant.expiration ?? "") > Date.now())) throw new Error("STS returned no usable credentials");
  return { profile: GRANT_PROFILE, expiration: grant.expiration!, settings: writeFence(session, grant) };
}
