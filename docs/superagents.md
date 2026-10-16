# Superagents

A superagent is a program that runs on agentbox, not in it. Agentbox gives it
a name on the Agents page, a main conversation, a page of its own, and keeps
its program running. Everything it decides — when to start a session, what to
tell it, which rules to hold it to, what to remember — is its own code,
written against the same HTTP API and CLI any session uses (`docs/v2.md`,
HTTP API). Nothing in agentbox knows any superagent by name.

That is the whole design, and it is a rule for agentbox's own code: a
behaviour one superagent needs is that superagent's to write. Core changes
only when no superagent could do the thing from its own process with the
public API — and then the change is generic (a read-only session, a handover,
a card that does not push, a memory journal its manifest turns on), never
shaped after one agent.

Every agent on the Agents page is a superagent. Each person keeps theirs in
their own directories or git repositories and adds them with `agentbox
superagent add`; [agents.md](agents.md) is how to use them on the page.
Each registered directory is a generic agent: one definition, with layers
for a person and for a project over it, and one instance in each project
that turns it on ([Overrides and gates](#overrides-and-gates)).

The people who set superagents up are expected to have their coding agent do
it, so the bar is flexibility, not a form: a superagent is a directory of
code, and anything code can do it can do.

## Examples

`superagents/` in this checkout holds the starting ones. Copy one and change
it, or ask Jupiter for a new one.

| | What it is |
|---|---|
| `jupiter/` | Writes new superagents from a conversation: drafts a directory, shows it on its page with editable fields, and registers it when you press Create. |
| `vulcan/` | Turns reported issues into a reviewed pull request: one writer per family of issues in its own worktree, three independent read-only reviewers per round, at most three rounds, a guarded publication, and follow-up waits for review feedback and checks. |
| `steward/` | A do-it-all steward: every minute it reads your open pull requests and the sessions it started, starts an owner for a PR that needs work and has none, and brings its main conversation only what needs judgement. With `steward.discover: false` it takes only the PRs handed to it (`pr.tend`, below) and hands each one to the project's judge with `agentbox pr ready` once its owner verified it ready. Another directory can run its code with a manifest of its own (`run: ["bun", "<agentbox>/superagents/steward/main.ts"]`). |
| `caelus/`, `salus/` | Conversation-only agents for release follow-through and production health: a manifest and instructions, no code. |
| `lib/sdk.ts` | What a program in TypeScript needs: the API client, the page server, a store. A superagent in another language uses the same HTTP calls. |

## The directory

```
my-agent/
  superagent.json     the manifest (below)
  MAIN.md             optional: what its main conversation is told first
  SOUL.md             optional: its persona, read after MAIN.md by each fresh main
  main.ts             optional: its program
  …                   anything else it wants
```

Add it with `agentbox superagent add <dir>` (or `POST /api/superagents
{dir}`). It is off until a gate turns it on ([Overrides and
gates](#overrides-and-gates)), so adding one never starts work by itself.
Agentbox reads the manifest again when it changes, and starts its program
again with the new one. `agentbox superagent rm` forgets it and its
instances and leaves the directory and its state alone.

### `superagent.json`

```jsonc
{
  "name": "vulcan",                 // lowercase, digits, dashes; unique on this machine
  "title": "Vulcan",                // shown on the Agents page
  "description": "Issues to reviewed pull requests",
  "run": ["bun", "main.ts"],        // optional: its program, argv, run in the directory and kept running
  "url": "http://127.0.0.1:9000",   // optional instead of run: a program agentbox does not run
  "enabled": false,                 // optional: on when no layer says (default off: adding it starts nothing)
  "projectFields": ["myagent.labels"], // optional: its own fields a project's layer may set with no approval (dotted paths)
  "icon": "fix",                    // optional: its picture until one is set on the page (brain, sparkle, fix, release, health)
  "projects": ["owner/repo"],       // optional: the projects it shows in (repo ids, owner/repo or checkout paths);
                                    // default main.start.repoId; none: every project. It places it on the page,
                                    // decides which ready PRs it gets and which agents its main hears of
  "memory": true,                   // optional: its memory journal and MEMORY.md (below)
  "sweep": "23:00",                 // optional: close its idle work sessions daily; true is the time in Settings
  "events": ["pr.ready"],           // optional: generic events it takes (below): pr.ready, pr.tend
  "main": {                         // optional: its main conversation
    "start": { "provider": "claude", "model": "…", "cwd": "." },  // a POST /api/sessions body; cwd is from the directory, ~ is home;
                                    // "provider": "auto" picks Claude or Codex by room
    "instructions": "MAIN.md",       // said before the first message; {{name}}, {{dir}}, {{home}}, {{agentbox}} (the checkout)
                                    // and {{bin}} are filled in
    "schedule": "7w4wvcfm",          // instead of start: the session this schedule spoke to last
    "rollover": { "idleMin": 10, "contextPct": 60 },  // optional, needs memory: a fresh main from a handoff (below)
    "loops": [{ "id": "hourly", "when": "every hour", "check": "./ready.sh", "prompt": "…" }]  // or "file": "LOOP.md"
  },
  "github": { … }                   // optional: the GitHub App policy it proposes (GitHub actions, below)
  // Any other field is the superagent's own: agentbox ignores it.
}
```

Do not copy a directory to change it for a person or a project: write a
layer ([Overrides and gates](#overrides-and-gates)). With `{{name}}` in its
instructions, each instance calls itself by its own name.

Each part is optional. A manifest with only `main.start` and `instructions`
is a conversation agent with standing instructions and no code. One with
`main.schedule` adopts a same-session schedule (docs/v2.md, Schedules that
speak to one session) as its main conversation, which is how an existing
steward becomes a superagent without changing how it runs.

## Overrides and gates

One directory defines a generic agent. A person or a project never copies it
to change it: they write a layer over it. The effective manifest of an agent
in a project is, from the least specific to the most:

| Layer | File | Whose |
|---|---|---|
| base | `<its directory>/superagent.json` | the agent's author |
| user | `~/.agents/overrides/<name>.json` | the person, in every project |
| project | `<checkout>/.agentbox/superagents/<name>.json` | the project, shared by git (like `.vscode/settings.json`) |
| local | `<checkout>/.agentbox/superagents/<name>.local.json` | the person, in that project only |

`<name>` is the generic agent's name, and `<checkout>` is the project's
checkout on this machine. Each layer is a JSON merge patch
([RFC 7396](https://www.rfc-editor.org/rfc/rfc7396)) over the manifest,
the agent's own fields too (`steward.repos`, `vulcan.writer`). A null
removes a field. Three keys are the layer's own:

```jsonc
{
  "enabled": true,                  // the gate (below); null or absent: this layer does not decide
  "instructions": "Run bun test before you call work done.",  // said after MAIN.md; every layer's, in order
  "soul": "…",                      // a SOUL.md for it; the most specific layer's wins over the directory's
  "steward": { "repos": ["owner/repo"] }   // anything else is the merge patch
}
```

Agentbox reads each file again when it changes. A program reads its
effective manifest from `AGENTBOX_SUPERAGENT_MANIFEST` (the SDK's
`me.manifest`), not from its directory, and agentbox starts it again when
that manifest changes. A layer that cannot be read turns the agent off and
says why on its Settings.

**The gates.** Each layer can set `enabled`. For an agent in a project, the
project's gate wins when one is set: the local file first, then the shared
file. Else the person's gate decides, else the manifest's `enabled`, else it
is off. Settings shows which layer decided. On the page and with
`agentbox superagent enable|disable <name> [--project P | --user]`, a person
sets their own gates: the user one, and the local one of a project, which
agentbox adds to the checkout's `.git/info/exclude`. The shared project file
is changed in git, like any other file of the project.

**Instances.** A generic agent with no project runs once, for the person:
its own name, with the base and the user layer, on when the user gate (else
the manifest) says so. A project whose shared or local file names the agent
can turn it on there, by its own gate or by the person's. Then agentbox makes
one instance for that project, `<name>-<project>` (`vulcan-plaibook-dev`),
once, and keeps that name. A taken name gets a number. An instance has its
own main conversation, memory, store, home, token, loops, picture and page,
and shows under that project on the Agents page, in the place of its
generic agent. Its manifest is the generic one with its layers, its own name,
`projects` set to its project, and `main.start` with `repoId` of its project
and `worktree: true` unless a layer says otherwise (a `cwd` is dropped). Its
program runs from the generic directory with `AGENTBOX_SUPERAGENT_PROJECT`
(the repo id) and `AGENTBOX_SUPERAGENT_BASE`. A generic agent whose main is a
schedule's session has no instances. An instance that a gate turns off keeps
its conversations and shows as off; to remove one, turn it off in its project
(`agentbox superagent rm` of its generic agent removes the instances too).

**What a project layer may change.** A project's file is in a repository that
other people push to. It may change:

- `enabled`, `instructions` and `soul`;
- `title`, `description`, `icon`, `memory`, `sweep`, `events`,
  `main.rollover`, and `main.loops` with prompts only;
- the agent's own fields that its manifest declares safe for a project, in
  `projectFields` (dotted paths, each with everything under it). Only the
  directory and the person's layer declare them.

It may not change, without the person's approval, what runs, where it runs,
on which credentials, or what it reads from disk:

- `run`, `url` and `github`;
- `main.start` (provider, model, account, directory), `main.schedule` and
  `main.instructions` (a file path);
- `main.loops` with a `check` (a command) or a `file`, and `main` itself
  taken away;
- every own field the agent did not declare: only its program knows whether
  one is a path it reads, a provider it spends or a command it runs.

Agentbox leaves these fields out and shows them on Settings. The person
approves exactly those fields with those values (`agentbox superagent
approve <name> project|local`, or Review on the page): the approval is a
digest of them, so a later change to any of them needs approval again. Only
a person approves or sets a gate: a request from a session, or from a
superagent's program or anything it started, is refused. Like every loopback
rule here, this holds against mistakes and other sites, not against code
that runs as you on purpose: a program can leave its process tree, or write
the layer files itself (docs/v2.md, Security). The local file has the same rule, because a repository can commit
it too. `projects` and `name` in a project layer are ignored: an instance's
are its own.

What a project layer may change is still input from other people: its
instructions are as trusted as the repository's own `CLAUDE.md`. Declare a
field in `projectFields` only when any value of it is safe from a stranger:
never a path, a command, a provider, a model or a count with no bound. A
layer that nests deeper than 32 levels, or names `__proto__`, `constructor`
or `prototype`, is refused, and the agent is off until it is fixed.

The project's gate wins over the person's, as the person's own local gate
wins over the project's. So a project whose shared file says `"enabled":
true` turns on, in that project, an agent the person registered, even when
the person's own gate is off: with the agent's own code and the person's
config, never with code from the project. The person's local gate (`agentbox
superagent disable <name> --project P`) turns it off there again.

## What agentbox does for it

**Its program.** With `run`, agentbox starts it in its directory when the
server starts, and again whenever it exits: within seconds if it ran a minute,
otherwise after a backoff doubling to a minute. Its output is in
`<agentbox home>/superagents/<name>/process.log` (`agentbox superagent log`).
A restart of agentbox stops and starts it, so a program keeps what matters in
its own store and picks up where it was. The restart stops what the program
started too (under systemd, agentbox's whole unit stops), so long work that
must not be cut in half runs as a session, or in a unit of its own
(`systemctl --user start` of a oneshot). Its environment:

| Variable | |
|---|---|
| `AGENTBOX_URL` | the server, for the HTTP API |
| `AGENTBOX_BIN` | the `agentbox` command, to put in the prompts it writes |
| `AGENTBOX_SUPERAGENT` | its name |
| `AGENTBOX_SUPERAGENT_DIR` | its directory: the generic agent's, for an instance |
| `AGENTBOX_SUPERAGENT_MANIFEST` | its effective manifest, with its layers: read this one |
| `AGENTBOX_SUPERAGENT_PROJECT` | an instance's project (a repo id); empty for the person's own |
| `AGENTBOX_SUPERAGENT_BASE` | the generic agent it is |
| `AGENTBOX_SUPERAGENT_HOME` | `<agentbox home>/superagents/<name>/`: its own state, which agentbox never reads |
| `AGENTBOX_SUPERAGENT_TOKEN` | the secret every request from agentbox carries, and what proves the program to agentbox: it sends it back as `x-agentbox-superagent-token`, with `x-agentbox-superagent: <name>` (the SDK's `call` does), to claim work, write its memory or ask for a GitHub action |
| `PORT` | where to answer agentbox, on 127.0.0.1 |

**Its main conversation.** The Agents page shows it as the superagent's chat:
an ordinary session, with the Sessions page's timeline and composer. It is
the first that applies of: the schedule's session (`main.schedule`), the
session the program named (`PATCH /api/superagents/:name {main}` or
`agentbox superagent main`), or, on the first message with neither, a session
agentbox starts from `main.start` with `instructions` before the message.
Opening the page never starts anything; only sending does. When a program
hands its main to a fresh session (`agentbox handover`, below), the page
follows; the ones before are listed under it, read-only.

**Its page.** A program answers `GET /agentbox/view[?tab=…]` with blocks that
agentbox draws, on a phone too:

```jsonc
{
  "tabs": [{ "id": "work", "title": "Work", "badge": 2 }, { "id": "feed", "title": "Feed" }],
  "blocks": [
    { "type": "heading", "text": "Open work" },
    { "type": "markdown", "text": "Anything **markdown**." },
    { "type": "fields", "items": [{ "label": "Rounds", "value": "2 of 3" }] },
    { "type": "item", "title": "#123 Fix the export", "subtitle": "round 2", "status": "busy",
      "body": "markdown", "sessions": ["ab12cd34"], "links": [{ "label": "PR", "url": "https://…" }],
      "actions": [{ "id": "stop", "label": "Stop", "style": "danger", "confirm": "Stop this work?" }],
      "children": [] },
    { "type": "form", "id": "draft", "fields": [
        { "name": "title", "label": "Title", "kind": "text", "value": "…" },
        { "name": "body", "label": "Instructions", "kind": "textarea", "rows": 8 },
        { "name": "provider", "label": "Provider", "kind": "select", "options": [{ "value": "claude", "label": "Claude" }] },
        { "name": "on", "label": "Enabled", "kind": "checkbox", "value": true } ],
      "actions": [{ "id": "create", "label": "Create", "style": "primary" }] },
    { "type": "actions", "actions": [{ "id": "refresh", "label": "Refresh" }] },
    { "type": "divider" }
  ],
  "refresh": 10
}
```

A button posts `POST /agentbox/action` with `{action, values, tab, caller}`:
`values` is the action's own `values` plus, inside a form, the form's fields.
The answer may carry `message` (shown), `view` (drawn instead), `open` (an
app link to go to, such as `#/agents/janus`), and `compose` (text put in the
chat's message box, for "give guidance").

**Who asked.** `caller` is `{session, via, user?}`: `via` is `app` when a
browser sent it, `team` when a teammate on another machine sent it through
the cloud ([Team](#team)), and `api` otherwise. `session` is the session that
proved itself with its capability (`agentbox superagent call` from inside a
session does), or null. It is how a program lets only its writer publish, or only a person
create. Like every loopback rule here it holds against mistakes and other
sites, not against code running as you on purpose (docs/v2.md, Security).

**Being called.** A session the program started calls it with `agentbox
superagent call <name> <action> --json file.json` (or `--set k=v`), and reads
the JSON answer. That is the verb a superagent's prompts teach its sessions;
it needs no CLI of its own.

**Every request** from agentbox to the program carries
`x-agentbox-superagent-token`; refuse any other (`serve` in `lib/sdk.ts`
does), so a page on another site cannot drive it.

## What its manifest turns on

These are generic: agentbox gives each to any superagent whose manifest asks,
and none of them knows what the superagent is for.

**Memory** (`"memory": true`). A journal in its home (`memory.db`) of
handoffs, decisions and preferences, each naming the conversation it came
from. Its current main conversation and its program write handoffs and
decisions; they, and a person, set preferences:

    agentbox superagent memory <name> note --request <uuid> --file decision.json   # {decision, why, refs}
    agentbox superagent memory <name> prefer --key <key> --text <text>             # forget --key <key>
    agentbox superagent memory <name> search <words>                               # show <id> reads one
    GET/POST /api/superagents/:name/memory[/handoff|note|prefer|<id>]

Any other session is refused. Credential-shaped text is refused, and a
handoff has at most about 500 words. `MEMORY.md` in its home is a read-only
view that agentbox rebuilds after each write; agentbox sets an edited copy
aside, uses nothing in it, and tells the next fresh main. A fresh main starts
with the preferences, the latest handoff and the decisions since, in at most
12,000 characters, and the commands to read the rest.

**SOUL.md.** When its directory holds `SOUL.md` (or a layer gives `soul`), each fresh main reads it
after MAIN.md: whole lines up to 4,000 characters, and nothing when it holds
credential-shaped text. It gives no authority. Agentbox never writes it: it
is part of the directory, which is the person's config.

**Rollover** (`main.rollover`, with memory). While the main is idle and its
prompt cache is still warm, agentbox asks it for a handoff. A later message
that finds it cold, or past `contextPct` full, starts a fresh main from that
handoff and hands the main over to it (`POST /api/sessions/:id/handover`:
waits, cards, PRs, work claims and the sessions it started go with it). A
missing or stale handoff leaves the message with the old main. Each step is
journaled; the old process is proven stopped before the fresh one starts, and
the fresh one proven started before anything moves.

**Loops** (`main.loops`, or `PUT /api/superagents/:name/loops/:id` from a
person, its main or its program). At each time of a recurring rule, an
optional check runs in the main's directory (exit 0 says the prompt with what
it printed, exit 1 skips), and the prompt goes to the main once its turn ends.

**The sweep** (`"sweep"`). Each day at its time, agentbox closes the
superagent's work sessions (every open session under its main or an earlier
main) that have been idle for two hours, and keeps, with the reason, one that
holds a wait, an open card, a claimed PR or a child at work
(`GET /api/superagents/:name/sweeps`).

**Events** (`"events"`). Each superagent that takes an event and shows in
the PR's project gets it, other than the sender's own. With a program, it is
an action of the event's name; without, a message to its main. A failed
delivery is not counted, so the next report of the same event tries again.

- `pr.ready`: a session reports a pull request it owns, verified it ready on a
  head (`agentbox pr ready`). Once per PR and head. The action has `{repo,
  number, head, owner}`, with the owner as the caller.
- `pr.tend`: someone hands a pull request on, to be taken to ready
  (`agentbox pr tend <PR> [--note-file F] [--head SHA]`). A person runs it by
  hand; a judge's session runs it to send a PR back with its findings. Once
  per PR, head and sender: the sender's superagent, else its session, else the
  person. The action has `{repo, number, head, from, agent, note}`: `from` is
  the sending session (also the caller) or null, `agent` its superagent or
  null, and `note` the findings (at most 20,000 characters). Without `--head`,
  agentbox reads the PR's head from GitHub and refuses a closed PR. A session
  that holds the PR lets go of it once some agent takes the event, so that
  the taker can give it to a fresh owner.

What the taker does with the PR is its own. Steward's code with
`discover: false` keeps the owner when a session already holds the PR: it
sends that session the findings, so that its context is kept, and follows
it. Only when nobody holds the PR does it start a fresh owner with `claim`.
Either way the owner runs `agentbox pr ready` when it has verified the PR
ready, which gives the PR back to the judge.

**Its picture.** A person sets one on the Agents page
(`PUT /api/superagents/:name/avatar`); agentbox keeps it in its home and shows
it beside its messages.

**Who a session belongs to.** A session is the superagent's when it is its
main, an earlier main, or a session either started (`agentOwner` on the
board, and the sender the Timeline names). For what may act as the
superagent — claims, GitHub actions, reports — only sessions it started count:
a session started by its program, its main or another of its sessions (as
`POST /api/sessions` proves from the caller), or one under those by the
process tree. A parent set by dragging on the board, a session another
caller started under its main (a person's too), and a session handed over
into it from another superagent's session group under it and grant nothing.
A handover keeps what a moved session had, within the same superagent.

## What it uses that every session has

A program is a client of the HTTP API (docs/v2.md). The parts superagents
lean on:

- `POST /api/sessions`: start a session, with `parent` to put it under the
  superagent's main on the board, `claim` to give it a PR from its first
  moment, `branch`/`worktree` to put it in a worktree, and `readOnly` for a
  reviewer that must not write (Codex; refused for a CLI that cannot be held
  to it). `notify: false` keeps its stops off your phone, for a session the
  superagent watches and shows on its own page; the board still shows it.
- `POST /api/sessions/:id/send` with `from: "agent"`: type into one, under
  the send guard.
- `GET /api/sessions/:id/timeline`: read what a session said, from its
  provider's transcript — the record. A reviewer's verdict is read from here,
  so a writer cannot post one for it.
- `POST /api/sessions/:id/handover {to, close?}`: what one session holds goes
  to the one taking over: the sessions it started, its cards, its PRs and
  their waits, its work claims, and messages to it (`agentbox handover`).
- `POST /api/waits` with `session`: a durable wait told to that session.
- `POST /api/cards`, with `notify: false` for a decision the superagent's own
  page already shows.
- `POST /api/prs/claim`, `/api/prs/who`: who has a PR.
- `GET /api/state`: everything on the board.
- `POST /api/claims`: who has a piece of work (below).

## Claims

A claim says who has a piece of work, so that two programs or two sessions
never do the same work. Agentbox keeps the claims (`src/core/workclaims.ts`);
a program never keeps its own copy of who holds what.

**The key.** A claim is keyed by its source. Agentbox makes each source
canonical:

- A GitHub issue or pull request is `github:owner/repo#12`. Host casing,
  repository casing, fragments, query strings and `/issues` against `/pull`
  give the same key. `owner/repo#12` is the same issue too.
- Another http(s) link is the link without its fragment, with its query sorted.
- `env:<repo>:<environment>` is a deployment environment, in the scope `env`.
- Any other `scheme:id` is its own key, as you give it.

**The holder** is `{superagent, session}`. A program says who it is with two
headers, `x-agentbox-superagent: <name>` and `x-agentbox-superagent-token:
<AGENTBOX_SUPERAGENT_TOKEN>`; the SDK's `call` sends both. A wrong token gets
403. A session that proves itself with its capability is the holder session.

**The rules.**

- One holder for each scope and key. A claim of several sources takes all of
  them or none. A held source is refused with 409, and the answer's `data` is
  `{key, holder, state}`. The holder itself gets 409 too: read your claims back
  with `GET /api/claims` when an answer was lost.
- The fence is an integer. It increases on each change of holder: the claim,
  an attach, a takeover and a handover. An attach and a release must give the
  current fence; a stale fence gets 409. A takeover gives none: it is a
  person's or the holder's program's, and it proves the stop itself.
- The scope is the key's: an `env:` key is held in `env`, every other key in
  `work`. A call that mixes them is refused.
- Agentbox renews the lease while the holder session runs. A program never
  renews. A lease past its end makes the claim `uncertain`, and an uncertain
  claim still excludes all others: expiry never frees work.
- Only `release` by the holder, with the current fence, frees a key.
- A takeover is for a person or the holder's own program. Agentbox stops the
  holder session, then proves the stop: no process and no pane. Only then does
  it move the key, with fence + 1. A caller cannot send the proof. When the
  stop is not proven, the claim stays `takeover_requested`, the old holder
  still excludes, and you can ask again.
- A handover (`POST /api/sessions/:id/handover`) moves the claims of the old
  session to the new one, each with fence + 1.

**The order.** `POST /api/sessions` takes no id of your choice. Thus claim
first, then start the session, then attach it:

```ts
const claims = await agentbox.claim([issueUrl], { note: "work 12" });
const s = await agentbox.start({ provider: "codex", prompt });
for (const c of claims) await agentbox.attachClaim(c.key, c.fence, s.id);
// … when the work ends: agentbox.releaseClaim(key, fenceNow)
```

Keep the fence that each call gives back. A superagent that is a shared team
instance keeps its claims in the cloud. The calls stay the same.

## GitHub actions

A superagent can act on GitHub as a GitHub App: comment, open or update a
draft PR, mark it ready, merge it, close an issue, request a review. It never
holds the App's key or a token. It requests each action from agentbox, and
agentbox's broker (`src/core/github/`) does it after it checks the action
again. Programs and sessions get no `GH_TOKEN` from it.

**What the manifest proposes.** A `github` field in `superagent.json`:

```jsonc
"github": {
  "app": { "appId": 123456, "installationId": 7890123, "login": "my-app[bot]" },
  "repos": ["owner/repo"],
  "actions": ["comment", "open_pr", "update_pr", "ready_pr", "request_review"],  // also merge_pr, close_issue
  "approval": "prepare",                         // or "automatic"
  "mergePolicy": { "requiredChecks": ["ci"], "minApprovals": 1 }   // optional, for merge_pr
}
```

**What the host owner pins.** The proposal does nothing until the person who
owns this machine pins it, from their own terminal or the app:

    agentbox github policy <superagent>             # read what it proposes
    agentbox github pin <superagent> --key <pem>    # pin exactly that

The pin records the policy's digest and the path of the App's private key.
The key path is host config: it is never in a manifest, it must be absolute,
and the file must be mode 0600. A session or a program cannot pin, approve,
decline or answer an action's card: a request with their headers is
refused, and so is one without them whose client process runs inside an
agentbox session (agentbox reads the connection's process with `lsof`;
without `lsof`, only the headers decide). When the manifest's `github` field changes, every action is refused
until the owner pins again.
`agentbox github unpin <superagent>` stops them all.

**How a program requests an action.** `POST /api/github/actions` with the
headers `x-agentbox-superagent: $AGENTBOX_SUPERAGENT` and
`x-agentbox-superagent-token: $AGENTBOX_SUPERAGENT_TOKEN`. A session of the
superagent (its main, an earlier main, or a session one of them started)
sends the same body with `agentbox github request <file>`:

```jsonc
{
  "request": "0b8e…",                  // a UUID you keep: a retry with it answers the same record
  "action": { "kind": "comment", "repo": "owner/repo", "number": 12, "body": "…" },
  "claim": { "key": "https://github.com/owner/repo/issues/12", "fence": 3 },  // optional: the work you hold
  "cwd": "/path/to/checkout"           // open_pr, update_pr: the checkout with the head commit
}
```

The answer is `{request, state, result, card?}`. In prepare mode the state is
`prepared` and `card` is a Review decision card: the person answers
"approve" or "decline" there, or runs `agentbox github approve <request>`.
In automatic mode the action is sent at once. Read the outcome with
`GET /api/github/actions/:request`: `sent` (with the `url`), `refused` or
`failed` (nothing was sent; the `message` says why), or `uncertain`.
`POST /api/github/read` reads an issue, a PR, its reviews or its checks as
the App.

**The states.** `prepared` → `approved` → `attempting` → `sent`. An action is
`attempting` from the moment the broker starts to send it. A server that
stops then leaves it there, and the next server marks it `uncertain`. An
uncertain action is never sent again: a person looks at GitHub, and a GET
reads back what a merge or a closure did. A failure after part of the action
was visible on GitHub is also `uncertain`. To try again, use a new request id.

**What is refused.**

- A superagent with no pin, or a manifest that changed since the pin.
- A repo or an action kind outside the pinned policy.
- The same request id with a different body (409).
- A claim that the requesting superagent does not hold at that fence, when
  it asks and again at dispatch. An action that names a claim on a host with
  no claims service is refused too.
- Contact without consent. Bot contact is off until each person opts in, in
  the cloud, by their numeric GitHub id. The broker checks every explicit
  recipient, every `@mention` (in quotes, code or HTML entities too), an
  issue's author for a reply, and each requested reviewer. It refuses a team
  mention. It checks consent when it sends, so an approval does not outlive
  an opt-out. Without the cloud, every action that contacts a person is
  refused.
- Issue-closing keywords in a PR ("fixes #12"): `close_issue` closes an
  issue, after its PR merged, with evidence.
- A publication that changes `.github/workflows/` or a submodule, a file
  over 5 MB, more than 500 paths, or a head or base that moved since the
  request.
- A merge whose head moved, whose checks are not green, or that does not have
  the pinned number of approvals on its head. GitHub's branch protection
  still applies: the broker never asks to bypass it.

`open_pr` creates a draft on `agentbox/<claim or request>`. `update_pr`
updates that branch, without force: the claim's branch, or the one this
superagent's own `open_pr` made.

## Team

The owner of this machine can share a superagent with their cloud workspace
(docs/cloud.md, "Shared superagents"). It still runs here, on this machine
only. Teammates who can see it read its Chat (its main conversation, without
tool calls and with credentials redacted), read its page, take its actions,
and send guidance to its main conversation. A teammate never gets a terminal
or any other session.

**Sharing.** The owner shares it from the Agents page, signed in to the
cloud: `POST /api/superagents/:name/share` with the browser's cloud session.
The cloud checks that the person owns this machine's installation, and that
the installation has the `superagents:host` scope. A session or a program
cannot share. `visibility` is `private` (its maintainers only) or `workspace`
(every member). Seeing a superagent gives no right to change it, to unshare
it or to run it elsewhere.

**`via: "team"`.** An action from a teammate reaches the program with
`caller: {session: null, via: "team", user: {id, name}}`. `user.id` is the
teammate's cloud user id, as the cloud vouches. The program must treat it as
a remote person: not the owner of this machine, and not one of its own
sessions. Let a teammate do only what you would let any member of the
workspace do: read, ask, propose. Keep publication, deletion and spending for
the owner (`via: "app"`) or for your own sessions.

**Guidance.** A teammate's message arrives in the main conversation as
`[via agentbox cloud from <name> (<email>), a teammate]`, framed as a
colleague's request, not the owner's. Agentbox types it only into the main
conversation the teammate saw. When the main changed since then (a rollover,
a handover), it types nothing, and the teammate reads the new one first.

**Claims.** A shared superagent keeps its claims in the cloud, with the same
rules and the same calls ([Claims](#claims)): one holder for each key across
every instance of the workspace. Release its claims on this machine before
you share it, and its cloud claims before you unshare it.

**Template copy by git.** The cloud holds no code. The registry names the
superagent's source: `{repo, path, commit}`, from its checkout's `origin`.
A teammate who wants one of their own copies that directory from git, at
that commit, changes it, and adds it with `agentbox superagent add`. Push the
commit first, or the teammate cannot fetch it.

## Writing one

Start from the closest example. A program in TypeScript imports the SDK by
path:

```ts
import { agentbox, serve, store, every, me } from "/path/to/agentbox/superagents/lib/sdk.ts";

const db = store();
serve({
  view: () => ({ blocks: [{ type: "heading", text: `Hello from ${me.name}` }] }),
  action: async ({ action, caller }) => ({ message: `${action} from ${caller.via}` }),
});
every(60_000, async () => {
  // look at the world, start or tell sessions, remember what you did
});
```

Read its config from `me.manifest` (its layers over its directory), and its
project from `me.project` when it is an instance in one: the same code then
serves the person and each project. Keep state in its home (`store()`), make every step safe to repeat (a
restart can land anywhere), and put each idempotency key in the store before
the side effect it guards. Its tests are its own: `bun test` in its
directory.
