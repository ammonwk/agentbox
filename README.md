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
  message to a running one is queued until its current turn ends.
- **Supervise** it automatically. agentbox watches tool calls for the two ways
  a cheap model fails — spiraling (repeating a failing command, thrashing one
  file) and drifting (taking the easy path instead of the right one). It nudges
  the second and stops the first, flagging it for you. A flagged session
  resumes in one click.
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

## The three pages

| Page | What's there |
|---|---|
| **Inbox** | Everything wanting a human, ranked: sessions that failed, stopped, or need an approval, plus open PRs. Empty is the good state. |
| **Sessions** | The board. Session list on the left, full detail on the right — activity, diff, task, and the steer box. |
| **Settings** | Run defaults, the system prompt every agent receives, supervision config, repos, disk reclaim, skills, and diagnostics. |

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

A conductor agent can drive the whole board over MCP.

```bash
bun bin/agentbox install     # register with opencode (backs up your config)
bun bin/agentbox uninstall
```

The MCP server is a thin client over the running agentbox HTTP API, so there is
one description of a session however you reach it.

## Layout

```
bin/agentbox        CLI: serve / doctor / mcp / host / install / uninstall
src/core/types.ts   the domain model — the web app imports it directly
src/core/           acp (ACP engine), host (one agent's process), hostproto
                    (the control socket), sessions (lifecycle), supervisor,
                    prompts, db, state, conductor, diff, git, prs, skills
src/server/         Bun.serve HTTP + WebSocket
src/mcp/            MCP server
web/                React + Vite UI
prompts/            prompt text, edited as content rather than code
```

## Notes

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
