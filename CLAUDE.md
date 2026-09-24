# agentbox

## The omp MCP (`mcp__omp__*`) lives here

Source: `/home/dev/Documents/agentbox` — `src/mcp/subagent.ts` (the tools),
`src/core/subagents.ts` (one agent), `src/core/workflow.ts` (fan-out),
`src/core/acp.ts` (the omp process). `bun test` is fast; it fakes omp.
`src/mcp/index.ts` is a *different* server (the agentbox board) — don't confuse
them.

**Code changes need a client restart.** The server process and the tool schemas
both bind at session start, so editing the source and re-calling `mcp__omp__*`
runs the OLD build and looks like the fix did nothing. To verify in-session,
import `SubagentPool` in a scratch script, or connect an MCP client over stdio
to `bun bin/agentbox subagent-mcp`.

Debugging: `~/.local/share/agentbox/subagents/<id>/` holds each agent's
`transcript.jsonl` and the `system.md` it was launched with; the client's
`mcp-logs-omp/` holds the server's stderr. `bun bin/agentbox doctor` checks deps.
