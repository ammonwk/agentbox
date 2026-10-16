/**
 * The GitHub App broker: the one place that holds a GitHub App's installation
 * token. A token never leaves this module: not in a session's environment, a
 * git command, the cloud, a log line or an HTTP answer.
 *
 * A superagent (its program or one of its sessions) requests an action; the
 * broker does it as the App the host owner pinned for that superagent
 * (`policy.ts`), after it checks again the App's identity, the repository's
 * owner and everyone the action contacts. The journal, the approval and the
 * claim check are `actions.ts`. Core names no superagent here.
 *
 * Consent: bot-initiated contact is off until a person opts in. Every explicit
 * recipient and every @mention (quoted, in code, encoded) needs a current
 * opt-in, keyed by the person's numeric GitHub id, read at dispatch. A team
 * mention is refused outright. Without a consent source (no cloud), an action
 * that contacts a person is refused.
 */
import { createHash, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BrokerPolicy } from "./policy";

export const repoName = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/, "a repo is owner/repo")
  .transform((x) => x.toLowerCase());
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const ref = z.string().regex(/^[\w./-]{1,200}$/);
const text = z.string().max(24000);
const num = z.number().int().positive();

export const GitHubAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready_pr"), repo: repoName, number: num, head: sha, base: ref }).strict(),
  z.object({ kind: z.literal("merge_pr"), repo: repoName, number: num, head: sha, base: ref, method: z.enum(["merge", "squash", "rebase"]) }).strict(),
  z
    .object({
      kind: z.literal("close_issue"),
      repo: repoName,
      number: num,
      pullNumber: num,
      head: sha,
      base: ref,
      verification: z.string().min(1).max(2000),
      evidence: z
        .array(z.object({ url: z.string().url().regex(/^https?:/).max(2000), label: z.string().min(1).max(160) }).strict())
        .min(1)
        .max(30),
    })
    .strict(),
  z.object({ kind: z.literal("open_pr"), repo: repoName, title: z.string().min(1).max(200), body: text, base: ref, head: sha }).strict(),
  z
    .object({ kind: z.literal("update_pr"), repo: repoName, number: num, title: z.string().min(1).max(200), body: text, base: ref, head: sha, remoteHead: sha })
    .strict(),
  z.object({ kind: z.literal("comment"), repo: repoName, number: num, body: text.min(1) }).strict(),
  z.object({ kind: z.literal("request_review"), repo: repoName, number: num, reviewers: z.array(z.string().regex(/^[\w-]{1,39}$/)).min(1).max(20) }).strict(),
]);
export type GitHubAction = z.infer<typeof GitHubAction>;
export const GITHUB_ACTION_KINDS = ["open_pr", "update_pr", "ready_pr", "merge_pr", "close_issue", "comment", "request_review"] as const;
export type GitHubActionKind = (typeof GITHUB_ACTION_KINDS)[number];

export const GitHubRead = z.object({ repo: repoName, kind: z.enum(["issue", "pull", "checks", "reviews"]), number: num }).strict();
export type GitHubRead = z.infer<typeof GitHubRead>;

/** The action contacts a person who has not opted in, or names a team. Nothing was sent. */
export class ContactRefused extends Error {}
/** Policy, identity or ownership refuses the action. Nothing was sent. */
export class BrokerRefused extends Error {}

/** A person the action contacts, as GitHub knows them now. */
export type Recipient = { login: string; id: number };
/** Whose contact preferences apply: the cloud maps the superagent to its workspace and instance. */
export type ContactScope = { superagent: string; repo: string };

/**
 * Where contact preferences come from: the cloud, keyed by each person's
 * numeric GitHub user id per workspace, repo and superagent instance. The
 * broker asks at dispatch, never earlier, so an approval cannot freeze a
 * consent that was revoked since. A recipient missing from the answer is
 * refused. The cloud registry wires one in (`GitHubActions.consent`); with
 * none, any action that contacts a person is refused.
 */
export interface ConsentSource {
  check(recipients: Recipient[], scope: ContactScope): Promise<{ id: number; allowed: boolean }[]>;
}

