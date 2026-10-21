# agentbox

A fleet manager for coding-agent CLI sessions (claude, codex, devin, omp, opencode)
across multiple subscription accounts. **Read `docs/v2.md` first** — it is the
design and the HTTP/WebSocket contract, and it says which piece owns what.

## Build and restart

The server serves the pre-built UI from `web/dist`; after editing `web/src`,
run `bun run web:build` and refresh (or use `bun run web:dev` on :5173).

After changing `src/`, restart the server — Bun does not hot-reload:

    systemctl --user restart agentbox

It is a service of your user's systemd (`systemd/agentbox.service`, which the
board's first-run card installs with this checkout's own paths), so it starts
at boot — before anyone logs in, once lingering is on (`loginctl
enable-linger`) — and it does not die with the terminal or agent session that restarted it. It runs in
a login shell's environment rather than whatever shell restarted it; every
agent inherits that environment through tmux. Then check `/api/health`, and
that `/api/state` has as many sessions as before. The server answers within a
few seconds of starting and `/api/state` waits for its first pass; the log's
`agentbox ready in …` line says how long that took and where it went. Never kill the process on
:4479 and start another by hand (the old `agentbox-serve.scope` recipe): the
service sees a clean exit and stays down, so the board runs outside it until
the next boot. `CPUWeight=2000` puts it ahead of the agents: each tmux pane is
a scope of its own at the default 100, and with a hundred busy the unweighted
server took seconds to answer anything. `ensureServer` (src/cli/index.ts)
starts the service when the server is down, and the old scope only where the
service is not installed.

The tmux server runs in a scope of its own, `agentbox-tmux.scope`
(`src/core/tmux.ts` starts it through `systemd-run`) — or an unnamed
`run-….scope` after a tmux server was killed, whose name stays held while
anything its panes started still runs. This is what makes a
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

The server runs from the checkout it was started in, so a change only
reaches it once it is there. Several agents may be editing that checkout at
once: commit your own files by path, never `git add -A`. A commit's subject
is one line of at most 72 characters saying what changed; why, and what it
fixes, go in the body after a blank line, so `git log --oneline` stays
readable.

## Rules that are easy to break

- **No agent carries its prompt or its briefing on a command line.**
  `pgrep -f` reads command lines, so an agent whose prompt is an argument is
  found by any word in it: a `pkill -f release-rehearsal` kills the agent
  that was told to run the rehearsal, and every other agent told the same
  words (on 2026-10-21 that killed seven sessions). The text goes in a file
  under `<agentbox home>/sessions/<id>/` and the launch names the file
  (`src/core/textfile.ts`): claude and omp read it, codex is told to read
  it, and a CLI that takes no file is given the prompt by typing it.
- **Search the tree, not the machine.** `grep -r` or `find` in `$HOME`, `/`,
  `/tmp`, `~/.local/share/agentbox`, or `~/Documents` reads hundreds of GB and
  millions of files, on one core and for minutes. Scope it to the worktree,
  use `rg` with `-g '!node_modules'`, bound it with `-m1` or `-maxdepth`, and
  remember `| head` does not stop the scan. `agentbox grep --all` is for
  conversations.
- **The provider's transcript is the record.** Never write a copy of a
  conversation. The database holds only what the provider cannot know: the
  account pin, the claim, the tmux session, a label, when it was closed, metrics.
  And Claude's /btw side questions: Claude keeps those only in the process's
  memory, so the `btw` table is their one record (`src/core/btw.ts`).
- **A warm session never changes account.** Switching accounts invalidates
  the provider's prompt cache, so until its cache goes cold
  (`Session.cacheWarmUntil`, `src/core/cache.ts` — the one clock for "is it
  warm?"; nothing else should keep its own) resume and adopt use its pinned
  account. After that it is shown unpinned, and a resume or a
  message wakes it on the balancer's pick (`Fleet.wake`, which moves — never
  copies — a transcript that lives in the account's home: claude and codex;
  omp, opencode and devin keep one store across accounts, and muse has no
  move at all).
  The one exception: a session stopped at its account's limit is moved once
  in its life to an account that can take it (`Fleet.continueStalled`);
  after that the UI offers a button. Transcripts are not shared between account homes, so a plain
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
  every 2s: stat, don't read. Readers are incremental (`JsonlTail`), and
  across restarts too: each reader's `saveState` goes to
  `~/.local/share/agentbox/cache/readers/` (`src/core/readercache.ts`) and
  the next server carries on from it, so a restart reads what was appended
  while it was down, not a week of transcripts. A reader exists only while
  its transcript can move — a process or pane of its session runs, the file
  changed, its timeline is open — and is put away after ten still minutes;
  the rest of the board is drawn from each session's record, whose facts say
  how much of the file they cover (`Tracked` in `src/core/fleet.ts`). A saved
  state is stamped with a hash of its provider's reading code; change a fold
  and that provider's live transcripts are read in full again, a few seconds
  a pass while the board shows the rest from their records, and the others
  when they next move. A new fold field must be plain data (`foldstate.ts`),
  or the reader must say how to save it.

## Where things are

