# Shared Agents

Agents are persistent workspace responsibilities, independent of any laptop,
provider account or session. Open **Agents**, above Sessions, to create an
instance, inspect work, or clone an existing definition. Ordinary standalone
Sessions retain their existing private transcript and access boundaries.

## First run: Vulcan

1. Configure the cloud as described in [cloud.md](cloud.md), apply all migrations,
   sign in, and create or join a workspace. Each human signs in as themselves.
2. Choose **Use VULCAN**. The instance starts paused with its creator as
   maintainer. Add allowed repositories and acceptance instructions. Team instances
   can have several maintainers; personal instances have one. Visibility alone
   grants neither editing nor execution rights.
3. Register the execution installation on Team with `agents:execute`. This is an
   additional, opt-in installation scope, not part of the default messaging grants.
   The installation can be a server. Its owner grants this particular agent access
   under **Execution host setup**. Then a maintainer selects the host in the agent
   definition. A maintainer cannot grant use of someone else's machine.
4. On that host, signed in as its current installation owner, map allowed repositories to registered local
   repositories and select a provider/model. Every new work item starts through
   Fleet in an isolated worktree. Provider logins remain in their original account
   homes. No credential is copied to another account or uploaded to the workspace.
5. Enable the instance. Add an issue URL and acceptance criteria, assign the
   accountable human, and choose **Run now**. An unassigned manual run makes its
   requester accountable. Scheduled intake uses the creator for new unassigned
   work; explicit per-item assignment always wins. A removed member cannot remain
   the assignee of a new execution.
6. Follow the work from any workspace member's Agents page: current stage, next
   action, pending decision, host, heartbeat, evidence and session references.
   Shared Chat reads the linked conversation through the authenticated live relay.
   A session reference never grants a remote terminal or unrelated Session access.

CAELUS and SALUS seed editable release and observability definitions through the
same flow. Installing samples never starts scans, messages, merges or deployments.
There is no hardcoded human, repository, production environment or bot registration.

## Definitions and intake

A definition records role/instructions, expertise areas, pinned workspace skill
revisions, allowed repositories, source adapters, activation, permitted actions,
approval policy, escalation, workload limit, public GitHub actor configuration and
optional release scope. The form exposes common fields and an editable full JSON
definition for source/skill/actor details. Saving is a compare-and-set revision;
an older edit cannot replace a newer one. Cloning creates a disabled instance
without copying executor grants or private settings. No template update silently
broadens an existing instance's permissions.

`github_issues` sources use a repository and optional label. Event activation
scans these every five minutes; timed activation uses the existing schedule parser
and the execution host's timezone. For log/trace/event adapters, the host operator
can supply a local note command producing a JSON array:

```json
[{"source":"https://example.org/trace/123","title":"Slow query","acceptance":"Confirm latency improves without a result change"}]
```

The command is local configuration, never downloaded as shared executable code.
Keep secrets, customer data and raw logs out of its output. It has a 30-second
limit. Output is journaled before the next intake pass. Busy execution slots do
not discard intake. Cloud work left between intake and enqueue is retried by the
reconciler. Empty output is quiet. Failed intake stays due. A GitHub source with
more than 2,000 matching open issues needs a narrower label; it reports an error
instead of silently treating the first page as complete.

Scheduler drives intake and reconciliation. Agents do not introduce another
provider runtime. Session scheduling, PR/workflow waits and `--note-cmd` sessions
remain available separately; merge/red-workflow schedule syntax is not interpreted
as a timed Agents source scan.

## Ownership and process safety

There are four distinct identities: creator/maintainers of the agent, accountable
human on each work item, execution installation, and GitHub actor. A shared team
Vulcan does not need one permanently assigned human for all its work.

Cloud source keys are unique **within a workspace**, across agents and humans.
GitHub host/repository case, fragments, query strings and issues/pull spelling do
not create separate claims for the same number. Intake returns existing work
without stealing its agent or assignee. Other HTTP sources use their canonical
source link; adapters should choose a stable external identity.

A run request is idempotent by UUID. A partial unique index permits one queued,
starting, running, waiting or uncertain run per work item. Claims use row locks,
revision checks and an incrementing fence. The 90-second lease is renewed by the
execution host. **Expiry does not free the work.** An uncertain worker continues
to exclude competitors, including deployment-environment claims. An offline host
stops its local writer before its last acknowledged lease expires when its
scheduler can run; the cloud never assumes a missing host stopped a process.

