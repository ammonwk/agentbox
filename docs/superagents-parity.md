# Superagents: parity with PR #4

PR #4 (branch `feat/agents-shared-d954iv5k`) built Agents into agentbox's
core: Jupiter, Vulcan, Caelus and Salus as local agents, a Feed of
recommendations, a guarded work family, a shared cloud tier and a project
switcher. Superagents (`docs/superagents.md`) replace it: the agents are
programs and instructions in `superagents/`, and core gained only generic
pieces. This list maps each item of that PR to where it is now, so nothing
is lost by accident.

Item numbers are the PR's inventory: Part 1 is what a person sees, Part 2
the generic changes beside it, Part 3 the agent process written into core.
A verdict is one of:

- **Carried**: it does what it did; the cell says where.
- **Different**: it works another way, on purpose; the cell says why, and
  how to make it the same (usually a few lines in a superagent's own program
  or manifest, not in core).
- **Not carried**: it is gone; the cell says why.

## Part 1. What a person sees

### A. Agents page and navigation

| # | Item | Verdict |
|---|---|---|
| 1 | Agents first in the nav, page loaded lazily | **Carried**: `web/src/App.tsx` (Agents first, `Icon.brain`, lazy `Agents`). |
| 2 | Agent routes | **Different**: `#/agents[/<name>[/<tab>]]` (`route.ts`), where a tab is Chat, one of the program's page tabs, Sessions or About. There are no thread routes: a superagent's sessions open on the Sessions page. |
| 3 | Landing selection | **Different**: a computer opens the last agent looked at (`localStorage agentbox.agent`), else the first; a phone shows the list. The PR's other fallbacks (the agent with a session, Jupiter, "vulcan") named agents in core. |
| 4 | Local vs shared mode | **Not carried**: there is no shared tier (section I). |
| 5 | Session browser rail (picker, Main chat row, Active/Inactive threads) | **Different**: a searchable list of agents with status dots, and per agent a Sessions tab listing its main conversations and every session under them, newest activity first (`Agents.tsx` `SessionsList`). Active/Inactive lives on the Sessions page, where those sessions open. |
| 6 | Agent picker modal | **Different**: the list beside the pane is always open and searches name, title and description. "Create agent…" is Jupiter in that list. |
| 7 | Thread activity (3 hours, sort, capped titles) | **Different**: the Sessions tab sorts by last activity and uses the session's own title (`titleOf`); there is no 3-hour split, since the Sessions page has one. |
| 8 | Read-only predecessors | **Different**: earlier main conversations are listed above the chat and on the Sessions tab, tagged "earlier main", and open on the Sessions page as ordinary sessions. A handover moves what they held to the new main (`POST /api/sessions/:id/handover`). Same: add a read-only state to `Detail` for sessions with a successor. |
| 9 | Agent header (status, tabs, Feed count, back link) | **Different**: title, description, a process pill (Running, Restarting, Stopped, Disabled, Manifest error), tabs Chat, the program's tabs with their badges, Sessions and About, and a back link on a phone. Busy or blocked shows as the list's status dot. |
| 10 | Navigation never starts or stops anything | **Carried**: only a sent message starts a main conversation (`superagents.chat`). Opening a page asks the program for its view; what a program does then is its own code. |
| 11 | Phone navigation, one pane at a time | **Carried**: `agents.css` at 900px and `Agents.tsx` `showList`/`showPane`, with a back link to the list. |
| 12 | Foreign and mismatched deep links | **Different**: an unknown name shows "No such agent" with a link to all agents. The project and workspace cases belonged to per-project and shared instances. |
| 13 | Shared directory (`#/agents/manage`) | **Not carried**: shared tier. |
| 14 | Shared agent About | **Not carried**: shared tier. |
| 15 | Local agent About (instructions, provider, repo, enabled) | **Different**: About shows name, directory, main conversation, program state and its output, with Restart and Enable/Disable. Provider, repository and instructions are in the directory (`superagent.json`, `MAIN.md`); change them there and run `agentbox superagent add <dir>`. |

