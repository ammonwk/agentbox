# agentbox

A fleet manager for coding-agent CLI sessions (claude, codex, devin, omp)
across multiple subscription accounts. **Read `docs/v2.md` first** — it is the
design and the HTTP/WebSocket contract, and it says which piece owns what.

## Build and restart

The server serves the pre-built UI from `web/dist`; after editing `web/src`,
run `bun run web:build` and refresh (or use `bun run web:dev` on :5173).

After changing `src/`, restart the server — Bun does not hot-reload:

    kill $(ss -tlnp | grep 4479 | grep -o 'pid=[0-9]*' | cut -d= -f2)
    setsid nohup bun bin/agentbox serve >> ~/.local/share/agentbox/logs/server.log 2>&1 < /dev/null &

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
  replayed, and the tests in `__tests__/balancer.test.ts` are the spec (the
  "worked example" test is the one the design was built from).
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
  argv), plus `jsonl.ts` (incremental tail) and `procs.ts` (/proc helpers).
- `src/core/accounts/` — credential homes, identity, usage fetchers, logins.
- `src/core/fleet.ts` — joins everything into sessions; spawn/resume/adopt.
- `src/core/balancer.ts`, `claims.ts`, `calibration.ts` — placement.
- `src/server/` — HTTP + WebSockets. `src/mcp/fleet.ts` — the conductor's MCP.
- `src/cli/index.ts` — `agentbox claude|codex|…`, `ls`, `attach`, `adopt`.

## Tests

`bun test` (everything is hermetic: suites that touch paths use
`src/core/__tests__/tmp-home.ts`; the fleet tests use a fake adapter and a fake
tmux). `bun run typecheck` must be clean.
