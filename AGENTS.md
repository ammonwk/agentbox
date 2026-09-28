# agentbox

A fleet manager for coding-agent CLI sessions (claude, codex, devin, omp)
across multiple subscription accounts. **Read `docs/v2.md` first** — it is the
design and the HTTP/WebSocket contract, and it says which piece owns what.

## Build and restart

The server serves the pre-built UI from `web/dist`; after editing `web/src`,
run `bun run web:build` and refresh (or use `bun run web:dev` on :5173).

After changing `src/`, restart the server — Bun does not hot-reload:

    systemctl --user restart agentbox

It is a service of your user's systemd (`systemd/agentbox.service`, enabled
with `systemctl --user enable --now ~/Documents/agentbox/systemd/agentbox.service`),
so it starts at boot — before anyone logs in, since lingering is on — and it
does not die with the terminal or agent session that restarted it. It runs in
a login shell's environment rather than whatever shell restarted it; every
agent inherits that environment through tmux. Then check `/api/health`, and
that `/api/state` has as many sessions as before. Never kill the process on
:4479 and start another by hand (the old `agentbox-serve.scope` recipe): the
service sees a clean exit and stays down, so the board runs outside it until
the next boot. `CPUWeight=2000` puts it ahead of the agents: each tmux pane is
a scope of its own at the default 100, and with a hundred busy the unweighted
server took seconds to answer anything. `ensureServer` (src/cli/index.ts)
starts the service when the server is down, and the old scope only where the
service is not installed.

The tmux server runs in a scope of its own, `agentbox-tmux.scope`
(`src/core/tmux.ts` starts it through `systemd-run`). This is what makes a
restart safe: tmux puts each pane in a `tmux-spawn-*.scope` that is `PartOf`
whatever unit the tmux server was in when the pane started, so a tmux server
living in the server's own unit meant stopping the server stopped every
agent. Check with `systemctl --user show <pane scope> -p PartOf`.

Restarting loses nothing. The server owns no agents: they run in
`tmux -L agentbox` (one tmux session per agent session, `ab-<id>`) or in your
own terminals, and the fleet rebuilds the board from transcripts, the process
table and tmux on its first tick.

A crash is another matter — the machine restarting, your user's systemd being
stopped (a logout, or a stray SIGTERM: `who-sigtermed` names the sender), the
tmux server dying — and it recovers by itself (`src/core/recovery.ts`,
`docs/v2.md` "Crash recovery"): what was working is resumed and told what
happened, what was idle or waiting on you is parked, and subagents come back
through their callers. `agentbox recover` shows what it would do now,
`agentbox recover --last` what it did. The server keeps the live-sessions
snapshot this starts from in `~/.local/share/agentbox/live-sessions.json`,
and each recovery's report in `recovery/`.

## Rules that are easy to break

- **The provider's transcript is the record.** Never write a copy of a
  conversation. The database holds only what the provider cannot know: the
  account pin, the claim, the tmux session, a label, when it was closed, metrics.
  And Claude's /btw side questions: Claude keeps those only in the process's
  memory, so the `btw` table is their one record (`src/core/btw.ts`).
- **A warm session never changes account.** Switching accounts invalidates
  the provider's prompt cache, so while a session has been active within
  `claimIdleMin` (60) resume and adopt use its pinned account. Once it is idle
  past that the cache is cold anyway: it is shown unpinned, and a resume or a
  message wakes it on the balancer's pick (`Fleet.wake`, which moves — never
  copies — the transcript into that account's home; claude and devin only).
  A session stopped at a limit is never moved on its own: the UI offers a
  button. Transcripts are not shared between account homes, so a plain
  `claude --resume` cannot cross accounts.
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
  that skip permission prompts; do not loosen this. The one exception is the
  tailnet listener (`src/server/tailnet.ts`): the same app on this machine's
  Tailscale IP, for a phone, where every peer must `tailscale whois` to the
  machine's own user on an untagged node, and only then do the Tailscale
  names stand in for loopback. `AGENTBOX_TAILNET=0` turns it off.
- **`agentbox serve` holds its port from its first line.** A CLI that finds
  the server slow starts another; that one must fail at once, not run a
  second fleet.
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
  `src/subagents/`: a pool of `omp acp` / `devin acp` processes it owns
  (`backend.ts` says how each CLI is started), their records and live status
  lines. Independent of the server and the database.
- `src/cli/index.ts` — `agentbox claude|codex|…`, `attach`, `usage`, `mcp`,
  `subagent-mcp`, `doctor`; `src/cli/sessions.ts` — the Unix-shaped session
  verbs (`ls`, `show`, `log`, `grep`, `screen`, `diff`, `send`, `watch`, `close`,
  `stop`, `resume`, `adopt`, `label`): ids first on every line, `-` reads ids
  from stdin.
- `src/voice/` — hands-free mode (the Voice page, `/ws/voice`): Deepgram Flux
  hears, Claude (`claude-opus-5-5`, low effort, on the API key in
  `<agentbox home>/voice.env`) decides and may `stay_silent`, Deepgram Aura
  speaks. Its tools are a shell with the `agentbox` CLI on it (the Project's
  guide, `CLI_GUIDE` in src/core/project.ts, is in its prompt), background
  `watch`es whose output lines come back to it as messages, and `ask_project`
  for real work. It speaks up on its own from those lines and from board news
  (`src/core/changes.ts`, the same changes `agentbox watch` prints).
- `.claude/skills/telegram/` — Telegram Dev (a personal Telegram bot) with a link back
  to the session; for sessions working in this checkout.
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
