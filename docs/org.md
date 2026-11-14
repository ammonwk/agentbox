# agentbox orgs

An org is a team's shared pool: accounts, skills, and the sessions its members
start in it. Plaibook is one. Everything else stays as it is on one machine
(`docs/v2.md`): each person runs agentbox on their own machine and opens their
own board, and every agent runs on the machine that started it.

The code is `src/core/org/` (config, seal, store, accounts, skills, and the
`Org` class that runs the timers) and `src/cli/org.ts`.

## The model

**The store.** One MongoDB database, `agentbox_plaibook` on production's Atlas
cluster (`rmplanner`, since 2026-11-06), reached with a database user (`agentbox-plaibook`) that can touch only
that database. Every member's machine calls out to it, polling; nothing calls
in. Atlas admits only our AWS network, so the store is reached through a
SOCKS5 proxy on the team tailnet (below), with the driver's own URI options,
`?proxyHost=<proxy's tailnet address>&proxyPort=1080` (the `socks`
dependency is what makes them work; without it the driver hangs). The invite
carries the URI as it is, so a member needs a tailnet login and nothing
else. Two collections:

| collection | a row | written by |
|---|---|---|
| `accounts` | a login the store keeps, under its sharer's account id: provider, label, email, plan, the login sealed with the org key, `shared`, `version`, a refresh `lease`, `problem` | any member's machine |
| `sessions` | a live session on the pool: id, person, machine, provider, status, account, what it claims, `seenAt`; an org session's also has its title, repo, branch, the PRs it holds and its mailbox (`inbox`), a personal one is `private` | the machine running it (the inbox: senders) |

Org skills are not in the store: they are a GitHub repo
(`plaibook-dev/agentbox-skills`), which already has history, review and
access control.

