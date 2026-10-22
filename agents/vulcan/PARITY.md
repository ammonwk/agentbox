# Parity with PR #4's Vulcan

One line per item of the PR #4 inventory (`pr4-inventory.md`, Part 1 sections C
and F, and Part 3) that Vulcan carried in core: how this agent carries
it, or why it deliberately differs. "Carried" means the same guarantee holds
through the public API; "differs" says what changed and why.

## C. Feed and recommendations

| # | Item | Status | How |
|---|---|---|---|
| 24 | `recommend` | carried, differs | `agentbox agent call vulcan recommend --json {request, title, finding, reason, next, evidence}` (`lib/feed.ts` `recommend`). Callable by Vulcan's main conversation or a family's writer while it may write; immutable and idempotent by `request`; a changed body is a 409. There is no `action` field: the local path never took one. |
| 25 | Proposal Review card | carried | `POST /api/cards {kind: note, key: vulcan-proposal:<id>, notify: false, recommend: next}` from the proposing session; closed with "Dismissed in Feed" or "Approved in Feed and delivered". |
| 26 | Feed tab | carried, differs | `lib/view.ts` `feed`: newest first, finding, reason, next, evidence links, delivery state, the recommending session. Inline "open proposals in Chat" is not drawn: the page's chat is agentbox's own session timeline, which an agent does not draw into; the Feed tab's badge counts them instead. |
| 27 | Approve | carried | `approve`: a person's action (refused with a session caller); the decision and a fresh delivery receipt id are written in one transaction before the send; delivered with `POST /api/sessions/:run/send {sendId}`, agentbox's own at-most-once receipt; sent/refused/uncertain recorded; a delivery still `queued` after a restart is reconciled from `GET …/submissions/:sendId` and never sent again; refused for a run that may no longer write. Tested in `tests/feed.test.ts`. |
| 28 | Dismiss | carried | `dismiss`: records, closes the card, starts nothing. |
| 29 | Give guidance | carried, differs | `guide` answers `{compose: 'Regarding "<title>" (<id>): '}` and says which session to say it to. The `[Guidance on recommendation …]` prefix and the jump to the writer's thread were parts of the PR's own chat transport, which the agent contract replaces with the page's composer. |
| 30 | Shared proposals | not carried | the shared cloud tier was never operational. |

## F. Vulcan work family

