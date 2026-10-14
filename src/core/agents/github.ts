/** Trusted GitHub App boundary. Installation tokens never leave this module:
 * not in a session environment, a git command, the cloud, or an HTTP answer. */
import { sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { InstallationAgents } from "../../cloud/agent-client";
import type { SharedAgent, AgentRun } from "../../cloud/agents";
import type { AgentBinding } from "./store";

const repo = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .transform((x) => x.toLowerCase());
const text = z.string().max(24000);
export const GitHubAction = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready_pr"),
      repo,
      number: z.number().int().positive(),
      head: z.string().regex(/^[0-9a-f]{40}$/),
      base: z.string().regex(/^[\w./-]{1,200}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("merge_pr"),
      repo,
      number: z.number().int().positive(),
      head: z.string().regex(/^[0-9a-f]{40}$/),
      base: z.string().regex(/^[\w./-]{1,200}$/),
      method: z.enum(["merge", "squash", "rebase"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("close_issue"),
      repo,
      number: z.number().int().positive(),
      pullNumber: z.number().int().positive(),
      head: z.string().regex(/^[0-9a-f]{40}$/),
      base: z.string().regex(/^[\w./-]{1,200}$/),
      verification: z.string().min(1).max(2000),
      evidence: z
        .array(
          z
            .object({
              url: z
                .string()
                .url()
                .regex(/^https?:/)
                .max(2000),
              label: z.string().min(1).max(160),
            })
            .strict(),
        )
        .min(1)
        .max(30),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open_pr"),
      repo,
      title: z.string().min(1).max(200),
      body: text,
      base: z.string().regex(/^[\w./-]{1,200}$/),
      head: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_pr"),
      repo,
      number: z.number().int().positive(),
      title: z.string().min(1).max(200),
      body: text,
      base: z.string().regex(/^[\w./-]{1,200}$/),
      head: z.string().regex(/^[0-9a-f]{40}$/),
      remoteHead: z.string().regex(/^[0-9a-f]{40}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("comment"),
      repo,
      number: z.number().int().positive(),
      body: text.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("request_review"),
      repo,
      number: z.number().int().positive(),
      reviewers: z
        .array(z.string().regex(/^[\w-]{1,39}$/))
        .min(1)
        .max(20),
    })
    .strict(),
]);
export type GitHubAction = z.infer<typeof GitHubAction>;
export const GitHubRead = z
  .object({
    repo,
    kind: z.enum(["issue", "pull", "checks", "reviews"]),
    number: z.number().int().positive(),
  })
  .strict();
export class ContactRefused extends Error {}
export interface ManagedResult {
  html_url: string;
  status?: "pending" | "enqueued" | "merged" | "closed";
  receipt?: string;
}
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
// Otherwise GitHub could close an issue during merge before the configured
// resolution policy has been satisfied. Use plain links in prepared PRs.
export function refuseAutomaticClosure(body: string) {
  if (
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#\d+|\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+https:\/\/github\.com\/[^\s]+\/issues\/\d+/i.test(
      body,
    )
  )
    throw new Error(
      "Use plain issue links instead of automatic closing keywords; issue closure has its own resolution policy and approval.",
    );
}

/** Conservative: include quoted text, code, escaped mentions and HTML entities
 * too. Team mentions have no individual consent and are refused outright. */
