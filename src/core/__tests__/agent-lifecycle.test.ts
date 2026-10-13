/** Security regression: an approved action cannot bypass current-head checks,
 * reviews, contact revocation or resolution evidence. No external mutations. */
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentGitHub, type GitHubAction } from "../agents/github";
import {
  AgentDefinition,
  type SharedAgent,
  type AgentRun,
} from "../../cloud/agents";
import type { InstallationAgents } from "../../cloud/agent-client";
import type { AgentBinding } from "../agents/store";

test("merge and issue closure preserve exact-head policy and reconcile without replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-lifecycle-"));
  try {
    const git = (args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.test"]);
    writeFileSync(join(dir, "sum.ts"), "export const sum = (a, b) => a - b;\n");
    git(["add", "sum.ts"]);
    git(["commit", "-m", "Fixture"]);
    const base = git(["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "sum.ts"), "export const sum = (a, b) => a + b;\n");
    git(["add", "sum.ts"]);
    git(["commit", "-m", "Prepare arithmetic fix"]);
    const preparedHead = git(["rev-parse", "HEAD"]);
    const pem = join(dir, "app.pem");
    writeFileSync(
      pem,
      generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey,
      { mode: 0o600 },
    );
    const head = "a".repeat(40),
      repo = "fixture/repo";
    const pull = {
      number: 2,
      node_id: "PR_fixture",
      html_url: `https://github.com/${repo}/pull/2`,
      title: "Prepared fix",
      body: "Related to #1",
      state: "open",
      draft: false,
      merged: false,
      merge_commit_sha: null as string | null,
      mergeable: true,
      mergeable_state: "clean",
      user: { login: "fixture-vulcan[bot]" },
      head: { sha: head },
      base: { ref: "main" },
    };
    let approval = "APPROVED",
      reviewHead = head,
      check = "success",
      consent = false,
      closed = false;
    const effects: { path: string; body: any }[] = [];
    const transport = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = new URL(String(url)),
        path = u.pathname;
      let body: unknown;
      if (path === "/app")
        body = { id: 10, slug: "fixture-vulcan", client_id: "client10" };
      else if (path === "/app/installations/20")
        body = { app_id: 10, account: { login: "fixture" } };
      else if (path.endsWith("/access_tokens"))
        body = { token: "server-only-token" };
      else if (path.startsWith("/users/"))
        body = {
          id: path.includes("bot") ? 1 : 42,
          login: path.includes("bot") ? "fixture-vulcan[bot]" : "reporter",
        };
      else if (path.endsWith("/git/ref/heads/main"))
        body = { object: { sha: base } };
      else if (path.endsWith(`/git/commits/${base}`))
        body = { tree: { sha: "b".repeat(40) } };
      else if (path.includes("/git/") && init?.method === "POST") {
        effects.push({ path, body: JSON.parse(String(init.body)) });
        body = { sha: head };
      } else if (path.endsWith("/pulls") && init?.method === "POST") {
        effects.push({ path, body: JSON.parse(String(init.body)) });
        body = pull;
      } else if (path.endsWith("/merge-async") && init?.method === "PUT") {
        effects.push({ path, body: JSON.parse(String(init.body)) });
        body = { status: "pending", details: { uuid: "receipt-1" } };
      } else if (path.endsWith("/merge-async/receipt-1"))
        body = { status: "pending" };
      else if (path.endsWith("/pulls/2")) body = pull;
      else if (path.endsWith("/commits"))
        body = [{ commit: { message: "Prepared fix" } }];
      else if (path.endsWith("/check-runs"))
        body = {
          total_count: 1,
          check_runs: [{ name: "CI", status: "completed", conclusion: check }],
        };
      else if (path.endsWith("/status"))
        body = { total_count: 0, statuses: [] };
      else if (path.endsWith("/reviews"))
        body = [
          {
            user: { id: 42, login: "reviewer", type: "User" },
            state: approval,
            commit_id: reviewHead,
          },
        ];
      else if (path.endsWith("/issues/1")) {
        if (init?.method === "PATCH") {
          effects.push({ path, body: JSON.parse(String(init.body)) });
          closed = true;
        }
        body = {
          html_url: `https://github.com/${repo}/issues/1`,
          state: closed ? "closed" : "open",
          state_reason: closed ? "completed" : null,
          user: { login: "reporter" },
        };
      } else if (
        path === "/graphql" &&
        String(init?.body).includes("closingIssuesReferences")
      )
        body = {
          data: { node: { closingIssuesReferences: { totalCount: 0 } } },
        };
      else if (path === "/graphql") {
        effects.push({ path, body: JSON.parse(String(init?.body)) });
        pull.draft = false;
        body = {
          data: {
            markPullRequestReadyForReview: { pullRequest: { isDraft: false } },
          },
        };
      } else throw new Error(`unexpected endpoint ${path}`);
      return Response.json(body);
    }) as typeof fetch;
    const github = new AgentGitHub(transport);
    const a = {
      id: crypto.randomUUID(),
      definition: AgentDefinition.parse({
        role: "Vulcan",
        instructions: "",
        repos: [repo],
        actions: ["investigate", "edit", "open_pr", "merge", "close_issue"],
        mergePolicy: { requiredChecks: ["CI"] },
        github: {
          kind: "app",
          appId: "10",
          installationId: "20",
          login: "fixture-vulcan[bot]",
        },
      }),
    } as SharedAgent;
    const cloud = {
      contacts: async (_agent: string, _repo: string, logins: string[]) =>
        logins.map((login) => ({
          login,
          allowed: consent,
          github_user_id: "42",
        })),
    } as InstallationAgents;
    const binding = { appKeyPath: pem } as AgentBinding;
    const published = await github.dispatch(
      a,
      { id: crypto.randomUUID() } as AgentRun,
      binding,
      {
        kind: "open_pr",
        repo,
        title: "Prepare arithmetic fix",
        body: "Related to #1",
        base: "main",
        head: preparedHead,
      },
      dir,
      cloud,
      async () => {},
    );
    expect(published.html_url).toBe(pull.html_url);
    expect(
      effects.find((e) => e.path.endsWith("/git/commits"))?.body.author,
    ).toEqual({
      name: "fixture-vulcan[bot]",
      email: "1+fixture-vulcan[bot]@users.noreply.github.com",
    });
    expect(effects.find((e) => e.path.endsWith("/pulls"))?.body.draft).toBe(
      true,
    );
    expect(JSON.stringify(effects)).not.toContain("PRIVATE KEY");
    expect(git(["config", "user.name"])).toBe("Fixture");
    effects.length = 0;
    const merge: GitHubAction = {
      kind: "merge_pr",
      repo,
      number: 2,
      head,
      base: "main",
      method: "squash",
    };
    const dispatch = (action: GitHubAction, guard = async () => {}) =>
      github.dispatch(a, {} as AgentRun, binding, action, dir, cloud, guard);
    pull.head.sha = "b".repeat(40);
    await expect(dispatch(merge)).rejects.toThrow("head or base changed");
    pull.head.sha = head;
    pull.base.ref = "other";
    await expect(dispatch(merge)).rejects.toThrow("head or base changed");
    pull.base.ref = "main";
    check = "failure";
    await expect(dispatch(merge)).rejects.toThrow(
      "checks are pending or failing",
    );
    check = "success";
    reviewHead = "b".repeat(40);
    await expect(dispatch(merge)).rejects.toThrow("human review");
    reviewHead = head;
    approval = "CHANGES_REQUESTED";
    await expect(dispatch(merge)).rejects.toThrow("human review");
    approval = "APPROVED";
    pull.body = "Fixes: #1";
    await expect(dispatch(merge)).rejects.toThrow("automatic closing keywords");
    pull.body = "Ask @reporter";
    await expect(dispatch(merge)).rejects.toThrow("no verified opt-in");
    pull.body = "Related to #1";
    expect(effects).toHaveLength(0);
    pull.draft = true;
    await expect(dispatch(merge)).rejects.toThrow("must be ready");
    await dispatch({ kind: "ready_pr", repo, number: 2, head, base: "main" });
    expect(pull.draft).toBe(false);
    const result = await dispatch(merge);
    expect(result.status).toBe("pending");
    expect(effects[1]!.body).toMatchObject({
      sha: head,
      bypass_rules: false,
      merge_action: "default",
      merge_method: "squash",
    });
    expect(
      await github.reconcile(a, binding, merge, result.receipt),
    ).toBeNull();
    expect(effects).toHaveLength(2);
    pull.merged = true;
    pull.state = "closed";
    pull.merge_commit_sha = "c".repeat(40);
    expect(
      (await github.reconcile(a, binding, merge, result.receipt))?.status,
    ).toBe("merged");
    expect(effects).toHaveLength(2);
    const close: GitHubAction = {
      kind: "close_issue",
      repo,
      number: 1,
      pullNumber: 2,
      head,
      base: "main",
      verification: "Original symptom verified",
      evidence: [{ url: pull.html_url, label: "Merged fix" }],
    };
    await expect(
      dispatch(close, async () => {
        throw new Error("resolution evidence not yet recorded");
      }),
    ).rejects.toThrow("resolution evidence");
    await expect(dispatch(close)).rejects.toThrow("no verified opt-in");
    expect(effects).toHaveLength(2);
    consent = true;
    expect((await dispatch(close)).status).toBe("closed");
    expect((await github.reconcile(a, binding, close))?.status).toBe("closed");
    expect((await dispatch(close)).status).toBe("closed");
    expect(effects).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("server-only-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
