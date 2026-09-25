# agentbox

A fleet manager for coding-agent CLI sessions (claude, codex, devin, omp)
across multiple subscription accounts. **Read `docs/v2.md` first** — it is the
design and the HTTP/WebSocket contract, and it says which piece owns what.

## Build and restart

The server serves the pre-built UI from `web/dist`; after editing `web/src`,
run `bun run web:build` and refresh (or use `bun run web:dev` on :5173).

After changing `src/`, restart the server — Bun does not hot-reload:

    systemctl --user stop agentbox-serve.scope 2>/dev/null
    kill $(ss -tlnp | grep 4479 | grep -o 'pid=[0-9]*' | cut -d= -f2) 2>/dev/null
    while systemctl --user list-units --all --no-legend agentbox-serve.scope | grep -q .; do sleep 0.5; done
    systemd-run --user --scope --collect --unit=agentbox-serve \
      setsid bun bin/agentbox serve >> ~/.local/share/agentbox/logs/server.log 2>&1 < /dev/null &

Its own systemd scope, so it does not die with the terminal (or the agent
session) that happened to start it: a process started from a terminal lives
in that terminal's cgroup scope, and `setsid` alone does not leave it. The
wait matters: `systemd-run` refuses the unit name while the old scope is
still stopping. Then check `/api/health`, and that `/api/state` has as many
sessions as before.

The tmux server runs in a scope of its own, `agentbox-tmux.scope`
(`src/core/tmux.ts` starts it through `systemd-run`). This is what makes a
restart safe: tmux puts each pane in a `tmux-spawn-*.scope` that is `PartOf`
whatever unit the tmux server was in when the pane started, so a tmux server
living in `agentbox-serve.scope` meant stopping the server stopped every
agent. Check with `systemctl --user show <pane scope> -p PartOf`.

Restarting loses nothing. The server owns no agents: they run in
`tmux -L agentbox` (one tmux session per agent session, `ab-<id>`) or in your
own terminals, and the fleet rebuilds the board from transcripts, the process
table and tmux on its first tick.

## Rules that are easy to break

- **The provider's transcript is the record.** Never write a copy of a
  conversation. The database holds only what the provider cannot know: the
  account pin, the claim, the tmux session, a label, archive state, metrics.
- **A session never changes account.** That is the whole point: switching
  accounts invalidates the provider's prompt cache. Resume and adopt always use
  the session's pinned account. Transcripts are deliberately not shared between
  account homes so a plain `claude --resume` cannot cross accounts either.
- **Never kill before proving the resume.** Adopt checks the transcript exists
  and (claude) the resume cwd slugs to the transcript's directory, *then*
  SIGTERMs, waits for exit, *then* resumes. `Fleet.resumeCwd` refuses rather
  than guesses.
- **Never copy or refresh credentials.** Claude and Codex rotate refresh
  tokens; two homes holding one token log each other out. Every account gets
  its own login. Usage reads with an expired token report `stale`.
- **The balancer is pure.** `src/core/balancer.ts` takes numbers and returns
  a choice with every candidate's inputs attached; it touches no I/O. Keep it
  that way — the assignments table stores its inputs so placements can be
  replayed.
- **Mutating requests carry `x-agentbox: 1`**, and Host/Origin must be
  loopback (`src/server/csrf.ts`). The terminal WebSocket types into agents
  that skip permission prompts; do not loosen this.
- **Address tmux by session name**, never by pane id (`%12` is renumbered when
  the tmux server restarts). `src/core/tmux.ts` is the only thing that runs
  tmux.
- **Adapters are cheap to poll.** `listTranscripts` and `liveProcesses` run
  every 2s: stat, don't read. Readers are incremental (`JsonlTail`).

## Where things are

- `src/core/providers/` — one adapter per CLI (transcript format, processes,
  argv, and its credential homes and environments), plus `jsonl.ts`
  (incremental tail) and `procs.ts` (/proc helpers).
- `src/core/accounts/` — credential homes, identity, usage fetchers, logins.
- `src/core/fleet.ts` — joins everything into sessions; spawn/resume/adopt.
- `src/core/balancer.ts`, `claims.ts`, `calibration.ts` — placement.
- `src/server/` — HTTP + WebSockets. `src/mcp/fleet.ts` — the conductor's MCP;
  it and the CLI share one HTTP client, `src/client.ts`.
- `src/mcp/subagent.ts` — the subagent MCP (`agentbox subagent-mcp`), over
  `src/subagents/`: a pool of `omp acp` processes it owns, their records and
  live status lines. Independent of the server and the database.
- `src/cli/index.ts` — `agentbox claude|codex|…`, `attach`, `usage`, `mcp`,
  `subagent-mcp`, `doctor`; `src/cli/sessions.ts` — the Unix-shaped session
  verbs (`ls`, `show`, `log`, `grep`, `screen`, `diff`, `send`, `archive`,
  `stop`, `resume`, `adopt`, `label`): ids first on every line, `-` reads ids
  from stdin.
- `src/core/project.ts` — the Project session pinned atop the board: an
  ordinary session in `<agentbox home>/project`, whose CLAUDE.md/AGENTS.md
  (written from here on every start) teaches it the CLI.

## Tests

Almost none, on purpose: this is a dev tool, and tests that pin behaviour
slowed it down more than they caught. Check a change by running it (`bun run
web:dev`, the live server) and keep `bun run typecheck` clean. Do not add tests
by default. One has to guard a non-obvious rule whose breakage would be
destructive or a security hole, and "useful" is not enough — the only one left
is `src/server/__tests__/csrf.test.ts`.
