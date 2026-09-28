/** The `agentbox` CLI, for an agent driving the fleet with it: printed by
 *  `agentbox guide`, committed to docs/cli.md by `bun run docs:cli`, and in
 *  the voice mode prompt (src/voice). */

export const CLI_GUIDE = `Everything goes through the \`agentbox\` CLI. It behaves like a Unix tool: plain
text out, the session id in the first column, and every verb that takes ids
also reads them from stdin with \`-\`, so pipes and xargs work.

## Looking

    agentbox ls                     # one line each: id status idle host provider repo branch title
    agentbox ls --status waiting,blocked --idle '>2h'
    agentbox ls --repo widget --all   # --all includes closed
    agentbox ls --roots             # without the helpers other sessions started
    agentbox ls -q ...              # ids only, for piping
    agentbox ls --json | jq ...     # every field
    agentbox show <id>              # the header: where, model, context, first/last prompt, last reply
    agentbox log <id> | tail -60    # the conversation as text, oldest first
    agentbox log <id> --tools       # with tool calls and their output
    agentbox grep <regex> [-i] [--all]   # search every conversation: id  time  who  line
    agentbox screen <id>            # what its terminal shows right now (tmux sessions)
    agentbox diff <id>              # its worktree's changes
    agentbox usage                  # each account's limits
    agentbox watch [<id>...] [--status blocked,waiting,running,stopped] [--once]
                                    # runs until killed: a line each time one starts
                                    # asking (blocked), finishes its turn (waiting, with
                                    # the end of its last message) or stops. --once
                                    # exits after the first: \`watch <id> --once\` waits for it

## Doing

    agentbox send <id> 'text'       # type a message into it (echo ... | agentbox send <id> -)
    agentbox close <id>...          # stop it and take it off the board; transcript and worktree kept
    agentbox reopen <id>...         # back on the board (still stopped; resume to run it)
    agentbox stop <id>...           # end its process; it stays resumable
    agentbox resume <id>... --detach
    agentbox adopt <id>... --detach # move a session from another terminal into agentbox
    agentbox label <id> 'name'      # rename it on the board
    agentbox claude|codex|omp|devin --detach [--account X] [--model M] 'prompt'   # start one, from the directory it should work in
    agentbox schedule '<when>' [--cwd DIR] [--agent codex] [--name N] 'prompt'
                                    # start one later: 'in 4 hours', 'tomorrow at 9am',
                                    # 'friday 5pm', 'every weekday at 8:30', 'every 2 hours'.
                                    # Prints the id and when it was understood to start
    agentbox schedules              # what is set to start: id  in  when · agent · title
    agentbox unschedule <id>...     # it will not start

## Conventions

- Statuses: running (mid-turn), blocked (a prompt needs answering), waiting
  (turn over, the user's move), stopped (no process, resumable), closed (stopped and
  off the board, still resumable).
- Idle is the time since the conversation last moved. Resuming a session
  does not reset it.
- Host: \`box\` runs in agentbox's tmux, so \`screen\` and \`send\` work on it;
  \`ext\` runs in a terminal of the user's, which agentbox can see but not
  read or type into; \`-\` has no process. \`adopt\` moves an \`ext\` session
  into agentbox by restarting it, which closes it in the user's terminal, so
  ask first.
- Repo is the repository, also for a session in a worktree; the branch says
  which worktree (agentbox's own are \`ab/<id>\`).
- Closing is cheap and reversible, but it stops the process first, so a
  session mid-turn loses that turn: ask before closing a running one.
- Stopping a running session interrupts its work, and a message sent to one
  lands mid-turn. Ask before stopping or sending to a running session.
- A session another one started (a teammate, a \`codex exec\` run from a
  Bash tool, an agent of its subagent MCP) is listed right after its parent
  with its title indented \`└\`, and \`show\` names its parent and children.
  Every verb acts on exactly the ids it is given: closing or stopping a parent
  leaves its children alone, so list them (\`ls | grep\`, or \`ls --json | jq\`
  on \`.parent\`) to act on them too. The exception is subagents (host
  \`sub\`): the parent runs them, so stopping or closing it stops every one
  mid-task, and none can be stopped, sent to or adopted on its own. Ask before
  stopping a session that has running subagents. What you start with \`agentbox claude|codex --detach\` is
  top-level, never your child.
- Prefer reading \`show\` and the tail of \`log\` over whole transcripts; they
  are long.
`;
