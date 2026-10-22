# Agents

An agent is a program that runs on agentbox, not in it: not one of the
coding-agent CLI sessions agentbox runs, but something that starts, talks to
and watches them. Agentbox gives it a name on the Agents page, a main
conversation, a page of its own, and keeps its program running. Everything it decides — when to start a session, what to
tell it, which rules to hold it to, what to remember — is its own code,
written against the same HTTP API and CLI any session uses (`docs/v2.md`,
HTTP API). Nothing in agentbox knows any agent by name.

That is the whole design, and it is a rule for agentbox's own code: a
behaviour one agent needs is that agent's to write. Core changes
only when no agent could do the thing from its own process with the
public API — and then the change is generic (a read-only session, a handover,
a card that does not push), never shaped after one agent.

The people who set agents up are expected to have their coding agent do
it, so the bar is flexibility, not a form: an agent is a directory of
code, and anything code can do it can do.

## Examples

`agents/` in this checkout holds the starting ones. Copy one and change
it, or ask Jupiter for a new one.

| | What it is |
|---|---|
| `jupiter/` | Writes new agents from a conversation: drafts a directory, shows it on its page with editable fields, and registers it when you press Create. |
| `vulcan/` | Turns reported issues into a reviewed pull request: one writer per family of issues in its own worktree, three independent read-only reviewers per round, at most three rounds, a guarded publication, and follow-up waits for review feedback and checks. |
| `steward/` | Takes pull requests to ready: each one handed to it (`agentbox agent call steward tend --set pr=<PR>`), or that its every-minute scan finds needing work with nobody on it (unless `steward.discover` is false), goes to one owner, the session that already holds it when there is one. It counts a PR ready only on the head GitHub shows green, corrects an owner once, and brings its main conversation only what needs judgement. |
| `salus/` | Production crashes to verified fixes: polls PostHog's exceptions, has a read-only session triage each new one against the code within a daily budget, and shows the verdicts for a person to decide. Fix files the issue and hands a prepared family to Vulcan through its main conversation; after the merge it counts whether the crash stopped. Its settings and PostHog key live in its home. |
| `caelus/` | A conversation-only agent for release follow-through: a manifest and instructions, no code. |
| `lib/sdk.ts` | What a program in TypeScript needs: the API client, the page server, a store. An agent in another language uses the same HTTP calls. |

## The directory

```
my-agent/
  agent.json    the manifest (below)
  MAIN.md       optional: what each fresh main conversation is told first
  main.ts       optional: its program
  …             anything else it wants
```

Add it with `agentbox agent add <dir>` (or `POST /api/agents
{dir}`); run it again after changing the manifest. `agentbox agent rm`
forgets it and leaves the directory and its state alone.

### `agent.json`

```jsonc
{
  "name": "vulcan",                 // lowercase, digits, dashes; unique on this machine
  "title": "Vulcan",                // shown on the Agents page
  "description": "Issues to reviewed pull requests",
  "icon": "fix",                    // optional: brain, sparkle, fix, release or health, until a picture is uploaded
  "projects": ["owner/repo"],       // optional: the projects it shows in (repo ids, owner/repo or checkout
                                    // paths); without it, main.start's repoId, else every project
  "run": ["bun", "main.ts"],        // optional: its program, argv, run in the directory and kept running
  "url": "http://127.0.0.1:9000",   // optional instead of run: a program agentbox does not run
  "main": {                         // optional: its main conversation
    "start": { "provider": "claude", "model": "…", "cwd": ".", "fallbacks": ["codex"] },
                                    // a POST /api/sessions body; cwd is from the directory, ~ is home;
                                    // fallbacks: other providers, in order, when its own has no room
    "instructions": "MAIN.md",       // what each fresh main is told first; {{dir}}, {{home}},
                                    // {{agentbox}} (the checkout) and {{bin}} are filled in
    "freshOver": 150000             // tokens of context past which the next message starts a fresh main
  }
  // Any other field is the agent's own: agentbox ignores it.
}
```

Each part is optional. A manifest with only `main.start` and `instructions`
is a conversation agent with standing instructions and no code. Something it
should hear on a timer is a schedule that speaks to it (`agentbox schedule
'every 10 minutes' --to <name> --note-cmd <command>`; docs/v2.md, Schedules
that speak to an agent): its note command runs in the agent's directory, and
what it prints is said to the main.

**Memory** is files. An agent keeps what it should remember where its main
can read and write it: its home (`{{home}}` in MAIN.md), or the CLI's own
memory for the main's directory, which agentbox shares across every account
of that CLI. Say in MAIN.md where it is and what goes there. Agentbox reads
none of it, except the handoff below.

## What agentbox does for it