Takeover first requests a stop. Handoff and human outcome editing become available
only after the host proves the old process is gone and acknowledges it. Pausing
or revising an agent stops active execution and prevents new claims; queued work
remains visible for cancellation/re-request. Moving an execution host requires
all active/uncertain work to be reconciled. Do not remove cloud run records or
local process journals to clear an uncertain claim.

Session replacement stops and proves the previous process before attaching a new
session with a new fence. Fleet handover transfers succession, PR claims and
Review cards; durable waits resolve the successor through Fleet. The cloud keeps
safe session references and rotation events, not a conversation copy. A run's
local process journal is written before spawning. An interrupted spawn is
reconciled, never automatically repeated under a new identity.

Release work additionally holds a workspace resource keyed by the real repository
and environment. Different humans, agents or artifact labels cannot concurrently
use the same deployment environment. This is coordination, not permission to
deploy. A monolithic artifact may contain several people's work.

## GitHub actors and opt-in outreach

Each separately named contributor needs its own GitHub App registration. Multiple
installations of one App share its bot identity. The definition holds only
`kind: "app"`, public `appId`, `installationId` and the exact `slug[bot]` login.
The host operator supplies an absolute path to a private (0600) PEM file. No UI
or command returns the private key or installation token. The server verifies
App identity and repository ownership, mints a repository-scoped installation
token, and retains it only inside the broker. It never adds `GH_TOKEN` to a
session or invokes git with an App token.

Managed publication uploads the prepared git objects through the GitHub API and
creates a commit with the verified bot ID/login noreply email. It does not change
global git identity or pretend a display-name change creates a bot account.
`open_pr` creates a draft PR on a branch bound to the run. `update_pr` requires
that run's existing bot-authored branch and the approved remote head, and updates
without force. Workflow/submodule changes and files over 5 MB need a human-managed
publication path. A changed local head, base or remote head requires a new action.
GitHub App registration, repository installation and secret setup require a
repository administrator; Agentbox does not provision them automatically.

Bot-initiated contact defaults to **off**. Each human links their own GitHub
identity through Supabase OAuth and manages their own workspace/repository/agent
scope preferences. Enable GitHub identity linking in the Supabase project before
using this flow. Editable expertise logins and user metadata are not verification.
Unlinking GitHub, leaving the workspace, or opting out revokes contact. Any matching
opt-out overrides a matching opt-in. Expertise, CODEOWNERS and membership never
imply consent.

The broker checks every explicit recipient and every `@mention`, including PR
bodies, titles, quoted/code text and encoded mentions. Team mentions are refused
because individual consent cannot be established. A targeted issue comment checks
the issue author even without an `@mention`. Review requests check each reviewer.
Consent and the current GitHub numeric user ID are rechecked at actual dispatch,
and again before visible publication after preparing git objects. Approval cannot
override revoked consent. Missing consent creates needs-human progress and Review,
not repeated opt-in invitations. GitHub's own subscriber notifications remain
GitHub's responsibility.

Shared agent sessions and their descendants cannot use Agentbox session messaging
as an alternate contact channel. This is checked before queueing and again when
cloud messages dispatch. Their Review cards are visible without unsolicited push
notifications. Ordinary standalone session messaging and the foundation's separate
remote delivery grants retain their existing behavior.

Managed reads support issue, pull, reviews and checks through the configured App, without borrowing a human’s gh login or returning a token. Grant Checks read permission to use check inspection.

The broker supports `open_pr`, `update_pr`, `ready_pr`, `merge_pr`, `close_issue`, `comment` and `request_review`. In
prepare mode, the proposed immutable action is visible in Agents and linked from
Review. Only a signed-in maintainer or the item's accountable human can approve
that action. A Review message alone is not a cloud approval. Automatic mode permits
supported actions only within the explicitly configured policy and repository
scope. Dispatch is claimed once. A network interruption after attempting an action
is **uncertain** and needs external reconciliation; it is never blindly replayed.

