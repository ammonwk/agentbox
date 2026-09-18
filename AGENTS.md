# agentbox

Spawning and maintaining omp sessions — a board over your agents.

## Web UI build

The Bun server (`src/server/`) serves the pre-built frontend from `dist/` — it does
not pick up `web/src` changes on its own. After editing anything under `web/src`,
run `bun run web:build`, then refresh the browser (no server restart needed).
Use `bun run web:dev` (vite dev server) for hot reload while iterating on the UI.

## Always restart the server after changing `src/`

The running server and its spawned host processes execute the code as it was when
they started — Bun does not hot-reload. After finishing any change under `src/`,
restart the server to apply it:

    kill <server pid> && setsid nohup bun bin/agentbox serve >> /tmp/agentbox-server.log 2>&1 < /dev/null &

Find the pid with `ss -tlnp | grep 4479` (default port 4479). Detached hosts
survive the restart and are re-attached by `reconcile()` at boot, so live agents
are not disturbed — but a host keeps its old code until its session is resumed,
so behaviour changes only reach sessions that start or resume afterwards.

## Idle sessions are parked, not closed

A host whose session has sat between turns for `IDLE_PARK_MS` (4 hours, in
`src/core/host.ts`) stops its omp and exits. The session keeps its `waiting` or
`done` status and gets a `parkedAt` timestamp, and nothing in the UI changes: a
message finds no host, and `sendMessage` starts one that resumes the same omp
conversation (`session/resume`, which does not replay history into the log).

The status is deliberately left alone, because both statuses already mean "the
turn is over and a message continues it". `parkedAt` exists only for the one
reader that must tell a deliberate stop from a crash, `reconcile`, which would
otherwise mark the session `dead`. `shouldPark` refuses whenever anything is in
flight: a turn, a permission prompt, or a scheduled auto-continue.

## Live status is a separate channel from MCP progress

`src/core/live.ts` writes one pre-rendered line per in-flight tool call to
`~/.local/share/agentbox/live/`. It exists because MCP progress notifications
stop being shown the moment a client backgrounds the call — which is when the
work becomes worth watching.

The two channels no longer share a writer. Progress notifications are still
sent per *call*, from `src/mcp/subagent.ts`, and are skipped when the client
sent no `progressToken`. The files are written per *agent*, by `SubagentPool`
in `src/core/subagents.ts`, for as long as the agent exists rather than as long
as some call is blocked on it — an agent whose caller stopped waiting is
exactly the one worth watching, and it used to vanish at that moment. A
workflow is the exception: it publishes one roster line for the whole fan-out
and its agents are spawned `quiet`.

Each line carries the owning client session, taken from the parent process's
`claude --session-id`. Filtering on the working directory alone was not enough:
two windows on one repository share a directory, and each was shown the other's
agents. The reader must match both.

The file holds text, not state, and that inversion is deliberate: the consumer
is a shell status line re-run every couple of seconds, where parsing costs a
fork. If you change what the roster says, change `renderRoster` in
`src/core/workflow.ts` for the workflow line and `renderAgentLine` in
`src/core/subagents.ts` for an agent's — not the reader.

## What the client does with a slow MCP call

Worth knowing before touching timeouts, because most of the machinery is the
client's and not ours.

Claude Code races each MCP tool call against a 120-second timer
(`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`). Settle first and the result is returned
inline. Lose the race and the call becomes a background task: the model is told
so and carries on, and when the call finally resolves its result is delivered
as a task notification at `priority: "next"` — the same channel background
shell commands use. The task outlives the turn and dies with the session.

All of that is keyed on the request still being open, which is why `agent` and
`send_message` block and have no timeout parameter. A call that answers early
does not start a background task, it prevents one.

Two client limits bound a long block. `MCP_TOOL_TIMEOUT` is a hard per-call
wall clock, defaulting to about 28 hours. The idle timeout for a stdio server
is 30 minutes, and it is reset by progress notifications — so the heartbeat in
`watch` is load-bearing: a quiet agent publishing nothing would have its call
killed at the half hour.

## Agents must not wander out of their working directory

`cwd` defaults to the MCP server's own, fixed when the client started it. A
caller that has since moved has no way to notice, so the place is said out loud
everywhere it can be: in the tool descriptions (`HERE`), in every report, in
the agent's own system prompt, and on the status line. `src/core/place.ts` owns
all of that, plus the two scans — `foreignRepoPaths`, which refuses a spawn
whose prompt names files in another git work tree, and `outsidePaths`, which
flags a finished turn's writes that landed outside. Read-only agents are exempt
from the refusal; they cannot change anything.

## A board session's fan-out is not the MCP pool

