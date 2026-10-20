# agentbox orgs

An org is a team's shared pool: accounts, skills, and the sessions its members
start in it. Plaibook is one. Everything else stays as it is on one machine
(`docs/v2.md`): each person runs agentbox on their own machine and opens their
own board, and every agent runs on the machine that started it.

This replaces the hub, its nodes and the public door, which are deleted.

## The model

**The store.** One MongoDB database, `agentbox_plaibook` on the nonprod Atlas
cluster, reached with a database user that can touch only that database. Every
member's machine calls out to it, polling; nothing calls in. It has two
collections:

| collection | a row | written by |
|---|---|---|
| `accounts` | an org account: provider, label, its login encrypted with the org key, `version`, a refresh `lease`, its last usage reading and when | any member's machine |
| `sessions` | a live org session: id, person, machine, title, repo, branch, PR, status, account, claim, `seenAt`, and its mailbox (`inbox`: messages for it) | the machine running it (the inbox: senders) |

Org skills are not in the store: they are a GitHub repo
(`plaibook-dev/agentbox-skills`), which already has history, review and
access control.

**Membership is the invite.** `agentbox org join <invite>` writes
`<agentbox home>/org.json` (0600): the org's name, the store URI, the org key
(AES-256-GCM, for the logins at rest: the cluster has other users and
backups), and the skills repo. There is no member list. Trust is per org:
every member's agents can read `org.json` and so every pooled login, because
that is what pooling is. **Removing someone** is changing the database user's
password, sending the rest a new invite, and logging every org account in
again (they could have copied the refresh tokens; nothing else revokes them).

**Session scope.** Every session is `personal` (today) or `org`. The
new-session dialog has Personal / Plaibook; the CLI takes `--org` /
`--personal`, defaulting to a setting. Scope is a column on the session and
an env var in its process (`AGENTBOX_SCOPE`), so a session it starts, a
subagent pool agent, recovery, resume and adopt keep it; schedules and
superagents start personal unless they say otherwise. Scope decides:

- **which accounts it may run on**: personal on this machine's accounts, org
  on the org's, never both. Scope goes through `placement()` and every caller
  (start, hop, wake, recovery, schedules), so a move never crosses it.
- **who sees it**: an org session has a `sessions` row and a mailbox; a
  personal one is invisible outside this machine.

## Org accounts

An account lives in one place: on one machine, or in the org. Two holders of a
Claude or Codex login log each other out at the next refresh, so **moving** is
the only operation, and it moves every copy:

