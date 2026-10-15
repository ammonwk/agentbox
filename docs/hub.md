# agentbox hub and nodes

One agentbox board for a team whose sessions run on several machines.
`docs/v2.md` is the contract for one machine and stays it; this file is what
a hub and its nodes add on top. With no hub configured, nothing here runs and
every machine behaves as v2.md says (the tests in
`src/server/__tests__/hub.test.ts` hold that).

Phase 1 is seeing and driving sessions where they already run. Phase 2 is
starting them: placing a session on a node, a start at a repo and a ref,
superagents placing their work, cards and pushes for one person, and the line
between what the owner does and what a member does. What comes next is at the
end.

## Roles

- **Hub.** One always-on agentbox that the whole team opens in a browser. It
  runs the superagent programs, cards, waits, PR claims and schedules as any
  agentbox does, and it shows the sessions of every node joined to it. The
  intended hub is the CI box, plaibook-box1, under a Unix user of its own. A
  machine is a hub when `<agentbox home>/hub/members.json` exists
  (`agentbox hub init`).
- **Node.** Any other machine running agentbox. It keeps everything it has
  today: its fleet, its tmux, its accounts, its transcripts. Joining a hub
  lets the hub show its sessions and pass requests for them through to it. A
  machine is a node when `<agentbox home>/hub/link.json` exists (`agentbox
  hub join`). A machine is a hub or a node, not both.
- **Member.** A person on the tailnet whose login is in the hub's
  `members.json`, with a role: `owner` or `member`. The owner edits the member
  list, approves nodes, and changes what the hub is (Roles on a hub, below); a
  member starts, reads and types into sessions.

**Sessions are static.** A session lives on one node for its whole life. The
hub lists it, records which node owns it, and passes its routes and its
terminal through to that node. Credentials never move between machines: work
goes to where the accounts are, never the reverse.

## Transport and identity

A private tailnet: Tailscale, or a self-hosted Headscale. agentbox uses only
what the local `tailscale` client answers either way:

- `tailscale status --json`: this machine's tailnet IP, its MagicDNS name, its
  user, and that user's login name.
- `tailscale whois --json <ip>`: for a connection's source address, the
  device (its name and tags) and the user it belongs to (`LoginName`,
  `DisplayName`).

It never calls Tailscale's SaaS API and never needs `tailscale cert`, which
Headscale may not offer. Without a certificate the tailnet listener serves
plain HTTP, as it always has; WireGuard encrypts and authenticates the path.

A source address on the tailnet cannot be forged by a peer, so "this request
came from the hub's IP" and "this connection is that person's device" are as
strong as the tailnet's own key exchange.

## Trust model

Loopback stays the trust boundary for everything on one machine
(`src/server/csrf.ts`). The tailnet listener (`src/server/tailnet.ts`) widens
it, and the hub widens it further. Every tailnet connection's source is looked
up with `whois` before routing (cached five minutes for a known device, ten
seconds for an address it could not vouch for), and is the first row that
applies (`admit` in `src/server/tailnet.ts`):

| peer | no hub configured | on a hub | on a node |
|---|---|---|---|
| the machine's own user's untagged device | admitted, as the owner | admitted, as the owner | admitted, as the owner |
| an untagged device whose login is in `members.json` | refused | admitted, as that member | refused |
| an approved node's IP | refused | `/api/hub/node/*` only, with its token | refused |
| the hub's IP (`link.json`) | refused | — | `/api/node/*` only, with the link's token |
| any other tagged device | refused | `POST /api/hub/join` only: files a request the owner must approve | refused |
| anyone else | refused | refused | refused |

The first row is v2's rule, unchanged; on a hub it means the person whose
untagged machine the hub is (if it is one) is an owner too, whatever
`members.json` says. A tagged device is a server or shared box, owned by tags
rather than a person, so it never counts as a member even when its tags were
set by one. The only door a tagged device has before it is a node is filing a
join request, which does nothing until the owner approves it, and at most 20
can wait at once.

