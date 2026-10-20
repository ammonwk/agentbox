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

This is an environment fence, not isolation from an agent running as the
same Unix user: it can read `~/.aws/credentials` directly or override these
paths. It also does not constrain product API tokens or database access.
A separate Unix user without access to the person's credentials, or admin
credentials requiring fresh MFA for each use with no accessible cached admin
session, is needed for that boundary. Agentbox does not change the person's
login or credential files. Terraform and deployments belong in GitHub Actions.
