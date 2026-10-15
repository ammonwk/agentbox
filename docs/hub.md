# agentbox hub and nodes

One agentbox board for a team whose sessions run on several machines.
`docs/v2.md` is the contract for one machine and stays it; this file is what
a hub and its nodes add on top. With no hub configured, nothing here runs and
every machine behaves as v2.md says (the tests in
`src/server/__tests__/hub.test.ts` hold that).

This is phase 1: seeing and driving sessions where they already run. What
comes next is at the end.

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
  list and approves nodes; a member does everything else.

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

**What a member can do.** Anything the hub's API allows, except editing the
members and approving or removing nodes, which are the owner's. That includes
starting sessions on the hub and typing into sessions on every node that
joined it, where agents may run without permission prompts. So: a member is
trusted with the hub's Unix user (why the hub runs under one of its own), and
a node's owner who joins a hub trusts its members with the sessions the node
shares. A node shares only the sessions on the accounts it lends.

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

`lend` is the node owner's: `accounts` is `"all"` or a list of account ids,
and the node shares only sessions on those (and none on an account it does
not list). `maxSessions` and `acceptStarts` limit starts from the hub, which
phase 1 does not make; they are recorded and shown now so the hub can honour
them when it does. `shareHeadroom: false` keeps the node's accounts' usage off
the hub.

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
| GET | /api/node/state | `NodeState`: the node's name, lending, the open sessions it shares, and its lent accounts' headroom when it shares that |
| WS | /api/node/ws | the app socket (`/ws`): `hot` and `hotDelta` hold only shared sessions; no `cold` or `metrics`; a `node` frame (`NodeState` without sessions) on connect and every 5 seconds, which is how the hub knows it is there; `watch` works as on `/ws` for a shared session |
| WS | /api/node/ws/term/:id | `/ws/term/:id` for a shared session |
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

What stays on the hub in phase 1, even for a remote session: anything not
under `/api/sessions/:id/` (`/api/sessions/changes`, cards, waits, PR claims
naming it, a superagent's action about it).

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

`src/server/__tests__/hub.test.ts` runs two real servers on one computer,
each with its own `AGENTBOX_HOME`, `HOME`, `AGENTBOX_PORT` and
`AGENTBOX_TMUX_SOCKET`, and `AGENTBOX_TAILNET=0`. `AGENTBOX_TAILNET_SEAM`
names a JSON file that stands in for `tailscale status` and `whois`: the
tailnet listener binds the seam's IP (another loopback address, such as
127.0.0.2), and reads a connection's source from `x-agentbox-seam-from`. The
seam is read only with `AGENTBOX_TAILNET=0`, so a server on the real tailnet
never honours the header.

## Phase 2 (not built)

- **Placement.** Starting a session on a node from the hub: `POST
  /api/sessions` with `node`, or `node: "auto"` chosen by the lent accounts'
  headroom and whether the repo is checked out there. The node checks
  `acceptStarts`, `maxSessions` and the lent accounts before it starts
  anything.
- **The superagent SDK's `start`** choosing a node, through the same.
- **Worktrees a superagent cuts.** Salus makes its own git worktrees on the
  hub today. A remote start needs to take a repo and a ref so that the node
  cuts the worktree where the session will run.
- **Cards and push notifications per person**: who a card is for, and pushing
  it to that person's devices only.
- **Uploads for a remote session**, saved on its node.
- **Setting up Headscale**, and the tailnet ACLs that should back the table
  above.