export function mentionedPeople(text: string): string[] {
  const decoded = text.replace(/&#(?:x0*40|0*64);?|&commat;/gi, "@");
  const names = [
    ...decoded.matchAll(/@([a-z\d][a-z\d-]{0,38}(?:\/[\w-]+)?)/gi),
  ].map((x) => x[1]!.toLowerCase());
  if (names.some((x) => x.includes("/")))
    throw new ContactRefused(
      "Team mentions cannot establish each person's consent. Ask the responsible human in Agentbox.",
    );
  return [...new Set(names)];
}

export async function checkContactAtDispatch(
  api: Pick<InstallationAgents, "contacts">,
  agent: string,
  repo: string,
  logins: string[],
  resolve: (login: string) => Promise<{ id: number; login: string }>,
): Promise<void> {
  if (!logins.length) return;
  // Resolve first, then consult current consent immediately before dispatch.
  // A GitHub rename/recycled login must not inherit the old person's opt-in.
  const identities = await Promise.all(logins.map(resolve));
  const decisions = await api.contacts(agent, repo, logins);
  const denied = logins.filter((login, n) => {
    const d = decisions.find(
      (x) => x.login.toLowerCase() === login.toLowerCase(),
    );
    return (
      !d?.allowed ||
      d.github_user_id !== String(identities[n]!.id) ||
      identities[n]!.login.toLowerCase() !== login.toLowerCase()
    );
  });
  if (denied.length)
    throw new ContactRefused(
      `Needs human: ${denied.join(", ")} ${denied.length === 1 ? "has" : "have"} no verified opt-in for this scope. No outreach sent; handle the question in Agentbox.`,
    );
}

export class AgentGitHub {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async request<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
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
    if (!res.ok)
      throw new Error(
        `GitHub ${method} ${path} refused (${res.status}); check the App installation's repository permissions.`,
      );
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  private async credential(
    a: SharedAgent,
    binding: AgentBinding,
    repo: string,
    purpose: "read" | "comment" | "publish" | "review" | "checks" | "merge",
  ) {
    const actor = a.definition.github;
    if (!a.definition.repos.includes(repo.toLowerCase()))
      throw new Error("repository is outside this agent's allowed scope");
    if (
      actor.kind !== "app" ||
      !actor.appId ||
      !/^\d+$/.test(actor.installationId) ||
      !isAbsolute(binding.appKeyPath)
    )
      throw new Error(
        "Connect a GitHub App on the execution host for managed GitHub actions. Local investigation does not need one.",
      );
    const info = statSync(binding.appKeyPath);
    if (!info.isFile() || info.mode & 0o077 || info.size > 32000)
      throw new Error(
        "the App key must be a private (0600) PEM file on the execution host",
      );
    const now = Math.floor(Date.now() / 1000);
    const part = (x: unknown) =>
      Buffer.from(JSON.stringify(x)).toString("base64url");
    const input = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: actor.appId })}`;
    const jwt = `${input}.${sign("RSA-SHA256", Buffer.from(input), readFileSync(binding.appKeyPath)).toString("base64url")}`;
    const app = await this.request<{
      slug: string;
      id: number;
      client_id: string;
    }>(jwt, "GET", "/app");
    const login = `${app.slug}[bot]`;
    if (
      login.toLowerCase() !== actor.login.toLowerCase() ||
      ![String(app.id), app.client_id].includes(actor.appId)
    )
      throw new Error(
        "the configured GitHub actor does not match this App key",
      );
    const installation = await this.request<{
      app_id: number;
      account: { login: string };
    }>(jwt, "GET", `/app/installations/${actor.installationId}`);
    if (
      installation.app_id !== app.id ||
      installation.account.login.toLowerCase() !== repo.split("/")[0]
    )
      throw new Error(
        "the App installation does not belong to this repository owner",
      );
    const granted = await this.request<{ token: string }>(
      jwt,
      "POST",
      `/app/installations/${actor.installationId}/access_tokens`,
      {
        repositories: [repo.split("/")[1]],
        permissions: {
          contents:
            purpose === "publish" || purpose === "merge" ? "write" : "read",
          issues: purpose === "comment" ? "write" : "read",
          pull_requests:
            purpose === "publish" || purpose === "review" ? "write" : "read",
          ...(purpose === "checks" || purpose === "merge"
            ? { checks: "read", statuses: "read" }
            : {}),
        },
      },
    );
    const bot = await this.request<{ id: number; login: string }>(
      granted.token,
      "GET",
      `/users/${encodeURIComponent(login)}`,
    );
    return {
      token: granted.token,
      login: bot.login,
      email: `${bot.id}+${bot.login}@users.noreply.github.com`,
    };
  }
  async issues(
    a: SharedAgent,
    binding: AgentBinding,
    repo: string,
    label = "",
  ) {
    const { token } = await this.credential(
      a,
      binding,
      repo.toLowerCase(),
      "read",
    );
    const result: { source: string; title: string; acceptance: string }[] = [];
    // Incremental intake must not discard older open issues behind a busy
    // page. Bound a pass, retain the next cursor in the runtime if needed.
    for (let page = 1; page <= 20; page++) {
      const rows = await this.request<
        { html_url: string; title: string; pull_request?: unknown }[]
      >(
        token,
        "GET",
        `/repos/${repo}/issues?state=open&sort=created&direction=asc&per_page=100&page=${page}${label ? `&labels=${encodeURIComponent(label)}` : ""}`,
      );
      result.push(
        ...rows
          .filter((x) => !x.pull_request)
          .map((x) => ({
            source: x.html_url,
            title: x.title.slice(0, 200),
            acceptance:
              "Inspect the linked issue; reproduce and verify the reported behavior.",
          })),
      );
      if (rows.length < 100) return result;
    }
    throw new Error(
      "More than 2,000 matching issues. Narrow the source label so intake can cover the full source without dropping work.",
    );
  }
  async reviewBase(
    a: SharedAgent,
    binding: AgentBinding,
    repo: string,
    branch: string,
  ) {
    const { token } = await this.credential(a, binding, repo, "read");
    const ref = await this.request<{ object: { sha: string } }>(
      token,
      "GET",
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .parse(ref.object.sha);
  }
  /** Read with the configured actor. The token stays here; issue content
   * goes to the provider, never into shared operational records. */
  async read(
    a: SharedAgent,
    binding: AgentBinding,
    input: z.infer<typeof GitHubRead>,
  ) {
    if (!a.definition.actions.includes("investigate"))
      throw new Error("investigation is outside this agent's policy");
    const { token } = await this.credential(
      a,
      binding,
      input.repo,
      input.kind === "checks" ? "checks" : "read",
    );
    const base = `/repos/${input.repo}`;
    if (input.kind === "reviews")
      return this.request(
        token,
        "GET",
        `${base}/pulls/${input.number}/reviews?per_page=100`,
      );
    const issue = await this.request<{
      title: string;
      body: string | null;
      html_url: string;
      state: string;
      user: { login: string };
      head?: { sha: string };
      base?: { ref: string };
      labels: { name: string }[];
      merged?: boolean;
      merge_commit_sha?: string | null;
    }>(
      token,
      "GET",
      `${base}/${input.kind === "issue" ? "issues" : "pulls"}/${input.number}`,
    );
    if (input.kind === "checks") {
      if (!issue.head?.sha)
        throw new Error("pull request has no head revision");
      const [checks, status] = await Promise.all([
        this.request(
          token,
          "GET",
          `${base}/commits/${issue.head.sha}/check-runs?per_page=100`,
        ),
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
      labels: issue.labels.map((l) => l.name),
    };
  }
  async dispatch(
    a: SharedAgent,
    run: AgentRun,
    binding: AgentBinding,
    action: GitHubAction,
    cwd: string,
    cloud: InstallationAgents,
    guard: () => Promise<void>,
    publication?: (mapping: {
      base: string;
      head: string;
      tree: string;
      remoteHead: string;
    }) => Promise<void>,
  ): Promise<ManagedResult> {
    const permission =
      action.kind === "comment"
        ? "investigate"
        : action.kind === "merge_pr"
          ? "merge"
          : action.kind === "close_issue"
            ? "close_issue"
            : "open_pr";
    if (!a.definition.actions.includes(permission))
      throw new Error(`this agent is not allowed to ${permission}`);
    if (
      ["open_pr", "update_pr"].includes(action.kind) &&
      !a.definition.actions.includes("edit")
    )
      throw new Error("publishing a fix requires edit permission");
    const c = await this.credential(
      a,
      binding,
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
    if (
      action.kind === "merge_pr" ||
      action.kind === "ready_pr" ||
      action.kind === "close_issue"
    ) {
      return this.lifecycle(a, action, c, cloud, guard);
    }
    const recipients = new Set<string>();
    if (action.kind === "open_pr" || action.kind === "update_pr")
      refuseAutomaticClosure(`${action.title}\n${action.body}`);
    if (action.kind === "request_review")
      action.reviewers.forEach((x) => recipients.add(x.toLowerCase()));
    else
      mentionedPeople(
        `${action.kind !== "comment" ? action.title : ""}\n${action.body}`,
      ).forEach((x) => recipients.add(x));
    if (action.kind === "comment") {
      const issue = await get<{ user: { login: string } }>(
        `/repos/${action.repo}/issues/${action.number}`,
      );
      // A targeted response to a report contacts its author even without @.
      if (issue.user.login.toLowerCase() !== c.login.toLowerCase())
        recipients.add(issue.user.login.toLowerCase());
    }
    const consent = () =>
      checkContactAtDispatch(
        cloud,
        a.id,
        action.repo,
        [...recipients],
        (login) => get(`/users/${encodeURIComponent(login)}`),
      );
    await guard();
    await consent();
    if (action.kind === "comment")
      return this.request<{ html_url: string }>(
        c.token,
        "POST",
        `/repos/${action.repo}/issues/${action.number}/comments`,
        { body: action.body },
      );
    if (action.kind === "request_review") {
      await this.request(
        c.token,
        "POST",
        `/repos/${action.repo}/pulls/${action.number}/requested_reviewers`,
        { reviewers: action.reviewers },
      );
      return {
        html_url: `https://github.com/${action.repo}/pull/${action.number}`,
      };
    }
    const git = (args: string[]) => {
      const r = Bun.spawnSync(["git", "--no-pager", ...args], {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
      });
      if (r.exitCode)
        throw new Error("could not read the prepared git revision");
      return r.stdout;
    };
    if (git(["rev-parse", "HEAD"]).toString().trim() !== action.head)
      throw new Error(
        "prepared head changed; prepare a new action for the new head",
      );
    const base = await get<{ object: { sha: string } }>(
      `/repos/${action.repo}/git/ref/heads/${encodeURIComponent(action.base)}`,
    );
    if (
      git(["merge-base", base.object.sha, action.head]).toString().trim() !==
      base.object.sha
    )
      throw new Error("update the fix onto the current base before publishing");
    const baseCommit = await get<{ tree: { sha: string } }>(
      `/repos/${action.repo}/git/commits/${base.object.sha}`,
    );
    const branch = `agentbox/${run.id}`;
    let parent = base.object.sha;
    if (action.kind === "update_pr") {
      const pr = await get<{
        user: { login: string };
        head: { sha: string; ref: string; repo: { full_name: string } };
        base: { ref: string };
      }>(`/repos/${action.repo}/pulls/${action.number}`);
      if (
        pr.user.login.toLowerCase() !== c.login.toLowerCase() ||
        pr.head.ref !== branch ||
        pr.head.repo.full_name.toLowerCase() !== action.repo ||
        pr.head.sha !== action.remoteHead ||
        pr.base.ref !== action.base
      )
        throw new Error(
          "the PR actor, branch, base or approved remote head changed; prepare a new action",
        );
      parent = pr.head.sha;
    }
    const entries = git([
      "diff",
      "--raw",
      "-z",
      "--no-renames",
      base.object.sha,
      action.head,
      "--",
    ])
      .toString()
      .split("\0");
    const tree: {
      path: string;
      mode: string;
      type: string;
      sha: string | null;
    }[] = [];
    for (let n = 0; n < entries.length - 1; n += 2) {
      const fields = entries[n]!.split(" "),
        path = entries[n + 1]!;
      if (!path || path.startsWith(".github/workflows/"))
        throw new Error(
          "workflow changes require a human-managed publication path",
        );
      const mode = fields[1]!;
      if (mode === "000000")
        tree.push({ path, mode: "100644", type: "blob", sha: null });
      else {
        if (!["100644", "100755", "120000"].includes(mode))
          throw new Error("submodule changes require human publication");
        const data = git(["show", `${action.head}:${path}`]);
        if (data.byteLength > 5_000_000)
          throw new Error("files above 5 MB require human publication");
        const blob = await this.request<{ sha: string }>(
          c.token,
          "POST",
          `/repos/${action.repo}/git/blobs`,
          { encoding: "base64", content: data.toString("base64") },
        );
        tree.push({ path, mode, type: "blob", sha: blob.sha });
      }
      if (tree.length > 500)
        throw new Error(
          "more than 500 changed paths require human publication",
        );
    }
    if (!tree.length) throw new Error("there are no changes to publish");
    const built = await this.request<{ sha: string }>(
      c.token,
      "POST",
      `/repos/${action.repo}/git/trees`,
      { base_tree: baseCommit.tree.sha, tree },
    );
    const commit = await this.request<{ sha: string }>(
      c.token,
      "POST",
      `/repos/${action.repo}/git/commits`,
      {
        message: action.title,
        tree: built.sha,
        parents: [parent],
        author: { name: c.login, email: c.email },
      },
    );
    if (
      built.sha !==
      git(["rev-parse", `${action.head}^{tree}`])
        .toString()
        .trim()
    )
      throw new Error(
        "GitHub tree does not match the independently reviewed candidate",
      );
    await publication?.({
      base: base.object.sha,
      head: action.head,
      tree: built.sha,
      remoteHead: commit.sha,
    });
    // These are the externally visible steps: revalidate after preparation.
    await guard();
    await consent();
    if (action.kind === "update_pr")
      await this.request(
        c.token,
        "PATCH",
        `/repos/${action.repo}/git/refs/heads/${branch}`,
        { sha: commit.sha, force: false },
      );
    else
      await this.request(c.token, "POST", `/repos/${action.repo}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    try {
      await guard();
      await consent();
    } catch (e) {
      throw new Error(
        `Branch ${branch} was published, but the PR action stopped: ${(e as Error).message}. Reconcile that branch before another publication.`,
      );
    }
    if (action.kind === "update_pr")
      return this.request<{
        html_url: string;
        number: number;
        head: { sha: string };
      }>(c.token, "PATCH", `/repos/${action.repo}/pulls/${action.number}`, {
        title: action.title,
        body: action.body,
      });
    return this.request<{
      html_url: string;
      number: number;
      head: { sha: string };
    }>(c.token, "POST", `/repos/${action.repo}/pulls`, {
      title: action.title,
      body: action.body,
      base: action.base,
      head: branch,
      draft: true,
    });
  }

  private exactPull(p: Pull, action: { head: string; base: string }) {
    if (p.head.sha !== action.head || p.base.ref !== action.base)
      throw new Error(
        "PR head or base changed; prepare a new action for the current revision",
      );
  }
  private async lifecycle(
    a: SharedAgent,
    action: Extract<
      GitHubAction,
      { kind: "merge_pr" | "ready_pr" | "close_issue" }
    >,
    c: { token: string; login: string },
    cloud: InstallationAgents,
    guard: () => Promise<void>,
  ): Promise<ManagedResult> {
    const root = `/repos/${action.repo}`,
      number =
        action.kind === "close_issue" ? action.pullNumber : action.number;
    const get = <T>(path: string) => this.request<T>(c.token, "GET", path);
    let p = await get<Pull>(`${root}/pulls/${number}`);
    this.exactPull(p, action);
    if (action.kind === "close_issue") {
      if (!p.merged || !p.merge_commit_sha)
        throw new Error("the linked fix has not been confirmed merged");
      if (!action.evidence.some((e) => e.url === p.html_url))
        throw new Error(
          "resolution evidence must include the linked merged PR",
        );
      const issue = await get<{
        html_url: string;
        state: string;
        state_reason: string;
        pull_request?: unknown;
        user: { login: string };
      }>(`${root}/issues/${action.number}`);
      if (issue.pull_request)
        throw new Error("close_issue requires an issue, not a pull request");
      if (issue.state === "closed") {
        if (issue.state_reason !== "completed")
          throw new Error(
            "issue was closed for another reason; reconcile with its responsible human",
          );
        return { html_url: issue.html_url, status: "closed" };
      }
      await guard();
      await checkContactAtDispatch(
        cloud,
        a.id,
        action.repo,
        issue.user.login.toLowerCase() === c.login.toLowerCase()
          ? []
          : [issue.user.login.toLowerCase()],
        (login) => get(`/users/${encodeURIComponent(login)}`),
      );
      const closed = await this.request<{
        html_url: string;
        state: string;
        state_reason: string;
      }>(c.token, "PATCH", `${root}/issues/${action.number}`, {
        state: "closed",
        state_reason: "completed",
      });
      if (closed.state !== "closed" || closed.state_reason !== "completed")
        throw new Error("issue closure was not confirmed");
      return { html_url: closed.html_url, status: "closed" };
    }
    if (action.kind === "ready_pr") {
      if (p.state !== "open" || p.merged)
        throw new Error("PR is no longer open");
      if (!p.draft) return { html_url: p.html_url };
      if (p.user.login.toLowerCase() !== c.login.toLowerCase())
        throw new Error("only this agent's own draft can be marked ready");
      refuseAutomaticClosure(`${p.title}\n${p.body ?? ""}`);
      await guard();
      await checkContactAtDispatch(
        cloud,
        a.id,
        action.repo,
        mentionedPeople(`${p.title}\n${p.body ?? ""}`),
        (login) => get(`/users/${encodeURIComponent(login)}`),
      );
      const result = await this.request<{
        errors?: unknown[];
        data?: {
          markPullRequestReadyForReview?: {
            pullRequest?: { isDraft: boolean };
          };
        };
      }>(c.token, "POST", "/graphql", {
        query:
          "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}",
        variables: { id: p.node_id },
      });
      if (
        result.errors ||
        result.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !==
          false
      )
        throw new Error("GitHub did not confirm the draft as ready");
      return { html_url: p.html_url };
    }
    if (p.merged && p.merge_commit_sha)
      return { html_url: p.html_url, status: "merged" };
    if (
      p.state !== "open" ||
      p.draft ||
      p.mergeable !== true ||
      !["clean", "unstable", "blocked"].includes(p.mergeable_state)
    )
      throw new Error(
        "PR must be ready, conflict-free and have computed mergeability before requesting a protected merge",
      );
    refuseAutomaticClosure(`${p.title}\n${p.body ?? ""}`);
    const links = await this.request<{
      errors?: unknown[];
      data?: { node?: { closingIssuesReferences?: { totalCount: number } } };
    }>(c.token, "POST", "/graphql", {
      query:
        "query($id:ID!){node(id:$id){... on PullRequest{closingIssuesReferences(first:1){totalCount}}}}",
      variables: { id: p.node_id },
    });
    if (
      links.errors ||
      links.data?.node?.closingIssuesReferences?.totalCount !== 0
    )
      throw new Error(
        "remove automatic issue-closing links before a managed merge; issue resolution has a separate evidence gate",
      );
    const commitMentions = new Set<string>();
    for (let page = 1; page <= 10; page++) {
      const commits = await get<{ commit: { message: string } }[]>(
        `${root}/pulls/${number}/commits?per_page=100&page=${page}`,
      );
      for (const commit of commits) {
        refuseAutomaticClosure(commit.commit.message);
        mentionedPeople(commit.commit.message).forEach((login) =>
          commitMentions.add(login),
        );
      }
      if (commits.length < 100) break;
      if (page === 10)
        throw new Error(
          "commit history exceeds the managed limit; human review required",
        );
    }
    const checks = await get<{
      total_count: number;
      check_runs: { name: string; status: string; conclusion: string | null }[];
    }>(`${root}/commits/${action.head}/check-runs?per_page=100&filter=latest`);
    const statuses = await get<{
      total_count: number;
      statuses: { context: string; state: string }[];
    }>(`${root}/commits/${action.head}/status?per_page=100`);
    if (
      checks.total_count > checks.check_runs.length ||
      statuses.total_count > statuses.statuses.length
    )
      throw new Error(
        "check results exceed one page; a human must inspect the full result set",
      );
    if (
      checks.check_runs.some(
        (x) =>
          x.status !== "completed" ||
          !["success", "neutral", "skipped"].includes(x.conclusion ?? ""),
      ) ||
      statuses.statuses.some((x) => x.state !== "success")
    )
      throw new Error("PR checks are pending or failing");
    for (const required of a.definition.mergePolicy.requiredChecks)
      if (
        !checks.check_runs.some(
          (x) => x.name === required && x.conclusion === "success",
        ) &&
        !statuses.statuses.some(
          (x) => x.context === required && x.state === "success",
        )
      )
        throw new Error(
          `required check ${required} has not succeeded on the approved head`,
        );
    type Review = {
      user: { id: number; login: string; type: string };
      state: string;
      commit_id: string;
    };
    const latest = new Map<number, Review>();
    for (let page = 1; page <= 10; page++) {
      const rows = await get<Review[]>(
        `${root}/pulls/${number}/reviews?per_page=100&page=${page}`,
      );
      for (const review of rows)
        if (
          ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state)
        )
          latest.set(review.user.id, review);
      if (rows.length < 100) break;
      if (page === 10)
        throw new Error(
          "review history exceeds the managed limit; human review required",
        );
    }
    const reviews = [...latest.values()];
    if (
      reviews.some((r) => r.state === "CHANGES_REQUESTED") ||
      reviews.filter(
        (r) =>
          r.state === "APPROVED" &&
          r.commit_id === action.head &&
          r.user.type === "User" &&
          r.user.login.toLowerCase() !== p.user.login.toLowerCase(),
      ).length < a.definition.mergePolicy.minApprovals
    )
      throw new Error(
        "current-head human review requirements have not been met",
      );
    // Re-read after checks, then send an exact-head merge request. GitHub
    // evaluates branch/ruleset requirements and merge queues with bypass off.
    p = await get<Pull>(`${root}/pulls/${number}`);
    this.exactPull(p, action);
    if (p.draft || p.state !== "open")
      throw new Error("PR readiness changed during validation");
    await guard();
    await checkContactAtDispatch(
      cloud,
      a.id,
      action.repo,
      [
        ...new Set([
          ...mentionedPeople(`${p.title}\n${p.body ?? ""}`),
          ...commitMentions,
        ]),
      ],
      (login) => get(`/users/${encodeURIComponent(login)}`),
    );
    const result = await this.request<{
      status: "pending" | "enqueued" | "merged" | "failed";
      details?: { uuid?: string };
    }>(c.token, "PUT", `${root}/pulls/${number}/merge-async`, {
      sha: action.head,
      merge_method: action.method,
      merge_action: "default",
      bypass_rules: false,
      commit_title: `Merge pull request #${number}`,
      commit_message: "Agentbox policy-approved fix",
    });
    if (!["pending", "enqueued", "merged"].includes(result.status))
      throw new Error("GitHub did not accept the protected merge request");
    return {
      html_url: p.html_url,
      status: result.status as "pending" | "enqueued" | "merged",
      receipt: result.details?.uuid,
    };
  }

  /** Read-only recovery of a submitted side effect. Never issues another
   * merge or closure after a network interruption. */
  async reconcile(
    a: SharedAgent,
    binding: AgentBinding,
    action: GitHubAction,
    receipt?: string,
  ): Promise<ManagedResult | null> {
    if (action.kind !== "merge_pr" && action.kind !== "close_issue")
      return null;
    const { token } = await this.credential(a, binding, action.repo, "merge");
    const number =
      action.kind === "merge_pr" ? action.number : action.pullNumber;
    const root = `/repos/${action.repo}`;
    const p = await this.request<Pull>(token, "GET", `${root}/pulls/${number}`);
    this.exactPull(p, action);
    if (!p.merged || !p.merge_commit_sha) {
      if (receipt && action.kind === "merge_pr") {
        const r = await this.request<{ status: string }>(
          token,
          "GET",
          `${root}/pulls/${number}/merge-async/${encodeURIComponent(receipt)}`,
        );
        if (r.status === "failed")
          throw new Error(
            "GitHub rejected the protected merge request; inspect required checks/reviews and prepare a new action",
          );
      }
      return null;
    }
    if (action.kind === "merge_pr")
      return { html_url: p.html_url, status: "merged" };
    const issue = await this.request<{
      html_url: string;
      state: string;
      state_reason: string;
    }>(token, "GET", `${root}/issues/${action.number}`);
    return issue.state === "closed" && issue.state_reason === "completed"
      ? { html_url: issue.html_url, status: "closed" }
      : null;
  }
}
