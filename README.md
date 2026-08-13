# agentbox

A board for spawning and maintaining **omp** sessions — built from scratch,
inspired by switchyard's shape (conductor, agents, PRs, skills, settings) but
not its code or its terminal look. Polished, dark/light web app.

## What it does

- **Spawn** an omp session on any registered repo: agentbox carves a fresh git
  worktree and drives omp over **ACP** (Agent Client Protocol).
- **Maintain** sessions, truly interactively:
  - **Steer** — send messages while it's running (queued and delivered when the
    turn ends) or when it's waiting.
  - **Interrupt** — cancel the current turn; the conversation and queue survive.
  - **Waiting** — when a turn ends or the agent needs input, the session is
    "waiting" and your next message resumes the *same* conversation.
  - **Approvals** — bash and other permission-gated tools surface an
    Approve/Deny prompt (auto-approved if you prefer).
- **Conductor** — everything that needs you, in one list: failed/lost sessions,
  sessions waiting on an approval, done sessions with an open PR, and open PRs.
- **Pull requests** — open PRs across your registered GitHub repos via `gh`.
- **Skills** — inventory of your skills from `~/.claude/skills`,
  `~/.agents/skills`, and the project.
- **MCP server** — a conductor agent can spawn, steer, interrupt, approve, and
  babysit every agent via MCP tools (`wait` is the babysitting primitive).
- **Settings** — theme (light/dark/system), model, auto-approve, max run time,
  and repository management.

Sessions run with your existing omp setup — model
`opencode-go/deepseek-v4-flash` via OpenCode Go, or anything else omp can reach.

## Install

Requires **bun**, **omp** (install via `omp.sh`), **git**, and **gh**.

```bash
bun install
bun run web:build   # build the UI
bun bin/agentbox doctor   # sanity check
```

## Run

```bash
bun bin/agentbox            # http://127.0.0.1:4479 (serves the built UI)
# or, during development:
bun run dev                 # backend (watch)
bun run web:dev             # vite dev server on :5173 → proxies to :4479
```

Everything (worktrees, logs, sqlite) lives under `~/.local/share/agentbox`.
Set `AGENTBOX_HOME` to relocate it. Port overrides: `AGENTBOX_PORT`.

## MCP (for a conductor agent)

Register the MCP server with opencode, then restart opencode:

```bash
bun bin/agentbox install    # add the agentbox MCP server to opencode
bun bin/agentbox uninstall  # remove it
```

Exposed tools: `state`, `list_sessions`, `spawn_session`, `send_message`,
`interrupt`, `reply_permission`, `wait`, `get_transcript`, `archive_session`,
`delete_session`, `list_prs`, `list_repos`, `add_repo`, `list_skills`,
`get_settings`, `set_settings`. `wait` polls until a session stops working —
the core of babysitting. A typical conductor loop:

1. `spawn_session` → `wait` → check the result
2. `send_message` to steer, `interrupt` to cut a turn, `reply_permission` to
   approve bash
3. `archive_session` / `delete_session` when done

## Layout

```
bin/agentbox        CLI (serve / mcp / install / doctor / version)
src/core/           domain: types, db, paths, git, acp (interactive engine),
                    sessions, conductor, prs, skills, settings, state
src/server/         Bun.serve HTTP + WebSocket API
src/mcp/            MCP server (thin adapter over the HTTP API)
web/                React + Vite UI (dark/light)
```

## Notes

- PR tracking needs `gh` authenticated for the repos you register.
- Local repos are used in place; `owner/repo` slugs are cloned under
  `~/.local/share/agentbox/repos`.
- Sessions stay alive between turns (one omp process per session). If the
  process dies, the next message you send resumes the saved conversation.