### B. Main chat

| # | Item | Verdict |
|---|---|---|
| 16 | Main chat before and after the first message | **Carried**: Chat shows a first-message box until there is a main conversation, then that session's timeline and composer (`Agents.tsx` `Chat`, `StartChat`). |
| 17 | First Send starts a session | **Carried**: `superagents.chat` starts `main.start` (any `POST /api/sessions` body: provider, model, `repoId` and worktree) with the instructions, `---`, then the message. It runs in the agent's directory unless `cwd` says otherwise, not in a private 0700 workspace. |
| 18 | Exact-target, idempotent sends | **Carried**: the first message is idempotent by its send id (`main_send`; the box keeps the id across a reload); later messages go through the Sessions composer and `submitWithReceipt`. The chat follows the current main (`Fleet.heir`), so a send never reaches a replaced one. |
| 19 | Transcript read-through (paged, redacted, prompt stripped) | **Different**: the chat is the Sessions page's own view (`Detail`: Timeline, Terminal, Diff, Load) of a session that is the person's own. Nothing is redacted or stripped, and the first message shows the instructions it was given. |
| 20 | Guidance into a Vulcan writer from Chat | Vulcan: section F. |
| 21 | Changing a local agent's provider or repository | **Different**: edit the manifest and run `superagent add`; the current main keeps going. `agentbox superagent main <name> none` makes the next message start a fresh main from the new manifest, and the old one is listed as earlier. There is no proof-of-stop or transcript check, and the new prompt does not point at the old session; a superagent with a program can do both (`handover`, its own prompt). |
| 22 | Agent composer (Enter, drafts, pending sends) | **Carried**: the main chat uses the Sessions composer itself: Enter sends, Shift+Enter is a newline, drafts and pending sends are the Sessions ones. |
| 23 | Shared Chat start and send | **Not carried**: shared tier. |

### C. Feed and recommendations

Vulcan carries the Feed (`superagents/vulcan/lib/feed.ts`); any other
program can do the same with its own actions.

| # | Item | Verdict |
|---|---|---|
| 24 | `agent recommend` (current session only, idempotent) | **Carried** in Vulcan: `agentbox superagent call vulcan recommend --json f` from its main or a writer that may still write; immutable and idempotent by `request`, a changed body is 409. The caller arrives proven (`caller.session`). |
| 25 | A Review note card that never pushes | **Carried** in Vulcan: `POST /api/cards {kind: note, key: vulcan-proposal:<id>, notify: false}`, closed on dismiss or delivery. |
| 26 | Feed tab, and proposals inline in Chat | **Different**: Vulcan's Feed tab, with its badge counting open proposals. The chat is agentbox's own session timeline, which a program does not draw into; on a screen 1280px wide or more the page's first tab sits beside it. |
| 27 | Approve, decided once and delivered at most once | **Carried** in Vulcan: a person's action; the decision and a delivery receipt id are written before the send (`POST /api/sessions/:id/send {sendId}`), and a delivery left queued by a restart is reconciled from its submission, never sent twice. Tested. |
| 28 | Dismiss | **Carried** in Vulcan: records, closes the card, starts nothing. |
| 29 | Give guidance | **Different**: the action answers `compose`, which puts "Regarding …" in the chat's box. The PR's prefix and jump to the writer's thread were its own chat transport. |
| 30 | Shared proposals | **Not carried**: shared tier. |

### D. Jupiter

