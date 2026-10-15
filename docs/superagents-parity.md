# Superagents: parity with PR #4 and with local main

Agentbox had two lines of work on agents. PR #4 (branch
`feat/agents-shared-d954iv5k`) built Agents into agentbox's core, and Nate's
local main carried it on for 111 commits: Jupiter, Vulcan, Caelus, Salus and
Terminus as local agents, a Feed, a guarded work family, a shared cloud tier,
project tabs, memory, loops and a daily sweep. Ammon's origin/main replaced it
with superagents (`docs/superagents.md`): the agents are programs and
instructions in directories, and core gained only generic pieces. The merge
of the two keeps both histories and follows Nate's decisions:

1. Core names no agent. The superagent runtime is the only agent runtime.
   Each agent is a directory that a person owns.
2. Each person keeps their own agents in their own directories or git
   repositories (`agentbox superagent add <dir>`).
3. Nate's Agents page stays (rail with pictures and drag order, project
   tabs, Chat / Feed / Settings, the question card, the Memory panel), driven
   by `/api/superagents`.
4. Nate's memory journal, MEMORY.md, SOUL.md, rollover, loops, provider
   choice and daily sweep stay, as generic services a manifest turns on.
5. Team sharing stays, as generic pieces: a cloud registry of instances, a
   claims API keyed by source, the GitHub App broker in core, the encrypted
   relay. Agent code travels by git, never through the cloud.
6. Ammon's `superagents/vulcan` replaces the core Vulcan; Jupiter, Caelus,
   Salus and Steward stay superagents. `scripts/migrate-local-agents.ts` moves
   each local agent's conversation, memory journal and SOUL.md into a
   superagent.

This list maps each item of PR #4 (Parts 1 to 3) and each feature local main
added after the merge base (Part 4) to where it is now. A verdict is one of:

- **Carried**: it does what it did; the cell says where.
- **Different**: it works another way, on purpose; the cell says why.
- **Not carried**: it is gone; the cell says why.

## Part 1. What a person sees

### A. Agents page and navigation

| # | Item | Verdict |
|---|---|---|
| 1 | Agents first in the nav, page loaded lazily | **Carried**: `web/src/App.tsx`. |
| 2 | Agent routes | **Different**: `#/agents[/<name>[/chat\|feed\|settings\|sessions[/<thread>\|<page tab>]]]` (`route.ts`). A name is a superagent's; an old `local-<x>` link opens `<x>`. |
| 3 | Landing selection | **Carried**: a computer opens the first active agent in the rail's order (#31); a phone shows the rail. |
| 4 | Local vs shared mode | **Different**: one rail. This machine's superagents first, then a Team group of the workspace's shared instances hosted elsewhere. |
| 5 | Session browser rail | **Carried**: `AgentBrowser.tsx`: each agent with its picture and activity, its main, earlier mains and work sessions under it, Active and inactive. |
| 6 | Agent picker modal | **Not carried**: the rail is always open. |
| 7 | Thread activity | **Carried**: in the rail, by the sessions' own status and titles. |
| 8 | Read-only predecessors | **Carried**: an earlier main opens read-only in Chat. A rollover or a handover moves what it held to the new main. |
| 9 | Agent header | **Carried**: picture, title, the first words of the description, a status pill (with Manifest error, Restarting, Stopped, Disabled), Chat / Feed / Settings, the Feed badge from the program's tab badges. |
| 10 | Navigation never starts or stops anything | **Carried**: only a sent message starts a main conversation. |
| 11 | Phone navigation, one pane at a time | **Carried**: Nate's narrow-screen history (`route.ts`). |
| 12 | Foreign and mismatched deep links | **Carried**: "No such agent", and "not in this project" for an agent of another project. |
| 13 | Shared directory | **Different**: the Team group in the rail, from the cloud registry (`GET /api/team/superagents`). |
| 14 | Shared agent About | **Different**: a team agent's Settings: host, maintainers, visibility, and the git source of its directory. |
| 15 | Local agent About and configuration | **Different**: Settings shows what the manifest says (directory, projects, provider and why, loops, sweep) and has the Enabled switch, Restart, the program's output, the picture and the Memory panel. Provider, repository and instructions change in the directory. |

### B. Main chat

