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

Claude, Codex, omp's OpenCode Go sign-ins, devin and muse. The last two share
only a credential that does not rotate: devin's `windsurf_api_key` and a muse
`api_key`. A muse login kept as an access token (or in the macOS Keychain)
stays personal, since every sharer refreshing it would log the others out.

A login is shared or not, and you flip it either way at any time
(Accounts › the card's "Shared with Plaibook" toggle, `agentbox org share
<account>` / `unshare <account>`). Nothing has to be idle and nothing is
logged out: the account stays yours, and the org gets it too.

Two holders of a refresh token log each other out at the next refresh, so
while a login is shared the store holds its only one. **Every home of it** on
every member's machine is a mirror: the org's home of it under
`org/accounts/<id>` on each machine, and the sharer's own homes (the account
and any copy logged in as the same login, the CLI's own home usually). A
login's name across machines is its email for claude, codex, devin and muse,
and one OpenCode account in one workspace for omp — an email can hold several
workspaces, each its own sign-in.

- **Sharing** seals the login into `accounts`. At the next sync (at once,
  here) the sharer's homes get the placeholder refresh token like everyone
  else's. A session already running on it goes on: its CLI re-reads the file
  near its token's expiry and finds the store's.
- **A newer login in any mirror** (logging in again, or a CLI that refreshed
  before it saw the store's) goes to the store when its access token outlives
  the store's; an older one is a stale copy and is overwritten. A refresh the
  provider refuses sets `problem` and clears the login, and every mirror is
  logged out until someone logs in again.
- **Unsharing** deletes the store's document (only at the version read, so a
  refresh landing in between is not lost) and writes the whole login, refresh
  token and all, into the sharer's homes of it here. The org's homes go at
  each machine's next sync; a session there already on it keeps its access
  token until it runs out. Unsharing is done from a machine with a personal
  home of the login: the org's own card has no switch.

Linux only for claude: on macOS it keeps its login in the Keychain, and a
muse default home may keep its login there too.

**Credential files.** Each member's machine keeps an ordinary local home for
each org account (`syncOrgAccounts`, every 60 s) and writes the store's current
login into it: claude `.credentials.json` with `refreshToken: "pooled"` and
`.claude.json`'s `oauthAccount`, codex `auth.json` with `refresh_token:
"pooled"`, omp `opencode-console.json` with `refresh: "pooled"`, and devin's
`devin/credentials.toml` and muse's `muse/auth.json` whole (their key does not
rotate, so a mirror needs no placeholder). The CLI runs on it as on any
account, so subscription features, identity, the usage fetchers, limit
detection and moving a session between accounts work unchanged. The
placeholder refresh token can never rotate the pool's login.
Both CLIs were checked to pick up a rewritten file: claude re-reads it when its
token is near expiry, codex reloads `auth.json` on a 401 (also its per-home
app-server daemon). omp never reads the sign-in itself: the devin bridge does,
on every request, and a pooled sign-in tells it not to refresh (`freshGoLogin`).
It picks up the store's rewrite on its next request.

**Refreshing** happens in the store, about an hour before a claude access
token expires, a day before a codex one does (or five days after codex's last
refresh), and a day before an OpenCode Go one does — the same lead the bridge
uses, so no member's bridge ever reaches its own refresh point. devin's key
and muse's `api_key` are never refreshed. A machine that
sees one due takes the account's lease (`findOneAndUpdate` on `version` where
the lease is free or past, 60 s), refreshes at the provider's token endpoint
with the CLI's own client id, writes the new login to a local pending file
first and then to the store with `version + 1`. Every machine rewrites its
mirrors' files when the login changes. A machine that dies between the
provider's answer and the store's write recovers from its pending file.

**Usage** is read by each machine for itself, with its home's access token, as
for any account. **Claims are shared**: each machine publishes what its org
sessions still claim in their rows, and every member's balancer counts them,
so two members do not both place onto one pooled account as if it were free.
An org session at its limit moves to another org account as any session does
(`Fleet.continueStalled`); codex has a `moveSession` (the rollout moves to the
same day's path in the other home).

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
every 10 minutes. Claude and codex org homes get a `skills` directory of their
own (not the link to the personal one that other homes have) holding a link to
each org skill and each personal skill, a personal skill winning a name clash;
muse's is `muse/skills` in its config home, made the same way. omp and opencode
read one user-level skills directory for every account
(`~/.omp/agent/skills`, `~/.config/opencode/skills`), so the org's skills are
linked there too — and so they reach personal sessions of those CLIs, which is
the price of a CLI that has one directory. Publishing is a pull request or a
push to the repo.

## When things fail

- **The store unreachable.** Running org sessions keep their access tokens
  (hours) and go on; a refresh waits; `send` to another machine and the org
  status say why. Personal sessions do not notice.
- **A member's machine off.** Its org sessions stop with it; their rows show
  away after 3 minutes, and messages to them are refused.