| # | Item | Status | How |
|---|---|---|---|
| 40 | Work grant | carried, differs | Created by a person on the Grants tab (`grant-create`, refused unless `caller.via === "app"`); fields project (a registered repo), human {name, github}, actor (= `gh api user` now), requiredChecks, improvementRepo, expiry ≤ 7 days, requester (Vulcan's main by default). Immutable id (a reused id is 409 even after revoke). Revoke (`grant-revoke`) keeps the row with `revokedAt` and runs enforcement at once. The operator token is gone: the page's `via` is the person's proof. `worktreeRoot` is gone: agentbox cuts the worktree. |
| 41 | `work-start` | carried, differs | `startWork` (`lib/work.ts`): caller must be the grant's requester; input validated; repo identity checked against the checkout's origin; canonical, distinct, open, real issues via `gh api`; base pinned by fetching `refs/heads/<base>` to `refs/agentbox/work/<id>/base`; config hash over name, provider, prompt revision text and repo; per-issue claims in one transaction ("extend that family"); idempotent by id. The branch `agentbox/work-<id>` is created at the base in the checkout and the writer is started with `POST /api/sessions {repoId, branch, parent: main, prompt}`, so agentbox cuts and sets up the worktree (`setUpWorktree`) and owns it; the worktree path is therefore agentbox's (`worktrees/<session>`), not `agent-work-<id>`. |
| 42 | Writer prompt | carried | `lib/prompts.ts` `writerPrompt`: the PR's text with each `agentbox agent work-…` replaced by `agentbox agent call vulcan <action>`, pointed at this agentbox (`env AGENTBOX_HOME=… AGENTBOX_PORT=…` when not the default). "Work only in <cwd>" became "the worktree agentbox started you in": the cwd is known only after the start. |
| 43 | `work-retry-start` | carried, differs | `retryStart`: for `starting`/`uncertain`; the recorded launch is proven by the session agentbox has in the branch's worktree under Vulcan's main (with a provider transcript) and adopted, else the writer is started; a branch not at the base or a dirty worktree refuses; a proven session is never asked for again. Proof is by worktree and parent rather than a pre-reserved session id, which `POST /api/sessions` does not take. |
| 44 | Work history under the agent | carried, differs | The writer is started with `parent` = Vulcan's main, reviewers with `parent` = the writer, so the board shows the family under Vulcan; the Work tab lists each family's sessions. "<Project> · <Agent>" row titles were the PR's own Sessions-page change and are not an agent's to make. |
| 45 | `work-review` | carried, differs | `review` (`lib/reviews.ts`): writer only (the task narrowed it from writer-or-requester); clean tree, exact head, current remote base via `gh api …/git/ref`, fetch of the base ref, `merge-base` must be the base. |
| 46 | Three read-only reviewers | carried | `startRound`: architecture, correctness, deslop, each `POST /api/sessions {provider: codex, readOnly: true, cwd}` in a detached worktree `vulcan-review-<id>-<round>-<focus>` beside the writer's at the exact head, with the focus prompt and JSON contract; one `{kind: session, ids: [reviewer]}` wait armed for the writer per started reviewer. |
| 47 | `work-collect` | carried | `collect`: last 200 timeline events of each reviewer's own session, fenced JSON or the whole reply, `ReviewVerdict` contract, round/focus/base/head must match, format errors as `validationError`, completed verdicts immutable, a running reviewer not read. Tested in `tests/reviews.test.ts`, including that a verdict in the writer's transcript counts for nothing. |
| 48 | Three-round cap | carried | At most 3 rounds; the same base/head returns its round; an uncollected round blocks the next; R4 refused with the PR's words; an unclean complete R3 sets `quality_failed`. Tested. |
| 48a | `producer-to-assertion-v1` | carried, differs | `revisions/producer-to-assertion-v1.md`, named by `agent.json` `vulcan.promptRevision`; a family pins `promptRevision` and its rounds carry it; the writer and correctness prompts read the pinned file, so a later revision changes new families only. A file, not a constant. |
| 49 | `work-retry-review` | carried | `retryReview`: only an incomplete reviewer that is not running; a started reviewer with no provider transcript is stopped (`POST …/stop`), proven stopped (`host === none`), retired, and a fresh one started; one with a transcript gets the infrastructure-retry nudge (`send` with a `sendId`); verdicts never replaced; a new session wait armed. |
| 50 | `work-publish` | carried | `publish` (`lib/publish.ts`): writer only; `[Vulcan · Human]` title via `agentPrTitle`; closing keywords and @mentions refused in title, body and commit messages; actor = grant at entry and again before the request; `assertReviewed` on the current base/head before the push and again after; checkout checks (clean, HEAD = head, branch current, remote branch unchanged); existing PR open/same head/branch/base/author; push `head:refs/heads/<branch>` without force, then create or PATCH; idempotent on the same head/title/body. Tested. |
| 51 | Stages and `work-reconcile` | carried | `stage` push → branch → request with `attempting/prepared/sent/uncertain`; `reconcile` reads `ls-remote` and the PRs by head, restores the previous publication when the push never landed and the prior PR is unchanged, marks a confirmed branch resumable, needs a unique matching PR, replays nothing. Tested for the failed push. |
| 52 | Follow-up waits at publish | carried, differs | `follow`: `POST /api/prs/claim` for the writer; the full-check wait (`head`, `all`, `checks: requiredChecks`) reused from `GET /api/waits?session=&all=1` when an equivalent one exists; the feedback wait armed as `{kind: pr, repo, number, head, feedback: true}`. On a core without the feedback wait the answer is a second full-check wait: it is cancelled and the family records that feedback is not watched (CORE-NEEDS.md). |
| 53 | `work-follow` | carried, differs | `followPublication`: writer or requester; needs a confirmed published PR; refused when the writer no longer holds the PR after Vulcan claimed it for it (`POST /api/prs/who`). `pr_releases` is not readable over the API, so "released" is read as "claimed by Vulcan for the writer, and not held by it now". |
| 54 | Feedback wait semantics | depends on core | Generic (Part 2 items 1-11), being ported by another session; Vulcan arms the spec shape PR #4's `parseSpec` accepts. See CORE-NEEDS.md. |
| 55 | `work-milestone` | carried | `milestone`: writer only, `POST /api/sessions/<requester>/send {from: agent, fromSession: writer, wake: false}` with `[Vulcan work <id>] <body>`, under the send guard. |
| 56 | `work-failure` | carried | `failure` (`lib/outcomes.ts`): R3 complete; a clean R3 needs `feedback` verified on GitHub as CHANGES_REQUESTED or a failed/timed-out/action-required check run on the published R3 head; `quality_failed`; evidence immutable; a non-pushing decision card; the improvement issue deduplicated by `agentbox-quality:<sha256[:24]>`, scrubbed of mentions and credentials, closing keywords refused, actor checked, never refiled when attempting/uncertain; "Needs human" without `improvementRepo`. |
| 57 | Pause, revoke and expiry enforcement | carried, differs | `enforceAuthority` every 30s and on revoke: a family whose grant is gone, expired or changed has its writer and reviewers stopped (`POST …/stop`) each tick while they run. "Vulcan disabled" is agentbox stopping the program: nothing runs, and the tick resumes when it is enabled. "Agent enabled and project unchanged" became "the grant's project is still registered with the same origin", checked at start and launch. |
| 58 | `agentbox agent work [id]` | carried | `agentbox agent call vulcan work` / `work-get --set id=…`, and the Work tab. |
| 59 | Shared repository writers | not carried | the shared cloud tier was never operational. |
| 60 | Shared publication guard | not carried | the shared cloud tier was never operational. |

## Part 3: what was hardcoded in core, and where it is now

| # | Item | Now |
|---|---|---|
| 7 | "improve Vulcan" strings in generic work code | `AGENT_NAME` in `lib/text.ts`, used by Vulcan's own `outcomes.ts`. |
| 8 | The writer prompt | `lib/prompts.ts`, Vulcan's. |
| 9 | The reviewer prompt and retry nudge | `lib/prompts.ts`. |
| 10 | `SCENARIO_TRACE` | `revisions/producer-to-assertion-v1.md`, pinned per family (48a). |
| 15 | Quality-failure card text | `lib/outcomes.ts`. |
| 18 | Review roles | `FOCUSES` in `lib/types.ts`, one place. |
| 19 | The round cap | `ROUND_CAP` in `lib/types.ts`, one place. |
| 20 | `agentPrTitle` | `lib/text.ts`. |
| 21 | Branch, worktree and ref names | `agentbox/work-<id>`, `refs/agentbox/work/<id>/{base,review-base}`, `vulcan-review-<id>-<round>-<focus>`; the writer's worktree is agentbox's own (41). |
| 22 | Grant expiry, 50 checks, 20 issues | `MAX_GRANT_MS` and the zod schemas in `lib/types.ts`. |
| 23 | Improvement-issue marker and template | `lib/outcomes.ts`. |
| 24 | Feedback evidence rules | `lib/outcomes.ts`. |
| 28 | Credential regex | `CREDENTIAL` in `lib/text.ts`, once. |
| 30 | Providers | writer `claude` or `codex` (manifest default, family override); reviewers codex, the one CLI agentbox can hold read-only. |
| 32 | `agents/runtime.db`, operator token | `store()` in Vulcan's home; no operator token. |
| 33 | Core wiring | none: `src/` is unchanged. |

Counts: C items 24-29 carried (3 as-is, 3 with a noted difference), 30 not carried; F items 40-58 and 48a carried (10 as-is, 9 with a noted difference, and 54 depending on the core port of the feedback wait), 59-60 not carried.