| # | Item | Verdict |
|---|---|---|
| 16 | Main chat before and after the first message | **Carried**: a first-message box, then the main's messages and composer. |
| 17 | First Send starts a session | **Carried**: `Superagents.chat` starts `main.start` with MAIN.md, SOUL.md, the services' lines and the memory first. |
| 18 | Exact-target, idempotent sends | **Carried**: the first message by its send id; later ones by the composer's submission receipts, to the session shown. |
| 19 | Transcript read-through | **Different**: Chat draws the viewed session's own timeline (`AgentConversationEvents`). A teammate's read goes through the relay: messages and questions only, credentials redacted. |
| 20 | Guidance into a Vulcan writer from Chat | Vulcan: section F. |
| 21 | Changing provider or repository | **Different**: change the manifest and run `superagent add`; the current main keeps going. A rollover chooses again on `provider: "auto"`. |
| 22 | Agent composer | **Carried**: Nate's composer; a message ends a running turn first (#25, `interrupt`). |
| 23 | Shared Chat start and send | **Different**: a teammate guides the host's main through the relay (`superagent_guide`), pinned to the session they saw. |

### C. Feed and recommendations

| # | Item | Verdict |
|---|---|---|
| 24 | `agent recommend` | **Carried** in Vulcan: `agentbox superagent call <name> recommend`. |
| 25 | A Review note card that never pushes | **Carried** in Vulcan: `notify: false`. |
| 26 | Feed tab, and proposals inline in Chat | **Different**: Feed is the program's own page (Vulcan's Feed, Work and Grants tabs), and the daily sweeps. Chat shows no proposals. |
| 27 | Approve, decided once and delivered at most once | **Carried** in Vulcan. |
| 28 | Dismiss | **Carried** in Vulcan. |
| 29 | Give guidance | **Different**: an action answers `compose`, which puts the text in Chat's box. |
| 30 | Shared proposals | **Not carried**: a program keeps its own proposals. |

### D. Jupiter

| # | Item | Verdict |
|---|---|---|
| 31 | Jupiter instances | **Different**: one per directory. The migration script makes `jupiter-agentbox` and `jupiter-plaibook-dev` from Nate's two, each a copy that runs `superagents/jupiter`. |
| 32–36 | Jupiter only creates; `propose`; the creation form; accepting a draft; what a created agent inherits | **Carried**: `superagents/jupiter/` (its MAIN.md says `{{name}}`, so a copy calls itself). |
| 37 | Shared creator auto-binding | **Not carried**: an agent is a directory; a teammate copies it from git. |

### E. Custom agents

| # | Item | Verdict |
|---|---|---|
| 38 | Custom agents are first-class | **Carried**: any directory is a superagent. The migration script makes Nate's Terminus `terminus-plaibook-dev`. |
| 39 | Shared editor and "Clone for me" | **Different**: the git source in the registry is the template; copy the directory and add it. |

### F. Vulcan work family

`superagents/vulcan/`, on the public API. Its own list is
`superagents/vulcan/PARITY.md`.

| # | Item | Verdict |
|---|---|---|
| 40 | Work grant | **Different**: a person creates it on the Grants tab (`caller.via === "app"`). |
| 41 | `work-start` | **Different**: same checks; the issues are claimed with one agentbox claim (`POST /api/claims`), and the writer is attached to it once started. |
| 42 | Writer prompt | **Carried**: `lib/prompts.ts`, with `agentbox superagent call <its name> …`. |
| 43 | `work-retry-start` | **Different**: a lost start is proven by the session in the branch's worktree; the claim is attached once it is found. |
| 44 | Work history under the agent | **Carried**: the writer's parent is Vulcan's main, so the rail lists it under Vulcan. |
| 45–52, 54–56, 58 | Review, reviewers, collect, round cap, revisions, retry, publish, reconcile, waits, failure, milestone, `work` | **Carried** in Vulcan, as before. |
| 53 | `work-follow` | **Different**: "released" is read from the PR claim. |
| 57 | Pause, revoke and expiry | **Different**: enforced every 30 s; a stopped family releases its claims. |
| 59, 60 | Shared writers and the publication guard | **Different**: a shared instance's claims are in the cloud (one holder across hosts), and publication goes through the GitHub App broker in core. |

### G. CLI verbs `agentbox agent …`

