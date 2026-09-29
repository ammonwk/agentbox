/**
 * Every pull request of the repos agentbox works in, kept in the database and
 * brought up to date from GitHub once a minute. The New session dialog, a
 * session's PR number, `ls`, the worktree scan and "when PR N merges" all read
 * this copy; nothing else asks GitHub about pull requests on a timer.
 *
 * GitHub's rate limit is shared with every agent's `gh`, so the sync is built
 * to cost next to nothing:
 *   - REST, not `gh pr list`: GraphQL is the budget agents run out of.
 *   - Only what changed: PRs newest-updated first, read down to the ones the
 *     last sync saw. A minute is one request, and a page that has not changed
 *     answers 304 Not Modified, which GitHub does not count.
 *   - Every open PR, no cap, when a repo is first seen and every fifteen
 *     minutes after. GitHub's "updated" order lags — a PR updated a minute
 *     ago can sort last — so the catch-up alone misses some changes. One
 *     still open here and gone from that list closed or merged unseen, and is
 *     asked about by itself.
 *   - Closed and merged history, which only the worktree scan wants, walked
 *     oldest first a few pages a minute, and only while the hour has room.
 *   - Rate-limited, it stops until the reset GitHub gives.
 */

import {
  getPrSync,
  listOpenPrs,
  listRepos,
  listSchedules,
  prBranchesOf,
  savePrSync,
  upsertPrs,
  type PrSync,
  type StoredPr,
} from "./db";
import { ghErrorMessage, repoCheckoutPath, repoFullNameOf, runAsync } from "./git";
import type { PrInfo, Session } from "./types";

const API = "https://api.github.com";
/** A page of the one-time loads. */
const BIG_PAGE = 100;
/** A page of the minute's catch-up: a PR is ~28 KB of JSON, and a minute
 *  changes a handful. More than this and it reads the next page. */
const SMALL_PAGE = 30;
/** How often every open PR is read again: a couple of requests per pass on a small repo. */
const OPEN_EVERY_MS = 15 * 60_000;
/** History pages a sync reads: the biggest repo here runs seventy, so a full walk takes a while. */
const HISTORY_PAGES_PER_SYNC = 5;
/** The history walk waits while fewer requests than this are left in the
 *  hour: the rest are the agents'. */
const RESERVE = 1500;

/**
 * What GitHub thinks of a branch, closed and merged PRs included. Reclaiming
 * disk asks whether a branch is *finished with*, and a merged PR is the
 * strongest possible yes. `unknown` covers "not loaded yet" and "gh is not
 * here", and the reclaim path must never read it as "finished".
 */
export type PrState = "open" | "merged" | "closed" | "none" | "unknown";

// ---------------------------------------------------------------- reading

/** The open PRs of the registered repos, most recently updated first, each
 *  matched to the session whose branch it came from. */
export function openPrs(sessions: Session[]): PrInfo[] {
  const repos = [...tracked()].filter(([, registered]) => registered).map(([slug]) => slug);
  return listOpenPrs(repos).map((p) => {
    const session = sessions.find((s) => s.branch === p.headRef && s.repoRoot !== null && slugOf(s.repoRoot) === p.repo);
    return {
      number: p.number,
      repo: p.repo,
      title: p.title,
      headRef: p.headRef,
      state: p.state,
      isDraft: p.isDraft,
      url: p.url,
      author: p.author,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      sessionId: session?.id ?? null,
    };
  });
}

/**
 * Every branch of a repo that has had a PR, and what became of it.
 *
 * Null — not an empty map — until the repo's open PRs are loaded, because the
 * two mean opposite things: an empty map says "no PRs, so nothing is finished
 * on GitHub", and null says "we do not know". While the history walk is still
 * going, an old merged PR may be missing and its branch reads "none": that
 * only costs a reclaim, since "none" still has to prove it has nothing the
 * base branch lacks.
 */
