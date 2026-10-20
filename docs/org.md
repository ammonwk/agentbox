# agentbox orgs

An org is a team's shared pool: accounts, skills, and the sessions its members
start in it. Plaibook is one. Everything else stays as it is on one machine
(`docs/v2.md`): each person runs agentbox on their own machine and opens their
own board, and every agent runs on the machine that started it.

The code is `src/core/org/` (config, seal, store, accounts, skills, and the
`Org` class that runs the timers) and `src/cli/org.ts`.

## The model

**The store.** One MongoDB database, `agentbox_plaibook` on the nonprod Atlas
cluster, reached with a database user (`agentbox-plaibook`) that can touch only
that database. Every member's machine calls out to it, polling; nothing calls
in. Two collections:

| collection | a row | written by |
|---|---|---|
| `accounts` | an org account: provider, label, email, plan, its login sealed with the org key, `version`, a refresh `lease`, `problem` | any member's machine |
| `sessions` | a live org session: id, person, machine, provider, title, repo, branch, status, account, the PRs it holds, `seenAt`, and its mailbox (`inbox`) | the machine running it (the inbox: senders) |

Org skills are not in the store: they are a GitHub repo
(`plaibook-dev/agentbox-skills`), which already has history, review and
access control.

**Membership is the invite.** `agentbox org init <name> --store <uri>
[--skills owner/repo]` starts an org and prints its invite; `agentbox org
invite` prints it again; `agentbox org join <invite>` writes
`<agentbox home>/org.json` (0600): the org's name, the store URI, the org key
(AES-256-GCM, for the logins at rest: the cluster has other users and
backups), and the skills repo. There is no member list. Trust is per org:
every member's agents can read `org.json` and so every pooled login, because
that is what pooling is. **Removing someone** is changing the database user's
password, sending the rest a new invite, and logging every org account in
again (they could have copied the refresh tokens; nothing else revokes them).

**Scope is the account's.** An org account's home is under
`<agentbox home>/org/accounts/<id>`; every other home is personal. A session
is an org session when its account is an org account, so there is no column
and nothing to carry along: a resume, a hop or a recovery stays in its scope
because `placement()` only offers accounts of the scope it is asked for, and
every caller (start, hop, wake, fork, schedules) asks for the session's own.
A start says `scope` (`--org` / `--personal`, the dialog's Personal /
Plaibook); without it, its parent's; without a parent, `settings.scope`
(`agentbox org default org|personal`). A schedule keeps the scope it was made
with, or takes the default when it starts. Scope decides:

- **which accounts it may run on**: personal on this machine's own accounts,
  org on the org's, never both.
- **who sees it**: an org session has a `sessions` row and a mailbox; a
  personal one is invisible outside this machine.

## Org accounts

Claude and Codex only. omp's OpenCode Go logins are Console sign-ins the devin
bridge refreshes, not static keys, and devin and muse are per-person: they stay
personal.

An account lives in one place: on one machine, or in the org. Two holders of a
login log each other out at the next refresh, so **moving** is the only
operation, and it moves every copy:

- `agentbox org add-account <account>` (Accounts › Move to Plaibook) is
  refused while a session runs on it or on a copy (another personal home of
  the same provider and email, usually the CLI's own), and when the org
  already has that email. It seals the login into `accounts`, then removes the
  login file from the home and every copy and clears their email, so they are
  not taken for the same account again. The homes stay, logged out, for their
  old transcripts. Linux only: on macOS claude keeps its login in the
  Keychain.
- `agentbox org take-account <account>` (Accounts › Take back) is the
  reverse: refused while a session here or a live row on another machine is
  on it, it makes a personal home with the full login and deletes the store's
  document. Every other machine drops its local org account at its next sync.
- A login made in an org home (Accounts › Log in again) is uploaded to the
  store; a refresh the provider refuses sets `problem` and clears the login,
  and every machine's home is then logged out until someone logs in again.

**Credential files.** Each member's machine keeps an ordinary local home for
each org account (`syncOrgAccounts`, every 60 s) and writes the store's current
login into it: claude `.credentials.json` with `refreshToken: "pooled"` and
`.claude.json`'s `oauthAccount`, codex `auth.json` with `refresh_token:
"pooled"`. The CLI runs on it as on any account, so subscription features,
identity, the usage fetchers, limit detection and moving a session between
accounts work unchanged. The placeholder refresh token can never rotate the
pool's login. Both CLIs were checked to pick up a rewritten file: claude
re-reads it when its token is near expiry, codex reloads `auth.json` on a 401
(also its per-home app-server daemon).

**Refreshing** happens in the store, about an hour before a claude access
token expires and a day before a codex one does (or five days after codex's
last refresh), so a CLI never reaches its own refresh point. A machine that
sees one due takes the account's lease (`findOneAndUpdate` on `version` where
the lease is free or past, 60 s), refreshes at the provider's token endpoint
with the CLI's own client id, writes the new login to a local pending file
first and then to the store with `version + 1`. Every machine rewrites its
homes' files when the login changes. A machine that dies between the
provider's answer and the store's write recovers from its pending file.

**Usage** is read by each machine for itself, with its home's access token, as
for any account; the balancer counts this machine's own claims. An org session
at its limit moves to another org account as any session does
(`Fleet.continueStalled`); codex now has a `moveSession` (the rollout moves to
the same day's path in the other home).

## Seeing and messaging

Every 15 s each machine upserts a row for each of its live org sessions,
deletes its rows for the ones that ended, and reads everyone else's. A row
unseen for 3 minutes shows away; the TTL index removes it after a day. The
Sessions rail has a Plaibook section with the other members' live org
sessions (read-only; a click copies the id); `agentbox org ls` prints them.

`agentbox send <id> 'text'` from an org session to an org session on another
machine pushes the message into the target row's `inbox`. The target machine
polls its rows' inboxes every 5 s, marks each message taken before typing it
(a crash loses it rather than sending it twice), delivers it as a local
agent's message is delivered, framed `[from <person>'s session on
<machine>]`, and writes the outcome back. The sender waits up to 30 s for
`delivered` or the refusal and prints it. A personal session cannot message
another machine's session.

`agentbox pr claim` is refused when a live org session on another machine
holds the PR.

## Org skills

Each member's machine keeps a clone of the skills repo in
`<agentbox home>/org/skills` (`gh repo clone`, else `git clone`) and pulls it
every 10 minutes. Org homes get a `skills` directory of their own (not the link
to the personal one that other homes have) holding a link to each org skill
and each personal skill, a personal skill winning a name clash. Publishing is
a pull request or a push to the repo.

## When things fail

- **The store unreachable.** Running org sessions keep their access tokens
  (hours) and go on; a refresh waits; `send` to another machine and the org
  status say why. Personal sessions do not notice.
- **A member's machine off.** Its org sessions stop with it; their rows show
  away after 3 minutes, and messages to them are refused.