`ready_pr` marks this actor's exact-head draft ready for review. `merge_pr`
requires an unchanged head/base, computed mergeability, successful reported checks,
configured required check names, and at least the configured number of human
approvals on that head. Outstanding change requests block it. Large incomplete
check/review pages fail closed. GitHub's [asynchronous merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request-asynchronously)
receives the exact SHA and `bypass_rules: false`; branch protections, rulesets and
merge queues still govern the result. Pending/enqueued means submitted, never
merged. The journal retains the receipt and Scheduler reconciles by reading the
remote result, including after interruption, without repeating a merge request.

`close_issue` names the exact linked merged fix and recorded evidence. The work
must meet its definition's `mergePolicy.resolution` (default `verified_resolved`),
have an outcome, and include all proposed evidence. The broker confirms that PR
is merged at the expected head/base, checks the issue author's consent at dispatch,
and confirms the closed/completed response. An already completed issue is a
read-only reconciliation. PR publication and merge reject automatic closing
keywords so GitHub cannot skip this resolution gate. Do not put closing directives
in independently authored commits either; a repository administrator must ensure
that the configured App cannot bypass their policies through other channels.

Deploy and rollback have no managed adapter in this release and are not available
permission switches. CAELUS can investigate and prepare releases, hold shared
environment claims and follow evidence; operational deployment stays human-managed.
There is no unrestricted shell action or administrative merge bypass. Provider
shells still run as the host's Unix user: these boundaries govern Agentbox-managed
actions, not arbitrary shell access to ambient credentials. Use a dedicated
service account/container with only the intended access for a server execution
host when operating-system isolation is required.

## Progress, expertise and CLI

Managed progress and action routes require a private per-session capability in
`x-agentbox-session` and `x-agentbox-session-token`, then verify that session's
current run/fence. A supplied or omitted `callerPid` is never authentication.
Capabilities live in private 0600 host files, never shared state or transcripts;
the installed CLI reads its own capability through its process environment or
ancestry. PR transfer uses the same capability, expected holder and live destination.
Rotated sessions cannot write for their successor. Read-only durable checks may
continue for their original associated run.

Binding and rotation require a current human access token, verified by the cloud's
human-only installation-owner RPC. The browser supplies it transiently; the host
never stores it. Prefer the signed-in UI. A host terminal can supply its own short
lived `AGENTBOX_HUMAN_ACCESS_TOKEN` for these two CLI operations. Missing identity,
a session capability, another member's JWT or a forged PID cannot authorize them.
These capabilities secure managed HTTP calls; they do not isolate processes that
can deliberately read the same Unix user's private credential files. Existing
local terminal/operator APIs retain their loopback trust boundary.

```sh
agentbox agent status
agentbox agent read RUN_UUID --repo owner/repo --number 123 --kind issue
agentbox wait until -- agentbox agent check RUN_UUID --repo owner/repo --number 123 --condition checks
# Host terminal with its own human token, or use signed-in execution setup:
agentbox agent bind --file local-binding.json
agentbox agent progress RUN_UUID --stage in_progress --next 'Validate the fix'
agentbox agent progress RUN_UUID --stage awaiting_review --decision 'Confirm the acceptance criteria'
agentbox agent action RUN_UUID --request ACTION_UUID --file proposed-action.json
agentbox agent experts AGENT_UUID --areas TypeScript --paths src/service.ts
agentbox agent finish RUN_UUID
# The host operator, after inspecting the current work:
agentbox agent rotate RUN_UUID
```

Retain the action request UUID for retries. `open_pr` JSON includes `kind`, `repo`,
`title`, `body`, `base` and the exact local `head` SHA. `update_pr` also includes the
PR `number` and exact `remoteHead`. Comments include `repo`, `number` and `body`;
review requests include `repo`, `number` and `reviewers`. `ready_pr` includes
`repo`, `number`, `head`, `base`. `merge_pr` additionally names `method` (`merge`,
`squash` or `rebase`). `close_issue` includes issue `number`, linked `pullNumber`,
`head`, `base`, `verification` and labeled `evidence` (including the merged PR URL).

Use `agentbox wait until -- agentbox agent check RUN_UUID --repo owner/repo
--number N --condition checks` (or `merged`) to watch using the configured App;
the wait runner carries its session capability, so it needs no ambient `gh` login.
Grant Checks/Commit statuses read for inspection, Pull requests write for drafts
and reviews, Contents write for publication/merge, and Issues write for approved
comments/closure. Tokens request only the needed permissions and repository.