Two different systems in this repo produce something called a subagent, and
`docs/architecture.md` is the map. Briefly: a board session's agent dispatches
its own subagents through omp's `hub` tool, in-process, and agentbox never
spawns them — that is the path `/babysit` and every wide sweep uses. The pool in
`src/core/subagents.ts` is the other one: agents an MCP *caller* owns, each its
own `omp acp` process with a record under `subagents/<id>/`.

For the first kind, omp's own session directory is the record:
`~/.omp/agent/sessions/<cwd-slug>/<stamp>_<ompSessionId>/`, holding
`<Name>.jsonl` (every message and tool call) and `<Name>.md` (the report it
finished with) per subagent, plus a subdirectory per subagent that dispatched
subagents of its own. `src/core/ompsession.ts` reads it; nothing writes it.

## Subagent progress is state, not history

omp streams a progress snapshot every couple of seconds per dispatched batch,
on the parent's `tool_call_update`s. Those go to the session's roster
(`src/core/roster.ts`, persisted on the row), and only *transitions* — a
subagent starting, finishing, failing — are appended to the transcript as
`subagent` events. Appending the snapshots themselves is what made one
session's log 805 MB: each line was a full copy of the dispatching call,
arguments and all. `src/core/compact.ts` fixes the logs already written; `bun
bin/agentbox compact --apply` runs it, and Settings → Transcripts is the same
thing with a button.

The roster merges two sources that disagree by construction. The live stream is
the only thing that can describe a *running* subagent, and it stops dead when
the parent's turn ends. omp's directory is the only thing that can say how one
*ended*, and it is still there hours later. Neither is "the" truth: the stream
wins while running, the disk wins for anything terminal, and every entry carries
`observedAt` so a reader can say "last seen running at 07:50" instead of
drawing an eleven-hour-old frame as if it were live. `rosterIsLive` is the whole
rule — a session that is not running cannot have a roster that is getting
fresher.

## Watching a subagent

Three files per agent under `~/.local/share/agentbox/subagents/<id>/`, and
every reader works from them rather than from the object:

- `meta.json` — identity, written once at spawn: name, directory, branch,
  model, and the brief.
- `state.json` — the live snapshot, rewritten on the pool's two-second tick and
  sealed once more when the agent stops.
- `transcript.jsonl` — the event log, appended forever.

`state.json` is a republished snapshot rather than something a reader folds out
of the event log, and that is load-bearing. The log says what happened, not
what is *still* happening, so folding it cannot tell a finished agent from one
whose process was killed mid-turn. A snapshot with a timestamp can: if nobody
has refreshed it inside `STALE_AFTER_MS`, nobody is there, and readers render
that as `abandoned`. Sealing on stop is the other half — without it every
agent's last published state says "running" and then goes stale, so a clean
finish and a crash look identical.

An agent idle for `IDLE_PARK_MS` (15 minutes, in `src/core/subagents.ts`) has
its omp stopped by the pool's tick, and the caller is never told. Nothing it can
observe changes: the state stays `idle`, and the mailbox, history and tool ring
live on the `Subagent`, not in omp. The next `send` starts a new runner resumed
onto the saved omp session and delivers the message. Two things keep that
honest. Each runner's events are tagged with a generation, so the exit of the
omp we stopped cannot kill the agent. And a resume that fails goes through
`die`, so the waiting caller gets a `dead` report with the reason rather than
silence. This only lasts as long as the MCP server does; its exit still stops
every agent for good.

`src/core/health.ts` holds the judgement, once, for all of them. `verdict()`
answers "is something wrong" in sentences (`looping`, `quiet`, `slow-tool`,
`silent`, `context`, `overrunning`); `budget()` answers "how much is left" and
refuses to guess — there is no honest denominator for task completion, so it
reports consumption against the three real ceilings instead: context window,
wall clock, money. If you are tempted to add a percentage-done, that is the
thing this file exists to not do.

Two distinctions in there are worth not breaking. Silence inside a running tool
call is `slow-tool` and silence outside one is `quiet`, because a clock alone
cannot tell a wedged agent from one running your test suite. And `escalate` is
deliberately only `looping` and `quiet`: it is what lets `waitForTurn` end a
caller's blocked call early, which costs that caller its completion
notification, so it must be reserved for "this is not working".

The readers: `renderAgentLine` (status line), `agentbox watch` (terminal,
`--once`, `--interrupt`, `--stop`), `list_agents` (the calling model), and
`/api/subagents` behind the web view. Adding a fifth should mean writing a
renderer, not new state.

Control crosses processes through the record. A watcher cannot reach an agent's
owner — it is an MCP server on somebody's stdio with no address — so
`requestCommand` leaves a file and the pool's tick calls `takeCommand`. It
degrades honestly: if nobody is there to sweep, nothing happens, which is
exactly what "nobody is there" should mean. Never make these controls claim
success they cannot verify.