| # | Item | Verdict |
|---|---|---|
| 31 | Jupiter instances (general and per project) | **Different**: one Jupiter, `superagents/jupiter/`. Per project: register a copy under another name with `repoId` in its `main.start`. |
| 32 | Jupiter only creates | **Carried**: its instructions (`MAIN.md`) and its program, whose only actions are propose, save, create and discard. |
| 33 | `agent draft` (current session only, idempotent) | **Carried**: `agentbox superagent call jupiter propose --json f`, refused unless the caller is Jupiter's current main; idempotent by `request`, which revises a draft nobody has edited and is refused (409) once one is edited. Six providers, not three, plus model, repository and a program's `dir`. |
| 34 | Inline creation card | **Carried**: a form on Jupiter's Drafts tab, beside the chat on a wide screen: Name, Title, Purpose, Instructions, Provider, Model, Repository, Limits, Requested automation, with "… · You stay accountable · Manual activation". Create saves edits first, then says "<title> created. It is ready for a conversation; nothing was started." and opens it. |
| 35 | Accepting a draft | **Carried**: create is idempotent per draft, edits need the revision they were made on, a draft from an earlier conversation is read-only, only a person on the page saves or creates (`via: app` and no session), and a repository must be registered. |
| 36 | What a created agent inherits | **Carried**: a directory with `superagent.json` and `MAIN.md` (instructions, then `Limits:`), enabled, manual activation, no process, the automation recorded as `requestedAutomation` and not set up, the repository as `repoId` with a worktree. |
| 37 | Shared creator auto-binding | **Not carried**: shared tier. |

### E. Custom agents

| # | Item | Verdict |
|---|---|---|
| 38 | Custom agents are first-class | **Carried**: what Jupiter makes is a superagent like any other, in the list, with its chat, Sessions and About. |
| 39 | Shared editor and "Clone for me" | **Not carried**: shared tier. A local copy is a copied directory with a new name, added with `superagent add`. |

### F. Vulcan work family

`superagents/vulcan/`, on the public API with nothing in `src/` of its own.
Its own list, with each item's detail, is `superagents/vulcan/PARITY.md`;
what it needed from core is `superagents/vulcan/CORE-NEEDS.md`.

