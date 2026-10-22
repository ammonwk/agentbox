# What Vulcan needs from agentbox's core

Vulcan runs on the public API and changes nothing in `src/`. These are the
places where the API falls short of what PR #4's in-core Vulcan had, with how
Vulcan behaves until each is there.

## 1. The PR feedback wait (landed)

PR #4 Part 2 items 1-11: `POST /api/waits` with `{kind: "pr", repo, number,
head, feedback: true}` — a wait that wakes on new or edited reviews, inline
and conversation comments, and freshly failed checks on `head`, with a durable
cursor that survives rearm and restart, separate from the full-check wait.

Vulcan arms exactly that shape at publish and on `follow` (`lib/publish.ts`).
On a core without it, `parseSpec` ignores `feedback` and answers with a
second full-check wait; Vulcan detects that from the returned `spec`, cancels
it (`DELETE /api/waits/:id`), records `feedbackWait: null` on the family with
a note the Work tab shows, and the writer's prompt still tells it to rearm
with `follow`. The port has landed, so on a current core the feedback wait is armed as asked; nothing in Vulcan changed.

## 2. Reading PR releases (worked around)

`work-follow` in PR #4 refused to rearm when the writer had released the PR
(`prReleased`, the `pr_releases` table). The API exposes claims
(`POST /api/prs/who`) but not releases. Vulcan reads "released" as: Vulcan
claimed the PR for the writer once (`publication.follow.claimedAt`) and the
writer does not hold it now. That also covers a hold lost to a stop, which
the PR's check did not; both are cases where handing the PR back unasked is
wrong, so the stricter reading stands. A `released` field on
`POST /api/prs/who` would make it exact.

## 3. Starting a session under a chosen id (worked around)

PR #4 reserved the writer's and each reviewer's session id before spawning,
so "a launch was recorded" was a lookup. `POST /api/sessions` takes no `id`.
Vulcan proves a lost start by what agentbox has instead: the session in the
branch's worktree under Vulcan's main (the writer), or in the reserved
detached worktree (a reviewer). This is a sound proof and no core change is
asked for; it is noted because `retryStart` and `collect` depend on
`cwd`/`worktree`/`parent` in `GET /api/state` staying what they are.

## 4. A registered repo's checkout path (landed)

`Repo` gives `ref` (a path for a local repo, a slug for a GitHub one) but not
where a GitHub repo's clone is. Vulcan derives it as agentbox does
(`<AGENTBOX_HOME>/repos/<safe ref>`, `lib/work.ts` `checkoutOf`). A
`checkoutRoot` on `Repo` has since landed, and Vulcan uses it when the
server gives it.
