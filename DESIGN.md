# agentbox — design contract

This is the spec the rework is built against. `src/core/types.ts` is the
machine-readable half; this is the rest. If code and this document disagree,
that is a bug in one of them — say so rather than silently picking a side.

## What agentbox is for

Running cheap coding agents (deepseek-class) on real repos, watching them
closely, correcting them early, and shipping their PRs. The model is capable
but not stable: it does well on well-scoped work and badly when left alone.
**Everything here optimises for a human noticing a wrong turn quickly and
correcting it cheaply.**

The surface area stays small. When a feature and a simplification are both
defensible, take the simplification.

## The loop we are designing for

1. Give a task → spawn.
2. Something needs me → I find out without hunting.
3. See what it actually did → transcript **with tool calls**, and the diff.
4. Correct / approve / stop it.
5. Its PR lands.

Steps 3 and 4 are where the old version was weakest: there was no detail view,
tool calls were discarded, and there was no way to see the diff. Those are the
centre of the rework, not the periphery.

## Information architecture

Three pages. The old five collapsed:

| Page | Holds | Was |
|---|---|---|
| **Inbox** | Sessions that need a human *act*, ranked. Nothing else. | Conductor + Pull Requests |
| **Sessions** | Master–detail board. List left, full detail right. | Agents |
| **Settings** | Run defaults, the system-prompt overlay, supervisor/advisor config, repos, and a read-only skills list. | Settings + Skills |

Skills was a card grid of things you cannot act on. It becomes a plain list in
Settings. Do not build a page for it.

### Sessions detail — the important screen

Master–detail, list on the left (~320px, sorted by attention rank then
recency), detail on the right. Detail is:

- **Header** — title, status, attention line, repo · branch, model, elapsed,
  cost/tokens, tool-call count. Actions: Interrupt (running), Resume
  (flagged/dead), Archive, Delete.
- **Activity** — the live transcript, streamed. Tool calls render as compact
  rows (kind icon, title, duration, ok/error) that expand to show input and
  output. Assistant text renders as prose. Advisory and supervisor events are
  visually distinct from both. Auto-scrolls when pinned to the bottom; shows a
  "jump to latest" affordance when scrolled up. **Never** re-fetch the whole
  transcript on a timer.
- **Diff** — per-file, collapsible, with an added/removed count. This is how a
  human judges the work; it is not optional.
- **Steer** — always-visible composer at the bottom. Placeholder states what
  will happen (delivered now vs. queued until the turn ends). Approve/Deny
  replaces it when the session is blocked on a permission.

### What is in the Inbox — corrected after running it

The first build followed an earlier version of this spec and produced a
**72-item Inbox** against real data. Both causes were spec bugs, and the rule
now is: *an Inbox item is something a human can act on, that nobody has acted
on yet.*

- **`idle` never enters the Inbox.** `idle` means "a turn ended and nothing is
  wrong" — that describes 15 of 22 real sessions, permanently, so the empty
  state was unreachable. `idle` stays in `Attention` because it orders the
  Sessions board; it is not an Inbox item. Inbox kinds are `approval`,
  `failed`, `flagged`, `review`.
- **Standalone PR items are gone.** The rule "open PRs with no session behind
  them" means, on any real repo, *every PR anybody has open* — 50 of them here,
  none agentbox's. A PR reaches the Inbox only through the session that
  produced it (`review`). `listPrs` still runs, for linking and for `done`.

The Pull Requests page was already deleted; this finishes the thought. agentbox
is a board for *its own* agents, not a GitHub client.

## Behaviour rules

- **A session that halts must be resumable in one click.** A supervisor that
  stops a run the human cannot cheaply restart trains people to switch the
  supervisor off. `flagged`, `dead` **and `failed`** all get **Resume**:
  a `failed` session is usually one that never launched, and re-running the
  original task is exactly what a person wants. Resume is offered in the same
  places with the same words everywhere it appears.
- **Destructive actions confirm; reversible ones do not.** Delete confirms
  (worktree + branch die). Interrupt, archive and deny do not.
- **Every empty state says what will fill it**, and links to the action that
  does so where one exists.
- **Every failure is legible.** Never a spinner that can hang forever and never
  a silent catch. If `gh` is missing, the UI says `gh` is missing.