**Membership is the invite.** `agentbox org init <name> --store <uri>
[--skills owner/repo]` starts an org and prints its invite; `agentbox org
invite` prints it again; `agentbox org join <invite>` writes
`<agentbox home>/org.json` (0600): the org's name, the store URI, the org key
(AES-256-GCM, for the logins at rest: the cluster has other users and
backups), the skills repo, and `env`: variables every session the machine
starts gets (`INTERNAL_URL` and `AGENT_TOKEN`, for plaibook-internal's
`/api/work`), passed with a launch's secrets so no command line shows them.
`agentbox org env NAME=value` sets one (`NAME=` removes it); the other
members get it with a new invite, which `org join` takes over the old.
There is no member list. Trust is per org:
every member's agents can read `org.json` and so every pooled login, because
that is what pooling is. **Removing someone** is changing the database user's
password, sending the rest a new invite, and logging every org account in
again (they could have copied the refresh tokens; nothing else revokes them),
and deleting their devices from the tailnet (`sudo headscale nodes delete -i
<id>` on the headscale box, which takes the store's proxy from them).

**Scope is the session's** (`sessions.scope`), set when it starts and kept:
a resume, a hop, a wake, a fork or a recovery stays in it because
`placement()` only offers accounts of the scope it is asked for, and every
caller asks for the session's own. A start says `scope` (`--org` /
`--personal`, the dialog's Personal / Plaibook); without it, its parent's;
without a parent, `settings.scope` (`agentbox org default org|personal`). A
schedule keeps the scope it was made with, or takes the default when it
starts. A session started outside agentbox is personal, unless its home is
the pool's mirror of someone else's login. `agentbox org scope
org|personal <session>...` moves a session from one to the other later,
refused when its account is not one the new scope may run on; given a
schedule's id, it changes the scope of the sessions the schedule starts from
then on. An extension's long conversation (`sdk/conversation.ts`) takes
`scope` in its `start`, so each successor stays where the first was. Scope decides:

- **which accounts it may run on** (`Fleet.scopesOf`): a personal session on
  your own accounts, an org session on the logins in the pool. A login of
  yours that you shared is one account in both.
- **who sees it**: an org session has a `sessions` row with its title and a
  mailbox. A personal one is invisible outside this machine, except that one
  on a pooled login publishes an untitled `private` row, so the other
  members count what it claims.

## Org accounts

Claude, Codex, omp (an OpenCode Go sign-in or a service's key, Morph's), devin
and muse. A key does not rotate, so the store keeps it whole and never
refreshes it, like devin's `windsurf_api_key` and a muse `api_key`, which are
the only credentials those two share. A muse login kept as an access token (or in the macOS Keychain)
stays personal, since every sharer refreshing it would log the others out.

A login is shared or not, and you flip it either way at any time
(Accounts › the card's "Shared with Plaibook" toggle, `agentbox org share
<account>` / `unshare <account>`). Nothing has to be idle and nothing is
logged out: the account stays yours, and while it is shared the org has it
too. A login is one account everywhere: the store's document of it has its
sharer's account id, which is its account id on every member's machine, so
its card, its claims and the balancer's view of it are one in both scopes.

Two holders of a refresh token log each other out at the next refresh, so
the store holds the only one of a login from the first time it is shared,
and **every home of it** on every member's machine is a mirror: the sharer's
own homes (the account and any copy logged in as the same login, the CLI's
own home usually), and on each other member's machine, while it is shared,
the pool's home of it under `org/accounts/<id>`. A machine that holds a
login of its own of a shared one gets no mirror of it. A login's name across
machines is its email for claude, codex, devin and muse, and one OpenCode
account in one workspace for an omp sign-in (or the key itself, by digest) — an email can hold several workspaces,
each its own sign-in.

- **Sharing** seals the login into `accounts` with `shared: true`, or sets
  `shared` again on one the store already keeps. At the next sync (at once,
  here) the sharer's homes get the placeholder refresh token like everyone
  else's. A session already running on it goes on: its CLI re-reads the file
  near its token's expiry and finds the store's.
- **Unsharing** sets `shared: false`, and that is all: the store keeps the
  login and the sharer's machines go on mirroring and refreshing it, so it
  does not matter which of them is online. The other members' mirrors go at
  their next sync; a session there already on it keeps its access token until
  it runs out. A login out of the pool is still readable by any member with
  the org key: unsharing is a rule, not a revocation.
- **Reclaiming** (`agentbox org reclaim <account>`, for leaving the org)
  deletes the store's document (only at the version read, so a refresh
  landing in between is not lost) and writes the whole login, refresh token
  and all, back into the sharer's homes of it here.
- **A newer login in any mirror** (logging in again, or a CLI that refreshed
  before it saw the store's) goes to the store when its access token outlives
  the store's; an older one is a stale copy and is overwritten. A refresh the
  provider refuses sets `problem` and clears the login, and every mirror is
  logged out until someone logs in again.

Linux only for claude: on macOS it keeps its login in the Keychain, and a
muse default home may keep its login there too.

**Credential files.** Each member's machine keeps every home it has of a
login the store keeps in step with it (`syncOrgAccounts`, every 60 s): its
own, and an ordinary local home for each pooled login it holds none of. It
writes the store's current login into each: claude `.credentials.json` with
`refreshToken: "pooled"` and `.claude.json`'s `oauthAccount`, codex `auth.json` with `refresh_token:
"pooled"`, omp `opencode-console.json` with `refresh: "pooled"`, and devin's
`devin/credentials.toml`, muse's `muse/auth.json` and an omp key's
`api-key.json` whole (their key does not
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
for any account. **Claims are shared**: each machine publishes what every
session of its on a pooled login still claims, personal ones (untitled)
among them, and every member's balancer counts them, so two members do not
both place onto one pooled account as if it were free. The rows carry the
account id, which is the same on every machine. An org session at its limit
moves to another pooled account as any session does
(`Fleet.continueStalled`); codex has a `moveSession` (the rollout moves to the
same day's path in the other home).

## Seeing and messaging

Every 15 s each machine upserts a row for each of its live org sessions,
deletes its rows for the ones that ended, and reads everyone else's. A row
unseen for 3 minutes shows away; the TTL index removes it after a day. The
Sessions rail has a Plaibook section with the other members' live org
sessions; `agentbox org ls` prints them.

**Anyone in the org can read an org session**, its conversation included:
that is how a member's agent tells whether work is already being done before
it starts the same. A click on its row in the rail, or `agentbox log <id>`
for an id that is not this machine's, leaves a request in the store's `reads`
collection; the machine running the session answers it at its next look at
its mailbox (every 5 s) with the conversation's last 400 events from the
provider's transcript (what was said, and each tool by its one-line summary),
and the reader waits up to 30 s for it. Nothing calls in, and no copy is
kept: an answer is gone ten minutes later (a TTL index). A personal session
is not the org's to read, and a request for one is refused.

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
every 10 minutes. It links each org skill into each installed CLI's
user-level skills directory: `~/.claude/skills`, `~/.codex/skills` and muse's
`muse/skills`, which every account home of those CLIs links to, and
`~/.omp/agent/skills` and `~/.config/opencode/skills`, which omp and opencode
read for every account. So an org skill reaches every session on a member's
machine, personal ones too, and a personal skill of the same name (in any of
those, or `~/.agents/skills`) wins. Publishing is a pull request or a push to
the repo.

## The tailnet

The members' machines and the store's proxy are on one tailnet, run by our
own headscale (`headscale.plaibook.tech`); the files are `scripts/tailnet/`.
Joining a device is a one-use pre-auth key from `scripts/tailnet/key.sh
<user>` (24 hours) and `sudo tailscale login --login-server
https://headscale.plaibook.tech --authkey <key>`, which keeps the device's
other Tailscale account as a profile (`tailscale switch` goes back; a
device is on one at a time). It needs root: the operator setting is per
profile, so an operator's login to a new server is refused and leaves the
device logged out of both. `scripts/tailnet/move-here.sh` does it on a
machine of Ammon's. A phone or GUI client set to that custom coordination
server shows an auth id instead, approved with `sudo headscale auth register
--auth-id <id> --user <user>` on the box. Each person is a headscale user
(`ammon`, `nate`, `maxwell`, `tanner`, `austin`). The policy
(`scripts/tailnet/policy.hujson`, at `/etc/headscale/policy.hujson`,
reloaded with `systemctl reload headscale`) lets each person reach their own
devices and every member reach the proxy's port 1080, and nothing else;
agentbox's own tailnet listener also answers only its owner's devices
(`tailscale whois`).

**Ammon's own devices.** His phone, Mac and fedora stay on his personal
tailnet, where the board has its HTTPS name (headscale cannot issue
`tailscale cert` certificates, and the phone needs HTTPS for the mic). fedora
is on the team tailnet as well, through a second, unprivileged tailscaled
(`~/.config/systemd/user/tailscale-work.service`, userspace networking, state
in `~/.local/share/tailscale-work`), and reaches plaibook-box1 and box2
(100.64.0.5 and 100.64.0.7; netdata bound to those) through it with an `ssh`
`ProxyCommand tailscale --socket=… nc %h %p` in `~/.ssh/config`. Its own
store goes through its AWS tunnel (127.0.0.1:27180), so its invite is
`scripts/tailnet/invite.sh`, which swaps in the proxy's address.

**The proxy** is `atlas-proxy`, 100.64.0.2, a node tagged
`tag:atlas-proxy` on `plaibook-ssm-jump` (i-0b4dcd834f3fde8a2), the host in
the VPC that already holds everyone's Session Manager tunnels and whose NAT
addresses Atlas admits. `scripts/tailnet/atlas-proxy.sh` installs Tailscale,
joins it and runs a SOCKS5 server (`atlas-proxy.service`) on its tailnet
address that connects only to the store's cluster's members
(`*.ofldod7.mongodb.net:27017`; the store's database user can touch only
`agentbox_plaibook` there). The host is terraform's
(`plaibook-platform/infrastructure/ssm-jump-host.tf`) and keeps none of this
if it is replaced: run the script again over SSM, with a key from
`ssh headscale sudo headscale preauthkeys create --tags
tag:atlas-proxy`; if its address changed, change it in `invite.sh` and
send everyone a new invite. No security group or access
list changed for it: Tailscale needs only outbound 443 (its DERP relays,
since the host allows no UDP out).

    aws ssm send-command --instance-ids i-0b4dcd834f3fde8a2 --document-name AWS-RunShellScript \
      --parameters "$(jq -n --rawfile s scripts/tailnet/atlas-proxy.sh --arg k "$KEY" \
        '{commands: [("set -- " + $k), $s]}')"

**The headscale box** (EC2 i-0fc452f9ad83f9f6d, t4g.micro, Ubuntu 24.04 arm64,
in its own VPC vpc-0855b10b572742f35, Elastic IP 54.84.189.218, security group
sg-0d1060f954b4c8803 with 443 open; tagged `ManagedBy=manual-agentbox`, not
terraform). SSH reaches it only over the tailnet, as `ubuntu@100.64.0.1`
from one of Ammon's devices (`tag:server` in the policy; fedora's
`~/.ssh/config` names it `headscale`, through tailscale-work, with
`HostKeyAlias 54.84.189.218`); with the tailnet down, Session Manager
(its SSM agent is registered). To rebuild it: the headscale
v0.29.5 arm64 .deb from GitHub's releases and Ubuntu's `caddy`; the shipped
`/etc/headscale/config.yaml` with `server_url:
https://headscale.plaibook.tech`, `listen_addr: 127.0.0.1:8080`,
`policy.path: /etc/headscale/policy.hujson`, `dns.base_domain:
tail.plaibook.tech` and `dns.override_local_dns: false`; and
`/etc/caddy/Caddyfile` is `headscale.plaibook.tech { reverse_proxy
127.0.0.1:8080 }`. DERP is Tailscale's public one. A Route53 A record in
`plaibook.tech` points the name at the Elastic IP. The box is itself a
node (`headscale`, 100.64.0.1, `tag:server`), and the root disk is encrypted
(SOC 2). Its state is `/var/lib/headscale/db.sqlite`; losing
it means every device joins again.

## When things fail

- **The store unreachable.** Running sessions on a login the store keeps,
  yours among them, keep their access tokens (hours) and go on; a refresh
  waits; `send` to another machine and the org status say why. Sessions on a
  login the store does not keep do not notice.
- **A member's machine off.** Its org sessions stop with it; their rows show
  away after 3 minutes, and messages to them are refused.
