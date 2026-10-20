/** The `agentbox` CLI, for an agent driving the fleet with it: printed by
 *  `agentbox guide`, committed to docs/cli.md by `bun run docs:cli`, and in
 *  the voice mode prompt (src/voice). */

export const CLI_GUIDE = `Everything goes through the \`agentbox\` CLI. It behaves like a Unix tool: plain
text out, the session id in the first column, and every verb that takes ids
also reads them from stdin with \`-\`, so pipes and xargs work.

## Looking

    agentbox ls                     # one line each: id status idle host provider repo branch title
    agentbox ls --status waiting,blocked --idle '>2h'
    agentbox ls --repo agentbox --all  # --all includes closed
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
    agentbox watch [<id>...] [--status blocked,waiting,running,stopped] [--once] [--now]
                                    # runs until killed, or until the agent that armed
                                    # it exits: a line each time one starts
                                    # asking (blocked), finishes its turn (waiting, with
                                    # the end of its last message) or stops. --once
                                    # exits after the first. --now first reports any
                                    # already blocked, waiting or stopped; without it a
                                    # session that is already idle never produces a line.
                                    # For a terminal or a script to follow the board: it
                                    # stops with the process that runs it, so an agent
                                    # waits with \`agentbox wait session\` instead.

## Waiting

    agentbox wait pr <n|owner/repo#n|url> [--require 'Reviewed head'] [--only 'Build,API Tests'] [--head <sha>]
                                    # a pull request's checks concluding on that head (the
                                    # one it has now, unless named): every check except Merge gate. --require
                                    # names checks that must be among them, for one that
                                    # reports only when it has something to say (a review
                                    # that marks the head it read); --only waits for just
                                    # those named (a name takes its shards too: "API Tests
                                    # (shard 1/3)"). A check that fails ends it at once and
                                    # is named
    agentbox wait pr <n> --feedback --head <sha>
                                    # new/edited review or comment, failed check, or moved head;
                                    # independent of queued CI. Read the actual verdict now,
                                    # then rearm: a durable cursor skips observed feedback.
                                    # Keep a separate full-check wait; neither is merge permission.
    agentbox wait pr <n> --merged [--head <sha>]
                                    # its merge (or its closing); with --head, also its
                                    # head moving off that commit: the wait for a PR
                                    # yours is stacked on. Use this, not an until over gh
    agentbox wait run <id|url> [-R owner/repo]   # a GitHub Actions run concluding
    agentbox wait job [--name N] -- <command…>   # start a long command as a native service
                                    # (systemd on Linux, launchd on macOS), in this
                                    # directory and environment, and be told its recorded
                                    # exit or signal with the end of its output. One argument
                                    # is a shell line ('a | b > out.log'); several are an argv
    agentbox wait session <id>...   # the first of those sessions to end its turn, ask
                                    # something or stop (at once if one already has)
    agentbox wait until [--every 2m] -- <command>
                                    # run in this directory every --every (two minutes at
                                    # most each time, in the server's environment): exit 0
                                    # is the event and what it prints is said; exit 1
                                    # with nothing on stderr is not yet; any other exit,
                                    # or an exit 1 with an error on stderr, is a look that
                                    # failed, and five running end the wait as one that
                                    # cannot watch. One argument is a shell command line;
                                    # several are an argv (\`-- bash -c '<script>'\`).
                                    # Let a read that fails fail: \`|| exit 2\`, not
                                    # \`2>/dev/null\` then a test that reads as not yet
    agentbox wait time 45m          # nothing but the time
    agentbox waits [--mine | --session <id>] [--all] [--json]
                                    # what is waited on and what the last look found;
                                    # those that ended in the last day, and how
    agentbox unwait <id>...         # cancel one; a job it started keeps running

Each takes \`--timeout <3h>\` (it has one regardless: 3h for a pull request, 2h a
run or a command, 12h a job, 4h a session; a week at most) and \`--for <session>\`
(default: the session it is run in). It prints the wait's id and returns at
once. The server does the waiting, not your process: end your turn, or carry
on with other work, and the wait is typed into the session as agentbox's own
note the moment it ends, which is one of exactly four ways, each named:

- HAPPENED: what it waited for (a failed check or job is this too, and says so);
- CANNOT HAPPEN: waiting will not bring it: the head moved, the PR was closed, a
  named check never reported though nothing has run for half an hour;
- TIMED OUT: with what the last look found;
- THE WAIT FAILED: it could not be watched: GitHub answered nothing for twenty
  minutes, a job's unit vanished without a result, the command kept failing.

A parked session is resumed to hear it; one that was stopped by hand, or is at
a usage limit, hears it when it next runs (\`agentbox waits\` shows NOT TOLD and
why). Arming the same wait twice is one wait.

## Doing

    agentbox send <id> 'text'       # type a message into it (echo ... | agentbox send <id> -)
    agentbox send <id> --wake 'text'   # ...when it is stopped or cold and waking it is the point
    agentbox close <id>...          # stop it and take it off the board; transcript and worktree kept
    agentbox reopen <id>...         # back on the board (still stopped; resume to run it)
    agentbox stop <id>...           # end its process; it stays resumable
    agentbox resume <id>... --detach
    agentbox move <id> [--account X]   # continue it on another account, its conversation intact:
                                    # for one stopped at its account's usage limit (show has a
                                    # "limit:" line; agentbox moves each once by itself, so this is
                                    # for the second time, or the one it missed). Cheaper than
                                    # a successor that rebuilds the context from the log.
                                    # Refused when no other account can take it
    agentbox adopt <id>... --detach # move a session from another terminal into agentbox
    agentbox label <id> 'name'      # rename it on the board
    agentbox claude|codex|omp|opencode|devin|muse --detach [--account X] [--model M] 'prompt'   # start one, from the directory it should work in
                                    # --repo owner/name [--ref REF]: in that registered repo instead,
                                    # at REF in a detached worktree of its own; on a hub, --node NAME|auto
                                    # starts it on a node (auto: the machine with the most room)
    agentbox schedule '<when>' [--cwd DIR] [--agent codex] [--name N] 'prompt'
                                    # start one later: 'in 4 hours', 'tomorrow at 9am',
                                    # 'friday 5pm', 'every weekday at 8:30', 'every 2 hours'.
                                    # Prints the id and when it was understood to start.
                                    # --fallback omp,codex: started on those, in order,
                                    # when --agent has no account with room
    agentbox schedule 'every 10 minutes' --note-cmd './whats-open.sh' --same-session [--fresh-over 150k] 'prompt'
                                    # a recurring one that speaks only when there is
                                    # something to say, and to one session. Each time
                                    # it comes due the command runs in --cwd (2 minutes
                                    # at most); what it prints goes before the prompt,
                                    # and when it prints nothing, nothing happens.
                                    # --same-session types the note into the session it
                                    # started last instead of starting another, skips
                                    # the time while that one is mid-turn, and starts a
                                    # fresh one (closing the old) once it is gone or
                                    # holds over --fresh-over tokens of context. One
                                    # compacted since the last note is kept, and that
                                    # note carries the prompt again. Either flag works
                                    # without the other
    agentbox schedules              # what is set to start: id  in  when · agent · title,
                                    # and for those: its session, its command, its last note
    agentbox unschedule <id>...     # it will not start
    agentbox card add --kind decision --title T --short S [--long-file F] [--recommend R] [--pr URL]
                      [--default D --default-at 'in 24 hours'] [--key K] [--for <session>]
                                    # hand the user a card on the app's Review page and
                                    # print its id. kind: decision (they owe an answer),
                                    # merged, note (it happened). --short is two or three
                                    # sentences; --long-file the long, extra clear version
                                    # in Markdown. --key adds it once, however often you run it
    agentbox card list [--open|--later|--answered [--unread]|--closed] [--json]
    agentbox card show <id>         # all of it, with the answer
    agentbox card ack <id>          # you have read an answer that was waiting (--unread)
    agentbox card close <id> <why>  # withdraw it: the question went away
    agentbox pr who <n|owner/repo#n|url>   # the session that has this pull request, or "nobody" (exit 1)
    agentbox pr claim <n|…>         # it is yours, and says so ("you hold", "you already hold"); refused,
                                    # naming "another session", if another live session has it
    agentbox pr release [<n|…>]     # release ownership, and the waits that act on it
                                    # (one PR, or all); a --merged wait stays armed
    agentbox pr transfer <repo#n> --expect <holder> --to <successor>
                                    # the holder hands it over; refused if ownership moved meanwhile
    agentbox pr claims              # every pull request a live session has

## Superagents (programs that run on agentbox: docs/superagents.md)

    agentbox superagent ls          # each one: its program, its main conversation, its directory
    agentbox superagent call <name> <action> --json <file>   # what a superagent's prompt tells you
                                    # to run: its answer is JSON; it knows which session called
    agentbox superagent view <name> [--tab t]   # its page, as JSON
    agentbox superagent add <dir>   # register one (a person's call: do it only when asked)
    agentbox handover <from> <to> [--close]     # what <from> started, its cards, PRs and their
                                    # waits go to <to>; messages to <from> reach <to>

## Conventions

- One session has a pull request. You have yours by being on its branch, or
  by having been started with \`--claim <n>\`. Before you work a pull request
  you did not open (fix it, rebase it, push to it, take it to green), run
  \`agentbox pr claim <n>\`; if it is refused, another live session is on it:
  do not work it as well. To start a session on a PR, start it with
  \`--claim <n>\` (\`agentbox claude --detach --claim 8653 '…'\`): it has the
  PR from its first moment, or is not started. Reading or reviewing a PR
  needs no claim. A claim lapses when its session stops or closes. Your own
  id is \`$AGENTBOX_SESSION\`; wherever ls, show, pr who and pr claims name
  you, the id has "(you)" after it.

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
  session mid-turn loses that turn: ask before closing a running one, and
  before closing a parent whose children are running — closing takes the
  sessions it started, at any depth, with it.
- Stopping a running session interrupts its work, and a message sent to one
  lands mid-turn. Ask before stopping or sending to a running session.
- \`send\` is for coordination a session cannot do without: an answer it is
  waiting on, a blocker, a handoff, two sessions about to collide on the same
  files. Never send to narrate your progress or to direct how another session
  does its work: each message interrupts it and stays in its context. A
  session you started says when its turn ends; \`agentbox wait session <id>\`
  tells you, instead of checking in.
- Waiting is \`agentbox wait\`'s, never your own process's. A background shell
  loop over \`gh\`, \`gh run watch\`, \`sleep\`, \`pidwait\`, \`agentbox watch\` in
  the background, a script that messages you when something exits: each one
  stops when your session is parked, moved or restarted, and each can end
  without the thing having happened and without saying so. A long command
  started in the background stops the same way, taking its work with it:
  start it with \`agentbox wait job\`. Say what you are waiting on only after
  the wait is armed.
- A \`send\` to a session that is stopped, or whose prompt cache is cold, is
  refused: it would re-read its whole context to hear you. Read it with
  \`show\` and \`log\`, or start a fresh session with a handoff; pass \`--wake\`
  only when waking it is the point (an answer it asked for, a blocker). More
  than 3 messages to one session in an hour are refused too: batch them.
- A \`send\` to a session another has taken over (a schedule replaced it)
  goes to the one that took over, and says so: send to that one from then on.
- \`send\` prints \`sent: <id> took it\` and exits 0 only when the session
  took the message. Refused, or typed and left in its input box, it prints
  \`not sent: …\` and exits 1: read that before you say you sent anything,
  and never pipe \`send\` into \`tail\` or \`grep\`, which hides the exit code.
- A message is a nudge, not a record. A result another session waits on (a
  PR that is ready, a verdict, a finished batch item) is written first where
  it will be looked for (a PR comment, a ledger such as \`steward.py report\`),
  and then sent; the reader that never gets the nudge still finds the result.
- A sent message arrives marked \`[via agentbox send from <id>]\` with the
  sender's session id, so don't sign it yourself; reply to the id in that
  mark.
- A session another one started (a teammate, a \`codex exec\` run from a
  Bash tool, an agent of its subagent MCP) is listed right after its parent
  with its title indented \`└\`, and \`show\` names its parent and children.
  Every verb acts on exactly the ids it is given, except close: closing a
  parent closes the sessions it started, at any depth, with it (running ones
  are stopped, and the app asks first when any are), but leaves open, and
  names, any that has a wait armed or has claimed an open PR, with what that
  one started. Stopping a parent
  leaves its children alone, so list them (\`ls | grep\`, or \`ls --json | jq\`
  on \`.parent\`) to act on them too. The exception is subagents (host
  \`sub\`): the parent runs them, so stopping or closing it stops every one
  mid-task, and none can be stopped, sent to or adopted on its own. Ask before
  stopping a session that has running subagents. What you start with \`agentbox claude|codex --detach\` is
  your child too (\`show\` lists it), so closing you would close it: a session
  with work under it is stopped, not closed, or its children are moved first
  (the board's drag; \`PATCH /api/sessions/:id\` with \`parent\`).
- A card is how you ask the user something when you are not the session
  they are looking at, or tell them what you did without making them read
  your conversation. Their answer is typed into you as their own message,
  \`[card 12 “title”] …\`; an empty answer means they saw it, and nothing is
  typed. Write the short version so it can be answered from a phone without
  opening anything, give a recommendation, and never add a card for progress.
  If the session that asked is gone, the answer waits: \`card list --answered
  --unread\`, act on it, then \`card ack\`.
- Prefer reading \`show\` and the tail of \`log\` over whole transcripts; they
  are long.
`;
