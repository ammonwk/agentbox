# agentbox: what is what

Most of this codebase is legible one file at a time — the comments say why each
piece is the way it is. What they could not say is how the pieces are supposed
to relate, and that is where the bugs came from. Every module below was locally
reasonable and was designed against the others as they stood at the time; the
mistakes were all at the seams.

This document is the part that is supposed to stay true across changes. If a
change contradicts something here, either the change is wrong or this is — say
which, in the same commit.

## Two kinds of subagent, and they are not the same thing

Two systems in this repo produce something called a subagent. They are
different enough that confusing them has already cost real work, and they are
both correct.

**omp `hub` subagents — a board session's fan-out.** The agent in a board
session dispatches these itself, through omp's `hub` tool. They run *inside*
omp's process, in the session's own worktree, and agentbox never spawns them.
This is the path every large run in practice uses: `/babysit`, a fifty-way
green-and-clean sweep, anything where one session farms work out.

**agentbox's own pool — `src/core/subagents.ts` + `src/mcp/subagent.ts`.** A
*calling* agent (Claude Code, usually, over MCP) asks agentbox for agents it
can call like functions. Each gets its own `omp acp` process, its own record
under `~/.local/share/agentbox/subagents/<id>/`, health verdicts and budgets.
It has no board row, no worktree of its own and no supervisor, deliberately —
see the header of `subagents.ts` for why that is the right data model.

**Which is primary: for a board session, omp's.** That is where the work
happens, and for a long time it was the one agentbox could see least — the pool
had a durable per-agent record and a staleness rule, and the board's fan-out had
neither, because the only thing anybody had wired up was omp's live progress
stream. `src/core/ompsession.ts` closes that gap by reading omp's own session
directory, which is the same shape of answer the pool's `record.ts` gives:
identity, a snapshot, and history.

If you are adding observability for a board session's subagents, extend
`ompsession.ts`. If you are adding it for the MCP pool, extend `record.ts`.
Neither should grow a copy of the other.

## State and history are different, and the transcript is history

This is the distinction the 800 MB transcript came from.

**History** is the session's event log: `~/.local/share/agentbox/logs/<id>.jsonl`,
append-only, one process writing it (the session's host), read back by seq. A
line goes in it when something *happened*: a message, a tool call starting or
finishing, a turn ending, a subagent starting or coming back.

**State** is what is true right now: the session row in sqlite. It is rewritten
in place, it is pushed to clients as `hot` state, and it is where anything that
gets *superseded* belongs.

Progress is state. omp streams a subagent progress snapshot every couple of
seconds per dispatched batch, and each one supersedes the last. Appending them
to the log wrote fourteen thousand copies of one tool call — including its
arguments, which hold every subagent's full assignment — into one session's
history, and made opening that session read 805 MB off disk. The snapshots now
go to the roster on the session row; what reaches the log is one `subagent`
event per transition. `src/core/compact.ts` rewrites the logs that already have
the old shape, and is the only thing in this app that rewrites history.

The rule, for the next thing that streams: **if the next update makes the last
one wrong, it is state.**

## Derived state does not get rebuilt from a window

The browser holds the newest few hundred events and pages backwards as the
reader scrolls. Anything folded out of that window is wrong at its edges — the
subagent roster used to be, so a dispatch that had scrolled out of the page took
its subagents' assignments with it, and nothing that happened after the turn
ended was visible at all.

So: the host maintains the roster (`src/core/roster.ts`), persists it on the
session row, and the UI reads it. The transcript fold (`subagentRoster` in
`web/src/views/session/transcript.ts`) still exists and is still correct, but it
is the fallback for a session whose row has no roster — not the source.

The same reasoning already applied to `status`, `blocked` and `permission`, all
of which are on the row for exactly this reason. Subagents were simply left out.

## Two sources, one merge, and nothing is assumed to still be true

A fan-out is described by two things that disagree, structurally:

| | live progress stream | omp's session directory |
|---|---|---|
| where | `tool_call_update` on the parent call | `~/.omp/agent/sessions/<slug>/<stamp>_<id>/` |
| when | only while the parent's turn runs | always, and after everything exits |
| says | what an agent is doing right now | when it started, when it ended, what it reported |
| sees | one level of subagents | the whole tree, including nested ones |

`Roster` in `src/core/roster.ts` is the only place they are reconciled. The
stream wins for a running agent; the disk wins for anything terminal and is the
only source that can retire an entry at all. Every entry carries `observedAt`
and `source`, because the failure this replaced was not a wrong status — it was
a *stale* status rendered as a current one. A reader that cannot say when it
last heard from something will eventually claim it is still running.

`rosterIsLive(sessionStatus)` is the whole rule for whether to believe a roster
is current: omp reports subagent progress while the parent's turn is running and
not one word afterwards.

## One writer per file

- A session's event log is written by its host and nobody else. `seq` is a
  per-instance counter, so two appenders would hand the same number to different
  events and a client would silently skip one.
- A session's row is written by its host while one is alive. The server repairs
  the roster only when no host holds the session (`fanoutOf` in
  `src/server/fanout.ts`), because nothing else ever would.
- Compaction rewrites a log, so it only ever runs where nothing is appending:
  the host on its way out, or a caller that has checked there is no host.
- omp's session directory is omp's. agentbox only reads it.

## Where to look

| Question | File |
|---|---|
| What became of a board session's subagents? | `src/core/ompsession.ts` |
| Which source do we believe, and how stale is it? | `src/core/roster.ts` |
| Who writes the session row and the log? | `src/core/host.ts` |
| Why is a transcript enormous, and what fixes it? | `src/core/compact.ts` |
| What does the browser get told about a fan-out? | `src/server/fanout.ts` |
| An MCP-pool agent's record | `src/core/record.ts`, `src/server/subagents.ts` |
