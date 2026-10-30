# Extensions

An extension is code of yours that runs on agentbox: a program that starts
sessions and talks to them, a part in the app (pages in the rail, keys,
buttons), or both — the way a plugin works in Obsidian. It is yours, not
agentbox's: it lives outside this checkout, so nothing personal reaches
upstream, and an agentbox update cannot break it as long as the HTTP API and
`agentbox/client` hold. Your coding agent is expected to write it, so the bar
is flexibility, not a form: an extension is a directory of code.

Agentbox does four things for one, and nothing else:

- **It runs its program.** Started when the server starts and again
  whenever it exits (at once if it ran a minute, else after a backoff that
  doubles to a minute), with the environment below.
- **It serves its program's page.** `/x/<name>/<path>` on agentbox is passed
  to the program as `/<path>`, and Settings → Extensions frames `/x/<name>/`.
- **It says who asked.** Every request it passes carries `x-agentbox-caller`
  and the program's token.
- **It loads its client into the app.** The module `client` names is bundled
  by the server against the app's own React and `agentbox/client`, and every
  page of the app loads it at start (Its part in the app, below).

Agentbox's own Review page is an extension of this kind, in the checkout's
`extensions/review/`: the extensions that come with agentbox live there and
are written against the same API as yours, nothing more.

Everything else an extension does — start a session, type into one, read
what one said, keep a conversation going, hand you a card — it does through
the same HTTP API and CLI any session uses (docs/v2.md, HTTP API). Nothing in
agentbox knows any extension by name, and that is a rule for agentbox's own
code: a behaviour one extension needs is that extension's to write. Core
changes only when no program could do the thing with the public API, and
then the change is generic (a pinned session is not parked the moment its
turn ends; a session start takes `fallbacks`), never shaped after one
extension.

## The directory

```
my-ext/
  extension.json   { "title": "My extension", "description": "…", "run": ["bun", "main.ts"], "client": "client.tsx" }
  main.ts          its program (any language)
  client.tsx       its part in the app
  …                anything else it wants
```

It has `run`, `client` or both. `run` is an argv, not a shell line, run in
the directory. Any other field in `extension.json` is the extension's own;
agentbox reads only `title`, `description`, `run` and `client`.