- **Settings never save per keystroke.** Text inputs commit on blur or Enter;
  toggles commit immediately.

## Module ownership

One owner per file. Do not edit a file you do not own — if you need a change in
someone else's file, build to the contract below and say so in your report.

| Owner | Files |
|---|---|
| *(fixed contract — nobody edits)* | `src/core/types.ts`, `DESIGN.md` |
| **engine** | `src/core/acp.ts`, `src/core/sessions.ts` |
| **supervisor** | `src/core/supervisor.ts`, `src/core/prompts.ts`, `prompts/*` |
| **data** | `src/core/db.ts`, `src/core/state.ts`, `src/core/conductor.ts`, `src/core/prs.ts`, `src/core/skills.ts`, `src/core/git.ts`, `src/core/diff.ts`, `src/core/paths.ts` |
| **surface** | `src/server/index.ts`, `src/mcp/index.ts`, `bin/agentbox` |
| **ui-shell** | `web/src/styles.css`, `web/src/components.tsx`, `web/src/App.tsx`, `web/src/api.ts` |
| **ui-sessions** | `web/src/views/Sessions.tsx`, `web/src/views/session/*` |
| **ui-inbox** | `web/src/views/Inbox.tsx`, `web/src/views/Settings.tsx` |

Delete `web/src/views/{Agents,Conductor,Prs,Skills}.tsx` — ui-shell owns the
deletion, after the replacements exist.

## Module contracts

Signatures other modules may rely on. Implement them exactly.

```ts
// src/core/conductor.ts          (data)
export function attentionOf(s: Session): Attention;
export function inboxItems(sessions, prs): InboxItem[];

// src/core/diff.ts               (data)
export function diffOf(session: Session, base: string): SessionDiff;

// src/core/prompts.ts            (supervisor)
/** Compose the append-system-prompt file for a session; returns its path. */
export function writeSessionPrompt(session: Session, repo: Repo, settings: AgentSettings): string;
/** Write WATCHDOG.yml into the worktree when the advisor is on. */
export function writeWatchdog(session: Session, settings: AgentSettings): void;
/** Frame a non-human message so the agent can weigh it correctly. */
export function frameSupervisorMessage(nudge: string): string;

// src/core/supervisor.ts         (supervisor)
/** Called by the engine after every tool call. Cheap; returns fast. */
export function onToolCall(session: Session, call: ToolCall): void;
/** Fires when a verdict lands. The engine wires the actions. */
export const supervisorEvents: EventEmitter;  // "verdict" → (sessionId, SupervisorVerdict)

// src/core/sessions.ts           (engine)
export function spawnSession(repo, prompt, opts?): Session;
export function sendMessage(id, text, from?: "human" | "supervisor"): Promise<Session>;
export function interruptSession(id): Promise<Session>;
export function resumeSession(id): Promise<Session>;   // flagged | dead → running
export function flagSession(id, reason: string): void;
export function replyPermission(id, approved): Promise<Session>;
export function eventsOf(id, since?: number): TranscriptEvent[];
export const sessionEvents: EventEmitter;  // "hot" | "cold" | "events"
```

## HTTP API

All responses are `{ ok, data, error }`. Errors carry a real message.

```
GET    /api/state                      → AppState
GET    /api/health                     → { ok, omp, gh, git, version }

POST   /api/sessions                   { repoId, prompt, model?, branch? } → Session
DELETE /api/sessions/:id               → { ok }
POST   /api/sessions/:id/message       { text } → Session
POST   /api/sessions/:id/interrupt     → Session
POST   /api/sessions/:id/resume        → Session
POST   /api/sessions/:id/permission    { approved } → Session
POST   /api/sessions/:id/archive       → Session
GET    /api/sessions/:id/events?since= → TranscriptEvent[]
GET    /api/sessions/:id/diff          → SessionDiff

GET    /api/repos                      → Repo[]
POST   /api/repos                      { ref } → Repo
DELETE /api/repos/:id                  → { ok }

GET    /api/settings                   → AgentSettings
PUT    /api/settings                   → AgentSettings   (deep-merges)
```

Gone: `/kill` (Interrupt covers it), `/continue` (alias of `/message`),
`/log` (alias of `/transcript`).

## WebSocket

`/ws`. Server → client is `ServerMessage`, client → server is `ClientMessage`
(both in types.ts).

