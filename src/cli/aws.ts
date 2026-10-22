/** `agentbox aws-grant <code>`: the person's MFA code becomes this session's own
 *  `mfa` profile (src/core/agent-aws.ts). The server mints it; this prints
 *  no credential. */

import type { Api } from "../client";
import { agentAwsSettings } from "../core/agent-aws";

export async function awsGrant(api: Api, args: string[]): Promise<number> {
  const [code] = args;
  if (!code || !/^\d{6}$/.test(code) || args.length > 1) throw new Error("usage: agentbox aws-grant <the 6-digit MFA code your user gave you>");
  // An agentbox subagent carries its caller's AGENTBOX_SESSION but never its grant.
  if (process.env.AWS_CONFIG_FILE === agentAwsSettings(null).AWS_CONFIG_FILE) throw new Error("a subagent is never granted admin AWS: the session that started you runs aws-grant");
  const g = await api<{ profile: string; expiration: string; settings: Record<string, string> }>("POST", "/api/aws-grant", { code });
  const left = ((Date.parse(g.expiration) - Date.now()) / 3_600_000).toFixed(1);
  console.log(`granted: --profile ${g.profile} works in this session until ${new Date(g.expiration).toLocaleString()} (${left}h). The default stays agent-readonly.`);
  // A session started before its files were its own still reads the old ones.
  const files = ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"] as const;
  if (files.some((k) => process.env[k] !== g.settings[k])) {
    console.log(`this shell reads other AWS files; run with: ${files.map((k) => `${k}=${g.settings[k]}`).join(" ")}`);
  }
  return 0;
}