| # | Item | Verdict |
|---|---|---|
| 61 | `agent status` | **Different**: `agentbox agent ls` (`agent` is the same verb as `superagent`). |
| 62, 63 | `sync`, `bind` | **Different**: `agentbox github pin <superagent> --key <pem>` pins a policy and its App key on this host. |
| 64 | `read` | **Different**: `agentbox github read <repo> <n> <kind>` through the pinned App. |
| 65, 66, 70, 72, 73 | `check`, `progress`, `intake`, `finish`, `experts` | **Not carried**: a program keeps its own progress and intake; expertise suggestions are gone. |
| 67 | `prepare/review/collect/retry-review` | **Different**: Vulcan's actions. |
| 68 | `action` | **Different**: `agentbox github request <file>` and `POST /api/github/actions`. |
| 69 | `agent recommend` | **Different**: `superagent call <name> recommend`. |
| 71 | `agent draft` | **Carried**: `superagent call jupiter propose`. |
| 74 | `rotate` | **Different**: `agentbox handover`, and a claim takeover that proves the stop. |
| 75 | Local work verbs | Vulcan: section F. |
| 76, 77 | Prompts address their own installation; session capability, not PID | **Carried**. |

### H. Templates

| # | Item | Verdict |
|---|---|---|
| 78 | Vulcan, Caelus and Salus definitions | **Carried**: `superagents/`. |
| 79 | Template cards | **Not carried**: the examples are in `docs/superagents.md`. |
| 80 | Local instances seeded automatically | **Different**: nothing is seeded. The migration script moved the instances that had something to keep. |
| 81 | Caelus release scope, Salus observability intake | **Not carried**: conversations, as locally. |

### I. Shared cloud tier

None of PR #4's 12 agent migrations ran on a hosted project. They are
replaced by one migration, `20261015120000_shared_superagents.sql`
([cloud.md](cloud.md), Shared superagents).

| # | Item | Verdict |
|---|---|---|
| 82, 83 | Definitions, editor, revision history | **Not carried**: an agent's code and manifest travel by git; the registry keeps a pointer to the source. |
| 84 | Maintainers and visibility | **Carried**: `superagent_instances`. |
| 85, 86 | Execution host grants; host-local binding | **Different**: the host is the installation that shared the instance (scope `superagents:host`); the App key path is given when its owner pins the broker policy. |
| 87, 88, 91, 94, 95, 97–99 | Work queue and intake, Run now, run start, progress, finish, intake sources, note commands, coordinator intake | **Not carried**: a program's own (loops and events give it time and triggers). |
| 89, 92, 108 | Claims, leases, fences; takeover and handoff; release environment claims | **Carried**: `src/core/workclaims.ts` and `superagent_claims`: one active holder per key, expiry leaves it uncertain and excluding, takeover only after a proven stop, handover with fence + 1, `env:` keys. |
| 90 | Host reconciler | **Different**: the host tick (`src/core/superagent/team.ts`). |
| 93 | Rotation | **Different**: handover and rollover. |
| 96 | Managed reads | **Carried**: `POST /api/github/read`. |
| 100, 101 | Chat relay; guidance queue | **Carried**: `superagent_reads` and `superagent_commands`, sealed with `src/cloud/relay.ts`. |
| 102–104 | GitHub App broker, managed actions, action lifecycle | **Carried** in core: `src/core/github/`, policy pinned by the host owner, tokens never leave it, prepare mode through a Review card a person answers. |
| 105 | Consent and outreach | **Carried**: `contact_preferences`, checked at request and again at dispatch; opt-out wins. |
| 106 | Shared sessions cannot message | **Different**: a session is quiet when its program starts it with `notify: false`. |
| 107 | Expertise suggestions | **Not carried**. |
| 109 | Activity events | **Different**: claim events only. |
| 110 | Migrations | **Different**: one new migration. |
| 111, 112 | Workspace scope in the URL; sign-in and revocation | **Carried**. |

### J. Projects

Nate's project tabs replace Ammon's logo switcher.