/** The host owner's pin: the policy and the App's private key, which is host config only. */
export type PinnedApp = { policy: BrokerPolicy; appKeyPath: string };

export interface ManagedResult {
  url: string;
  status?: "pending" | "enqueued" | "merged" | "closed";
  /** GitHub's id for an asynchronous merge, for `reconcile`. */
  receipt?: string;
}

/** What one dispatch runs with. `visible` turns true just before the first
 *  request that others can see, so a failure after it is uncertain, not failed. */
export type Dispatch = {
  superagent: string;
  pin: PinnedApp;
  /** The branch `open_pr` creates and `update_pr` must find: from the claim or the request (`actions.ts`). */
  branch: string;
  /** The checkout that holds `head`, for `open_pr` and `update_pr`. */
  cwd: string | null;
  consent: ConsentSource | null;
  /** Checks again that the action is still allowed (policy pin, claim fence). Throws to stop. */
  guard: () => Promise<void>;
  visible: { sent: boolean };
};

interface Pull {
  number: number;
  node_id: string;
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  merge_commit_sha: string | null;
  mergeable: boolean | null;
  mergeable_state: string;
  user: { login: string };
  head: { sha: string };
  base: { ref: string };
}

type Credential = { token: string; login: string; email: string };
type Purpose = "read" | "comment" | "publish" | "review" | "checks" | "merge";

/** GitHub closes an issue on merge when a PR says "fixes #12": issue closure
 *  has its own action and evidence, so a PR must use plain links. */
export function refuseAutomaticClosure(body: string): void {
  if (
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#\d+|\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+https:\/\/github\.com\/[^\s]+\/issues\/\d+/i.test(body)
  )
    throw new BrokerRefused("Use plain issue links instead of automatic closing keywords; issue closure has its own action and evidence.");
}

/** Conservative: quoted text, code, escaped mentions and HTML entities count
 *  too. A team mention has no individual consent and is refused outright. */