Use the existing `agentbox pr claim`, `agentbox wait`, and `agentbox card add`
commands for follow-through. Run completion stops its process; it does not invent
a successful work outcome. PR opened, merged, deployed and verified resolved are
separate stages. Later stages require labeled evidence links; verified resolution
also requires an explanation of the verification.

Expertise suggestions combine declared areas/paths, commit-email matches in actual
local path history, and CODEOWNERS. Each score includes its evidence. Missing
history or identity mapping produces an honest partial result. It is a suggestion,
not an assignment, credential grant or permission to contact someone. The result lists current consent separately per repository and explains skipped outreach; dispatch still rechecks it.

## Validation

Run `bun run typecheck`, `bun run web:build`, and `bun run test:cloud` against the
local Supabase stack. Destructive/security checks cover two-human visibility and
authority, tenant isolation, independent host grants, source dedupe, competing
claims, takeover, stale fences, expired leases, release-environment exclusion,
immutable approval, OAuth identity forgery and contact revocation. The broker's
transport regression proves a previously approved targeted comment cannot send
after opt-out. Additional guards cover forged/missing HTTP identity, exact-head review/check gates, rule-bypass refusal, and merge/closure reconciliation without replay. Validate Fleet run-now, session association, rotation, shared
progress, desktop/mobile/keyboard behavior with an isolated execution host. Never
use a production bot or deploy an artifact just to obtain a smoke-test result.


The reproducible isolated acceptance script is `scripts/agents-smoke.ts`. Start
only the disposable local Supabase stack, install `playwright-core` in a temporary
directory, and provide its module/browser paths:

```sh
AGENTBOX_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs \
AGENTBOX_CHROMIUM=/absolute/path/to/chromium \
AGENTBOX_SMOKE_OUTPUT=/tmp/agentbox-agents-evidence \
bun scripts/agents-smoke.ts
```

It refuses non-loopback cloud URLs, creates fixture humans/installations, launches
a controlled adapter through real Fleet/tmux and isolated git worktrees, exercises
the actual CLI/router, restarts the runtime journal, replaces the session and
proves stop before takeover. It also checks shared read/edit boundaries and the
create/edit, desktop/mobile/keyboard UI. It never provisions or logs into a real
provider or GitHub bot. See [validation evidence](agents-validation.md).

## Chat, About and Feed

Agent detail opens **Chat**: one logical conversation across its managed run and
predecessor-session references. About contains configuration, human and host
accountability, work controls and history. Feed contains immutable recommendations
created by the current agent writer with `agentbox agent recommend RUN --request
UUID --file proposal.json`. The JSON fields are `title`, `finding`, `reason`,
`next`, `evidence: [{url,label}]` and an optional `action` UUID. The same durable
proposal appears inline in Chat and in Feed. Existing scheduled intake instructs
the agent to curate evidence-backed recommendations; no fixture or activity-log
entry is turned into one. Approving a linked action uses the existing exact-action
approval and broker, including actual-dispatch consent. Guidance reaches the
responsible run; dismissal never starts work.

With no shared project configured, three local agents are available immediately.
Their definitions and session references are local operational records. Sending
the first message starts the selected existing provider via Fleet; later messages
resume that same conversation. Provider/repository can be changed in About after
the current turn is idle. Agentbox proves the old transcript exists, stops the old
process, retains its reference, and starts the next message in a fresh scoped
session. This does not move a warm session between accounts. Local agents inherit the existing loopback operator trust boundary;
this does not isolate malicious code running as the same Unix user. Local scope
is explicit and never presented as workspace sharing. Creating a local agent does
not authorize external outreach or repository scans.

### Memory and fresh conversations

A local agent keeps one provider conversation while you chat with it. When you
have been away for 10 minutes and its prompt cache is still warm, Agentbox asks
it for a handoff of at most about 500 words: what you want, decisions and why,
open questions, commitments and references. A later message after the cache
went cold (or past 60% context) starts a fresh conversation from that handoff,
your durable preferences and the live state of its work, and Chat follows it.
If the handoff is missing or older than the last real message, the message goes
to the old conversation instead; nothing is dropped. About → Memory shows the
policy, preferences, handoffs and search, and the form sets the idle minutes,
the context budget, or turns rollover off. The agent records decisions with
`agentbox agent memory <ID> note` and reads older handoffs with `search` and
`show`; each record names its source conversation, and the provider transcript
stays the record. Memory never authorizes anything. Waits, Review cards, PR
claims, work grants and messages to the old conversation pass to the new one.
Scrolling up in Chat past the start of a fresh conversation loads the
conversations whose summaries it started from, muted, with a divider for each
and a mark where the carried history starts; older conversations stay in the
session list. Shared coordinators keep handoffs on their execution host and start from them
after a human rotation or a new run; they do not roll over automatically.

