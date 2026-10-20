# AWS credentials in agent sessions

Every new or resumed tmux session, and every subagent ACP process, starts
with `AWS_PROFILE=agent-readonly`. `src/core/agent-aws.ts` refreshes private
0600 files under `<agentbox home>/agent-aws/` from `~/.aws/`: only the
`agent-readonly` profile and its static source key are included. Process,
SSO, container and instance credentials are not fallback providers; inherited
AWS credential variables are cleared. Missing read-only credentials leave
AWS unavailable rather than falling back to the person's default profile.
Explicit `--profile mfa`, `personal` or `plaibook-root` cannot resolve there.
Existing processes acquire this environment on their next resume, not on a
server restart. CLIs started outside agentbox are not covered.

Codex also receives `AWS_PROFILE`, `AWS_CONFIG_FILE`,
`AWS_SHARED_CREDENTIALS_FILE` and `AWS_EC2_METADATA_DISABLED` as command-local
`-c shell_environment_policy.set.<NAME>=...` overrides, after any carried
configuration on new, resumed and adopted sessions. This keeps an
`inherit = "core"` policy from dropping them from tool commands without
changing inheritance or other personal `set` keys. Building these flags only
reads the shared path policy; tmux still refreshes the credential files once.

Codex's [shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)
applies include allowlists after `set`: `include_only` or `filters` include
patterns must admit all four AWS variables. Agentbox preserves those filters;
it does not guarantee this fence for configurations that filter these values
out or explicitly inject credentials through other personal `set` keys.
Verify the actual tool environment when changing that policy, not just the
Codex process's environment.

This is an environment fence, not isolation from an agent running as the
same Unix user: it can read `~/.aws/credentials` directly or override these
paths. It also does not constrain product API tokens or database access.
A separate Unix user without access to the person's credentials, or admin
credentials requiring fresh MFA for each use with no accessible cached admin
session, is needed for that boundary. Agentbox does not change the person's
login or credential files. Terraform and deployments belong in GitHub Actions.