| # | Item | Verdict |
|---|---|---|
| 40 | Work grant | **Different**: a person creates it on the Grants tab (`caller.via === "app"`); immutable id, revoke keeps the row and enforces at once. The operator token is gone (the page's `via` is the proof), and so is `worktreeRoot` (agentbox cuts the worktree). |
| 41 | `work-start` | **Different**: same checks (requester only, repo identity, canonical open issues, base pinned, per-issue claims in one agentbox claim (`POST /api/claims`), idempotent by id); the writer is started with `POST /api/sessions {repoId, branch, parent, notify: false}`, so its worktree is agentbox's own. |
| 42 | Writer prompt | **Carried**: `lib/prompts.ts`, with `agentbox superagent call vulcan …` for each verb. |
| 43 | `work-retry-start` | **Different**: a lost start is proven by the session in the branch's worktree under Vulcan's main, not by a reserved id (`POST /api/sessions` takes none). |
| 44 | Work history under the agent | **Different**: the writer's `parent` is Vulcan's main and each reviewer's is the writer, so the board nests them; the Work tab lists them. No "Project · Agent" row titles (see 122). |
| 45 | `work-review` | **Carried**, writer only: clean tree, exact head, current remote base, merge-base is the base. |
| 46 | Three read-only reviewers | **Carried**: architecture, correctness, deslop; Codex `readOnly: true`, `notify: false`, each in a detached worktree at the exact head; a session wait for the writer per reviewer. |
| 47 | `work-collect` | **Carried**: verdicts read only from each reviewer's own timeline, contract-checked, immutable once complete. Tested. |
| 48 | Three-round cap | **Carried**: no fourth round; an unclean third sets `quality_failed`. Tested. |
| 48a | `producer-to-assertion-v1` | **Different**: a file in `revisions/`, named in the manifest and pinned per family, not a constant. |
| 49 | `work-retry-review` | **Carried**: a reviewer that never started is stopped, proven stopped and replaced; one with a transcript is nudged once; verdicts never replaced. |
| 50 | `work-publish` | **Carried**: title, closing keywords and mentions refused, actor checked twice, reviewed head and base checked before and after the push, no force, idempotent. Tested. |
| 51 | Stages and `work-reconcile` | **Carried**: push, branch, request, each attempting/prepared/sent/uncertain; reconcile replays nothing. Tested. |
| 52 | Follow-up waits at publish | **Carried**: the PR claimed for the writer, the full-check wait reused when one matches, and the feedback wait (`{kind: pr, head, feedback: true}`). |
| 53 | `work-follow` | **Different**: PR releases are not readable over the API, so "released" is read as "claimed for the writer by Vulcan and not held by it now", which also covers a hold lost to a stop. |
| 54 | Feedback wait semantics | **Carried** in core (Part 2, 1–7). |
| 55 | `work-milestone` | **Carried**: a message to the requester under the send guard. |
| 56 | `work-failure` | **Carried**: feedback verified on GitHub, evidence immutable, a quiet decision card, the improvement issue deduplicated and scrubbed. |
| 57 | Pause, revoke and expiry | **Different**: enforced every 30s and on revoke by stopping the family's sessions. "Vulcan disabled" is agentbox stopping its program. |
| 58 | `agentbox agent work [id]` | **Carried**: `agentbox superagent call vulcan work` (or `work-get --set id=…`) and the Work tab. |
| 59, 60 | Shared writers and publication guard | **Not carried**: shared tier. |

### G. CLI verbs `agentbox agent …`

| # | Item | Verdict |
|---|---|---|
| 61 | `agent status` | **Different**: `agentbox superagent ls` (program state, main, directory) and `superagent log`. |
| 62–68, 70, 72–74 | `sync`, `bind`, `read`, `check`, `progress`, `prepare/review/collect/retry-review`, `action`, `intake`, `experts`, `finish`, `rotate` | **Not carried**: shared tier. |
| 69 | `agent recommend` | **Different**: `superagent call <name> <action>`, as 24. |
| 71 | `agent draft` | **Carried**: `superagent call jupiter propose`, as 33. |
| 75 | Local work verbs | Vulcan: section F. |
| 76 | Prompts address their own installation | **Carried**: a session's environment carries `AGENTBOX_HOME`, `AGENTBOX_PORT` and `AGENTBOX_TMUX_SOCKET` when set (`sessionEnv`), so a plain `agentbox` reaches the server that started it; instructions get `{{bin}}`, programs `AGENTBOX_BIN`. |
| 77 | Session capability, not PID | **Carried**: actions get `caller.session` from `authenticatedSession`; the CLI sends the session's headers. |

### H. Templates

| # | Item | Verdict |
|---|---|---|
| 78 | Vulcan, Caelus and Salus definitions | **Carried**: `superagents/caelus/` and `superagents/salus/` (manifest and instructions), and Vulcan (section F). |
| 79 | Template cards | **Not carried**: they were in the shared directory. The examples are listed in `docs/superagents.md` and in the empty Agents list. |
| 80 | Local instances seeded automatically | **Different**: nothing is seeded; `agentbox superagent add <checkout>/superagents/<name>` adds one. No agent is on a machine that did not ask for it. |
| 81 | Caelus release scope, Salus observability intake | **Not carried**: shared tier. Locally they were conversations, as they are now. |

### I. Shared cloud tier

Never operational: none of its 12 migrations was applied to a hosted
project, no GitHub App was registered, and identity linking and Realtime
were not enabled. It stays on `feat/agents-shared-d954iv5k` for reference.
**Not carried**: 82 definitions and editor, 83 revision history, 84
maintainers and visibility, 85 execution host grants, 86 host-local binding,
87 work queue and intake, 88 Run now, 89 claims, leases and fences, 90 host
reconciler, 91 shared run start, 92 takeover and handoff, 93 rotation, 94
progress, 95 finish, 96 managed reads, 97 intake sources and schedules, 98
note-command intake, 99 coordinator intake, 100 Chat relay, 101 guidance
queue, 102 GitHub App broker, 103 managed actions, 104 action lifecycle,
105 consent and outreach, 106 shared sessions cannot message or push (local
side below), 107 expertise suggestions, 108 release environment claims, 109
activity events, 110 migrations, 111 workspace scope in the URL, 112 sign-in
and revocation.

| # | Item | Verdict |
|---|---|---|
| 106 (local) | Agent sessions cannot message, their cards and blocked pushes are quiet | **Different**: a superagent's sessions are ordinary sessions and may message. Its program makes a session quiet with `notify: false` on `POST /api/sessions` (Vulcan's writer and reviewers are), and a card with `notify: false` on `POST /api/cards`. |