- `src/core/providers/` — one adapter per CLI (transcript format, processes,
  argv, and its credential homes and environments), plus `jsonl.ts`
  (incremental tail) and `procs.ts` (/proc helpers).
- `src/core/accounts/` — credential homes, identity, usage fetchers, logins.
- `src/core/fleet.ts` — joins everything into sessions; spawn/resume/adopt.
- `src/core/org/`, `src/cli/org.ts` — orgs (`docs/org.md`): a team's pooled
  claude, codex, omp, devin and muse accounts, kept in step through a MongoDB
  store, the members' org sessions and messages between them, and the org's
  skills. A session's scope is its account's: an org account's home is under
  `<agentbox home>/org/accounts/`, and `placement()` never crosses scopes.
- `src/core/balancer.ts`, `claims.ts`, `calibration.ts` — placement.
- `src/server/` — HTTP + WebSockets. `src/mcp/fleet.ts` — the conductor's MCP;
  it and the CLI share one HTTP client, `src/client.ts`.
- `src/mcp/subagent.ts` — the subagent MCP (`agentbox subagent-mcp`), over
  `src/subagents/`: a pool of `omp acp` / `devin acp` processes it owns
  (`backend.ts` says how each CLI is started), their records and live status
  lines. Independent of the server and the database.
- `src/bridge/` — the devin bridge (`agentbox devin-bridge`, a process of
  its own on :4480): runs a model devin does not sell in devin's harness, so
  it gets devin's compaction. LongCat 2.5 Preview from OpenCode Go is the one
  so far, rolled before 220k. A devin session on such a model has
  `WINDSURF_API_SERVER_URL` pointed at it (the devin adapter does this) and
  is placed as `unmetered`. It depends on a wire format read off the network:
  **`docs/devin-bridge.md` is how it works and how to repair it after a devin
  update**, starting with `agentbox devin-bridge check`. After changing
  `src/bridge/`, `agentbox devin-bridge restart`.
- `src/cli/index.ts` — `agentbox claude|codex|…`, `attach`, `usage`, `mcp`,
  `subagent-mcp`, `devin-bridge`, `doctor`; `src/cli/sessions.ts` — the Unix-shaped session
  verbs (`ls`, `show`, `log`, `grep`, `screen`, `diff`, `send`, `watch`, `close`,
  `stop`, `resume`, `adopt`, `move`, `label`): ids first on every line, `-` reads ids
  from stdin.
- `src/voice/` — hands-free mode (the Voice page, `/ws/voice`): Deepgram Flux
  hears, Claude (`claude-opus-5-5`, low effort, on the API key in
  `<agentbox home>/voice.env`) decides and may `stay_silent`, Deepgram Aura
  speaks. Its tools are a shell with the `agentbox` CLI on it (the CLI guide,
  `CLI_GUIDE` in src/core/cli-guide.ts, is in its prompt) and background
  `watch`es whose output lines come back to it as messages; for real work it
  starts a detached session and watches it. It speaks up on its own from those
  lines and from board news (`src/core/changes.ts`, the same changes
  `agentbox watch` prints).
- `src/core/mcp.ts`, `src/core/mcp-reach.ts` — the global MCP servers (the
  MCPs page): agentbox's own list, and the layer each CLI is launched with
  so that every agent gets it. Never edit a CLI's own config for it.
  `docs/v2.md` "Global MCP servers" is how each CLI takes it.
- `src/core/rules.ts`, `src/server/context.ts`, `web/src/views/Context.tsx` —
  the Context page: your rules (`<agentbox home>/rules.md`, and one file per
  repo under `rules/<repo id>.md`) and the instruction files each CLI reads
  itself (AGENTS.md and CLAUDE.md, global and per repo). The browser names a
  document by id, never a path. Rules are read at every launch and resume
  (`providers/briefing.ts`), so an edit reaches the next session without a
  restart — and spends a kept-warm session's prompt cache once when it resumes.
- `src/core/user.ts` — who agentbox works for, derived from the machine (git,
  gh, the passwd entry, the timezone) into `<agentbox home>/user.env` by
  `agentbox onboard`, and re-derived at boot when that file is missing. The
  repo never learns a name, an email or a login; personal skills live in
  `~/.claude/skills` or `~/.agents/skills`, outside any checkout.
- `src/core/cli-guide.ts` — the `agentbox` CLI guide for agents: `agentbox
  guide` prints it and `bun run docs:cli` writes it to `docs/cli.md`.
- `src/core/pwa.ts` — the board's PWA launcher entry. Chrome writes its
  .desktop with `StartupWMClass=crx_<id>`, but the Wayland window's app id is
  `chrome-<id>-<profile>` (the `Icon=` value), so GNOME groups the board with
  Chrome. The server patches the entry at boot and on a slow poll, and
  `doctor` fixes and reports it; nothing is touched without a Wayland session.

## Tests

Almost none, on purpose: this is a dev tool, and tests that pin behaviour
slowed it down more than they caught. Check a change by running it (`bun run
web:dev`, the live server) and keep `bun run typecheck` clean. Do not add tests
by default. One has to guard a non-obvious rule whose breakage would be
destructive or a security hole, and "useful" is not enough — such as
`src/server/__tests__/csrf.test.ts`.