| # | Item | Verdict |
|---|---|---|
| 113 | The project button and its dialog | **Different**: project tabs with an "Add project tab" dialog (Ctrl+Tab, Shift+Tab, attention dots). |
| 114 | Phone project bar | **Different**: the tab bar, at every width. |
| 115–117, 119, 121, 123 | Scope in the URL; scoped Sessions; scoped Review; stale scope; per-project new session; navigation is not a grant | **Carried**. |
| 118 | Session to project | **Different**: a session of a superagent that shows in one project is in that project (`Session.agentProject`); otherwise its checkout says. |
| 120 | Per-project agent instances | **Different**: one directory each, under its own name (`vulcan-plaibook-dev`); a superagent shows in the projects its manifest names. |
| 122 | "Project · Agent" row titles | **Carried**: a superagent's session in the Sessions rail is titled with its project and its superagent. |

### K. Drafts

| # | Item | Verdict |
|---|---|---|
| 124, 125, 127 | Per-thread drafts; clearing never erases a newer one; pending sends | **Carried**. |
| 126, 128 | A draft carries its proposal; recover an agent-level draft | **Not carried**: no proposals or agent-level drafts in core. |

### L. Anything else

| # | Item | Verdict |
|---|---|---|
| 129 | Docs | **Different**: [agents.md](agents.md) (use), [superagents.md](superagents.md) (contract), [cloud.md](cloud.md) (team), docs/v2.md. |
| 130 | Acceptance scripts and tests | **Different**: the tests that guard a destructive or security rule moved with the code (memory, rollover, loops, sweep, claims, broker, relay, migration); the smoke scripts are gone. |
| 131 | Loopback trust; creating refuses session callers | **Carried**. |
| 132 | Credential scrubbing | **Carried** where text leaves: memory refuses credentials, the relay redacts them, reports refuse them. |
| 133 | Generic fixes | **Carried**: Part 2. |

## Part 2. Generic changes beside it

| # | Item | Verdict |
|---|---|---|
| 1–16, 18–20, 23, 26, 33 | Feedback waits, `until` probes, PR release casing, tmux `\|`, late discovery, `closed(…, include)`, inherited `AGENTBOX_*`, physical roots, `notify` on cards, `checkoutRoot`, ZodError 400 | **Carried**. |
| 17 | Read-only sessions | **Carried**, generic. |
| 21 | `paths.agentboxCommand()` | **Not carried**: `{{bin}}` and `AGENTBOX_BIN`. |
| 22 | `Scheduler.onTick` | **Carried**: claims renew their leases on it; the superagent services keep their own 15-second pass. |
| 24, 27–30 | `outboundRefusal`, the agents scope, Realtime, cloud test URL | **Different**: the new migration and `superagents:host`; Realtime carries the relay. |
| 31, 32 | Messages need the sender's capability | **Not carried**: worth doing on its own. |
| 34 | Cards without a session capability stop pushing | **Not carried**: a card is quiet only with `notify: false`. |
| 35, 41, 43–47, 50–52, 54–58, 60–62 | Project scope pieces | Section J. |
| 36 | No blocked pushes for agent sessions | **Different**: `notify: false` per session. |
| 37, 38 | The agents runtime and `agentbox agent` | **Different**: `Superagents` and its services; `agent` is `superagent`. |
| 39 | The guide's Shared Agents block | **Different**: the guide's superagents section, with memory, loops and reports. |
| 40, 42 | Agents route; phone history | **Carried**. |
| 48 | The shell polls `/api/agents/local` | **Different**: the board marks each superagent's sessions (`agentOwner`, `agentProject`); the Agents page polls `/api/superagents`. |
| 49, 53, 59 | Nav entry, phone nav order, `RailTabs` | **Carried**. |
| 63–67 | Clearing, recover draft, `AgentComposer`, `PendingSends`, `AgentConversationEvents` | **Carried**, except `recoverAgentDraft` (K128). |
| 68–73 | Agent docs, images, smoke scripts | **Different**: L129, L130. |
| 74–79 | Tests for the generic fixes; relay test | **Carried**. |

## Part 3. Agent process written into core

**Not carried**, all of it, by design: the agent names, ids and templates,
the prompts and transcript filters keyed on them, and the process constants
(review roles, round cap, PR titles, grant limits, evidence rules, intake
limits, provider lists, stages). Each is a superagent's: names, titles and
instructions in its directory, its process in its program. What remains in
core is generic: read-only sessions, handover, quiet cards, the program
supervisor, the page and action relay, the services of Part 4, claims, the
GitHub broker and the team registry. The migration script names no agent
either: the old names are given as its flags.