### J. Project switcher

Ported without agents: `src/core/projects.ts`, `web/src/ProjectSwitcher.tsx`,
`web/src/lib/projects.tsx`, `route.ts`.

| # | Item | Verdict |
|---|---|---|
| 113 | The logo is a project button, with the Switch project dialog | **Carried**: search, All projects, keyboard, Manage projects. |
| 114 | Phone project bar | **Different**: on a phone only (900px and under); the PR drew it at every width, a second logo above every desktop page. |
| 115 | Scope in the URL, restored, kept per tab | **Carried**: `?project=`/`&workspace=`, `agentbox.navigationScope`, `followLinks` on every width. |
| 116 | Scoped Sessions list | **Carried**: rail, bookmarks, search per project, closed list filtered on the server (`/api/sessions/closed?project=`), reopen-last scoped; close warnings still count work outside it. |
| 117 | Scoped Review and badges | **Carried**. |
| 118 | Session to project | **Different**: the longest `checkoutRoot` wins, as in the PR; `sessionProject` takes optional explicit bindings, which nothing passes now that agents are not in core. |
| 119 | Mismatched and stale scope | **Carried**: "Open in its project", auto-scope, "no longer registered". Adding or removing a repo now updates the board at once, not after the next GitHub refresh. |
| 120 | Per-project agent instances | **Different**: a superagent is one per machine. One per repo is a copy of its directory under another name, or a program that keys its own state by repo. |
| 121 | New-session dialog per project | **Carried**: `agentbox.newSession.project.<id>`. |
| 122 | "Project · Agent" row titles | **Not carried**: they existed to hide agents' private directories; a superagent's sessions run where it puts them. |
| 123 | Navigation is not an access grant | **Carried**: switching starts, stops and rebinds nothing (checked on a test server). |

The Team page keeps its saved workspace as a fallback (the PR dropped it)
and puts the workspace it resolved into the URL without a history entry.

### K. Drafts

| # | Item | Verdict |
|---|---|---|
| 124 | Per-thread drafts that survive navigation | **Carried**: the main chat's draft is its session's, in the Sessions store; the first-message draft is `superagent:<name>`. |
| 125 | Clearing never erases another tab's newer draft | **Carried**, and now for every Sessions composer too (`saveDraft(…, previousRevision)`). |
| 126 | A draft carries its proposal and run | **Not carried**: `compose` appends text only. A program that needs the pin puts the proposal's id in the text and checks it in the action it is sent to. |
| 127 | Pending sends reuse the Sessions model | **Carried**: it is the Sessions composer; `PendingSends` takes an injected `reconcileSend` and an optional restore. |
| 128 | "Recover earlier agent draft here" | **Not carried**: there are no agent-level drafts to recover. |

### L. Anything else

| # | Item | Verdict |
|---|---|---|
| 129 | Docs | **Different**: `docs/superagents.md` (the contract), the Superagents section of `docs/v2.md`, and the CLI guide's superagents section. |
| 130 | Acceptance scripts and agent tests | **Not carried**: they tested core code that is gone. An example's tests are its own (`bun test` in its directory). |
| 131 | Loopback trust; creating refuses session callers | **Carried**: the local API trusts loopback as before; Jupiter's save and create refuse a caller with a session. |
| 132 | Credential scrubbing | **Not carried**: transcripts are shown as on the Sessions page, and there are no shared artifacts. A program that publishes scrubs what it publishes. |
| 133 | Generic fixes found on the way | **Carried**: Part 2. |

## Part 2. Generic changes beside it

