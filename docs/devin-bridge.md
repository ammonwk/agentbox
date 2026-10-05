# The devin bridge

Runs a model devin does not sell inside devin's harness: devin's tools,
prompts, transcripts and, the reason it exists, devin's compaction. The first
such model is LongCat 2.5 Preview, free on OpenCode Go, which has a 1M window
and is to be rolled before about 220k: in devin it is summarised from 160k,
the summary swapped in at 195k, and never sent more than 220k.

None of this is supported by devin. It rests on a wire format read off the
network, so a devin update can break it. The second half of this page is how
to find out what broke and put it back.

## How it works

devin takes its model catalog and every model reply from one API server, and
`WINDSURF_API_SERVER_URL` says which. The bridge (`src/bridge/devin.ts`) is a
local HTTP server that stands in front of the real one
(`https://server.codeium.com`). A devin pointed at it gets the real server for
everything, its login token passed through untouched, with three exceptions:

| Call | What the bridge does |
| --- | --- |
| `GetCliModelConfigs` | adds a catalog entry per bridged model: a copy of a real model's entry (so it runs in that model's harness) with its own name, window and compaction thresholds |
| `GetCliTeamSettings` | adds the bridged models to `allowed_model_uids`, which otherwise lists exactly the catalog; a model not in it is quietly replaced by devin's default |
| `GetChatMessage` for a bridged model | answers from the model's own OpenAI-compatible endpoint, translating the request and the streamed reply |

Everything else is devin's own, including two model calls that still go to
devin's server on your devin login: the session title (`swe-1-6-fast`) and the
compaction summary (a model called `compactor`). So the conversation is sent
to Cognition when it is summarised, as it is for any devin session.

The models are declared in `src/bridge/models.ts` (`BRIDGED`). The key for a
model's endpoint is read from its owner's file at each request (OpenCode Go's
from `~/.local/share/opencode/auth.json`, or `OPENCODE_GO_API_KEY`); the
bridge stores nothing. OpenCode Go asks outside agents for their own user
agent and a stable `x-opencode-session` per conversation; the bridge sends
`agentbox-devin-bridge/1.0` and `devin-<devin's session name>`. Its anonymous
free tier (`/zen/v1` with no key) refuses anything but OpenCode itself, and
the bridge does not pretend to be OpenCode: it needs a Go key.

### In agentbox

- The new-session box lists bridged models first under devin
  (`src/core/models.ts`), when their key is present.
- The devin adapter sets `WINDSURF_API_SERVER_URL` for a session whose model
  is bridged, on spawn and on every resume (the saved model in devin's
  `sessions.db` decides when none is given), and starts the bridge if it is
  not running. Other devin sessions never touch the bridge.
- The balancer places such a session as `unmetered`: it claims nothing and an
  account at its limit can still take it, since the model draws on its own
  provider and not on the devin account.
- The board shows the model's window (`contextLimit`), so the context bar
  works.
- Subagents: `AGENTBOX_SUBAGENT_DEVIN_MODEL=longcat` runs `devin acp`
  subagents through the bridge the same way.

Outside agentbox: `WINDSURF_API_SERVER_URL=http://127.0.0.1:4480 devin --model longcat`
(after `agentbox devin-bridge start`). A session started that way must be
resumed that way.

### The process

The bridge is a process of its own (`src/bridge/service.ts`), not part of
`agentbox serve`, so restarting the server does not cut a reply off. It is a
transient systemd user unit, `agentbox-devin-bridge.service`, started by the
first session that needs it and restarted by systemd if it dies; after a
reboot the first resumed session starts it again.

    agentbox devin-bridge            # is it up, what has it served
    agentbox devin-bridge check      # test every step end to end
    agentbox devin-bridge restart    # after changing src/bridge/ or its settings
    agentbox devin-bridge run        # in the foreground, to watch it

Log: `~/.local/share/agentbox/logs/devin-bridge.log`, one line per reply
(`first=` is how long the provider took to start answering). Settings, read
when the bridge starts, so restart it from a shell that has them:

