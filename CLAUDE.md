# agentbox

See `AGENTS.md` (rules, build/restart) and `docs/v2.md` (design, API contract).

The fleet MCP (`mcp__agentbox__*`) is `src/mcp/fleet.ts`, a thin client of the
HTTP API — it needs the server running (`bun bin/agentbox serve`). Code changes
to it need a client restart: the MCP process and its tool schemas bind at
session start.

Debugging: `~/.local/share/agentbox/logs/server.log`; the database is
`~/.local/share/agentbox/box.db`; `tmux -L agentbox ls` lists the sessions
agentbox is running. `bun bin/agentbox doctor` checks dependencies.