It is an extension once it is in `<agentbox home>/extensions/`, as a
directory or a link to one; its name is that entry's name. `agentbox ext add
<dir> [--name n]` makes the link, `agentbox ext rm <name>` removes it (its
program is stopped within seconds), and editing `run` starts it again with
the new one. Keep the code in a git repo of your own. To share one with a
team, share the repo: each member links their clone in, and it runs on each
member's machine against their own agentbox. The sessions it starts are
personal or the org's like any other (`scope`, docs/org.md), so an org
extension's work shows to the rest of the org, and PR claims keep two
members' copies off the same pull request.

`agentbox ext ls` shows each one and its program's state, `agentbox ext log
<name>` its output (`<agentbox home>/extensions/.state/<name>/process.log`),
and `agentbox ext restart <name>` stops it so it starts again. `agentbox ext
off <name>` (or Turn off on Settings → Extensions) stops its program and
leaves its client out of the app until `on`; it is how one that comes with
agentbox, such as Review, is put away. One of yours with the same name as one
that comes with agentbox is used in its place.

## Its program

Its environment:

| Variable | |
|---|---|
| `AGENTBOX_URL` | the server, for the HTTP API |
| `AGENTBOX_BIN` | the `agentbox` command, to put in the prompts it writes |
| `AGENTBOX_EXT` | its name |
| `AGENTBOX_EXT_DIR` | its directory |
| `AGENTBOX_EXT_HOME` | `<agentbox home>/extensions/.state/<name>/`: its own state, which agentbox never reads |
| `AGENTBOX_EXT_TOKEN` | the secret every request from agentbox carries in `x-agentbox-ext-token` |
| `PORT` | where to answer agentbox, on 127.0.0.1 |

A restart of agentbox stops and starts it, so it keeps what matters in its own
store and picks up where it was; make every step safe to repeat, and put
each idempotency key in the store before the side effect it guards. The
restart stops what the program started too (under systemd, agentbox's whole
unit stops), so long work that must not be cut in half runs as a session, or
in a unit of its own (`systemctl --user start` of a oneshot).

## Its page

Whatever it answers at `/` is its page, framed by the app from `/x/<name>/`
on agentbox's own origin: plain HTML of its own, or blocks (below). Its
script can call `/api/…` directly, with `x-agentbox: 1` on anything that
changes something, as the app does. The same rules as `/api` hold on
`/x/`: Host and Origin must be this machine's, and a request that changes
something must carry `x-agentbox: 1`, which a plain HTML form cannot send —
use `fetch`.

Because the page runs on agentbox's origin, a page that puts someone else's
text into HTML unescaped (a PR title, a session's words) hands that text the
whole API, including typing into agents that skip their permission prompts.
Escape everything, or draw blocks.

**Blocks** are the easy way: answer `/` with a redirect to
`/blocks.html?src=/x/<name>`, `GET /view?tab=` with blocks and `POST
/action` with what a button did, and the app's block page draws them in its
own look, on a phone too, escaping everything:

```jsonc
// GET /view?tab=work
{
  "tabs": [{ "id": "work", "title": "Work", "badge": 2 }, { "id": "log", "title": "Log" }],
  "blocks": [
    { "type": "heading", "text": "Open work" },
    { "type": "markdown", "text": "Anything **markdown**; [an app link](#/session/ab12cd34) opens in the app." },
    { "type": "fields", "items": [{ "label": "Rounds", "value": "2 of 3" }] },
    { "type": "item", "id": "pr-123", "title": "#123 Fix the export", "subtitle": "round 2", "status": "busy",
      "body": "markdown", "sessions": ["ab12cd34"], "links": [{ "label": "PR", "url": "https://…" }],
      "actions": [{ "id": "stop", "label": "Stop", "style": "danger", "confirm": "Stop this work?", "values": { "pr": 123 } }],
      "children": [], "collapsed": false },
    { "type": "form", "id": "draft", "fields": [
        { "name": "title", "label": "Title", "kind": "text", "value": "…" },
        { "name": "body", "label": "Instructions", "kind": "textarea", "rows": 8 },
        { "name": "provider", "label": "Provider", "kind": "select", "options": [{ "value": "claude", "label": "Claude" }] },
        { "name": "on", "label": "Enabled", "kind": "checkbox", "value": true } ],
      "actions": [{ "id": "create", "label": "Create", "style": "primary" }] },
    { "type": "actions", "actions": [{ "id": "refresh", "label": "Refresh" }] },
    { "type": "divider" },
    { "type": "text", "title": "prompt.txt", "text": "exactly as written", "wrap": true, "maxHeight": 480 },
    { "type": "split", "id": "parts", "title": "Parts", "selected": "a", "items": [
        { "id": "a", "title": "First part", "subtitle": "what it is", "badge": "2.1k", "status": "ok", "blocks": [] } ] },
    { "type": "switch", "id": "how", "options": [
        { "id": "rendered", "label": "Rendered", "blocks": [] }, { "id": "plain", "label": "Plain text", "blocks": [] } ] }
  ],
  "refresh": 10
}
```

A button posts `{action, values, tab}` to `/action`: `values` is the
action's own `values` plus, inside a form, the form's fields. The answer may
carry `message` (shown), `view` (drawn instead) and `open` (an app link to go
to, such as `#/session/ab12cd34`). What a person chooses in a `split`,
`switch` or folding `item` is kept in the browser by the block's `id`. The
types are `web/src/blocks/types.ts`.

## Who asked

`x-agentbox-caller` is `session:<id>` for a session that proved itself with
its capability, `app` for a browser, and `api` for anything else on this
machine. A session calls an extension with `agentbox ext call <name> <path>
[--json file]` (GET, or POST with the JSON), which proves it; that is the
verb an extension's prompts teach its sessions. It is how a program lets only
its own writer publish, or only a person press a button. Like every
loopback rule here it holds against mistakes and other sites, not against
code running as you on purpose (docs/v2.md, Security). Refuse any request
without the token (`serve` in the SDK does), so nothing reaches the program
except through agentbox.

## Its part in the app

`client` names a module (TypeScript and JSX are fine) whose default export is
called once, as each page of the app loads, with the `Plugin` it adds things
through:

```tsx
// client.tsx
import { type Plugin, Icon, Button, go } from "agentbox/client";
import "./mine.css";

export default function (p: Plugin) {
  p.page({
    id: "mine",                        // its address: #/mine, and #/mine/<rest>
    label: "Mine",
    icon: Icon.extension,
    badge: (state) => state.cards.filter((c) => c.state === "open").length,   // the count on its rail entry
    badgeTitle: (n) => `${n} open`,
    scoped: true,                      // filtered to the project selected at the top
    keys: [["→", "Next"]],             // its own keys, listed under its label in `?`
    render: ({ state, rest }) => <Mine state={state} />,
  });
  p.command({ key: "m", label: "Open Mine", run: () => go({ page: "ext", id: "mine", rest: "" }) });
  p.status(() => <span>✓</span>);                                  // the end of the system bar
  p.settings({ title: "Mine", render: () => <MineSettings /> });   // a section in Settings → General
  p.sessionAction(({ session }) => <Button size="sm">For {session.id}</Button>);   // an open session's tab bar
}
```