| Variable | Default | |
| --- | --- | --- |
| `AGENTBOX_DEVIN_BRIDGE_PORT` | 4480 | must be the same for the server and the bridge |
| `AGENTBOX_LONGCAT_CONTEXT` | 220000 | the window devin is told, and the hard limit |
| `AGENTBOX_LONGCAT_COMPACT_SPAWN` | 160000 | devin starts writing the summary |
| `AGENTBOX_LONGCAT_COMPACT_APPLY` | 195000 | devin swaps the summary in |
| `AGENTBOX_LONGCAT_BASE_URL` | OpenCode Go | another endpoint for the same model (or a stub, to test failures) |
| `AGENTBOX_DEVIN_BRIDGE_TRACE` | off | log every request, passed through or not |
| `AGENTBOX_DEVIN_BRIDGE_DUMP` | off | a directory to write each request to the provider and its raw reply into: whole conversations, so only while debugging |

### What to expect from the provider

OpenCode Go's free LongCat queues. Most replies start in 2 to 5 seconds, but
the same request has been measured waiting 25s, 90s and seven minutes before
answering normally, and it once returned an empty reply. So the bridge opens
the reply to devin at once and sends the empty keep-alive frames devin's own
server sends, which devin shows as thinking; it waits up to 15 minutes for the
first byte, treats an empty reply as a failure, and ends a failed reply with
an error devin retries three times before showing it. If a session sits on
"Thinking" for minutes, look at `first=` in the log before suspecting the
bridge: `agentbox devin-bridge check` asks the provider directly as its
second step.

## Adding a model

Add an entry to `BRIDGED` in `src/bridge/models.ts`: its endpoint and model id
there, where its key comes from, a `template` (the uid of a real devin model
whose harness suits it: `deepseek-v4-1-flash-max` for a reasoning model over
chat completions; `devin models list` has the uids), its window and the three
compaction thresholds, which must satisfy spawn ≤ apply ≤ hard ≤ window or
devin ignores them. Then `agentbox devin-bridge restart`, `agentbox
devin-bridge check`, and restart the server so the picker and the adapter know
it.

## When a devin update breaks it

Start with `agentbox devin-bridge check`. It walks the path a session takes
and names the step that failed; the sections below are named as it names them.
The wire format is documented at the top of `src/bridge/devin-wire.ts`, field
number by field number. The tools are in `scripts/devin-wire.ts`.

How the format was read in the first place, which is how to read it again:

1. **Record a real session.** Use a model devin serves itself (`swe-2-medium`
   is free), through the recorder:

       bun scripts/devin-wire.ts record /tmp/devin-wire &
       cd /some/scratch/dir
       WINDSURF_API_SERVER_URL=http://127.0.0.1:4591 \
         bun ~/Documents/agentbox/scripts/devin-wire.ts ask swe-2-medium \
         "In one step, call two tools in parallel: read ./note.txt and run 'echo hi'. Then tell me both results."

   `devin -p` hangs on this machine with or without a proxy; `ask` drives
   `devin acp` instead. devin can take a minute or two to start a session here
   (its sessions database is several GB), so give it time before deciding it
   is stuck.

2. **Dump the bodies.** `bun scripts/devin-wire.ts dump /tmp/devin-wire/NNN-GetChatMessage-req.bin`
   prints numbered fields. Requests are readable at once: the system prompt,
   the messages, the tools. A tool-calling turn gives you the reply's call
   frames, and the next request shows how devin sends calls and their results
   back.

3. **Name the fields.** The binary is Rust with prost; message and field
   names survive as strings in declaration order, even though numbers do not:

       strings -n 8 "$(readlink -f "$(which devin)")" > /tmp/devin-strings.txt
       grep -o 'GetChatMessageResponse[a-z_]*' /tmp/devin-strings.txt | head
       grep -o 'CompactionThresholds[a-z_]*ModelInfo[a-z_]*' /tmp/devin-strings.txt

   Run-together names (`message_iddelta_textdelta_tokensstop_reason…`) are a
   message's fields, in the order they were declared, which is not always the
   order of their numbers (`CompactionThresholds` reads spawn, hard, apply and
   is numbered spawn 1, apply 2, hard 3). That is where `spawn_tokens`, `apply_tokens`,
   `hard_tokens`, `allowed_model_uids` and `inference_server_url` came from.