| # | Item | Verdict |
|---|---|---|
| 1–7, 10 | `wait pr --feedback --head`, `readPrFeedback`, stable check identity, partial reads past 100 checks, a cursor that survives rearm and restart, ending and cursor in one write, a throwing look counted as failed | **Carried**: `waits.ts`, `waitreads.ts`, `cli/waits.ts`; tested in `pr-release.test.ts`. The ending no longer mentions a "round cap". |
| 8, 9 | `until` probes in their own process group without GNU `timeout`, output bounded, a command's own 124/137 kept | **Carried**: `waitreads.ts`; `waitreads.test.ts`, `waits.test.ts`. |
| 11 | Guide and docs for `--feedback` | **Carried**: `cli-guide.ts`, `docs/cli.md`, `docs/v2.md`. |
| 12 | PR releases matched whatever the repo's casing | **Carried**: `prclaims.ts`; `pr-transfer.test.ts`. |
| 13 | PR-transfer paragraph | **Carried**: `docs/v2.md`. |
| 14 | tmux panes listed with `\|` | **Carried**: `tmux.ts`. |
| 15, 16 | Late pane discovery, with the discovered record kept as a closed alias | **Carried**: `fleet.ts`, `db.attachDiscoveredSpawn`; `succession.test.ts`. |
| 17 | Read-only sessions | **Carried**, made generic: `ProviderAdapter.readOnly` (Codex has it), `POST /api/sessions {readOnly}`, a provider without it refused with 400, the launch saved so a resume stays read-only. |
| 18 | `Fleet.closed(…, include)` | **Carried**. |
| 19 | Sessions inherit `AGENTBOX_HOME`, `PORT`, `TMUX_SOCKET` | **Carried**: `sessionEnv`. |
| 20 | Physical repo roots | **Carried**: `repoRootOf`. |
| 21 | `paths.agentboxCommand()` | **Not carried**: 19 makes the plain command right, and `{{bin}}`/`AGENTBOX_BIN` name it. |
| 22 | `Scheduler.onTick` | **Not carried**: a program keeps its own time (`every` in the SDK). |
| 23 | `NewCard.notify` | **Carried**: `cards.ts`, `POST /api/cards {notify}`. |
| 24 | `CloudBridge.outboundRefusal` | **Not carried**: it gated the shared tier's outreach. |
| 25 | `core/projects.ts` | Project switcher: section J. |
| 26 | `Repo.checkoutRoot` | **Carried**: `coldState`. |
| 27–30 | Cloud client, `agents:execute` scope, Realtime, cloud test URL | **Not carried**: shared tier. |
| 31 | Cloud messages need the sender's capability | **Not carried**: the hardening came with the agent contact gate. Worth doing on its own. |
| 32 | Agent sends need the sender's capability | **Not carried**: as 31. |
| 33 | `ZodError` answers 400 | **Carried**: `mapError`. |
| 34 | Cards without a session capability stop pushing | **Not carried**, on purpose: it silenced cards from the web UI and from people. A card is quiet only when it says `notify: false`. |
| 35 | Closed sessions filtered by project | Project switcher: section J. |
| 36 | No blocked pushes for agent sessions | **Different**: a per-session `notify: false`, which any program can set; see 106. |
| 37, 38 | Agents runtime wired into the server; `agentbox agent` | **Not carried**: superagents are wired generically (`Superagents`, `/api/superagents`, `agentbox superagent`). |
| 39 | The "Shared Agents" block in the CLI guide | **Not carried**: the guide has a superagents section that names no agent and no agent's process. |
| 40 | Agents route | **Different**: `{page: "agents", name, tab}`. |
| 41, 43–47, 50–52, 54–58, 60, 61 | Project switcher | Section J. |
| 42 | Phone history for agent views | **Different**: the pane's back link returns to the list. |
| 48 | The app shell polls `/api/agents/local` every 10s | **Not carried**: only the open Agents page polls `/api/superagents`. |
| 49 | Agents nav entry | **Carried**: as A1. |
| 53 | Phone nav ordered by `data-nav-id`, scrolling | **Carried**: `styles.css`. |
| 59 | `RailTabs` extracted | **Carried**: `Rail.tsx`. |
| 62 | `repoOfSession`: the longest registered checkout | **Carried**: `lib/newsession.ts`. |
| 63 | Clearing deletes only our own revision | **Carried**, for the Sessions composer too; the agent context is not (K126). |
| 64 | `recoverAgentDraft` | **Not carried**: K128. |
| 65 | `AgentComposer` | **Not carried**: the main chat uses the Sessions composer. |
| 66 | `PendingSends` optional restore, injectable reconcile | **Carried**: `submissions.tsx`. |
| 67 | `AgentConversationEvents` | **Not carried**: the main chat uses the Sessions view. |
| 68–70 | Agent sections of `docs/v2.md`, `docs/cloud.md`, `docs/cli.md` | **Not carried**: replaced by the superagents docs (L129). |
| 71–73 | Agent images; project and agent browser smoke scripts | **Not carried** for agents; the project switcher's are in section J. |
| 74–78 | Tests for the generic fixes | **Carried**: `waitreads.test.ts`, `waits.test.ts`, `pr-release.test.ts`, `pr-transfer.test.ts`, `succession.test.ts`. |
| 79 | Relay test | **Not carried**: shared tier. |

