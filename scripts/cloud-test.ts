/** Runs the cloud's security tests against the local Supabase stack
 *  (`supabase start` in this checkout), reading its URL and keys from
 *  `supabase status`. The secret key only creates test users. */
const status = Bun.spawnSync(["supabase", "status", "-o", "env"], { stderr: "ignore" });
const env: Record<string, string> = {};
for (const line of status.stdout.toString().split("\n")) {
  const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
  if (m) env[m[1]!] = m[2]!;
}
if (!env.API_URL || !env.PUBLISHABLE_KEY || !env.SECRET_KEY) {
  console.error("no local Supabase stack: run `supabase start` in this checkout first (docs/cloud.md)");
  process.exit(1);
}
const test = Bun.spawnSync(["bun", "test", "src/cloud/", ...process.argv.slice(2)], {
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    AGENTBOX_CLOUD_TEST_URL: env.API_URL,
    AGENTBOX_CLOUD_TEST_PUBLISHABLE_KEY: env.PUBLISHABLE_KEY,
    AGENTBOX_CLOUD_TEST_SECRET_KEY: env.SECRET_KEY,
    AGENTBOX_CLOUD_TEST_DB_URL: env.DB_URL,
  },
});
process.exit(test.exitCode ?? 1);
