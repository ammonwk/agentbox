/** Regression: preparing/approving outreach cannot freeze consent, and no
 * App token reaches a caller or a shell. GitHub is a controlled transport. */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentGitHub, mentionedPeople } from "../agents/github";
import {
  AgentDefinition,
  type SharedAgent,
  type AgentRun,
} from "../../cloud/agents";
import type { InstallationAgents } from "../../cloud/agent-client";
import type { AgentBinding } from "../agents/store";

describe("managed GitHub outreach boundary", () => {
  test("PR body mentions, escaped mentions and team mentions cannot bypass checking", () => {
    expect(
      mentionedPeople(
        "Please ask @Person; even `@Other` or &#64;Third or \\@Fourth.",
      ),
    ).toEqual(["person", "other", "third", "fourth"]);
    expect(() => mentionedPeople("@org/team")).toThrow("Team mentions");
  });
  test("a previously approved targeted comment is blocked after opt-out at dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-outreach-"));
    try {
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
      let allowed = true,
        mutationCount = 0,
        guardCount = 0;
      const transport = (async (
        url: string | URL | Request,
        init?: RequestInit,
      ) => {
        const path = new URL(String(url)).pathname;
        let body: unknown;
        if (path === "/app")
          body = { slug: "fixture-vulcan", id: 10, client_id: "client10" };
        else if (path === "/app/installations/20")
          body = { app_id: 10, account: { login: "fixture" } };
        else if (path.endsWith("/access_tokens"))
          body = { token: "server-only-fixture-token" };
        else if (path.startsWith("/users/"))
          body = {
            id: path.includes("bot") ? 1 : 42,
            login: path.includes("bot") ? "fixture-vulcan[bot]" : "reporter",
          };
        else if (path.endsWith("/issues/1"))
          body = { user: { login: "reporter" } };
        else if (path.endsWith("/comments") && init?.method === "POST") {
          mutationCount++;
          body = {
            html_url: "https://github.com/fixture/repo/issues/1#comment-1",
          };
        } else throw new Error(`unexpected fixture endpoint ${path}`);
        return Response.json(body);
      }) as typeof fetch;
      const github = new AgentGitHub(transport);
      const a = {
        id: crypto.randomUUID(),
        definition: AgentDefinition.parse({
          role: "Vulcan",
          instructions: "",
          repos: ["fixture/repo"],
          github: {
            kind: "app",
            appId: "10",
            installationId: "20",
            login: "fixture-vulcan[bot]",
          },
        }),
      } as SharedAgent;
      const binding = { appKeyPath: pem } as AgentBinding;
      const cloud = {
        contacts: async (_agent: string, _repo: string, logins: string[]) =>
          logins.map((login) => ({
            login,
            allowed,
            user_id: crypto.randomUUID(),
            github_user_id: "42",
            reason: "fixture consent",
          })),
      } as InstallationAgents;
      const action = {
        kind: "comment" as const,
        repo: "fixture/repo",
        number: 1,
        body: "I can reproduce the report.",
      };
      // A human approved this body earlier. Even without @, its author is a
      // targeted recipient and the current preference controls dispatch.
      allowed = false;
      await expect(
        github.dispatch(
          a,
          {} as AgentRun,
          binding,
          action,
          dir,
          cloud,
          async () => {
            guardCount++;
          },
        ),
      ).rejects.toThrow("no verified opt-in");
      expect(mutationCount).toBe(0);
      expect(guardCount).toBe(1);
      allowed = true;
      const result = await github.dispatch(
        a,
        {} as AgentRun,
        binding,
        action,
        dir,
        cloud,
        async () => {},
      );
      expect(mutationCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain("server-only-fixture-token");
      await expect(
        github.dispatch(
          a,
          {} as AgentRun,
          binding,
          { ...action, body: "Ask @org/team" },
          dir,
          cloud,
          async () => {},
        ),
      ).rejects.toThrow("Team mentions");
      expect(mutationCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