## Part 4. Local main after the merge base

What Nate's local main added after 498aee8, and where each is now.

| Item | Verdict |
|---|---|
| #19 Sent, Read and typing in Chat | **Carried**: worked out from the viewed session's events and status. |
| #21 Drag rows into your own order | **Carried**: the Sessions rail and the Agents rail (`lib/manualorder.ts`, `lib/agentorder.ts`). |
| #22 `/help` attaches the images you tick | **Carried**: `/help` in an agent's Chat (`POST /api/superagents/:name/help`, `src/core/superagent/feedback.ts`). |
| #24 SOUL.md and a read-only MEMORY.md | **Different**: SOUL.md is in the agent's directory, the person's config; agentbox never creates or writes it (it used to seed one). It is read after MAIN.md with the same limits. MEMORY.md is in the agent's home, rebuilt after each write, with the same set-aside rule. Turned on by `"memory": true`. |
| #25 A person's Chat message ends a running turn | **Carried**: the Agents composer sends `interrupt: true` (`POST /api/sessions/:id/submissions`). |
| #26 Each agent hears which other agents are active in its project | **Carried**: the first prompt of a fresh main lists the other enabled superagents of its projects and their mains (`opening.ts`). |
| #27, #31 Paused agents last; open the first active agent | **Carried**: disabled superagents last in the rail; the page opens the first active one. |
| #28 New session in the Sessions sidebar | **Carried**. |
| #29 Shift+Tab to the next project tab | **Carried**. |
| #33 Footer plans; session facts under the box | **Carried**: also under the Agents composer. |
| #34 Automatic agents follow Codex's weekly left | **Different**: generic. `provider: "auto"` on any `POST /api/sessions` and in a manifest's `main.start` (`src/core/providers/auto.ts`); the rule is the same. |
| #35 Chat, Feed and Settings header | **Carried**; Feed is the program's page and the sweeps. |
| #36 → leaves the rail on Agents | **Carried**. |
| #37, #38 | No commit on local main carries these numbers. |
| #39 The daily sweep at 23:00 | **Different**: per superagent, from `"sweep": "HH:MM"` or `true` (the time in Settings); off when the manifest does not say. The keep rules are the same. |
| #40 An agent's question in its Chat | **Carried**: the question card at the end of Chat answers it in the session's terminal. A teammate sees the question as text and cannot answer the host's dialog. |
| Memory journal, handoffs, preferences of 1,500 characters | **Carried**: in each superagent's home, with an API its main, its program and a person use (`/api/superagents/:name/memory`, `agentbox superagent memory`, the SDK's `note`/`prefer`). |
| Conversation rollover | **Carried**: `main.rollover`, the same rule and proofs (`rollover.ts`); the main is handed to the fresh session with the generic handover. |
| Loops (`agentbox agent loop`) | **Carried**: `main.loops` in the manifest, or `agentbox superagent loop <name> set <id>`; the old `agent loop <name> --when …` form still parses. |
| `agentbox agent ls` and `agent send` | **Carried**: `agent` is `superagent`; `send` records the sender and starts a main when there is none; `--project` picks the copy for that project. |
| `agentbox agent report` | **Carried**: `agentbox report` (and `agent report`) from a superagent's session, at most three a day. |
| `pr ready` hands a verified PR to the project's Terminus | **Different**: the generic `pr.ready` event goes to each superagent with `"events": ["pr.ready"]` that shows in the PR's project. The migration script gives Terminus that event (`--events terminus=pr.ready`). |
| A session's waits move to the session that takes over | **Carried**: `Fleet.handOver`, with work claims too. |
| Sender attribution of agent messages | **Carried**: the sender is the superagent the sending session belongs to, by durable records. |
| Picture of an agent | **Carried**: Settings → Picture (`/api/superagents/:name/avatar`); the old pictures stay where they were. |
| Per-project agent instances | **Different**: one directory per instance (Part 1, J120). |
| Shared agents (local and hosted twins, expertise) | **Different**: team instances (section I); expertise is not carried. |
| Desktop app, cleanup pause, dictation, dev server switch, launchd service, `integrate`, serve from a commit, profile page, Update button | **Carried**: untouched by agents. |