export function branchStatesOf(repo: string): Map<string, PrState> | null {
  if (!getPrSync(repo)?.openAt) return null;
  // A branch can carry several PRs over its life. Open outranks everything —
  // reopening is a thing people do, and reclaiming under an open PR surprises
  // someone. Merged outranks closed for the same reason in reverse: it is the
  // stronger statement that the work landed.
  const rank: Record<string, number> = { OPEN: 3, MERGED: 2, CLOSED: 1 };
  const best = new Map<string, string>();
  for (const row of prBranchesOf(repo)) {
    if ((rank[row.state] ?? 0) > (rank[best.get(row.headRef) ?? ""] ?? 0)) best.set(row.headRef, row.state);
  }
  const out = new Map<string, PrState>();
  for (const [branch, state] of best) out.set(branch, state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed");
  return out;
}

/** Why the copy may be behind: one line per repo, or one for `gh` itself. */
export function prWarnings(): string[] {
  return [...new Set(errors.values())];
}

// ---------------------------------------------------------------- syncing

const errors = new Map<string, string>();
let syncing: Promise<boolean> | null = null;
let again = false;

/**
 * Bring every tracked repo's copy up to date; true when anything changed.
 * Asked while one is running (a repo was just added), it runs once more after.
 */
export function syncPrs(): Promise<boolean> {
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    let changed = false;
    do {
      again = false;
      changed = (await syncAll()) || changed;
    } while (again);
    return changed;
  })().finally(() => (syncing = null));
  return syncing;
}

async function syncAll(): Promise<boolean> {
  const repos = tracked();
  let changed = false;
  for (const slug of errors.keys()) {
    if (!repos.has(slug)) changed = errors.delete(slug) || changed;
  }
  for (const [slug, registered] of repos) {
    if (Date.now() < pausedUntil) break;
    try {
      changed = (await syncRepo(slug, registered)) || changed;
      changed = errors.delete(slug) || changed;
    } catch (e) {
      const message = (e as Error).message;
      const scoped = message.startsWith("`gh`") ? message : `Could not bring ${slug}'s pull requests up to date: ${message}`;
      if (errors.get(slug) !== scoped) {
        errors.set(slug, scoped);
        changed = true;
      }
    }
  }
  return changed;
}

async function syncRepo(slug: string, registered: boolean): Promise<boolean> {
  const at: PrSync = getPrSync(slug) ?? { etag: null, updatedTo: null, openAt: 0, historyPage: 1 };
  let changed = false;
  const store = (rows: readonly RawPr[]) => {
    upsertPrs(rows.map((p) => toStored(slug, p)));
    if (rows.length > 0) changed = true;
  };

  // What changed since the last sync, newest first, down to what it saw. The
  // very first reads one page: the open read below has the rest.
  const recent = `/repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=${SMALL_PAGE}`;
  const first = await get<RawPr[]>(`${recent}&page=1`, at.etag);
  if (first) {
    let newest = at.updatedTo;
    let page = first.body;
    for (let n = 2; ; n++) {
      store(page);
      for (const p of page) if (!newest || p.updated_at > newest) newest = p.updated_at;
      const last = page.at(-1);
      if (!last || page.length < SMALL_PAGE || !at.updatedTo || last.updated_at < at.updatedTo) break;
      page = (await get<RawPr[]>(`${recent}&page=${n}`))?.body ?? [];
    }
    at.etag = first.etag;
    at.updatedTo = newest;
    savePrSync(slug, at);
  }

  if (Date.now() - at.openAt >= OPEN_EVERY_MS) {
    const seen = new Set<number>();
    for (let n = 1; ; n++) {
      const page = (await get<RawPr[]>(`/repos/${slug}/pulls?state=open&per_page=${BIG_PAGE}&page=${n}`))?.body ?? [];
      store(page);
      for (const p of page) seen.add(p.number);
      if (page.length < BIG_PAGE) break;
    }
    for (const p of listOpenPrs([slug])) {
      if (seen.has(p.number)) continue;
      const one = await get<RawPr>(`/repos/${slug}/pulls/${p.number}`).catch(() => null);
      if (one) store([one.body]);
    }
    at.openAt = Date.now();
    savePrSync(slug, at);
  }

  // Oldest first, so a PR opened meanwhile lands at the end instead of
  // shifting the pages still to read.
  for (let i = 0; registered && at.historyPage > 0 && i < HISTORY_PAGES_PER_SYNC && remaining > RESERVE; i++) {
    const page = (await get<RawPr[]>(`/repos/${slug}/pulls?state=all&sort=created&direction=asc&per_page=${BIG_PAGE}&page=${at.historyPage}`))?.body ?? [];
    store(page);
    at.historyPage = page.length < BIG_PAGE ? 0 : at.historyPage + 1;
    savePrSync(slug, at);
  }
  return changed;
}

