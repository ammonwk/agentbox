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
a card that does not push), never shaped after one agent.

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
| `steward/` | A do-it-all steward: every minute it reads your open pull requests and the sessions it started, starts an owner for a PR that needs work and has none, and brings its main conversation only what needs judgement. |
| `salus/` | Production crashes to verified fixes: polls PostHog's exceptions, has a read-only session triage each new one against the code within a daily budget, and shows the verdicts for a person to decide. Fix files the issue and hands a prepared family to Vulcan through its main conversation; after the merge it counts whether the crash stopped. Its settings and PostHog key live in its home. |
| `caelus/` | A conversation-only agent for release follow-through: a manifest and instructions, no code. |
| `lib/sdk.ts` | What a program in TypeScript needs: the API client, the page server, a store. A superagent in another language uses the same HTTP calls. |

## The directory

```
my-agent/
  superagent.json     the manifest (below)
  MAIN.md             optional: what its main conversation is told first
  main.ts             optional: its program
  …                   anything else it wants
```

Add it with `agentbox superagent add <dir>` (or `POST /api/superagents
{dir}`); run it again after changing the manifest. `agentbox superagent rm`
forgets it and leaves the directory and its state alone.

### `superagent.json`

```jsonc
{
  "name": "vulcan",                 // lowercase, digits, dashes; unique on this machine
  "title": "Vulcan",                // shown on the Agents page
  "description": "Issues to reviewed pull requests",
  "run": ["bun", "main.ts"],        // optional: its program, argv, run in the directory and kept running
  "url": "http://127.0.0.1:9000",   // optional instead of run: a program agentbox does not run
  "main": {                         // optional: its main conversation
    "start": { "provider": "claude", "model": "…", "cwd": "." },  // a POST /api/sessions body; cwd is from the directory, ~ is home
    "instructions": "MAIN.md",       // said before the first message; {{dir}}, {{home}}, {{agentbox}} (the checkout) and {{bin}} are filled in
    "schedule": "7w4wvcfm"           // instead of start: the session this schedule spoke to last
  },
  "node": "auto"                    // optional, on a hub: where the SDK's start puts a session that does not say (docs/hub.md)
  // Any other field is the superagent's own: agentbox ignores it.
}
```

Each part is optional. A manifest with only `main.start` and `instructions`
is a conversation agent with standing instructions and no code. One with
`main.schedule` adopts a same-session schedule (docs/v2.md, Schedules that
speak to one session) as its main conversation, which is how an existing
steward becomes a superagent without changing how it runs.

## What agentbox does for it

**Its program.** With `run`, agentbox starts it in its directory when the
server starts, and again whenever it exits: at once if it ran a minute,
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
| `AGENTBOX_SUPERAGENT_DIR` | its directory |
| `AGENTBOX_SUPERAGENT_HOME` | `<agentbox home>/superagents/<name>/`: its own state, which agentbox never reads |
| `AGENTBOX_SUPERAGENT_TOKEN` | the secret every request from agentbox carries |
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
    { "type": "divider" },
    { "type": "text", "title": "prompt.txt", "text": "exactly as written\n  indentation kept", "wrap": true, "maxHeight": 480 },
    { "type": "split", "id": "parts", "title": "Parts", "selected": "a", "items": [
        { "id": "a", "title": "First part", "subtitle": "what it is", "badge": "2.1k", "status": "ok", "blocks": [] } ] },
    { "type": "switch", "id": "how", "options": [
        { "id": "rendered", "label": "Rendered", "blocks": [] }, { "id": "plain", "label": "Plain text", "blocks": [] } ] }
  ],
  "refresh": 10
}
```

`text` shows its text exactly, in a fixed-width font, with copy and wrap
buttons; `split` is a list beside the pane of the entry chosen in it (as on
the Skills page, one at a time on a phone); `switch` is alternative views of
one thing behind a segmented control. An `item` with `collapsed` folds under
its header (`true` starts folded). What a person chooses in a `split`,
`switch` or folding `item` is kept in the browser by the block's `id` across
refreshes, so a page that refreshes does not throw it away; nothing is sent
to the program.

A button posts `POST /agentbox/action` with `{action, values, tab, caller}`:
`values` is the action's own `values` plus, inside a form, the form's fields.
The answer may carry `message` (shown), `view` (drawn instead), `open` (an
app link to go to, such as `#/agents/janus`), and `compose` (text put in the
chat's message box, for "give guidance").

**Who asked.** `caller` is `{session, via, person}`: `via` is `app` when a
browser sent it and `api` otherwise, `session` is the session that proved
itself with its capability (`agentbox superagent call` from inside a session
does), or null, and `person` is who made the request (`{login, name, role,
via}`: the machine's owner on loopback, a member's tailnet login on a hub,
docs/hub.md). It is how a program lets only its writer publish, or only a
person create, or on a hub only one person approve. A decision a person
makes on a superagent's page is theirs: record `caller.person` with it, and
pass it as `by` when closing the card the decision settles
(`agentbox.closeCard(id, why, caller.person)`), so the card says who decided. Like every loopback rule here it holds against mistakes and other
sites, not against code running as you on purpose (docs/v2.md, Security).

**Being called.** A session the program started calls it with `agentbox
superagent call <name> <action> --json file.json` (or `--set k=v`), and reads
the JSON answer. That is the verb a superagent's prompts teach its sessions;
it needs no CLI of its own.

**Every request** from agentbox to the program carries
`x-agentbox-superagent-token`; refuse any other (`serve` in `lib/sdk.ts`
does), so a page on another site cannot drive it.

## What it uses that every session has

A program is a client of the HTTP API (docs/v2.md). The parts superagents
lean on:

- `POST /api/sessions`: start a session, with `parent` to put it under the
  superagent's main on the board, `claim` to give it a PR from its first
  moment, `branch`/`worktree` to put it in a worktree, and `readOnly` for a
  reviewer that must not write (Codex; refused for a CLI that cannot be held
  to it). `notify: false` keeps its stops off your phone, for a session the
  superagent watches and shows on its own page; the board still shows it.
  `repo` and `ref` run it in a registered repo at that branch, tag or
  commit, in a detached worktree agentbox cuts where the session runs, and
  `close` with `removeWorktree` removes it after. On a hub, `node` puts it on
  a joined node or wherever has the most room (`"auto"`, docs/hub.md); the
  SDK's `start` sends the superagent's own default when it does not say: the
  `node` its settings (`PATCH /api/superagents/:name {node}`, the owner's)
  or its manifest give, and the hub itself unless one of them opts in.
- `POST /api/sessions/:id/send` with `from: "agent"`: type into one, under
  the send guard.
- `GET /api/sessions/:id/timeline`: read what a session said, from its
  provider's transcript — the record. A reviewer's verdict is read from here,
  so a writer cannot post one for it.
- `POST /api/sessions/:id/handover {to, close?}`: what one session holds goes
  to the one taking over: the sessions it started, its cards, its PRs and
  their waits, and messages to it (`agentbox handover`).
- `POST /api/waits` with `session`: a durable wait told to that session.
- `POST /api/cards`, with `notify: false` for a decision the superagent's own
  page already shows.
- `POST /api/prs/claim`, `/api/prs/who`: who has a PR.
- `GET /api/state`: everything on the board.

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

Keep state in its home (`store()`), make every step safe to repeat (a
restart can land anywhere), and put each idempotency key in the store before
the side effect it guards. Its tests are its own: `bun test` in its
directory.