4. **Ask devin what it thinks.** `RUST_LOG=debug` on `ask` (or any devin)
   prints its side. The lines that mattered:
   - `Ignoring invalid compaction thresholds for model …: spawn=… apply=… hard=…`:
     which field is which, and that the order must hold;
   - `` `devin acp --model` value did not resolve to an available model; falling back ``:
     the model is in the catalog but not selectable;
   - `Fetched team config: GetCliTeamSettingsResponse { … allowed_model_uids: […`:
     decoded messages, field names and all;
   - `Compacting conversation history with N messages and T tokens`,
     `spawned background compaction`, `falling back to synchronous compaction`:
     what compaction is doing.

### The provider

`check` posts one small completion straight to the model's endpoint. A failure
here is not devin's: the model id (free previews are renamed and withdrawn;
`curl -H "authorization: Bearer $KEY" https://opencode.ai/zen/go/v1/models`
lists the current ones), the key, or the provider's limits. OpenCode Go
answers 400 `MissingSessionID` without `x-opencode-session`.

### The catalog

`devin models list` through the bridge does not show the model. Either the
template's uid is gone (pick another in `models.ts`), or `GetCliModelConfigs`
changed shape. Record a session, dump the `GetCliModelConfigs` response, find
a model's entry by its uid, and compare with the header of `devin-wire.ts`.
devin caches the catalog per server URL in `~/.cache/devin/cli/model_configs_v*.<hash>.bin`
and reads the stale copy first, so a fix can take one more run to show; a
`model_configs_v7` there means the format moved on.

### When devin falls back

The dangerous one, because nothing errors: devin answers on its own default
model. Signs are the wrong window on the board, the wrong model name at the
foot of the TUI, and no `chat` line in the bridge's log. `check` catches it by
counting replies the bridge served. The cause so far has been
`allowed_model_uids` in `GetCliTeamSettings` (field 7); look for the
`did not resolve` line under `RUST_LOG=debug`, then for whichever list devin
checked.

### The chat

devin reaches the bridge but the turn fails or shows nothing. Set
`AGENTBOX_DEVIN_BRIDGE_DUMP` and restart the bridge to see what it sent the
provider and got back; if that is right, the frames devin wants have changed.
Record a real reply and compare with `ChatReply` in `devin-wire.ts`. Things
that were not obvious:

- `usage.2` is input *not* read from cache and `usage.5` the cached part;
  devin adds them. Chat completions counts cached tokens inside
  `prompt_tokens`, so the bridge subtracts. Get this wrong and devin sees the
  context twice as full and compacts far too early.
- A tool call is opened by a frame with its id and name; argument deltas
  follow with neither and belong to the call opened last.
- devin hangs up as soon as it has the stop frame (`hung up on` in the log is
  a normal ending).
- An error is HTTP 200 with a last envelope of `{"error":{"code","message"}}`;
  `unavailable` is retried.
- An image in a prompt is field 10 of its message (base64 and a MIME type),
  sent on as an `image_url` part with a data URL.

### Compaction

`check` compares the window devin reports with the one configured and looks
for the `Ignoring invalid compaction thresholds` warning. To watch compaction
itself, run the bridge with a tiny window in a scratch directory holding a few
files of a few thousand tokens each (devin's own prompt is about 12k):

    AGENTBOX_LONGCAT_CONTEXT=40000 AGENTBOX_LONGCAT_COMPACT_SPAWN=17000 \
      AGENTBOX_LONGCAT_COMPACT_APPLY=21000 agentbox devin-bridge restart
    WINDSURF_API_SERVER_URL=http://127.0.0.1:4480 RUST_LOG=info VERBOSE=1 \
      bun scripts/devin-wire.ts ask longcat \
      "Read ./big1.txt and tell me its first line. ||| Now ./big2.txt. ||| Now ./big3.txt. ||| Now ./big4.txt. ||| Without reading anything again, list every first line so far."
    agentbox devin-bridge restart      # back to the real thresholds

What it looked like when it worked: past `spawn` devin logs `spawned
background compaction` and asks `compactor` for a summary; at the next step
past `apply` with the summary ready, `usage_update` drops (it keeps the system
prompt, the skills message, the summary and a recent tail verbatim, so it does
not drop to nothing); past `hard` it compacts synchronously before sending.
The last prompt checks that what was summarised is still known.

## What is not done

- The summary and the title are devin's models on the devin login. If that
  ever needs to be the bridged model too, they arrive as `GetChatMessage` for
  `compactor` and `swe-1-6-fast` with the same session name.
- A bridged model cannot be switched to from a session that was not started
  on one: only bridged sessions see the catalog with it in.
