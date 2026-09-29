# agentbox

See `AGENTS.md` (rules, build/restart) and `docs/v2.md` (design, API contract).

**No branches in this project.** All work goes straight to `main`, in the main
checkout (`~/Documents/agentbox`), which is what the server runs from: no
feature branches, no worktrees, no PRs. Work left on a branch never reaches the
running server. Commit your own files by path — other sessions may be editing
this checkout at the same time — then build/restart per `AGENTS.md`.

Debugging: `~/.local/share/agentbox/logs/server.log`; the database is
`~/.local/share/agentbox/box.db`; `tmux -L agentbox ls` lists the sessions
agentbox is running. `bun bin/agentbox doctor` checks dependencies.
