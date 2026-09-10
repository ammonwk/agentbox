# agentbox

A board for running and babysitting **omp** coding agents.

The model doing the work is cheap and capable but not stable — it does well on
well-scoped tasks and badly when left alone. agentbox is built around that:
everything here optimises for **noticing a wrong turn quickly and correcting it
cheaply**.

## What it does

- **Spawn** an omp session on any registered repo. agentbox cuts a fresh git
  worktree off the repo's default branch, injects its own system prompt, and
  drives omp over ACP (Agent Client Protocol).
- **Watch** what the agent actually does — every tool call, with its arguments
  and result, streamed live. Not just what it says it did.
- **Review** the work as a diff, in the app, before it ever reaches a PR.
- **Steer** it mid-run. A message to a waiting agent lands immediately; a
  message to a running one reaches it after its current tool call, without
  interrupting the turn — a wait on subagents is cut short for it, and the
  subagents keep running.
- **Supervise** it automatically. agentbox watches tool calls for the ways a
  cheap model fails — repeating a failing command, thrashing one file, taking
  the easy path instead of the right one — and when it sees one, it sends the
  agent a corrective nudge and lets the run continue. The run is never cut off;
  the transcript shows every verdict either way.
- **Approve** permission requests, or let it run unattended.
- **Close** a session when you are done with it. That stops the process and
  takes it off the board, but keeps the transcript, the branch and the
  worktree — Resume brings it back, checking the branch out again if its
  worktree has since been reclaimed. Nothing is destroyed by closing.
- **Reclaim** the disk deliberately, in Settings → Disk. Worktrees are a
  gigabyte apiece on a large repo, so agentbox scans every worktree of every
  registered repo (not only its own), says which have nothing to lose — clean,
  or with a merged or closed PR — and removes them on request. Branches are
  always kept.

## The pages

| Page | What's there |
|---|---|
| **Inbox** | Everything wanting a human, ranked: sessions that failed, stopped, or need an approval, plus open PRs. Empty is the good state. |
| **Sessions** | The board. Session list on the left, full detail on the right — activity, diff, task, and the steer box. |
| **Skills** | Every `SKILL.md` an agent can reach, in one place — read and edit the body, promote a repo-local skill to your global set, or remove a global one. |
| **Settings** | Run defaults, the system prompt every agent receives, supervision config, repos, disk reclaim, and diagnostics. |

## Install

Requires **bun**, **omp** (install via `omp.sh`), **git**, and **gh**.

```bash
bun install
bun run web:build          # build the UI
bun bin/agentbox doctor    # check omp / git / gh and report what's missing
```

## Run

```bash
bun bin/agentbox           # http://127.0.0.1:4479
# during development:
bun run dev                # backend, watch mode
bun run web:dev            # vite on :5173, proxying to :4479
```

Worktrees, logs, prompts and the sqlite DB live under
`~/.local/share/agentbox`. `AGENTBOX_HOME` relocates it; `AGENTBOX_PORT`
changes the port.

## The system prompt

agentbox injects its own guidance into every session via omp's
`--append-system-prompt`. It layers:

1. the harness contract — that a human is watching, that messages arrive
   mid-run, what "done" means, and the scope discipline a cheap model needs;
2. your overlay from **Settings → System prompt**;
3. the repo's own `.omp/APPEND_SYSTEM.md`, if it has one — passing the flag
   suppresses omp's discovery of that file, so agentbox concatenates it rather
   than silently replacing it.

Prompt files are written under `AGENTBOX_HOME`, never into the worktree, so
they cannot end up in a diff.

## Supervision

Two independent layers, both optional:

- **The supervisor** (agentbox's own) counts **tool calls**, not turns — an ACP
  turn is an entire agentic loop, so turn boundaries would fire roughly never.
  Free heuristics run on every call; a cheap judge model runs every N calls or
  when a heuristic trips. It nudges, or it interrupts and flags. It reuses your
  existing omp auth and adds no credentials, and it can never take a session
  down by failing.
- **The advisor** is omp's built-in second model, enabled with `--advisor`. It
  reviews each turn and injects notes into the *running* agent — the one thing
  agentbox cannot do from outside the process. It needs a model assigned to
  omp's `advisor` role; without one the flag does nothing.

## MCP

Two MCP servers, for two different things.

### The board (`agentbox mcp`)

A conductor agent drives the whole board: spawn sessions, watch them, review
diffs, answer permission prompts, close them out.

```bash
bun bin/agentbox install     # register with opencode (backs up your config)
bun bin/agentbox uninstall
```

It is a thin client over the running agentbox HTTP API, so there is one
description of a session however you reach it — and the agentbox server has to
be running.

### Subagents (`agentbox subagent-mcp`)

The other direction: omp agents that *your* agent calls like functions. Register
it with any MCP client — for Claude Code:

```bash
claude mcp add -s user omp -- bun /path/to/agentbox/bin/agentbox subagent-mcp
```

It gives the caller `agent`, `send_message`, `collect`, `list_agents`,
`transcript`, `interrupt`, `stop_agent` and `workflow` — deliberately the same shape as the
client's own subagent tools, so a model that can delegate already knows how to
use these.

A subagent is not a board session and never appears on the board. It has no
worktree, no branch, no PR and no supervisor: it runs **in the client's own
working directory**, on the real repository with the real uncommitted changes,
answers one question, and its final message is its whole return value. It is a
function call that happens to be a language model. The agentbox server does not
need to be running, and nothing is written to the database — only a transcript
under `~/.local/share/agentbox/subagents/`.

`agent` waits for the agent to finish, and that is the whole intended flow —
there is no timeout to choose and nothing to poll. A native subagent takes no
timeout either; it runs to completion and the harness notifies its caller. MCP
clients reproduce that themselves: a call that outruns the client's patience is
backgrounded and its result delivered as a notification. Blocking is therefore
the call that behaves most like an ordinary subagent, and a short block is the
thing that makes it feel unlike one.

A turn cut short by a provider error is **resumed, not reported**. A rejected
`session/prompt` is a 429 or a 500, not the agent finishing, and handing that
back as a completed turn gives the caller a truncated answer wearing the costume
of a finished one — while throwing away the work up to that point, because the
agent is never asked to go on. omp keeps its context across the failure, so
agentbox salvages the turn with one message and a backoff, up to three times.
The prose written before the error is carried over so the answer reads as one
piece, and every resume is noted in the turn's `errors`. It gives up after three
— a permanent error (bad credentials, a model that no longer exists) would
otherwise spend your money forever — and it stands aside entirely if you have
already queued a follow-up, because then you are steering and your message is
the continuation.

`timeout_seconds` exists for deliberate exceptions — a small number to peek at a
long agent, or `0` to fire-and-forget. Both trade away the notification for a
handle you must remember to `collect`. Either way nothing is lost: a finished
turn waits in a mailbox whether or not anyone is there for it.

`collect` is the one tool that does **not** inherit that hour. It waits a minute
and then reports progress. The long block is what makes `agent` feel native, but
`collect` is the call a caller reaches for when it is unsure — and an hour-long
check-in is backgrounded exactly like the call it was checking on, so the caller
checks again, and the outstanding tasks pile up until they all report completion
at once. A finished turn also goes to exactly one waiting caller, so the second
collect on a running agent could never have returned an answer anyway; now it
says so, and says how many others are queued.

### Workflows

`workflow` runs a JavaScript script in which `agent(prompt, opts)` spawns a
subagent and returns its answer. One tool call, however many agents — and only
what the script *returns* crosses back, so a hundred agents' reports cost the
caller nothing.

It exists because a single subagent call is a function call, which is the right
shape for one question and the wrong shape for ten. A caller wanting a fan-out
otherwise issues ten tool calls, holds ten names, and reduces ten reports by
hand in its own context. The work that coordinates agents — fan out, collect,
dedup, count, decide — is deterministic, and paying a language model to do it by
hand is slower and less reliable than writing it down.

The hooks are `agent`, `parallel`, `pipeline`, `log` and `args`. Two rules carry
most of the value:

- **`pipeline`, not a barrier.** `pipeline` runs each item through every stage
  independently. A barrier costs the sum over stages of the slowest item in
  each; a pipeline costs the slowest single item's whole chain. Agent durations
  vary wildly, so that gap is most of the wall clock. `parallel` is for the case
  where a stage genuinely needs every result at once — deduping across all
  findings, or deciding whether to continue at all.
- **`schema` turns prose into a value.** `agent(prompt, {schema})` returns a
  parsed object rather than text. Prose can only be fed to another model; a
  value can be counted, filtered, sorted and branched on by the script, exactly
  and for free.

Workflow agents are **read-only by default** — a fan-out is usually a survey and
they share one working tree — and every agent is stopped when the script ends. A
dead agent fails its call rather than returning an empty string, so a script can
never mistake silence for an answer. Concurrency, total agent count and wall
clock are all bounded.

Models come from `AGENTBOX_SUBAGENT_MODEL`, or the `model` argument, or the
built-in default. Permission prompts are auto-approved: the caller is an agent
blocked inside a tool call, not a human at a board, so there is nobody to ask.
The exception is `read_only: true`, which flips that rule for one agent: every
request to edit, move, delete or execute — including shell — is denied at the
permission layer, so an auditor or a parallel fan-out of searchers cannot touch
the tree no matter what its model decides. `role` prose asks; `read_only`
enforces. It fails closed: a tool omp does not classify is denied rather than
waved through, and each denial appears in the turn's `errors` so the agent's
report can be read knowing what it was not allowed to do.

Every report is stamped with the turn it answers — turn 1 is the spawning task,
turn 2 the first `send_message`. `send_message` waits for *its own* answer
rather than the oldest unread one, which is what makes fire-and-forget safe to
mix with follow-ups. Transcripts under `subagents/` are pruned after seven days
at server start.

### Watching a call that has not answered yet

Every blocking tool — `agent`, `send_message`, `collect` and `workflow` — streams
MCP `notifications/progress` while it waits, roughly every two seconds. This is
the only live view anyone gets of work that will not answer for twenty minutes,
and it does two jobs: it resets the client's idle-call watchdog, so a long
fan-out is not mistaken for a hung server, and its `message` is what the client
puts on screen.

A single agent reports itself:

    agent-1 38s · 2 tool calls → Reading paths.ts to determine its purpose 29s

A workflow reports its whole roster, as a snapshot rather than an event —
because the surface this lands on shows one message at a time and replaces it,
so "done review:web" would show whichever agent moved last and nothing about
the other eleven:

    2/5 done · 2 running · 1 queued · scan:core 6m12s → Grep refreshToken · scan:web 51s → Read acp.ts · 8 findings

Every count is in the head, because the real limit is not the protocol's 200
characters but the width of the window, and the line is cut wherever that falls.
Agents are ordered longest-running first — the straggler is the one worth
looking at, and start order does not reshuffle under a reader every two seconds.
A number after an action is how long that action has been the current one; a
running agent's queue time is counted from the `agent()` call, not from launch,
because on a wide fan-out the wait at the gate is most of the wall clock.

**A client stops showing this once it backgrounds the call**, which is exactly
when it starts being worth watching. Claude Code moves an MCP tool call to the
background after two minutes and drops progress at that moment; its Background
panel row (`omp/workflow · k9h2ezpb · working`) has a field for detail but only
writes it on completion. `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` raises that
deadline, or `0` disables backgrounding entirely — but backgrounding is the
whole reason two workflows can run at once, so that trade is usually the wrong
way round.

So the same line is also written to a file: `~/.local/share/agentbox/live/`,
one per in-flight call, replaced every couple of seconds and removed when the
call answers. Stale files (a server that was killed rather than closed) are
ignored after 15 seconds and swept at the next start.

    <unix seconds>\t<cwd>\t<the line>

Three tab-separated fields, and the line is already rendered — the reader that
matters is a shell script re-run every few seconds by a terminal, where a JSON
parse costs a fork and a fork is most of the frame budget. To put it in a
Claude Code status line, read the directory with builtins only and set
`statusLine.refreshInterval` (seconds) so the line re-renders on a timer rather
than only when the conversation moves:

```bash
omp=""
for f in "$HOME/.local/share/agentbox/live/"*.live; do
  [ -e "$f" ] || break
  IFS=$'\t' read -r at lcwd line < "$f" || continue
  [ "$lcwd" = "$cwd" ] || continue                               # another repo's session
  [ $(( ${EPOCHSECONDS:-0} - ${at:-0} )) -lt 15 ] || continue    # writer is gone
  omp="${omp:+$omp • }$line"
done
```

Put it first on the line: it is the only perishable thing there, terminals
truncate from the right, and it is empty whenever nothing is running.

## Layout

```
bin/agentbox        CLI: serve / doctor / mcp / subagent-mcp / host /
                    install / uninstall
src/core/types.ts   the domain model — the web app imports it directly
src/core/           acp (ACP engine), host (one agent's process), hostproto
                    (the control socket), sessions (lifecycle), subagents
                    (off-board agents for the subagent MCP), workflow
                    (many subagents from one script), supervisor,
                    prompts, db, state, conductor, diff, git, prs, skills
src/server/         Bun.serve HTTP + WebSocket
src/mcp/            index (the board MCP), subagent (the subagent MCP)
web/                React + Vite UI
prompts/            prompt text, edited as content rather than code
```

## Notes

- **Skills** are scanned from `.claude/skills` under the directory agentbox was
  started from, then `~/.claude/skills`, then `~/.agents/skills` — in that
  order, matching omp's own precedence. The Skills page reads and edits the
  SKILL.md on disk directly, and **Promote** copies a repo-local skill to
  `~/.claude/skills` (copy, never move — the repo's copy stays put). The body
  routes confine every path to those roots, so a browser-supplied path can
  never reach outside them.
- PR tracking needs `gh` authenticated for the repos you register. If it isn't,
  Settings → Diagnostics says so; PRs don't silently read as "none".
- Local repos are used in place. `owner/repo` slugs are cloned under
  `~/.local/share/agentbox/repos`.
- One omp process per session, alive between turns. If it dies the conversation
  survives — the session shows as lost and resumes from where it was.
- **Agents do not depend on the server.** Each live session runs under its own
  `agentbox host` process, which owns the omp child and writes the transcript
  and the session row directly. The server talks to hosts over a unix socket in
  each session's directory, and reconnects to whatever is still running when it
  starts. So you can restart, upgrade or kill the server mid-turn and the agents
  carry on — a turn started under one server routinely finishes under the next,
  or under none at all. Sessions started before an upgrade keep running the code
  they were spawned with; new ones pick up the new code immediately.