**Its program.** With `run`, agentbox starts it in its directory when the
server starts, and again whenever it exits: at once if it ran a minute,
otherwise after a backoff doubling to a minute. Its output is in
`<agentbox home>/agents/<name>/process.log` (`agentbox agent log`).
A restart of agentbox stops and starts it, so a program keeps what matters in
its own store and picks up where it was. The restart stops what the program
started too (under systemd, agentbox's whole unit stops), so long work that
must not be cut in half runs as a session, or in a unit of its own
(`systemctl --user start` of a oneshot). Its environment:

| Variable | |
|---|---|
| `AGENTBOX_URL` | the server, for the HTTP API |
| `AGENTBOX_BIN` | the `agentbox` command, to put in the prompts it writes |
| `AGENTBOX_AGENT` | its name |
| `AGENTBOX_AGENT_DIR` | its directory |
| `AGENTBOX_AGENT_HOME` | `<agentbox home>/agents/<name>/`: its own state, which agentbox never reads |
| `AGENTBOX_AGENT_TOKEN` | the secret every request from agentbox carries |
| `PORT` | where to answer agentbox, on 127.0.0.1 |

**Its place on the Agents page.** The rail lists the agents the selected
project shows, each with its picture (uploaded on its Settings tab, kept as
`<its home>/avatar`) and what it is doing, in the order you drag them to
(or Alt+↑/↓); disabled ones last. Under the open one are its conversations:
its main, the sessions started under it that are still open, and on request
the closed ones and the earlier mains. Its tabs are Chat (the conversation
picked in the rail), Feed (its page, below) and Settings: what it is, whether
it is enabled, its program and that program's output, and the schedules
that speak to it.

**Its main conversation.** The Agents page shows it as the agent's chat:
an ordinary session, with the Sessions page's timeline and composer, so a
question it asks (AskUserQuestion) is answered there as on the Sessions page. It is
the session the program named (`PATCH /api/agents/:name {main}` or `agentbox
agent main`), or one agentbox starts from `main.start` on the first message,
with `instructions` before it. Opening the page never starts anything; only
sending does. Every message for the main, yours and a schedule's, goes
through agentbox (`Agents.say`), which keeps it a conversation that can run
for months:

- **A fresh main** takes over when the main is closed, stopped at a usage
  limit, holds more context than `main.freshOver` (150k tokens unless it
  says), or runs on a fallback while its own provider has room again. The
  message starts it, after its instructions, the name of the main it follows,
  and that main's handoff. The old main's sessions, cards, pull requests and
  messages go to it (`agentbox handover`), and the old one is closed once it
  is not mid-turn. The ones before are listed under it, read-only.
- **The handoff.** A main that is idle, holds more than half its context
  size, and whose prompt cache goes cold in a few minutes is asked once to
  write what a successor needs to `<its home>/handoff.md`: a short turn while
  the cache is warm, where asking a cold one would cost a re-read of
  everything it holds.
- **Compaction.** A main the CLI compacted is told its instructions again
  with the next message, once.
- **Kept warm.** A main is not parked as soon as its turn ends `STATUS:
  done`, as other sessions are, since its next message is coming.

When a program hands its main to a fresh session itself (`agentbox
handover`), the page follows.

**Its page.** A program answers `GET /agentbox/view[?tab=…]` with blocks that
agentbox draws as its Feed, on a phone too; on a wide screen the first tab
also sits beside its main conversation:

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

**Who asked.** `caller` is `{session, via}`: `via` is `app` when a
browser sent it and `api` otherwise, and `session` is the session that proved
itself with its capability (`agentbox agent call` from inside a session
does), or null. It is how a program lets only its writer publish, or only a
person create. Like every loopback rule here it holds against mistakes and other
sites, not against code running as you on purpose (docs/v2.md, Security).

**Being called.** A session the program started calls it with `agentbox
agent call <name> <action> --json file.json` (or `--set k=v`), and reads
the JSON answer. That is the verb an agent's prompts teach its sessions;
it needs no CLI of its own.

**Every request** from agentbox to the program carries
`x-agentbox-agent-token`; refuse any other (`serve` in `lib/sdk.ts`
does), so a page on another site cannot drive it.

## What it uses that every session has

A program is a client of the HTTP API (docs/v2.md). The parts agents
lean on:

- `POST /api/sessions`: start a session, with `parent` to put it under the
  agent's main on the board, `claim` to give it a PR from its first
  moment, `branch`/`worktree` to put it in a worktree, and `readOnly` for a
  reviewer that must not write (Codex; refused for a CLI that cannot be held
  to it). `notify: false` keeps its stops off your phone, for a session the
  agent watches and shows on its own page; the board still shows it.
  `repo` and `ref` run it in a registered repo at that branch, tag or
  commit, in a detached worktree agentbox cuts where the session runs, and
  `close` with `removeWorktree` removes it after.
- `POST /api/sessions/:id/send` with `from: "agent"`: type into one, under
  the send guard.
- `GET /api/sessions/:id/timeline`: read what a session said, from its
  provider's transcript — the record. A reviewer's verdict is read from here,
  so a writer cannot post one for it.
- `POST /api/sessions/:id/handover {to, close?}`: what one session holds goes
  to the one taking over: the sessions it started, its cards, its PRs and
  their waits, and messages to it (`agentbox handover`).
- `POST /api/waits` with `session`: a durable wait told to that session.
- `POST /api/cards`, with `notify: false` for a decision the agent's own
  page already shows.
- `POST /api/prs/claim`, `/api/prs/who`: who has a PR.
- `GET /api/state`: everything on the board.

## Writing one

Start from the closest example. A program in TypeScript imports the SDK by
path:

```ts
import { agentbox, serve, store, every, me } from "/path/to/agentbox/agents/lib/sdk.ts";

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