About → Picture uploads a PNG, JPEG, GIF or WebP (up to 2 MB) for a local agent.
It stays with the agent across reloads, restarts and fresh conversations, and
Chat shows it beside each reply. Without one, or when it fails to load, the
agent's own icon is shown. Shared agents use their icon; their definitions do not
store pictures yet.

Shared transcript reads use **live encrypted Realtime Broadcast** (enable
Supabase Realtime). A human JWT queues a bounded 45-second read request containing
only an agent ID, cursor and ephemeral P-256 public key. The current authorized
execution host reads only its verified managed-session references, records its
own ephemeral public key via a scoped installation RPC, and sends AES-GCM encrypted
chunks over WebSocket broadcast. Bodies are never inserted into cloud tables
or written to another conversation log. The browser obtains that host key through
a human-only RPC which rechecks current membership, installation and grant; request
ID authentication binds the ciphertext to that read. The host rechecks before
every bounded chunk. Public relay observers cannot decrypt or forge replies.
Expired or offline requests produce an unavailable state, while shared Feed and
progress remain visible. Private standalone Sessions are never relay targets.
Only user/assistant messages are shared; tool payloads, private images and known
credential formats are excluded/redacted. Agents must still keep secrets out of
human-facing prose.

Shared guidance uses a short-lived delivery queue, not a chat history. The cloud
rechecks current member, host grant, run revision/lease/control and the responsible
session at dispatch; local durable send receipts guard the attempt boundary.
Terminal outcomes purge the queued body. Uncertain attempts are reported and never
replayed automatically. Browser drafts and pending sends reuse the Sessions model;
reloading does not turn an uncertain submission back into an unsent draft.

Any current workspace member can begin Chat on an enabled agent with an authorized
execution host; opening Chat grants no repository publication permission.
The persistent Chat coordinator has separate capacity from repository workers.
Its managed repository actions are refused; `agentbox agent intake RUN --file
issue.json` queues a canonical source under the configured activation policy.
Scheduled intake can therefore start its one allowed issue worker while Chat
is idle, without allowing a second writer for the same issue. Manual activation
still requires a maintainer to run queued work from About.

Local Feed decisions are persisted before delivery with one stable receipt ID.
Approval, dismissal and retries cannot overwrite or repeat that decision. A
refused or uncertain delivery remains visible; a server restart never retries it
automatically. Guidance appends to existing browser drafts, and retains its
proposal/run context through reload and failed-send recovery. A changed workspace
requires the old recommendation to be reviewed anew before approval.

Cross-installation Chat requires a secure browser context (HTTPS or localhost)
for WebCrypto and a reachable Realtime service. Plain HTTP on a tailnet address
cannot provide the encrypted shared relay; local Chat remains usable there.

## Projects and navigation

Click the sidebar logo (or the project name above the page on a phone) to search
registered repositories. Each registered repository is one project. **All projects**
includes general conversations, unassigned sessions and global Review cards.
**Manage projects** opens the existing repository settings. Workspace selection is
shared by Agents and Team; a workspace is the membership boundary, not a repository
or an execution host.

Opening a local project's Agents directory creates only stable definitions for
Vulcan, Caelus and Salus. It starts no session or repository work. Each project's
instances retain separate provider conversations, drafts and Feed recommendations;
their repository binding cannot be changed. Earlier general conversations stay
reachable in All projects. Shared agents deliberately scoped to several repositories
appear in those projects with the same identity and conversation; About lists their
full scope. New shared definitions and templates default to the selected repository.

Sessions use canonical checkout/worktree roots and local-agent bindings. Review
uses a card's GitHub PR repository or linked session. Archived sessions are filtered
before pagination. Badges follow this scope; account warnings and system status
stay global. Session close/stop warnings still account for running descendants
outside the selected project.

