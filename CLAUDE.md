# agentbox

See `AGENTS.md` (rules, build/restart) and `docs/v2.md` (design, API contract).

The server runs from the checkout it was started in, so work that should reach
it has to land there. Other sessions may be editing the same checkout at once:
commit your own files by path, then build/restart per `AGENTS.md`.

Debugging: `~/.local/share/agentbox/logs/server.log`; the database is
`~/.local/share/agentbox/box.db`; `tmux -L agentbox ls` lists the sessions
agentbox is running. `bun bin/agentbox doctor` checks dependencies.