/**
 * The repos to keep: every registered one on GitHub (true), and any other a
 * "when PR N merges" is waiting on (false — its open PRs and what changes,
 * without the history).
 */
function tracked(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of listRepos()) {
    const slug = r.fullName ?? (r.kind === "github" ? r.ref : slugOf(repoCheckoutPath(r)));
    if (slug) out.set(slug, true);
  }
  for (const s of listSchedules()) {
    if (s.enabled && s.rule.kind === "merge" && s.rule.repo && !out.has(s.rule.repo)) out.set(s.rule.repo, false);
  }
  return out;
}

const slugs = new Map<string, string | null>();
/** The GitHub slug of a checkout, cached: it costs a `git remote` call and a
 *  checkout's remote does not change under a running app. */
function slugOf(root: string): string | null {
  if (!slugs.has(root)) slugs.set(root, repoFullNameOf(root));
  return slugs.get(root)!;
}

// ---------------------------------------------------------------- GitHub

interface RawPr {
  number: number;
  title: string;
  state: "open" | "closed";
  draft?: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
}

function toStored(repo: string, p: RawPr): StoredPr {
  return {
    repo,
    number: p.number,
    title: p.title,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    state: p.merged_at ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED",
    isDraft: p.draft === true,
    author: p.user?.login ?? "unknown",
    url: p.html_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    // Before the merge this is GitHub's trial merge, not anything that landed.
    mergeCommit: p.merged_at ? p.merge_commit_sha : null,
  };
}

/** Until when GitHub said to stop. */
let pausedUntil = 0;
/** Requests left in the hour, as of the last answer. */
let remaining = Infinity;
let token: string | null = null;

/** `gh`'s token, so the sync counts against the same login the agents use
 *  and needs no setup of its own. */
async function ghToken(): Promise<string> {
  if (token) return token;
  const r = await runAsync(["gh", "auth", "token", "--hostname", "github.com"]);
  const t = r.stdout.trim();
  if (r.code !== 0 || !t) {
    const message = ghErrorMessage(r);
    throw new Error(message.startsWith("`gh`") ? message : "`gh` is not authenticated — run `gh auth login`");
  }
  return (token = t);
}

/** What GitHub answers, or null when it has not changed since `etag`. */
async function get<T>(path: string, etag?: string | null): Promise<{ body: T; etag: string | null } | null> {
  const res = await fetch(API + path, {
    headers: {
      Authorization: `Bearer ${await ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(etag ? { "If-None-Match": etag } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const left = res.headers.get("x-ratelimit-remaining");
  if (left !== null) remaining = Number(left);
  if (res.status === 304) return null;
  if (res.ok) return { body: (await res.json()) as T, etag: res.headers.get("etag") };
  if (res.status === 401) {
    token = null;
    throw new Error("`gh` is not authenticated — run `gh auth login`");
  }
  const retry = res.headers.get("retry-after");
  if (res.status === 429 || (res.status === 403 && (left === "0" || retry !== null))) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    pausedUntil = retry !== null ? Date.now() + Number(retry) * 1000 : reset ? reset * 1000 : Date.now() + 60_000;
    throw new Error(`GitHub's rate limit is used up; catching up after ${new Date(pausedUntil).toLocaleTimeString()}`);
  }
  if (res.status === 404) throw new Error("GitHub has no such repo, or this login cannot see it");
  throw new Error(`GitHub answered ${res.status} ${res.statusText}`);
}