Project and workspace selections are in the URL, including explicit All projects.
Back, reload and separate browser tabs retain their context. A mismatched detail
link offers an explicit switch; an unscoped local agent/session link resolves to its
actual project. A removed repository leaves an unavailable page with an All projects
escape, and its conversations are retained. New-session drafts are stored per
project; provider defaults stay available, intentional location choices and prompt
inference still work. Existing general new-session drafts stay in All projects.

These are navigation filters, not new access grants. Switching projects does not
stop running work, rebind an agent, grant publication or change credentials. Shared
Chat still checks current membership and host grants at dispatch; Feed approval and
contact consent keep their existing boundaries. Standalone Sessions remain private.

## Agent session browser and Jupiter

Agents opens the last selected instance within the current project/workspace.
The searchable selector replaces the template landing page. The left rail uses
Sessions' Active/Inactive controls and real linked session rows; the right pane
shows only the selected provider conversation. Activity means running or active
within three hours; closed conversations are inactive. Retained predecessors are
read-only. About and Feed remain agent-level views. Mobile Back returns to that
agent's rail. Ordinary Sessions uses actual local agent/project metadata for its
row attribution, so a private execution directory is not mistaken for a project.

“Create agent…” opens **Jupiter**, whose internal creator capability permits
creation proposals only. It is a real provider conversation. Jupiter calls
`agentbox agent draft <local creator ID|shared run UUID> --request <stable UUID>
--file <spec.json>` to publish a typed, persisted proposal. The inline form lets
the human edit name, purpose, instructions, provider, limits and requested
automation. Save uses a revision check; Create accepts that exact draft once and
returns the new instance. Renaming an ordinary agent Jupiter grants no capability.
A replaced creator session cannot authorize an unaccepted old proposal.

Created instances inherit the creator's actual project/repository scope, with
manual activation and no publisher credentials. Creation never starts a process.
Requested automation is recorded as unconfigured; it does not create a schedule.
Local instances use the existing provider accounts on their first explicit Send.
Shared instances retain the authenticated creator as maintainer. Only a human
who owns the existing authorized execution installation can reuse it during
creation; otherwise About truthfully requires host setup. Provider logins remain
on that host. Jupiter does not manage, monitor, or delete agents in this version.

Read-through accepts an exact session ID only after verifying its recorded agent
run/history association. The response includes at most 200 metadata rows; older
rows are paginated. Transcript pagination stays within the selected session.
Shared guidance pins the run's session and fence when queued, and checks them
again at dispatch. It never follows a replacement writer. Drafts and pending
receipts are keyed to the actual agent/session. Earlier agent-level drafts have
an explicit recovery action; proposal guidance cannot move to another run.

## Local issue families and guarded publication

The installation operator can grant a coordinator one registered project, an
accountable human, an explicitly authorized existing gh actor, a worktree root,
required checks, an improvement-issue repository and an expiry (at most seven
days). `POST /api/agents/work-grants` requires the private host operator capability;
this is the trusted local operator boundary, not operating-system isolation.
Provider sessions cannot manufacture it through editable caller metadata.

`agentbox agent work-start --file family.json` validates canonical open issues,
records all claims atomically, pins the agent configuration and base, then starts
one Fleet writer in an isolated worktree. Family JSON contains a stable UUID,
grant, project agent, base branch, separately reproduced issues/acceptance/evidence,
and preparation covering the problem, consumers, edges, non-goals, design and
validation. Work/history appears under that agent; navigation still opens its
separate Main chat and never starts a writer.

New local work pins `pre-action-proof-v2` and `candidate-evidence-v1` in its
configuration. Before formal review, only its writer can append
`work-validation ID --file execution.json`: `{request,base,head,checks,acceptance}`.
Checks carry kind (`typecheck`, `acceptance`, `other`), actual/planned command,
status, evidence references, and actual start/end epoch milliseconds and exit
code when executed. `blocked`/`not_run` carry a reason without execution fields.
Only a genuinely inapplicable compiler can use `not_applicable`, with repo-specific
reason/evidence and no command. Acceptance entries are `{issue,evidence,proof}`:
describe the actual producer, pre-action state, action and why the final assertion
cannot pass without it, including background producers. Reports are capped at
32 KB and retain references rather than logs. The CLI guide gives the field names.