`agentbox/client` (web/src/plugin/client.ts) is what it may import from the
app: the app's parts (`Button`, `Empty`, `Icon`, `Modal`, `RelativeTime`,
`Markdown`, `MarkdownLinks`, `ErrorBoundary`), its live state
(`useAgentbox()`: all of it, the selected project's part, and that project),
`call(method, path, body)` for the HTTP API, `href` and `go` for the app's
addresses, and the domain types. It is the promise: what is there keeps
working across agentbox's updates, and anything else in the app is the app's
own to change. Import React as `react`; the server points it at the app's
copy, so there is one React on the page. Anything else it imports — its own
files, its CSS, a package in its own `node_modules` — is bundled into it.
For the types in an editor, give the extension a `tsconfig.json` with
`"paths": { "agentbox/client": ["<agentbox>/web/src/plugin/client.ts"] }`
and `"jsx": "react-jsx"`.

`p.data.load()` and `p.data.save(value)` keep one JSON value of its own in
`<agentbox home>/extensions/.state/<name>/data.json`, which its program, if it
has one, reads and writes as a file. What it shares with other people goes
where everything shared goes: cards, sessions, the org (docs/org.md).

Everything it draws is fenced: a page or section that throws says so in its
own place, a button or status item that throws becomes a mark naming the
extension, and a client that throws while loading, or does not build, is
shown failed on Settings → Extensions with why. A client is loaded once per
page load: after editing one, reload. If one breaks the app anyway, open it
with `?safe=1`, which loads no extension's client, and turn that one off.

The client runs in the app with everything the app can do, like an Obsidian
plugin: install only what you would run yourself.

## A conversation of its own

An extension that wants a conversation that runs for months, spoken to on a
timer and by you, keeps one with `sdk/conversation.ts`: what it says goes
to the session it has now, and a fresh one takes over when that one is
closed, stopped at a usage limit, past `freshOver` tokens of context, or on a
fallback while its own provider has room again. A fresh one is told the
instructions, the handoff its predecessor wrote, and whom it follows; what
the predecessor held goes to it (`agentbox handover`), and the idle
predecessor is closed. An idle, large one whose prompt cache is about to go
cold is asked once to write that handoff while it costs a short turn. The
session is pinned, so it is not parked the moment its turn ends, and you
talk to it on the Sessions page like any other.

From TypeScript, `conversation({start, instructions, freshOver, state})`;
from any other language, the same as a command configured by a
`conversation` field in the extension's own `extension.json`:

```jsonc
"conversation": {
  "start": { "provider": "claude", "model": "claude-opus-5-5", "cwd": ".", "fallbacks": ["codex"] },
  "instructions": "MAIN.md",
  "freshOver": 600000,
  "state": "~/.local/share/my-ext/conversation.json"   // default: its home's conversation.json
}
```

```
bun <agentbox>/sdk/conversation.ts say [--note] < text   # --note: skipped while it is mid-turn or showing a prompt
bun <agentbox>/sdk/conversation.ts tick                  # each minute: asks for the handoff while that is cheap
bun <agentbox>/sdk/conversation.ts show                  # {main, previous}
```

`<agentbox>` is the directory above `$AGENTBOX_BIN`'s. The state file is
`{main, previous}`, for the extension's own code to read.

## Writing one

A program in TypeScript imports the SDK by path:

```ts
import { agentbox, serve, store, every, me } from "/path/to/agentbox/sdk/extension.ts";

const db = store();
serve({
  view: (tab, caller) => ({ blocks: [{ type: "heading", text: `Hello from ${me.name}, ${caller.via}` }] }),
  action: async ({ action, caller }) => ({ message: `${action} from ${caller.via}` }),
});
every(60_000, async () => {
  // look at the world, start or tell sessions, remember what you did
});
```

`serve` answers `/`, `/view` and `/action` as above, refuses anything
without the token, and passes other paths to `routes`. The SDK is a
convenience over the HTTP API, not a requirement: an extension in Python
answers the same paths with the same headers.