Logins are what `whois` says: an email on Tailscale, and on Headscale the
user's name (`ammon`). Membership compares them case-insensitively.

Inside the door, the same CSRF rules as loopback apply (Host and Origin must
be one of this machine's tailnet names, and mutations carry `x-agentbox: 1`).

**The person behind each request.** Every request is given a person before it
is routed (`src/server/person.ts`):

- loopback: the machine's owner, the person in `members.json` with role
  `owner` on a hub, else this machine's own tailnet login, else `user.env`;
- the tailnet: the `whois` login and display name, with the role in
  `members.json` (the machine's own user is `owner`);
- the hub, on a node: the person the hub says made it, from
  `x-agentbox-person`. The node trusts this because it trusts the hub, and
  writes it beside every action it takes for the hub (`hub/audit.jsonl`).

Routes read it with `personOf(req)`. A superagent's action is sent
`caller: {session, via, person}`; `via` is unchanged (`app` is still a person
in a browser, `api` anything else), so existing programs keep working, and a
program that cares who can read `caller.person.login`.

**What a member can do.** Start sessions, on the hub and on any node that
takes starts; read them; type into them, on every node that joined, where
agents may run without permission prompts. What changes the hub itself, and
anything that runs a command as the hub's user outside a session, is the
owner's (Roles on a hub, below). So: a member is still trusted with the hub's
Unix user through the sessions they start (why the hub runs under one of its
own), and a node's owner who joins a hub trusts its members with the sessions
the node shares and, once it takes starts, with sessions in the repos it has
registered. A node shares only the sessions on the accounts it lends.

**What a node trusts.** Requests from the hub's tailnet IP that carry the
link's token, on `/api/node/*` only. Nothing else the hub could send reaches
the node's API. The node's own guards still run on every passed-through
request: CSRF (the node's own `checkRequest`, with the hub's request made
loopback-shaped), the send guard on agent messages, and the 409s a session not
in a state to do something answers. A request from the hub is never "from this
machine", so `open-file`, `open-url` and the background-tab check refuse it
rather than open something on the node owner's desktop.

## Configuration files

All in `<agentbox home>/hub/` (mode 0700), each file 0600. They are read again
when they change, so editing one by hand works without a restart.

`members.json`, on the hub:

```json
{ "members": [
  { "login": "ammonwk@gmail.com", "role": "owner", "name": "Ammon Kunzler" },
  { "login": "teammate@example.com", "role": "member" }
] }
```

There is always exactly one owner. Logins compare case-insensitively.

`nodes.json`, on the hub: the nodes that asked to join, approved or not.

```json
{ "nodes": [
  { "id": "k3v9x2", "name": "ammons-laptop", "ip": "100.64.0.7", "port": 4479,
    "token": "<64 hex>", "device": "ammons-laptop", "login": "ammonwk@gmail.com", "tags": [],
    "requestedAt": 1760000000000, "approvedAt": 1760000060000, "approvedBy": "ammonwk@gmail.com" }
] }
```

`link.json`, on a node:

```json
{ "hub": { "url": "http://plaibook-box1:4479", "ip": "100.64.0.1", "name": "plaibook-box1" },
  "name": "ammons-laptop", "token": "<64 hex>", "joinedAt": 1760000000000,
  "lend": { "maxSessions": null, "accounts": "all", "acceptStarts": false, "shareHeadroom": true } }
```

`lend` is the node owner's (`agentbox hub lend`): `accounts` is `"all"` or a
list of account ids, and the node shares only sessions on those (and none on
an account it does not list), and runs the hub's starts only on those.
`acceptStarts` lets the hub start sessions here at all, and `maxSessions`
caps how many it started are open at once (Placement). `shareHeadroom: false`
keeps the node's accounts' usage off the hub, which also keeps `"auto"` from
choosing it.

`placed.json`, on a node: the ids of the sessions the hub started here, which
`maxSessions` counts while they are open. Leaving the hub removes it.

`parents.json`, on the hub: the parent the hub gave each session it started
on a node (`<node id>:<its id there>` → a hub session id), which the node
cannot know. The hub shows it as that session's parent.

`audit.jsonl`, on a node: one line per mutating request the hub passed
through: `{at, person, method, path}`.

## Joining and leaving

1. On the hub, once: `agentbox hub init [--owner <login>]` writes
   `members.json` with its owner (by default this machine's own tailnet
   login; a tagged machine has none and must name one).
2. On the node: `agentbox hub join <hub address>` (a MagicDNS name, an IP, or
   a URL; port 4479 unless given). The node makes a random 32-byte token, asks
   the hub's `POST /api/hub/join` with it, and writes `link.json`. The hub
   files the request in `nodes.json` with the device's `whois` (its name,
   login and tags) and its IP, and answers with its own name and IP, which the
   node keeps as the only address it accepts hub requests from.
3. On the hub, the owner presses Approve on Team › Nodes (or `agentbox hub
   approve <node>`). From then on the hub connects to the node. The CLI on the
   node waits for that first connection and says so.
4. Either side ends it: `agentbox hub leave` on the node removes `link.json`
   and tells the hub; `agentbox hub leave <node>` or Remove on the hub removes
   the node from `nodes.json` and tells the node. Telling the other side is
   best effort: a node without `link.json` refuses the hub whatever it sends,
   and a hub without the node stops asking.

Joining again from the same node replaces its earlier entry and token.

## API additions

Every response is the v2 envelope. On a machine with no hub configured,
`GET /api/hub` answers `{role: "none"}` and the rest answer 409.

| method | path | who | body / query | returns |
|---|---|---|---|---|
| GET | /api/hub | any | | `HubStatus`: `role` (`none`, `hub`, `node`), the caller's `person`, and on a hub `members` and `nodes` (`HubNodeView`: reachable, last seen, sessions, lending, headroom; tokens never), on a node `link` (without its token) |
| POST | /api/hub/init | loopback | `{owner?}` | `HubStatus` — makes this machine a hub |
| PUT | /api/hub/members | owner | `{members: Member[]}` | `HubStatus` — exactly one owner; making another the owner hands it over |
| POST | /api/hub/nodes/:id/approve | owner | | `HubStatus` |
| DELETE | /api/hub/nodes/:id | owner | | `HubStatus` — ends the link, and tells the node |
| POST | /api/hub/join | a tailnet peer allowed to (above) | `{name, port, token, ip?}` | `{id, name, hub: {name, ip}}` — a pending request. `ip` is the node's tailnet IPv4, which the hub calls it on; it is taken only when `whois` says it is the device the request came from (which may have come over IPv6) |
| POST | /api/hub/node/leave | the node, with its token | | — the node ends its link |
| POST | /api/hub/link | loopback, on a machine not a hub | `{hub, name?}` | `HubStatus` — join (`agentbox hub join`) |
| PATCH | /api/hub/link | loopback, on a node | `{lend}` | `HubStatus` |
| DELETE | /api/hub/link | loopback, on a node | | `HubStatus` — leave, telling the hub |

Requests the hub sends a node, from the hub's IP with
`x-agentbox-hub-token` and `x-agentbox-person`:

| method | path | |
|---|---|---|
| GET | /api/node/state | `NodeState`: the node's name, lending, the open sessions it shares, its lent accounts' headroom when it shares that, the repos it has registered (`repos`: `{fullName, displayName}`), and how many sessions the hub started there are open (`placed`) |
| WS | /api/node/ws | the app socket (`/ws`): `hot` and `hotDelta` hold only shared sessions; no `cold` or `metrics`; a `node` frame (`NodeState` without sessions) on connect and every 5 seconds, which is how the hub knows it is there; `watch` works as on `/ws` for a shared session |
| WS | /api/node/ws/term/:id | `/ws/term/:id` for a shared session |
| POST | /api/node/sessions | a start from the hub (Placement): `POST /api/sessions` on the node's own path, within what it lends; into `audit.jsonl` |
| any | /api/node/sessions/:id/… | `/api/sessions/:id/…` for a shared session, with the node's own guards. Each that is not a read goes into `audit.jsonl` with the person (a terminal as `TERM`) |
| POST | /api/node/leave | the hub ends the link: the node removes `link.json` |

Anything else under `/api/node/` is 404, and a session the node does not share
is 404 too.

### Aggregated state

On a hub, `GET /api/state` and the `/ws` frames carry every joined node's
shared open sessions beside the hub's own. Each session has `node`: null for
the hub's own, the node's name otherwise. A remote session's `parent` and
`successor` are given as the hub knows them.

The hub holds one `/api/node/ws` socket to each approved node and keeps its
sessions from the frames. When the socket closes, or 15 seconds pass with no
frame, the node is away: its sessions stay listed, each with
`away: {lastSeen}`, never dropped and never marked stopped, until the socket
is back (it retries from 2 seconds, doubling to a minute) or the node leaves.

Session ids are random and stay as they are. The hub keeps a map from id to
node; when a node's id is already a local session's or an earlier node's, the
hub shows that one as `<node>-<id>` and maps it back on the way through.

### Passing through

On a hub, a request to `/api/sessions/:id/…` for a remote session goes to
its node's `/api/node/sessions/<its id there>/…`: the same method, query and
body, with `content-type` and `x-agentbox` kept, Host and Origin replaced
(the browser's were checked by the hub), and the token and person added. The
node's answer comes back as it is. A node that cannot be reached is a 502
saying which node and why.

`/ws/term/:id` for a remote session is relayed to the node's
`/api/node/ws/term/:id` frame for frame. A page socket on `/ws` that watches a
remote session gets its `timeline` and `btw` frames from a socket the hub
opens to the node for that watch, closed when the watch moves or the page
goes.

An image pasted into a remote session's composer goes to
`POST /api/sessions/:id/uploads` (and its thumbnail to
`GET /api/sessions/:id/uploads/:name`), so it is saved on the node, where the
agent reads it by path. A local session's composer keeps using
`/api/uploads`.

What stays on the hub, even for a remote session: anything not under
`/api/sessions/:id/` (`/api/sessions/changes`, cards, waits, PR claims naming
it, a superagent's action about it).

## Placement

`POST /api/sessions` on a hub takes `node`:

- absent or null: this machine, as on any agentbox;
- a joined node's name: that node;
- `"auto"`: the machine with the most room that may take it, the hub among
  them (`src/server/placement.ts`, pure, which says for each machine why it
  was or was not a candidate).

A machine may take an `"auto"` start when it is reachable, takes starts
(`acceptStarts`; the hub always does), is below its `maxSessions`, has the
repo registered, shares its headroom, and has an account for the provider
(a lent one, on a node) that its balancer finds eligible. Of those, the one
whose best such account has the most room wins: room is 100 less the
fuller of its weekly and short windows, the same readings Team › Nodes
shows. The hub wins a tie, so nothing hops for nothing. When none may, the
start is refused (409) with every machine's reason: `no machine can take it:
the hub: it has no codex account with room; nodebox: it is at its limit (2
of 2 open)`.

**A start on a node names a repo.** The hub's directories mean nothing on a
node, so a start placed there names a registered repo by its GitHub
`owner/name` (`repo`; the hub turns its own `repoId`, or a checkout's origin,
into that name) and runs in a new worktree of the node's clone of it: at
`ref` when one is given (below), on `branch` when that is, and else a fresh
worktree from the default branch, never the node owner's own checkout. An
`"auto"` start that names only a directory stays on the hub; one that names a
node outright from a checkout is taken there as that checkout's repo.
`claim` is refused for a node in phase 2, and `cwd` from the hub is refused by
the node. A hub `parent` (or the session above the CLI's `callerPid`) is kept
on the hub (`parents.json`).

**The node starts it.** The hub sends the start to `POST /api/node/sessions`
with the person who asked. The node checks, before anything runs, that its
owner lets the hub start sessions, that the open sessions the hub started
there and the starts under way are below `maxSessions`, that the repo is
registered, and that a named account is lent; then it starts the session on
its own `POST /api/sessions` path, where its balancer picks among the lent
accounts as it always picks (`SpawnRequest.accounts`). A refusal comes back
to whoever asked as it is, prefixed with the node's name (`node nodebox:
nodebox is at its limit: 2 of the 2 sessions it lends the hub are open`). A
started session is shown on the hub at once, under its id there, and is the
node's for its whole life: nothing moves it.

The CLI's `agentbox claude|codex|… --node <name|auto>` sends `node` (with
`--repo owner/name` and `--ref`), and prints the id of a session that went to
a node instead of attaching to its terminal. The New Session dialog's Where
row has a Runs on picker on a hub, for a start in a repo: this machine, Auto,
or a node (one away, not taking starts or at its limit is greyed with why).

### A start at a repo and a ref

On any machine, a start may name `repo` (a registered repo's id, `owner/name`
or ref) and `ref` (a branch, tag or commit) in place of a directory. The
machine that runs it fetches `ref` from origin, checks it out with a detached
HEAD in a new worktree at `<worktree root>/<session id>`
(`detachedWorktree` in `src/core/git.ts`), and starts the session there; a
read-only one gets none of the repo's worktree setup. `POST
/api/sessions/:id/close` with `removeWorktree: true` removes that worktree
once the session is done, when nothing in it would be lost: HEAD still
detached where it was cut (its reflog has the one entry), nothing
uncommitted. Anything else is left for the reclaim.

This is how Salus triages: it reads the base branch's commit from GitHub,
starts a read-only Codex session at `{repo: owner/name, ref: <sha>}`, and
closes it with `removeWorktree` once it has the verdict. It runs no git of its
own for a triage, so its triages can land on any node that has the repo.

### Superagents

The SDK's `agentbox.start` passes `node` through. Without one, it sends the
superagent's own default, which is `SuperagentInfo.node`: its setting
(`PATCH /api/superagents/:name {node}`: `"auto"`, a node's name, `"local"`,
or null for the manifest's) else its manifest's `node`; null, the hub itself,
unless one of them opts in, and always null on a machine that is not a hub.
Salus's manifest opts in to `"auto"`. A main conversation agentbox starts
from a manifest's `main.start` runs on the hub.

## People: cards, pushes and decisions

A card may name `person`, a member's login. On a hub it must be one (400
otherwise); a card that names nobody, or the owner, is the owner's. A push
subscription records the person who turned it on (`personOf`) and whether
they were the owner; one from before people were recorded is the owner's.
A new decision is pushed to its person's devices only, one batch per person;
a session's block is pushed to the owner's devices, as before; a test push
goes to the caller's own; `GET /api/push` lists the caller's own. On a
machine that is not a hub every device and every card is the owner's, so
nothing there changes.

Who decided is kept with the card: `decidedBy`, the person who answered it
(`POST /api/cards/:id/answer`), or whose decision on a superagent's page
settled it, which the superagent passes as `by` when it closes the card
(`agentbox.closeCard(id, why, caller.person)` in the SDK). Vulcan's Feed and
Salus's Fix and Dismiss record `caller.person` as `decidedBy` the same way.

## Roles on a hub

On a hub, a member is refused (403, `only the hub's owner may do that: …`)
what changes the hub itself or runs a command as its user outside any
session (`src/server/roles.ts`, before routing):

| what | routes |
|---|---|
| registering, changing or removing a superagent | `POST /api/superagents`, `PATCH`/`DELETE /api/superagents/:name` |
| the hub's accounts | anything but a read under `/api/accounts` and `/api/logins` |
| the hub's settings | `PUT /api/settings` |
| the global MCP servers, which every agent runs | anything but a read under `/api/mcp` |
| the registered repos, and the setup command a new worktree runs | anything but a read under `/api/repos` |
| the skills every agent reads | `POST /api/skill/*` |
| installing the hub's service | `POST /api/onboarding/*` |
| deleting worktrees | `POST /api/worktrees/reclaim` |
| acting as the hub on the agentbox cloud | anything but a read under `/api/cloud` |
| hands-free mode, an agent with a shell | `/ws/voice` |
| a command run on a timer | a wait whose kind is `until`; a schedule's `noteCmd` |

Editing the members and approving or removing nodes were the owner's in
phase 1 and still are. A member keeps everything else: starting sessions
(here or placed), schedules without a command, reading, typing into and
closing sessions, cards, waits, PR claims, a superagent's page and its
actions (where the superagent decides who may do what, with
`caller.person`), restarting a superagent. Reads stay open, settings and
accounts included. Loopback is the owner, so the CLI and every program and
session on the hub are too. On a machine that is not a hub every request is
its owner's and none of this refuses anything.

**When the link ends or changes**, the node closes every socket the hub
opened with it (state, watches, terminals): on `agentbox hub leave` either
side, and when its lending changes, after which the hub reconnects and is
sent the sessions it now shares. A socket whose token is no longer the link's
is closed at its next frame or keystroke even if `link.json` was edited by
hand.

## Failure

- **A node asleep or offline.** Its sessions stay on the hub's board, marked
  away with when it was last seen. Requests for them are 502, and a terminal
  says the node is away and closes. Nothing on the node is touched: its
  sessions keep running or stay stopped as they were, and the hub picks up
  where they are when it is back.
- **The hub down.** Nodes do not notice; nothing on a node waits for the hub.
  The team loses the shared board until it is back, and each person still has
  their own machine's board on loopback.
- **A token or IP that does not match.** The node answers 403 and logs it.
  It never tells the hub which part was wrong.
- **`link.json` or `members.json` unreadable.** The machine behaves as if it
  were absent (no hub, no node) and the server log says why. It never falls
  back to admitting more.

## Testing

`src/server/__tests__/hub.test.ts` runs three real servers on one computer (a
hub, a node, and a machine with no hub),
each with its own `AGENTBOX_HOME`, `HOME`, `AGENTBOX_PORT` and
`AGENTBOX_TMUX_SOCKET`, and `AGENTBOX_TAILNET=0`. `AGENTBOX_TAILNET_SEAM`
names a JSON file that stands in for `tailscale status` and `whois`: the
tailnet listener binds the seam's IP (another loopback address, such as
127.0.0.2), and reads a connection's source from `x-agentbox-seam-from`. The
seam is read only with `AGENTBOX_TAILNET=0`, so a server on the real tailnet
never honours the header.

For phase 2, both the hub and the node register `acme/app`, a clone of a bare
repo that stands in for GitHub (each machine's `~/.gitconfig` sends
`github.com/acme/app` there); only the node can run Codex (a stand-in `codex`
on its PATH and an API-key login); and the push services are an HTTPS sink on
loopback that counts what each device was sent. It covers a node refusing
starts until lent and at its limit, `"auto"` choosing it, the detached
worktree at the fetched commit and its removal on close, Salus starting a
triage on the node, a member's card pushed to that member only, and the
owner-only routes refusing a member; `choose` is tested on its own for the
order by room and every reason a machine is not a candidate.

## Next (not built)

- **PR claims and waits for a session on a node.** A claim or a wait naming a
  remote session is kept on the hub, which cannot see the session's branch
  or process, and a start placed on a node cannot carry `claim`.
- **A placed session's parent on the node.** The node does not know a parent
  that is a hub session (`parents.json` keeps it on the hub only), so closing
  the hub session does not close what it placed on nodes.
- **Pushes for a session per person.** A session's blocks go to the owner's
  devices; a session does not record who started it.
- **Schedules placed on nodes**, and the New Session dialog's Runs on for a
  schedule.
- **Placement from the hub's settings.** Who may place on which node is the
  node owner's `lend` alone; the hub has no per-member say.
- **Setting up Headscale**, and the tailnet ACLs that should back the trust
  table above.