- On connect: one `hot` and one `cold`.
- `hot` on every session change, coalesced at 250ms.
- `cold` only when repos/prs/skills/settings actually change — **never on a
  timer that shells out.**
- A client sends `{type:"watch", sessionId, since}` to follow one session;
  the server then streams `events` for that session only. Watching a new
  session replaces the old subscription.
- **`watch` backfills before it streams.** On receiving a `watch`, the server
  immediately sends every event with `seq > since` (`since` is 0 on a first
  watch, and the highest seq the client already holds on a reconnect), then
  streams new ones on the same subscription. The client does not fetch the
  backlog over HTTP — without this backfill every transcript opens empty.
  `GET /api/sessions/:id/events?since=` still exists, for MCP.

## Performance rules

These are the two real bugs in the old build; do not reintroduce them.

1. **`gh` must never run on a broadcast path.** PR data is refreshed on a slow
   interval (60s) and on demand, cached, and pushed as `cold` only when it
   changes. The old build spawned `gh pr list` per repo on every 400ms state
   broadcast.
2. **The transcript is never re-read whole on a timer.** Events carry a `seq`;
   clients receive increments over the WebSocket. The old build re-parsed the
   entire JSONL every 2 seconds from a `setInterval`.

Also: `listSkills()` walks the filesystem — cache it, refresh on the same slow
interval.

## Engine specifics

Facts established by reading omp v17.2.11's bundle. They are not guesses; do
not "fix" them without re-checking the source.

- **Spawn line.** `omp acp` accepts all global flags — it runs the same
  parse→launch pipeline as bare `omp`. Pass `--model`, `--append-system-prompt
  <abs path>`, `--max-time <n>m`, and `--advisor` when enabled.
- **`--append-system-prompt` path detection:** a value containing a newline is
  treated as literal text; otherwise omp tries to read it as a file **and
  silently falls back to using the string as literal prompt text if the read
  fails.** Always pass an absolute path and assert it exists first.
- Passing the flag suppresses omp's own `.omp/APPEND_SYSTEM.md` discovery, so
  `prompts.ts` must concatenate the repo's file if it has one.
- **Prompt files live under `AGENTBOX_HOME`, never in the worktree** — a file
  written into the worktree lands in the diff and the PR. The one exception is
  `WATCHDOG.yml`, which omp only discovers by walking up from cwd; write it and
  add it to `.git/info/exclude` for that worktree.
- **A turn is a whole agentic loop**, not one step: `session/prompt` returns
  after every tool call in that turn. Turn boundaries are therefore the wrong
  clock for supervision — count tool calls.
- **A message sent mid-turn is queued**, delivered when the current turn ends.
  To reach a running agent now, interrupt first: the queue and the conversation
  both survive `session/cancel`.
- **`tool_call` carries no tool name.** Use `kind` + `rawInput` shape. Verified
  against live omp: observed titles were `"reading greet file"`, `"changing
  greeting to hi"`, `"$ ls -1 src"` — two intent strings and a rendered
  command, none of them a tool name.
- **A terminal `tool_call_update` carries no `rawInput`.** Carrying the
  arguments forward from the opening `tool_call` is load-bearing; without it
  every completed call renders with empty arguments.
- **`rawOutput` is `{content, details, isError?}`.** There is no
  `errorMessage`; failure is `isError: true` plus the message in `content`.
  A *pending* `execute` puts the command echo in `content`, so `content` may
  only be read as output once the call is terminal.
- **`execute` calls carry no `locations`**; `read`/`edit` carry absolute paths.
  A file-path heuristic therefore never fires on a shell loop.
- **`usage_update` is `{used, size, cost:{amount,currency}}`** — *not*
  `tokens.totalTokens` / `cost.total`, which is what the pre-rework code read,
  so it displayed $0 and 0 tokens for every session, always. `cost.amount` is
  cumulative for the session and survives a resume into a fresh process, so it
  is **set**, not accumulated. `used` is *context occupancy*, not work done,
  and must not be shown as a token count. Per-turn tokens come from the
  `session/prompt` response's `usage.totalTokens`, summed by the engine.
- **`status: "done"`** is set when `linkPr` finds an open PR for the branch.
- The `running` map is in-memory: after a server restart every live session is
  `dead` but resumable via `ompSessionId`. Resume must work.