export function mentionedPeople(body: string): string[] {
  const decoded = body.replace(/&#(?:x0*40|0*64);?|&commat;/gi, "@");
  const names = [...decoded.matchAll(/@([a-z\d][a-z\d-]{0,38}(?:\/[\w-]+)?)/gi)].map((x) => x[1]!.toLowerCase());
  if (names.some((x) => x.includes("/"))) throw new ContactRefused("Team mentions cannot establish each person's consent. Ask the responsible person in agentbox.");
  return [...new Set(names)];
}

/**
 * Resolve each login to its numeric id now, then read the current consent.
 * A renamed or recycled login must not inherit the old person's opt-in.
 */
export async function checkContactAtDispatch(
  consent: ConsentSource | null,
  scope: ContactScope,
  logins: string[],
  resolve: (login: string) => Promise<{ id: number; login: string }>,
): Promise<void> {
  if (!logins.length) return;
  if (!consent)
    throw new ContactRefused(`Needs a person: ${logins.join(", ")} cannot be contacted without the cloud's contact preferences. Nothing was sent.`);
  const people = await Promise.all(logins.map(resolve));
  const decisions = await consent.check(
    people.map((p) => ({ login: p.login, id: p.id })),
    scope,
  );
  const denied = logins.filter((login, n) => {
    const p = people[n]!;
    const d = decisions.find((x) => x.id === p.id);
    return !d?.allowed || p.login.toLowerCase() !== login.toLowerCase();
  });
  if (denied.length)
    throw new ContactRefused(
      `Needs a person: ${denied.join(", ")} ${denied.length === 1 ? "has" : "have"} no verified opt-in for this scope. Nothing was sent; handle it in agentbox.`,
    );
}

/** A branch name from a claim key or a request id: stable, and safe for git. */
export function brokerBranch(seed: string): string {
  return `agentbox/${/^[\w-]{1,64}$/.test(seed) ? seed : createHash("sha256").update(seed).digest("hex").slice(0, 20)}`;
}

export class GitHubBroker {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // The path and the status only: never a header, so never the token.
    if (!res.ok) throw new Error(`GitHub ${method} ${path} refused (${res.status}); check the App installation's repository permissions.`);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** A request that others can see: from here on, a failure is uncertain. */
  private visible<T>(d: Dispatch, c: Credential, method: string, path: string, body?: unknown): Promise<T> {
    d.visible.sent = true;
    return this.request<T>(c.token, method, path, body);
  }

  /**
   * A token for one repository, with the permissions one purpose needs. It
   * proves first that the key is this App (id and slug[bot] login) and that
   * the installation belongs to the repository's owner.
   */
  private async credential(pin: PinnedApp, repo: string, purpose: Purpose): Promise<Credential> {
    const { app, repos } = pin.policy;
    if (!repos.includes(repo.toLowerCase())) throw new BrokerRefused(`${repo} is outside the pinned policy's repos`);
    if (!isAbsolute(pin.appKeyPath)) throw new BrokerRefused("the App key path must be absolute; pin the policy again with --key");
    let info;
    try {
      info = statSync(pin.appKeyPath);
    } catch {
      throw new BrokerRefused(`the App key ${pin.appKeyPath} does not exist on this host`);
    }
    if (!info.isFile() || info.mode & 0o077 || info.size > 32000) throw new BrokerRefused("the App key must be a private (0600) PEM file on this host");
    const now = Math.floor(Date.now() / 1000);
    const part = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const input = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(app.appId) })}`;
    const jwt = `${input}.${sign("RSA-SHA256", Buffer.from(input), readFileSync(pin.appKeyPath)).toString("base64url")}`;
    const me = await this.request<{ slug: string; id: number }>(jwt, "GET", "/app");
    const login = `${me.slug}[bot]`;
    if (login.toLowerCase() !== app.login.toLowerCase() || me.id !== app.appId) throw new BrokerRefused("the pinned App id and login do not match this App key");
    const installation = await this.request<{ app_id: number; account: { login: string } }>(jwt, "GET", `/app/installations/${app.installationId}`);
    if (installation.app_id !== me.id || installation.account.login.toLowerCase() !== repo.split("/")[0])
      throw new BrokerRefused("the App installation does not belong to this repository's owner");
    const granted = await this.request<{ token: string }>(jwt, "POST", `/app/installations/${app.installationId}/access_tokens`, {
      repositories: [repo.split("/")[1]],
      permissions: {
        contents: purpose === "publish" || purpose === "merge" ? "write" : "read",
        issues: purpose === "comment" ? "write" : "read",
        pull_requests: purpose === "publish" || purpose === "review" ? "write" : "read",
        ...(purpose === "checks" || purpose === "merge" ? { checks: "read", statuses: "read" } : {}),
      },
    });
    const bot = await this.request<{ id: number; login: string }>(granted.token, "GET", `/users/${encodeURIComponent(login)}`);
    return { token: granted.token, login: bot.login, email: `${bot.id}+${bot.login}@users.noreply.github.com` };
  }

  /** Read as the App. Issue text goes to the caller, never into a shared record. */
  async read(pin: PinnedApp, input: GitHubRead): Promise<unknown> {
    const { token } = await this.credential(pin, input.repo, input.kind === "checks" ? "checks" : "read");
    const base = `/repos/${input.repo}`;
    if (input.kind === "reviews") return this.request(token, "GET", `${base}/pulls/${input.number}/reviews?per_page=100`);
    const issue = await this.request<{
      title: string;
      body: string | null;
      html_url: string;
      state: string;
      user: { login: string };
      head?: { sha: string };
      base?: { ref: string };
      labels?: { name: string }[];
      merged?: boolean;
      merge_commit_sha?: string | null;
    }>(token, "GET", `${base}/${input.kind === "issue" ? "issues" : "pulls"}/${input.number}`);
    if (input.kind === "checks") {
      if (!issue.head?.sha) throw new Error("the pull request has no head revision");
      const [checks, status] = await Promise.all([
        this.request(token, "GET", `${base}/commits/${issue.head.sha}/check-runs?per_page=100`),
        this.request(token, "GET", `${base}/commits/${issue.head.sha}/status`),
      ]);
      return { head: issue.head.sha, checks, status };
    }
    return {
      title: issue.title,
      body: (issue.body ?? "").slice(0, 64000),
      url: issue.html_url,
      state: issue.state,
      merged: issue.merged ?? false,
      mergeCommit: issue.merge_commit_sha ?? null,
      author: issue.user.login,
      head: issue.head?.sha,
      base: issue.base?.ref,
      labels: (issue.labels ?? []).map((l) => l.name),
    };
  }

  /** Do one action as the App. The caller has checked the policy's repos and
   *  kinds; the credential checks the repo again. */
  async dispatch(d: Dispatch, action: GitHubAction): Promise<ManagedResult> {
    const c = await this.credential(
      d.pin,
      action.repo,
      action.kind === "comment" || action.kind === "close_issue"
        ? "comment"
        : action.kind === "merge_pr"
          ? "merge"
          : action.kind === "request_review"
            ? "review"
            : "publish",
    );
    const get = <T>(path: string) => this.request<T>(c.token, "GET", path);
    const scope = { superagent: d.superagent, repo: action.repo };
    const consent = (logins: string[]) => checkContactAtDispatch(d.consent, scope, logins, (login) => get(`/users/${encodeURIComponent(login)}`));
    if (action.kind === "merge_pr" || action.kind === "ready_pr" || action.kind === "close_issue") return this.lifecycle(d, action, c, consent);

    const recipients = new Set<string>();
    if (action.kind === "open_pr" || action.kind === "update_pr") refuseAutomaticClosure(`${action.title}\n${action.body}`);
    if (action.kind === "request_review") action.reviewers.forEach((x) => recipients.add(x.toLowerCase()));
    else mentionedPeople(`${action.kind !== "comment" ? action.title : ""}\n${action.body}`).forEach((x) => recipients.add(x));
    if (action.kind === "comment") {
      const issue = await get<{ user: { login: string } }>(`/repos/${action.repo}/issues/${action.number}`);
      // A reply to a report contacts its author even without an @.
      if (issue.user.login.toLowerCase() !== c.login.toLowerCase()) recipients.add(issue.user.login.toLowerCase());
    }
    const check = async () => {
      await d.guard();
      await consent([...recipients]);
    };
    await check();
    if (action.kind === "comment") {
      const r = await this.visible<{ html_url: string }>(d, c, "POST", `/repos/${action.repo}/issues/${action.number}/comments`, { body: action.body });
      return { url: r.html_url };
    }
    if (action.kind === "request_review") {
      await this.visible(d, c, "POST", `/repos/${action.repo}/pulls/${action.number}/requested_reviewers`, { reviewers: action.reviewers });
      return { url: `https://github.com/${action.repo}/pull/${action.number}` };
    }
    return this.publish(d, action, c, get, check);
  }

  /** `open_pr` and `update_pr`: upload the reviewed commit's objects through
   *  the API as the App, so no git command ever holds a token. */
  private async publish(
    d: Dispatch,
    action: Extract<GitHubAction, { kind: "open_pr" | "update_pr" }>,
    c: Credential,
    get: <T>(path: string) => Promise<T>,
    check: () => Promise<void>,
  ): Promise<ManagedResult> {
    const cwd = d.cwd;
    if (!cwd) throw new BrokerRefused("publishing needs the checkout that holds the head commit");
    const git = (args: string[]) => {
      const r = Bun.spawnSync(["git", "--no-pager", ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdout: "pipe", stderr: "pipe", timeout: 15000 });
      if (r.exitCode) throw new Error("could not read the prepared git revision");
      return r.stdout;
    };
    if (git(["rev-parse", "HEAD"]).toString().trim() !== action.head) throw new BrokerRefused("the checkout's head changed; request a new action for the new head");
    const base = await get<{ object: { sha: string } }>(`/repos/${action.repo}/git/ref/heads/${encodeURIComponent(action.base)}`);
    if (git(["merge-base", base.object.sha, action.head]).toString().trim() !== base.object.sha) throw new BrokerRefused("update the change onto the current base before publishing");
    const baseCommit = await get<{ tree: { sha: string } }>(`/repos/${action.repo}/git/commits/${base.object.sha}`);
    let parent = base.object.sha;
    if (action.kind === "update_pr") {
      const pr = await get<{ user: { login: string }; head: { sha: string; ref: string; repo: { full_name: string } }; base: { ref: string } }>(
        `/repos/${action.repo}/pulls/${action.number}`,
      );
      if (
        pr.user.login.toLowerCase() !== c.login.toLowerCase() ||
        pr.head.ref !== d.branch ||
        pr.head.repo.full_name.toLowerCase() !== action.repo ||
        pr.head.sha !== action.remoteHead ||
        pr.base.ref !== action.base
      )
        throw new BrokerRefused("the PR's author, branch, base or approved remote head changed; request a new action");
      parent = pr.head.sha;
    }
    const entries = git(["diff", "--raw", "-z", "--no-renames", base.object.sha, action.head, "--"]).toString().split("\0");
    const tree: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (let n = 0; n < entries.length - 1; n += 2) {
      const fields = entries[n]!.split(" ");
      const path = entries[n + 1]!;
      if (!path || path.startsWith(".github/workflows/")) throw new BrokerRefused("workflow changes need a person to publish them");
      const mode = fields[1]!;
      if (mode === "000000") tree.push({ path, mode: "100644", type: "blob", sha: null });
      else {
        if (!["100644", "100755", "120000"].includes(mode)) throw new BrokerRefused("submodule changes need a person to publish them");
        const data = git(["show", `${action.head}:${path}`]);
        if (data.byteLength > 5_000_000) throw new BrokerRefused("files above 5 MB need a person to publish them");
        const blob = await this.request<{ sha: string }>(c.token, "POST", `/repos/${action.repo}/git/blobs`, { encoding: "base64", content: data.toString("base64") });
        tree.push({ path, mode, type: "blob", sha: blob.sha });
      }
      if (tree.length > 500) throw new BrokerRefused("more than 500 changed paths need a person to publish them");
    }
    if (!tree.length) throw new BrokerRefused("there are no changes to publish");
    const built = await this.request<{ sha: string }>(c.token, "POST", `/repos/${action.repo}/git/trees`, { base_tree: baseCommit.tree.sha, tree });
    if (built.sha !== git(["rev-parse", `${action.head}^{tree}`]).toString().trim()) throw new BrokerRefused("GitHub's tree does not match the reviewed commit");
    const commit = await this.request<{ sha: string }>(c.token, "POST", `/repos/${action.repo}/git/commits`, {
      message: action.title,
      tree: built.sha,
      parents: [parent],
      author: { name: c.login, email: c.email },
    });
    // The objects so far are invisible; the branch and the PR are not. Check again first.
    await check();
    if (action.kind === "update_pr") await this.visible(d, c, "PATCH", `/repos/${action.repo}/git/refs/heads/${d.branch}`, { sha: commit.sha, force: false });
    else await this.visible(d, c, "POST", `/repos/${action.repo}/git/refs`, { ref: `refs/heads/${d.branch}`, sha: commit.sha });
    try {
      await check();
    } catch (e) {
      throw new Error(`Branch ${d.branch} was published, but the PR action stopped: ${(e as Error).message}. Reconcile that branch before another publication.`);
    }
    const pr =
      action.kind === "update_pr"
        ? await this.visible<{ html_url: string }>(d, c, "PATCH", `/repos/${action.repo}/pulls/${action.number}`, { title: action.title, body: action.body })
        : await this.visible<{ html_url: string }>(d, c, "POST", `/repos/${action.repo}/pulls`, { title: action.title, body: action.body, base: action.base, head: d.branch, draft: true });
    return { url: pr.html_url };
  }

  private exactPull(p: Pull, action: { head: string; base: string }): void {
    if (p.head.sha !== action.head || p.base.ref !== action.base) throw new BrokerRefused("the PR's head or base changed; request a new action for the current revision");
  }

  private async lifecycle(
    d: Dispatch,
    action: Extract<GitHubAction, { kind: "merge_pr" | "ready_pr" | "close_issue" }>,
    c: Credential,
    consent: (logins: string[]) => Promise<void>,
  ): Promise<ManagedResult> {
    const root = `/repos/${action.repo}`;
    const number = action.kind === "close_issue" ? action.pullNumber : action.number;
    const get = <T>(path: string) => this.request<T>(c.token, "GET", path);
    let p = await get<Pull>(`${root}/pulls/${number}`);
    this.exactPull(p, action);
    if (action.kind === "close_issue") {
      if (!p.merged || !p.merge_commit_sha) throw new BrokerRefused("the linked fix is not merged");
      if (!action.evidence.some((e) => e.url === p.html_url)) throw new BrokerRefused("the evidence must include the linked merged PR");
      const issue = await get<{ html_url: string; state: string; state_reason: string; pull_request?: unknown; user: { login: string } }>(`${root}/issues/${action.number}`);
      if (issue.pull_request) throw new BrokerRefused("close_issue needs an issue, not a pull request");
      if (issue.state === "closed") {
        if (issue.state_reason !== "completed") throw new BrokerRefused("the issue was closed for another reason; ask its responsible person");
        return { url: issue.html_url, status: "closed" };
      }
      await d.guard();
      await consent(issue.user.login.toLowerCase() === c.login.toLowerCase() ? [] : [issue.user.login.toLowerCase()]);
      const closed = await this.visible<{ html_url: string; state: string; state_reason: string }>(d, c, "PATCH", `${root}/issues/${action.number}`, {
        state: "closed",
        state_reason: "completed",
      });
      if (closed.state !== "closed" || closed.state_reason !== "completed") throw new Error("GitHub did not confirm the issue closed");
      return { url: closed.html_url, status: "closed" };
    }
    if (action.kind === "ready_pr") {
      if (p.state !== "open" || p.merged) throw new BrokerRefused("the PR is no longer open");
      if (!p.draft) return { url: p.html_url };
      if (p.user.login.toLowerCase() !== c.login.toLowerCase()) throw new BrokerRefused("only the App's own draft can be marked ready");
      refuseAutomaticClosure(`${p.title}\n${p.body ?? ""}`);
      await d.guard();
      await consent(mentionedPeople(`${p.title}\n${p.body ?? ""}`));
      const result = await this.visible<{ errors?: unknown[]; data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft: boolean } } } }>(d, c, "POST", "/graphql", {
        query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
        variables: { id: p.node_id },
      });
      if (result.errors || result.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) throw new Error("GitHub did not confirm the draft as ready");
      return { url: p.html_url };
    }
    if (p.merged && p.merge_commit_sha) return { url: p.html_url, status: "merged" };
    if (p.state !== "open" || p.draft || p.mergeable !== true || !["clean", "unstable", "blocked"].includes(p.mergeable_state))
      throw new BrokerRefused("the PR must be ready, free of conflicts and have computed mergeability before a protected merge");
    refuseAutomaticClosure(`${p.title}\n${p.body ?? ""}`);
    const links = await this.request<{ errors?: unknown[]; data?: { node?: { closingIssuesReferences?: { totalCount: number } } } }>(c.token, "POST", "/graphql", {
      query: "query($id:ID!){node(id:$id){... on PullRequest{closingIssuesReferences(first:1){totalCount}}}}",
      variables: { id: p.node_id },
    });
    if (links.errors || links.data?.node?.closingIssuesReferences?.totalCount !== 0)
      throw new BrokerRefused("remove automatic issue-closing links before a managed merge; issue closure has its own action");
    const commitMentions = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const commits = await get<{ commit: { message: string } }[]>(`${root}/pulls/${number}/commits?per_page=100&page=${page}`);
      for (const commit of commits) {
        refuseAutomaticClosure(commit.commit.message);
        mentionedPeople(commit.commit.message).forEach((login) => commitMentions.add(login));
      }
      if (commits.length < 100) break;
      if (page === 10) throw new BrokerRefused("the commit history is above the managed limit; a person must review it");
    }
    const checks = await get<{ total_count: number; check_runs: { name: string; status: string; conclusion: string | null }[] }>(
      `${root}/commits/${action.head}/check-runs?per_page=100&filter=latest`,
    );
    const statuses = await get<{ total_count: number; statuses: { context: string; state: string }[] }>(`${root}/commits/${action.head}/status?per_page=100`);
    if (checks.total_count > checks.check_runs.length || statuses.total_count > statuses.statuses.length)
      throw new BrokerRefused("the check results are more than one page; a person must look at all of them");
    if (
      checks.check_runs.some((x) => x.status !== "completed" || !["success", "neutral", "skipped"].includes(x.conclusion ?? "")) ||
      statuses.statuses.some((x) => x.state !== "success")
    )
      throw new BrokerRefused("the PR's checks are pending or failing");
    const policy = d.pin.policy.mergePolicy;
    for (const required of policy.requiredChecks)
      if (!checks.check_runs.some((x) => x.name === required && x.conclusion === "success") && !statuses.statuses.some((x) => x.context === required && x.state === "success"))
        throw new BrokerRefused(`the required check ${required} has not succeeded on the approved head`);
    type Review = { user: { id: number; login: string; type: string }; state: string; commit_id: string };
    const latest = new Map<number, Review>();
    for (let page = 1; page <= 10; page++) {
      const rows = await get<Review[]>(`${root}/pulls/${number}/reviews?per_page=100&page=${page}`);
      for (const review of rows) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)) latest.set(review.user.id, review);
      if (rows.length < 100) break;
      if (page === 10) throw new BrokerRefused("the review history is above the managed limit; a person must review it");
    }
    const reviews = [...latest.values()];
    if (
      reviews.some((r) => r.state === "CHANGES_REQUESTED") ||
      reviews.filter((r) => r.state === "APPROVED" && r.commit_id === action.head && r.user.type === "User" && r.user.login.toLowerCase() !== p.user.login.toLowerCase()).length <
        policy.minApprovals
    )
      throw new BrokerRefused("the review requirements on the current head are not met");
    // Read again after the checks, then send an exact-head merge request.
    // GitHub applies branch protection, rulesets and merge queues; bypass is off.
    p = await get<Pull>(`${root}/pulls/${number}`);
    this.exactPull(p, action);
    if (p.draft || p.state !== "open") throw new BrokerRefused("the PR's readiness changed during validation");
    await d.guard();
    await consent([...new Set([...mentionedPeople(`${p.title}\n${p.body ?? ""}`), ...commitMentions])]);
    const result = await this.visible<{ status: "pending" | "enqueued" | "merged" | "failed"; details?: { uuid?: string } }>(d, c, "PUT", `${root}/pulls/${number}/merge-async`, {
      sha: action.head,
      merge_method: action.method,
      merge_action: "default",
      bypass_rules: false,
      commit_title: `Merge pull request #${number}`,
      commit_message: "Merged by agentbox within its pinned policy",
    });
    if (!["pending", "enqueued", "merged"].includes(result.status)) throw new Error("GitHub did not accept the protected merge request");
    return { url: p.html_url, status: result.status as "pending" | "enqueued" | "merged", receipt: result.details?.uuid };
  }

  /** Read what a sent or interrupted merge or closure did. Never sends it
   *  again. "rejected": GitHub refused the merge, so nothing merged. */
  async reconcile(pin: PinnedApp, action: GitHubAction, receipt?: string): Promise<ManagedResult | "rejected" | null> {
    if (action.kind !== "merge_pr" && action.kind !== "close_issue") return null;
    const { token } = await this.credential(pin, action.repo, "merge");
    const number = action.kind === "merge_pr" ? action.number : action.pullNumber;
    const root = `/repos/${action.repo}`;
    const p = await this.request<Pull>(token, "GET", `${root}/pulls/${number}`);
    this.exactPull(p, action);
    if (!p.merged || !p.merge_commit_sha) {
      if (receipt && action.kind === "merge_pr") {
        const r = await this.request<{ status: string }>(token, "GET", `${root}/pulls/${number}/merge-async/${encodeURIComponent(receipt)}`);
        if (r.status === "failed") return "rejected";
      }
      return null;
    }
    if (action.kind === "merge_pr") return { url: p.html_url, status: "merged" };
    const issue = await this.request<{ html_url: string; state: string; state_reason: string }>(token, "GET", `${root}/issues/${action.number}`);
    return issue.state === "closed" && issue.state_reason === "completed" ? { url: issue.html_url, status: "closed" } : null;
  }
}