Agentbox verifies the clean committed candidate and authenticated writer; execution
remains explicitly **writer-reported**, not server-attested. Missing, blocked or
failed evidence cannot spend a formal review round or permit publication. Later
reports retain previously declared commands for that candidate; an omitted failed
check cannot turn it green. Idempotent requests cannot rewrite prior reports.
Resolving failed/blocked evidence requires a later execution; re-submitting an
older pass under a new request does not resolve it. Reviewer retries recheck the
same execution gate without replacing the original snapshot or consuming a round.
Each round snapshots its submitted evidence, and publication also checks the latest
report for that base/head. Reviewers inspect evidence, including compiler exclusions.
This is a prepublication execution floor, not a readiness verdict: full applicable
CI, actual review feedback, requested acceptance and human review remain required.
Legacy works/hashes/rounds keep their original contract; shared work is unchanged.

`work-review ID --file validation.json` starts three distinct read-only Codex
reviewers of the same committed base/head: architecture, correctness and deslop.
`work-collect ID` reads structured verdicts from their provider transcripts. The
journal retains only verdicts and evidence references. One family has at most
three cumulative rounds across all its issues and pre/postpublication changes.
A retry without a candidate change uses the same reserved reviewer and round.
`work-retry-start` and `work-retry-review` retry a proven unstarted reservation;
a recorded or uncertain launch is never blindly repeated with a new identity.

Only the current work writer can `work-publish ID --file publication.json` with
its head, title and body. It requires three clean independent verdicts, the same
base/head, a clean writer tree, unchanged grant and gh actor, and no unconsented
mentions or automatic-closing directives in title/body/commits. Titles are
`[Agent · Human] Concrete change`. Branch push and PR request have separate durable
stages: `work-reconcile` can confirm a branch before resuming an unattempted PR
request; ambiguous PR requests require positive remote reconciliation. Updates
preserve the existing PR and never force-push. The persistent writer owns its PR
and separate current-head full-check and review-feedback waits; repository
standing rules supply human-review gates. Feedback wakes for submitted/edited
reviews and comments or failed checks while other CI is queued. The notice is
not a clean verdict; the owner must read all actual surfaces before disposition.
`work-follow ID` lets the authorized writer or requester rearm feedback after
disposition (and add it to an already published work family). It retains the
full-check wait/evidence and returns its `waitEnded` state, without immediately
rearming unchanged failed CI. After repairing or rerunning CI, explicitly arm a
new full-check PR wait. Existing feedback is skipped using the durable same-head
cursor; owner, cumulative rounds and outbound consent are unchanged. No comments,
review requests, merges or issue closures are sent by these waits.
Pausing the agent, revoking its grant or expiry prevents publication and stops its
associated work processes during runtime reconciliation.

After an unclean R3, `work-failure ID --file failure.json` records the process root
cause and files a deduplicated improvement issue in the explicitly granted repo.
An uncertain issue POST is reconciled before any retry. Improvement issues never
count as solved trial issues. No fourth review or automatic merge is available.

Shared repository writers use the same review engine: `agent prepare RUN --file`
pins `{base,preparation:{problem,consumers,edges,nonGoals,design,validation}}` before
editing; `agent review RUN --file` takes `{validation:[artifact references]}`.
`agent collect RUN` reads the three actual reviewer transcripts. `retry-review`
accepts `{focus}` only for an incomplete infrastructure retry. The cloud journal
belongs to the work item and keeps its three-round budget across writer and host
replacement. Completed verdicts cannot be rewritten. An explicit retry on the new authorized host can replace an unfinished read-only
reviewer with a fresh locally reserved identity, preserving its candidate, round
and completed peer verdicts. It requires the pinned commit to be available there;
foreign short IDs never grant local transcript access or process authority.

App publication derives `[Agent · Human]` from the real instance and the current
work assignee's profile, then checks the exact clean review bundle before preparing
and again at the credential boundary. The broker records the reviewed local head,
base, complete tree and resulting App-authored remote commit in the shared action
before publishing its branch. Ready/merge actions require that receipt and current review proof; a human
action approval cannot replace them. No App is provisioned automatically. Local
publication uses its explicitly granted human gh actor.

`work-milestone ID --file` takes `{body}` and sends only from the current writer
to its explicitly granted requester, subject to the normal message throttle/wake
guard. It does not permit other session recipients, cloud messaging or outreach.
After clean R3, `work-failure` can take `feedback:{kind:"review"|"check",id,title,remedy}`
with its summary. The broker verifies a subsequent blocking review or failed check
on that published R3 head before recording failure; no fourth round is allowed.
