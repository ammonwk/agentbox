# AWS credentials in agent sessions

Every new or resumed tmux session, and every subagent ACP process, starts
with `AWS_PROFILE=agent-readonly`. `src/core/agent-aws.ts` refreshes private
0600 files from `~/.aws/` at each launch: each session has its own under
`<agentbox home>/agent-aws/sessions/<id>/`, and subagents share
`agent-aws/subagents/`. Only the `agent-readonly` profile and its static
source key are included. Process, SSO, container and instance credentials
are not fallback providers; inherited AWS credential variables are cleared.
Missing read-only credentials leave AWS unavailable rather than falling back
to the person's default profile. Explicit `--profile personal` or
`plaibook-root` cannot resolve there, nor `--profile mfa` without a grant.
Existing processes acquire this environment on their next resume, not on a
server restart. CLIs started outside agentbox are not covered.

## Admin AWS: a grant per session

A write or admin operation needs the person's approval, and the approval is
a fresh code from their authenticator. A session that needs one asks for a
code, saying what it is for, and runs

    agentbox aws-grant <6-digit code>

The CLI hands the code to the server (`POST /api/aws-grant`, which knows the
session by its capability, `src/core/session-authority.ts`, never by a name
it is given). The server runs what `~/.local/bin/aws-mfa` runs, `aws sts
get-session-token` against the person's own `~/.aws` with every `AWS_*`
variable cleared, and writes the result as the `mfa` profile into that
session's files alone, with `[profile mfa]` copied from `~/.aws/config`
(region, output). Other sessions and agentbox's subagents stay
`agent-readonly`; a CLI's own in-process subagents (Claude's Task) share
their session's environment, grant and all. The long-term source key is
never in any session's files. A code cannot be
used twice, so a session cannot mint again without a new one.

The source profile and MFA device are named in `<agentbox home>/aws-mfa.env`,
outside the repo:

    AWS_MFA_SOURCE_PROFILE=<the profile holding the long-term key>
    AWS_MFA_SERIAL=arn:aws:iam::<account>:mfa/<device>

A grant lasts until its session is closed, which deletes it, and at most
36 hours (`GRANT_HOURS`), the longest STS gives an IAM user. It survives the
session's resume. The first version minted 4 hours, so an approval could not
outlive the task it was asked for by a day; but a release that runs past 4
hours has to stop and ask for a second code, which is why `aws-mfa` had
minted 36 hours into the one `mfa` profile in `~/.aws/credentials`. That
profile was readable by every session on the box, so one code gave admin
AWS to all of them for a day and a half. A grant keeps the 36 hours and
drops the sharing: one session holds it, and closing the session ends it.
Inside an agentbox session `aws-mfa <code>` runs `agentbox aws-grant <code>`
and never writes `~/.aws/credentials`. The server log records each grant's
session, profile and expiry, never a credential.

A session started before its files were its own reads the old shared
`agent-aws/` files until it is resumed; `agentbox aws-grant` prints the
`AWS_CONFIG_FILE=… AWS_SHARED_CREDENTIALS_FILE=…` prefix it needs meanwhile.

## Codex

Codex also receives `AWS_PROFILE`, `AWS_CONFIG_FILE`,
`AWS_SHARED_CREDENTIALS_FILE` and `AWS_EC2_METADATA_DISABLED` as command-local
`-c shell_environment_policy.set.<NAME>=...` overrides, after any carried
configuration on new, resumed and adopted sessions. This keeps an
`inherit = "core"` policy from dropping them from tool commands without
changing inheritance or other personal `set` keys. Building these flags only
reads the session's paths; tmux still refreshes the credential files once.

Codex's [shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced#shell-environment-policy)
applies include allowlists after `set`: `include_only` or `filters` include
patterns must admit all four AWS variables. Agentbox preserves those filters;
it does not guarantee this fence for configurations that filter these values
out or explicitly inject credentials through other personal `set` keys.
Verify the actual tool environment when changing that policy, not just the
Codex process's environment.

This is an environment fence, not isolation from an agent running as the
same Unix user: it can read `~/.aws/credentials` directly or override these
paths, and read another session's grant. It also does not constrain product
API tokens or database access.
A separate Unix user without access to the person's credentials, or admin
credentials requiring fresh MFA for each use with no accessible cached admin
session, is needed for that boundary. Agentbox does not change the person's
login or credential files. Terraform and deployments belong in GitHub Actions.
