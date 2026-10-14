/** Publication and issue claims must fail closed across restarts, revocation,
 * mismatched reviewers and changed commits. Git runs against disposable repos. */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorks, agentPrTitle, requireOperator } from "./work";
import { AgentStore } from "./store";
import { AgentConversations } from "./conversation";
import { closeDb, insertRepo, insertSessionRecord } from "../db";

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode) throw Error(r.stderr.toString());
  return r.stdout.toString().trim();
}
test("family claims, independent exact-head rounds and revoked publication authority survive restart", async () => {
  const before = process.env.AGENTBOX_HOME,
    home = mkdtempSync(join(tmpdir(), "agent-work-"));
  process.env.AGENTBOX_HOME = home;
  let store: AgentStore | undefined;
  try {
    const root = join(home, "repo"),
      remote = join(home, "remote.git");
    mkdirSync(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.test");
    writeFileSync(join(root, "app.txt"), "base\n");
    git(root, "add", "app.txt");
    git(root, "commit", "-m", "Base");
    const base = git(root, "rev-parse", "HEAD");
    git(home, "clone", "--bare", root, remote);
    git(root, "remote", "add", "origin", "https://github.com/fixture/work.git");
    insertRepo({
      id: "project",
      kind: "local",
      ref: root,
      displayName: "Fixture",
      fullName: "fixture/work",
      defaultBranch: "main",
      addedAt: Date.now(),
      worktreeDefault: true,
      setup: { copy: [], run: "" },
    });
    store = new AgentStore(join(home, "runtime.db"));
    const sessions: any[] = [],
      prompts: any[] = [],
      messages = new Map<string, string>();
    let failWriter = true, failReviewer = true;
    const fleet: any = {
      sessions: () => sessions,
      get: (id: string) => sessions.find((s) => s.id === id),
      tick: async () => {},
      timeline: async (id: string) => ({
        events: [
          {
            kind: "assistant",
            text: messages.get(id) ?? "",
            id: "reply",
            at: Date.now(),
          },
        ],
      }),
      spawn: async (o: any) => {
        if (!o.readOnly && failWriter) { failWriter = false; throw Error("No available writer account"); }
        if (o.readOnly && failReviewer) { failReviewer = false; throw Error("No available reviewer account"); }
        prompts.push(o);
        const s = {
          id: o.id,
          status: "waiting",
          host: "none",
          cwd: o.cwd,
          closedAt: null,
          lastActivityAt: Date.now(),
        };
        sessions.push(s);
        insertSessionRecord({
          id: o.id,
          provider: o.provider,
          agentSessionId: o.id,
          accountId: null,
          cwd: o.cwd,
          worktree: o.cwd,
          label: null,
          claim: 0,
          origin: "agentbox",
          tmux: null,
          transcriptPath: null,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          archivedAt: null,
          facts: {},
          createdAt: Date.now(),
        });
        return { session: s };
      },
    };
    const runtime: any = { store, fleet, cards: { add: () => ({ id: 1 }) } };
    const requests: string[] = [];
    let remoteBase = base, churnOnPush = false, published: any = null, publicationWrites = 0;
    const github = async <T>(path: string, body?: unknown): Promise<T> => {
      requests.push(path);
      if (path.includes("/pulls?")) return (published ? [published] : []) as T;
      if (body) {
        if (!path.endsWith("/pulls")) throw Error("Unexpected external write in controlled transport");
        publicationWrites++;
        const w = runtime.works.list()[0], head = git(w.cwd,"rev-parse","HEAD");
        published = { ...(body as object), number:1, html_url:"https://github.com/fixture/work/pull/1", state:"open", user:{login:"operator"}, head:{sha:head,ref:w.branch},base:{ref:"main"} };
        return published as T;
      }
      return (
        path === "user"
          ? { login: "operator" }
          : path.startsWith("users/")
            ? { login: "accountable" }
            : path.includes("/issues/")
              ? { state: "open" }
              : { object: { sha: remoteBase } }
      ) as T;
    };
    const gitTransport = async (cwd: string, ...args: string[]) => {
      if (args[0] === "push" && churnOnPush) remoteBase = "b".repeat(40);
      return git(
        cwd,
        ...(["fetch","push","ls-remote"].includes(args[0]!)
          ? args.map((a) => (a === "origin" ? remote : a))
          : args),
      );
    };
    runtime.works = new AgentWorks(runtime, github, gitTransport);
    runtime.conversations = new AgentConversations(runtime);
    const works: AgentWorks = runtime.works,
      agent = runtime.conversations
        .local("project")
        .find((a: any) => a.name === "VULCAN");
    const grant = {
      id: crypto.randomUUID(),
      requester: "coordinator",
      project: "project",
      human: { name: "Human", github: "accountable" },
      actor: "operator",
      expires: Date.now() + 3600000,
    };
    expect(() =>
      requireOperator(
        new Request("http://localhost", { headers: { "x-agentbox": "1" } }),
      ),
    ).toThrow("capability");
    await works.authorize(grant);
    const input = {
      id: crypto.randomUUID(),
      grant: grant.id,
      agent: agent.id,
      base: "main",
      issues: [1, 2].map((n) => ({
        source: `https://github.com/fixture/work/issues/${n}`,
        repro: "Observed problem",
        acceptance: "Expected behavior",
        evidence: "repro.json",
      })),
      preparation: {
        problem: "Shared root cause",
        consumers: "All callers",
        edges: "Boundary cases",
        nonGoals: "Unrelated behavior",
        design: "One rule",
        validation: "Existing entry-point evidence",
      },
    };
    await expect(works.start("forged", input)).rejects.toThrow("coordinator");
    await expect(works.start("coordinator", input)).rejects.toThrow("writer account");
    expect(works.get(input.id).state).toBe("uncertain");
    const work = await works.retryStart(input.id, "coordinator");
    expect(prompts.length).toBe(1);
    expect(work.agent.id).toBe(agent.id);
    expect(work.input.issues.length).toBe(2);
    expect((await works.start("coordinator", input)).session).toBe(
      work.session,
    );
    await expect(
      works.start("coordinator", { ...input, id: crypto.randomUUID() }),
    ).rejects.toThrow("already belongs");
    await expect(
      works.publish(work.id, work.session, {
        head: base,
        title: "Fix",
        body: "Plain evidence",
      }),
    ).rejects.toThrow("three completed");
    for (let n = 1; n <= 3; n++) {
      writeFileSync(join(work.cwd, "app.txt"), `candidate ${n}\n`);
      git(work.cwd, "add", "app.txt");
      git(work.cwd, "commit", "-m", `Candidate ${n}`);
      const round = await works.review(work.id, work.session, {
        validation: [`artifact-${n}.json`],
      });
      for (const r of round.reviewers.filter((r) => r.state !== "started")) await works.retryReview(work.id, work.session, {focus:r.focus});
      expect(round.number).toBe(n);
      expect(new Set(round.reviewers.map((r) => r.session)).size).toBe(3);
      expect(
        prompts
          .slice(-3)
          .every((p) => p.readOnly === true && p.provider === "codex"),
      ).toBe(true);
      for (const r of round.reviewers)
        messages.set(
          r.session,
          JSON.stringify({
            kind: "agentbox-review",
            round: n,
            focus: r.focus,
            base: round.base,
            head: round.head,
            verdict: n === 3 ? "changes" : "clean",
            findings:
              n === 3
                ? [
                    {
                      title: "Boundary failed",
                      evidence: "app.txt:1",
                      remedy: "Fix underlying rule",
                    },
                  ]
                : [],
            evidence: ["app.txt"],
          }),
        );
      await works.collect(work.id, work.session);
      if (n === 1) {
        const candidate = { head: round.head, title: "Fix shared rule", body: "Plain reproduction evidence" };
        churnOnPush = true;
        await expect(works.publish(work.id, work.session, candidate)).rejects.toThrow("exact base/head");
        expect(works.get(work.id).publication?.state).toBe("prepared");
        expect(publicationWrites).toBe(0);
        expect((await works.reconcile(work.id, work.session)).state).toBe("prepared");
        remoteBase = base; churnOnPush = false;
        expect((await works.publish(work.id, work.session, candidate)).state).toBe("sent");
        expect(publicationWrites).toBe(1);
        expect(published.title).toBe("[VULCAN · Human] Fix shared rule");
        await works.publish(work.id, work.session, candidate);
        expect(publicationWrites).toBe(1);
      }
      if (n < 3) {
        works.assertReviewed(works.get(work.id), round.base, round.head);
        expect(() =>
          works.assertReviewed(works.get(work.id), round.base, "f".repeat(40)),
        ).toThrow("exact base/head");
      }
    }
    await expect(
      works.review(work.id, work.session, { validation: ["R4"] }),
    ).rejects.toThrow();
    expect(
      (
        await works.failure(work.id, work.session, {
          summary:
            "Missed boundary; inspect every caller before implementation",
        })
      ).state,
    ).toBe("recorded");
    const restarted = new AgentWorks(runtime, github, gitTransport);
    expect(restarted.get(work.id).rounds.length).toBe(3);
    await works.revoke(grant.id);
    await expect(
      restarted.publish(work.id, work.session, {
        head: base,
        title: "Fix",
        body: "Evidence",
      }),
    ).rejects.toThrow("grant");
    expect(publicationWrites).toBe(1);
    expect(
      agentPrTitle(
        "Vulcan\n@team",
        "Human\u202e",
        "[Fake · Other] Fix\n@mention",
      ),
    ).toBe("[Vulcan team · Human] Fix mention");
    expect(agentPrTitle("Vulcan", "Human", "a".repeat(500)).length).toBe(256);
  } finally {
    store?.db.close();
    closeDb();
    if (before === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});
