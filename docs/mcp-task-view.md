# Putting live status in Claude Code's MCP task panel

**Status: blocked on the client, not on us. Do not start building.**

Written 2026-08-29 against Claude Code with `claude-code-linux-x64`, the build
installed at
`~/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/`.
Everything below was read out of that binary; re-verify before acting, because
the whole verdict turns on one function that a future build can change.

## What was being asked for

A long `mcp__omp__workflow` call shows up in Claude Code's Background panel as

    MCP tasks (1)
    ⏳ omp/workflow · kjc0y6zk · working

The `working` never changes, and the roster we publish (`0/12 done · 12
running`) is nowhere near it. The idea was to feed our live roster into that
entry, since that panel is inherently per-session and per-call — the right home
for it, unlike a status line we have to filter by hand.

## Why it cannot be done today

There are two unrelated things in Claude Code that both call themselves tasks.

**1. The entry you can see is the client's own auto-background wrapper.** When
an MCP call outruns 120s, `callMcpToolWithAutoBackground` registers a local
entry (`PLf({serverName, toolName, toolUseId, abortController})`) whose id
matches `/^k[0-9a-z]{8}$/` — that is `kjc0y6zk`. Its status text is written by
the client and updated only when the call finally settles, via
`boundMcpStatusMessage`, which takes the *error message*. There is no path from
a server into it.

**2. The MCP protocol's tasks augmentation is what would work, and it is
switched off.** The client-side machinery is all present and complete: a
`notifications/tasks/status` handler, a poller over
`client.experimental.tasks.getTask`, `getTaskResult`, `cancelTask`, persisted
task metadata (`taskId`, `serverName`, `toolName`, `mcpTaskId`,
`pollIntervalMs`, `spawnedAt`, `toolUseId`), a `restoreMcpTasks` at session
startup, and a registry update of `{mcpStatus, statusMessage}` that is exactly
what the panel renders. A server's `updateTaskStatus(taskId, status,
statusMessage)` would land there, live.

None of it can fire, for two reasons that compound:

- The feature gate is a compile-time constant. `function rqe(){return !1}`.
  It guards both `restoreMcpTasks` at startup and the `tasks` entry in the
  client's advertised capabilities:

      function X_S(){ return { roots:{listChanged:!0}, elicitation:{},
        ...rqe() && { tasks:{ requests:{ elicitation:{ create:{} } } } } } }

- Nothing ever creates one. The SDK's `callToolStream` is the only code that
  attaches `task: {}` to a `tools/call`, and it has no caller outside the
  bundled SDK class. Claude Code's real tool path (`qRi`, reached through
  `invokeToolRaw` → `Hg(client).callTool(...)`) uses plain `callTool` with
  `{signal, timeout, onprogress}` and no task augmentation.

And declaring task support anyway makes things *worse*, not neutral. From the
bundled SDK client:

    async callTool(e, t, r) {
      if (this.isToolTaskRequired(e.name))
        throw new _c(Rc.InvalidRequest,
          `Tool "${e.name}" requires task-based execution. …`);

So `execution: { taskSupport: "required" }` on any of our tools would make
**every call to it throw immediately**. `"optional"` is safe but inert: the
client never passes `task`, so the tool just runs normally and no task exists.

## Re-verifying against a future build (about ten minutes)

The binary is ~342MB and bun-compiled with the JS embedded. Regex greps over it
are slow enough to be backgrounded; fixed-string greps for byte offsets are
instant. Work in offsets, then `dd`:

    B=~/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/\
    claude-code/node_modules/@anthropic-ai/claude-code-linux-x64/claude

    LC_ALL=C grep -a -F -b -o 'function rqe(' "$B"        # the gate
    dd if="$B" bs=1 skip=<offset> count=400 2>/dev/null | tr -c '[:print:]\n' '.'

Three questions, in order. Stop at the first "no":

1. **Is the gate still off?** Find the function that returns the capabilities
   object containing `roots` and `elicitation` — grep `'elicitation:{},'` — and
   read the guard in front of `tasks:`. If it is still `return !1`, stop.
   (The identifier `rqe` is minified and will be renamed by any rebuild; find
   it through the capabilities function, not by name.)
2. **Does anything call `callToolStream`?** `grep -a -F -b -o 'callToolStream'`.
   Two hits means the SDK class only, and nothing initiates tasks. More than
   two, look at the extra ones.
3. **Does the main tool path pass `task`?** Find `invokeToolRaw`, follow it to
   the `callTool({name, arguments, _meta}, …)` call, and check its options.

## What to build if all three come back yes

The SDK side is ready and documented; we are on `@modelcontextprotocol/sdk`
1.30.0, which ships `experimental/tasks/` including an in-memory `TaskStore`
(`experimental/tasks/stores/in-memory.js`).

    server.experimental.tasks.registerToolTask("workflow", {
      description: …, inputSchema: …,
      execution: { taskSupport: "optional" },   // never "required" — see above
    }, {
      createTask:    async (args, extra) => ({ task: await extra.taskStore.createTask({ ttl: … , pollInterval: 2000 }) }),
      getTask:       async (_a, extra) => extra.taskStore.getTask(extra.taskId),
      getTaskResult: async (_a, extra) => extra.taskStore.getTaskResult(extra.taskId),
    });

The work then is: keep `taskSupport: "optional"` so the non-task path stays the
one that runs today; start the workflow (or the agent) inside `createTask` and
return immediately; call `taskStore.updateTaskStatus(id, "working", <roster
line>)` from the same tick that already feeds `onProgress` in
`src/mcp/subagent.ts`; and `storeTaskResult` at the end. The roster string is
already rendered — `renderRoster` in `src/core/workflow.ts`, `renderAgentLine`
in `src/core/subagents.ts` — so the status text is free.

Two things to get right when it happens:

- Both paths must work. A tool with `taskSupport: "optional"` is called
  *without* a task by every other MCP client, so `createTask` cannot be the
  only way in.
- The client clamps `pollIntervalMs` between two bounds and also subscribes to
  `notifications/tasks/status`, so pushing status is worth doing even though
  polling exists.

## What we can already influence, and what shipped instead

Our `notifications/progress` messages *do* reach the client: `onprogress` in
`qRi` forwards them as `{type: "mcp_progress", …, progressMessage: <our
message>}`, which is the roster you see rendered under the running tool call.
That half already works and needs nothing.

The actual complaint that prompted this — the roster bleeding across windows —
was a filtering bug and is fixed in `fedfc78`. Live lines now carry the owning
session id, lifted from the parent `claude --session-id`, and
`~/.claude/statusline.sh` matches it against the `session_id` it already gets
on stdin. Two windows on one repository no longer see each other's agents.

## A better next thing, found on the way

The same capabilities function proves Claude Code advertises
**`roots: {listChanged: true}`**. We do not use roots at all today.

That matters because `cwd` defaulting to the MCP server's own working directory
is the root of the wrong-tree family of bugs (see `AGENTS.md`, "Agents must not
wander out of their working directory"). With roots, the server can ask the
client for its actual workspace directories at connect time and subscribe to
changes — so the default can be the client's real root rather than wherever the
process happened to start, and a `cwd` outside every declared root is a strong
signal worth warning on.

Unlike the task view, this is unblocked, small, and aimed at a bug that has
actually cost us hours. Do this first.