## Supervisor

Two layers, cheapest first, both counting **tool calls**.

1. **Heuristics** (free, every call): identical `execute` command ≥3×; ≥4
   consecutive `error` results; same file in `locations[0]` edited >6×. A hit
   escalates to layer 2 rather than deciding on its own.
2. **Judge** (every `everyToolCalls`, default 25, or on a heuristic hit): a
   one-shot `omp -p --no-session --no-tools --model <cheap>` over a compact
   window. **Give the child an empty/closed stdin.** `execFile`'s default piped
   stdin makes omp print `Reading prompt from piped stdin (waiting for EOF)`,
   ignore the positional message entirely, and hang until the timeout — so
   every check resolved `ok` after a 60s stall. That is the whole feature
   silently doing nothing, and it is invisible precisely because `ok` is the
   correct failure fallback. Verified live; do not "simplify" the stdio config. — the task, the last ~40 tool calls as `kind + input summary +
   ok/error`, and the assistant text between them. Returns `SupervisorVerdict`
   as JSON. **Reuses the user's existing omp auth; add no API client and no new
   credentials.**

Actions:

| Verdict | Action |
|---|---|
| `ok` | nothing |
| `adrift` | `sendMessage(id, frameSupervisorMessage(nudge), "supervisor")` — queued, lands at the next turn boundary |
| `spiraling` | `interruptSession(id)` then `flagSession(id, reason)`; counter resets so it cannot re-fire and thrash |

A malformed or failed judge response is `ok` with `source: "model"` and a
logged error. **The supervisor must never be able to take a session down by
failing.**

## UI contract

`web/src/api.ts` (ui-shell) owns the client. Everything else imports from it.

- Types are imported **type-only** from `../../src/core/types` — `import type
  { Session } from "../../src/core/types"`. There is no second copy of the
  domain model in `web/`. Type-only imports are erased at build time.
- `useAppState()` → `{ state, connected, warnings }`.
- `useSessionEvents(sessionId)` → `{ events, live }`, backed by the `watch`
  subscription, appending by `seq`.
- `api.*` mirrors the HTTP table above, one method per endpoint.

Primitives in `components.tsx` (ui-shell), used by everyone else:

```ts
Icon                                          // record of icon components
Button   { variant?: "primary"|"ghost"|"danger", size?: "sm"|"md", icon?, loading? }
StatusPill  { status: SessionStatus }
AttentionBadge { attention: Attention }
Empty    { title, children, action? }
Modal    { title, hint?, onClose, children }  // Escape closes, focus trapped
Confirm  { title, body, danger?, onConfirm, onCancel }
Field    { label, hint?, children }
Toggle   { checked, onChange, label }
CommitInput  { value, onCommit, ... }          // commits on blur/Enter, not per keystroke
RelativeTime { ts }                            // self-updating
```

Views are named exports with these props. `App.tsx` owns routing; a view never
holds its own selection state, because a run must be linkable.

```ts
Sessions { state: AppState; selectedId: string | null; onSelect: (id: string | null) => void }
Inbox    { state: AppState; onOpenSession: (id: string) => void }
Settings { state: AppState }
```

`Settings` takes no callback: it changes the theme through
`api.saveSettings({ theme })` like any other setting, and `App` reacts to
`state.settings.theme`.

`Button` is typed so an icon-only button (no children) **requires**
`aria-label` — a missing one is a compile error, not a lint warning.

Accessibility is part of "good", not a later pass: real `<button>`s, labelled
controls, visible focus rings, Escape closes overlays, and no click target
below 32px.

## Quality bar

- `bun run typecheck` clean. `strict`, `noUnusedLocals` and
  `noUnusedParameters` are on — do not silence them with `any` or `_` prefixes
  where the right answer is to use or delete the value.
- No dead code. If a field, prop, endpoint or setting is not read by anything,
  delete it. The old build shipped a `maxMinutes` setting wired to nothing and
  a `done` status no code ever assigned; that is the specific failure mode.
- No silent catches. `catch {}` is a bug unless the comment above it says why
  the failure is genuinely fine.
- Comments explain *why*, at the density of the surrounding code. No banners.
- Tests for logic that can silently break: attention derivation, supervisor
  heuristics, transcript assembly from ACP updates, diff parsing. Not for
  "React renders JSX".