## Part 3. Agent process written into core

**Not carried**, all of it, by design. Core names no agent and holds no
agent's process: the agent names, ids and templates (1–7), the prompts and
the transcript filters keyed on them (8–17), and the process constants:
review roles, the round cap, PR titles, work-family naming, grant limits,
dedupe markers, evidence rules, leases and timings, page sizes, intake
limits, credential patterns, action defaults, provider lists, stages,
storage paths and the core wiring (18–33). Each is now a superagent's:

- names, titles and instructions are in `superagents/<name>/superagent.json`
  and `MAIN.md`, and a person can change them without a release;
- Jupiter's policy is its own `MAIN.md` and `main.ts`; its providers are all six;
- Vulcan's process and constants are in its own program (section F);
- what remains in core is generic: read-only sessions (any provider that can
  be held to it), handover, quiet cards, the program supervisor, and the
  page and action relay.

## Counts

Over the 131 rows above that have a verdict (five more only point to
sections F and J):

| Verdict | Rows |
|---|---|
| Carried | 67 |
| Different | 32 |
| Not carried | 32 |

A row can cover several items (Part 2, 1–7). Besides these, section I's 31
shared-tier items and Part 3's 33 items are all not carried, by design.
Nothing marked different or not carried is something main had: each is a
behaviour of PR #4, which never merged.

## The ten most likely to be missed

1. **One writer per issue, atomically.** Vulcan: section F.
2. **The three-round cap is cumulative per family.** Vulcan: section F.
3. **Publication in separate stages.** Vulcan: section F.
4. **Feedback waits with a durable cursor.** Carried in core (Part 2,
   1–7): `agentbox wait pr <n> --feedback --head <sha>`. How Vulcan uses it
   is section F.
5. **Approval decided once, delivered at most once.** A program's own
   duty: its store holds the key before the side effect (`docs/superagents.md`).
   Jupiter does this for proposals (by request) and creation (by draft); its
   save and create check the revision. Drafts do not carry a proposal (K126).
6. **Changing provider or repo needs proof.** Different (B21): the manifest
   changes and the next main starts fresh only when told to
   (`superagent main <name> none`); no proof-of-stop. A program can require it
   before it hands over.
7. **Quiet sessions.** Decided: a card is quiet only when it says so, so
   cards from people and the web UI still push (Part 2, 34); a superagent's
   sessions may message like any session, and push when blocked unless their
   program started them with `notify: false` (I106).
8. **Scope in the URL; navigation never starts anything.** Navigation:
   carried (A10). Scope: section J.
9. **Jupiter's authority comes from the session, not the name.** Carried
   (D33–D36): propose needs Jupiter's current main as the proven caller,
   create needs a person on the page, an earlier conversation's draft is
   read-only, create is idempotent per draft. A superagent named Jupiter that
   is not this program gets nothing from the name.
10. **The generic fixes that ride along.** Carried (Part 2): tmux `|`, late
    discovery with an alias, case-insensitive PR releases, portable `until`
    probes, physical repo roots, inherited `AGENTBOX_*`, `ZodError` as 400.