- `agentbox org add-account <id>` (Accounts › Move to Plaibook) is refused
  while a session runs on it, or on a twin (another home on the same login,
  usually the default home). It encrypts the login into `accounts`, then
  deletes it from the home and from every twin, and says so ("this logs out
  your plain `claude`"). The homes stay, without a login, for their old
  transcripts. Linux only at first: on macOS claude keeps its login in the
  Keychain.
- `agentbox org take-account <id>` is the reverse, refused while any
  `sessions` row names the account.
- An org account whose login is lost shows "log in again" on every member's
  Accounts page; logging in writes straight to the store.
- omp (OpenCode Go) logins are static keys: they move the same way and need
  no refreshing. devin and muse stay personal.

**How an org session uses one: credential files** (to be confirmed, Build 1).
Each member's machine has an ordinary local home for each org account, and
writes the store's current access token into it: claude
`.credentials.json` with `refreshToken: "pooled"`, codex `auth.json` with
`last_refresh` set to now. The CLI runs on it as on any account, so every
subscription feature, identity, the usage fetchers, limit detection, and
moving a session between accounts work unchanged, and restarting the server
stays free. The placeholder refresh token can never rotate the pool's login.

**Refreshing** happens in the store, about an hour before the access token
expires (Claude's last about 8 hours), so a CLI never reaches its own refresh
point. A machine that sees it due takes the account's lease
(`findOneAndUpdate` where the lease is free or past, 60 s), refreshes with the
provider's token endpoint and the CLI's own client id, writes the new login
to a local file first and then to the store with `version + 1`, and frees the
lease. Every machine rewrites its homes' files when `version` moves. A
machine that dies between the provider's answer and the write leaves its
local file to recover from; failing that, the account asks to be logged in
again.

**The fallback, if the CLIs do not pick up a rewritten file:** a proxy, in a
process of its own (as the devin bridge is, so a server restart does not cut
streams), one login-less home per provider, routed by session id
(`/pool/<session>`), adding the session's current account's access token.
Moving an org session between accounts is then a repin, codex included. Its
cost is that subscription-only CLI features (claude.ai connectors, Remote
Control, `/usage`) are gone and limit detection must be checked under API-key
wording.

**Usage.** The existing fetchers (`/api/oauth/usage`, `wham/usage`) run with
the store's access token: a machine that finds an org account's stored reading
older than 3 minutes reads it and writes it back. The balancer is fed the org
accounts' readings and claims (`sessions` rows), with this machine's own
sessions counted once. `shortSamples`, `perWeekly`, `unfunded` and `refused`
stay what this machine has seen, and `loggedOut` comes from the store, not the
home.

**An account at its limit mid-session** is handled as today:
`Fleet.continueStalled` moves the session to another org account. Codex needs
a `moveSession` for this (it has none: `fleet.ts` moves only claude, devin,
omp and opencode).

## Seeing and messaging

The machine running an org session upserts its row when the session's board
row changes and every 60 s; a row unseen for 3 minutes shows away and expires
after a day (a TTL index). Every machine polls `sessions` every 15 s. The
board's Sessions list has a Plaibook section with the other members' live org
sessions (read-only: person, title, repo, PR, status); `agentbox ls --org`
prints them.

`agentbox send <id> 'text'` from an org session, to an org session on another
machine, pushes the message into the target row's `inbox`. The target machine
polls its rows' inboxes every 5 s, takes each message out (at most once: taken
is never retried), types it through the same `agentRefusal` guard and send
path as a local agent's message, framed as a peer's
(`[via agentbox org from <person>/<id>]`), and writes the outcome back. The
sender waits up to 30 s for `delivered` or the refusal and prints it, as a
local `send` does. With the store unreachable, `send` fails and says so.
Personal sessions neither send nor receive org messages.

`agentbox pr claim` in an org session writes the PR into its row at once, and
is refused when another live row names it.

## Org skills

Each member's machine keeps a clone of the skills repo in
`<agentbox home>/org/skills` and pulls it every 10 minutes. Org homes get a
`skills` directory of their own (not the link to the personal one that other
homes have) holding a link to each personal skill and each org skill, a
personal skill winning a name clash. Publishing is a pull request or a push to
the repo.

## When things fail

- **The store unreachable.** Running org sessions keep their access tokens
  (hours) and go on; a refresh waits; new org sessions, `send` and claims are
  refused with why. Personal sessions do not notice.
- **A member's machine off.** Its org sessions stop with it; their rows show
  away after 3 minutes.

## Build order

1. **Test the credential file.** Do claude and codex, interactive, pick up a
   rewritten login file mid-session without refreshing (claude) or on a 401
   (codex)? Decide credential files or the proxy. If the proxy: check the
   interactive TUI under `ANTHROPIC_AUTH_TOKEN` (an API-key prompt, MCP tool
   search, limit wording) and codex with a login-less `CODEX_HOME`.
2. **The store.** The Atlas database user (readWrite on `agentbox_plaibook`
   only), the cluster's network access for members' home networks, and the
   skills repo.
3. **Delete the hub, the public door and per-person plumbing**:
   `src/server/{hub,hubnodes,placement,public,person}.ts`, `src/core/hub.ts`,
   `src/cli/hub.ts`, `web/src/views/{Hub,Team}.tsx`, `team.css`,
   `newsession/NodePicker.tsx` and its use in `lib/newsession.ts`, `node` on
   starts and superagents, `person` on cards and push subscriptions,
   `admit`'s hub kinds in `tailnet.ts` (the tailnet listener stays for your
   own phone), the hub tests, `docs/hub.md` and AGENTS.md's hub paragraph;
   tear down `agents.plaibook.tech` (box1's `agentbox` user's services, the
   Caddy block, the Route53 record). A start at a repo and a ref stays. The
   migration dropping `cards.person` and `superagents.node` is written last
   and shipped at once.
4. **`org.json`, the store client, `agentbox org join|invite|status`.**
5. **Org accounts**: move in and out (twins included), the store's refresh
   with its lease, writing homes' files, usage readings, `loggedOut`, codex
   `moveSession`. Claude, then codex, then omp.
6. **Scope**: the column, `AGENTBOX_SCOPE`, the dialog and CLI, and scope
   through `placement()` and every caller.
7. **Rows, inboxes and claims**, the board section, `ls --org`.
8. **Org skills**: the clone and the org homes' `skills` directories.
9. **Docs and verification**: `docs/v2.md`, AGENTS.md, the CLI guide; then
   two machines in the org (fedora, and a second agentbox home on box1): move
   an account in, run org sessions on both, refresh while they run, message
   between them, take the store and a machine away, move the account back.
