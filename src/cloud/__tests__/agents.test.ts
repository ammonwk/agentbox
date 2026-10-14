/** Destructive/security boundaries, exercised through real human and machine
 * credentials against local Supabase. No production service key is accepted. */
import { z } from "zod";
import {
  AgentConversation,
  Proposal,
  relayIdentity,
} from "../agent-conversation";
import { beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { HumanCloud, InstallationCloud, supabaseFor } from "../client";
import { HumanAgents, InstallationAgents } from "../agent-client";
import { AGENT_TEMPLATES, type SharedAgent, type WorkItem } from "../agents";

const url = process.env.AGENTBOX_CLOUD_TEST_URL;
const publishableKey = process.env.AGENTBOX_CLOUD_TEST_PUBLISHABLE_KEY;
const key = process.env.AGENTBOX_CLOUD_TEST_SECRET_KEY;
const db = process.env.AGENTBOX_CLOUD_TEST_DB_URL;
const tag = crypto.randomUUID().slice(0, 8);
const cfg = { url: url ?? "", publishableKey: publishableKey ?? "" };
const definition = AGENT_TEMPLATES[0]!.definition;
async function human(name: string) {
  const email = `${name}-${tag}@agents.test`,
    password = `Agent-${tag}-${name}-A1!`;
  const root = createClient(url!, key!, { auth: { persistSession: false } });
  const made = await root.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (made.error) throw made.error;
  const sb = supabaseFor(cfg);
  const signed = await sb.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  const api = new HumanCloud(sb);
  await api.me();
  return { api, agents: new HumanAgents(api), id: made.data.user!.id, email };
}
function sql(query: string) {
  if (!db || !["127.0.0.1", "localhost"].includes(new URL(db).hostname))
    throw new Error("fixtures require the local test database");
  const r = Bun.spawnSync(["psql", db, "-v", "ON_ERROR_STOP=1", "-c", query], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode) throw new Error(r.stderr.toString());
}

describe.skipIf(!url || !publishableKey || !key || !db)(
  "shared agent authority and writer exclusion",
  () => {
    let alice: Awaited<ReturnType<typeof human>>,
      bob: typeof alice,
      outsider: typeof alice;
    let ws: string, host: string, otherHost: string;
    let machine: InstallationAgents, other: InstallationAgents;
    let raw: InstallationCloud, secret: string;
    let a: SharedAgent, b: SharedAgent;
    const save = (
      agent: SharedAgent,
      changes: Partial<Parameters<HumanAgents["save"]>[0]> = {},
    ) =>
      alice.agents.save({
        workspace: ws,
        id: agent.id,
        base: agent.revision,
        name: agent.name,
        team: agent.team,
        definition: agent.definition,
        maintainers: agent.maintainers,
        enabled: agent.enabled,
        executor: agent.execution_installation_id,
        ...changes,
      });
    const intake = (n: number, agent = a) =>
      alice.agents.intake(agent.id, {
        source: `https://github.com/fixture/repo/issues/${n}`,
        title: `Issue ${n}`,
        acceptance: "Reproduce, fix, and record verification.",
      });
    const fresh = async (w: WorkItem) =>
      (await alice.agents.board(ws)).work.find((x) => x.id === w.id)!;

    beforeAll(async () => {
      [alice, bob, outsider] = await Promise.all([
        human("alice"),
        human("bob"),
        human("outside"),
      ]);
      ws = (
        await alice.api.createWorkspace("Agent boundaries", `agents-${tag}`)
      ).id;
      await bob.api.acceptInvite(
        (await alice.api.createInvite(ws, { email: bob.email })).token,
      );
      const first = await alice.api.registerInstallation(ws, `server-${tag}`, {
        scopes: ["agents:execute"],
      });
      const second = await bob.api.registerInstallation(ws, `laptop-${tag}`, {
        scopes: ["agents:execute"],
      });
      host = first.installation.id;
      otherHost = second.installation.id;
      secret = first.secret;
      raw = new InstallationCloud(supabaseFor(cfg), secret);
      machine = new InstallationAgents(raw);
      other = new InstallationAgents(
        new InstallationCloud(supabaseFor(cfg), second.secret),
      );
      expect(
        (
          await alice.api.sb.rpc("agent_host_operator", {
            p_installation: host,
          })
        ).data,
      ).toBe(alice.id);
      expect(
        (await bob.api.sb.rpc("agent_host_operator", { p_installation: host }))
          .error,
      ).not.toBeNull();
      expect(
        (await raw.sb.rpc("agent_host_operator", { p_installation: host }))
          .error,
      ).not.toBeNull();
      a = await alice.agents.save({
        workspace: ws,
        name: "VULCAN",
        team: true,
        maintainers: [alice.id],
        definition,
      });
      b = await bob.agents.save({
        workspace: ws,
        name: "Another Vulcan",
        team: false,
        maintainers: [bob.id],
        definition,
      });
    });

    test("shared visibility grants neither editing nor host credentials", async () => {
      expect((await bob.agents.board(ws)).agents.map((x) => x.id)).toContain(
        a.id,
      );
      await expect(outsider.agents.board(ws)).rejects.toThrow();
      for (const table of [
        "shared_agents",
        "agent_work",
        "agent_runs",
        "agent_events",
        "agent_revisions",
        "agent_executor_grants",
        "agent_contact_preferences",
      ]) {
        const r = await outsider.api.sb
          .from(table)
          .select("*")
          .eq("workspace_id", ws);
        expect(r.error).toBeNull();
        expect(r.data).toEqual([]);
        expect(
          (await bob.api.sb.from(table).insert({ workspace_id: ws })).error,
        ).not.toBeNull();
      }
      await expect(
        bob.agents.save({
          workspace: ws,
          id: a.id,
          base: a.revision,
          name: "Stolen",
          team: true,
          definition,
          maintainers: [bob.id],
        }),
      ).rejects.toThrow();
      await expect(
        alice.agents.authorize(a.id, otherHost, true),
      ).rejects.toThrow();
      await expect(
        save(a, { enabled: true, executor: host }),
      ).rejects.toThrow();
      await alice.agents.authorize(a.id, host, true);
      a = await save(a, { enabled: true, executor: host });
      await expect(
        other.intake(a.id, {
          source: "https://example.test/1",
          title: "borrow",
          acceptance: "",
        }),
      ).rejects.toThrow();
      await expect(save(a, { base: a.revision - 1 })).rejects.toThrow();
      await expect(save(a, { base: null as never })).rejects.toThrow();
      expect((await alice.agents.revisions(a.id)).length).toBe(2);
      const clone = await bob.agents.clone(a, bob.id);
      expect(clone.enabled).toBe(false);
      expect(clone.execution_installation_id).toBeNull();
      expect(clone.maintainers).toEqual([bob.id]);
    });

    test("review budgets survive writer rotation and reject reset, mutation and unauthorized hosts", async () => {
      await alice.api.setDisplayName("Accountable human");
      const work = await intake(90900),
        queued = await alice.agents.run(work, crypto.randomUUID());
      let run = await machine.report(
        await machine.claim(queued.id),
        "running",
        { session: "review-owner" },
      );
      const load = () =>
        raw.agentCall(
          "inst_agent_review_load",
          { p_run: run.id, p_fence: run.fence },
          z.any(),
        );
      let journal = await load();
      expect(journal.human).toEqual({
        id: alice.id,
        name: "Accountable human",
      });
      const saveBody = (body: unknown, revision = journal.revision) =>
        raw.agentCall(
          "inst_agent_review_save",
          {
            p_run: run.id,
            p_fence: run.fence,
            p_revision: revision,
            p_body: body,
          },
          z.number(),
        );
      await expect(
        other.installation.agentCall(
          "inst_agent_review_load",
          { p_run: run.id, p_fence: run.fence },
          z.any(),
        ),
      ).rejects.toThrow();
      expect(
        (
          await outsider.api.sb
            .from("agent_review_journals")
            .select("*")
            .eq("workspace_id", ws)
        ).data,
      ).toEqual([]);
      for (let n = 1; n <= 3; n++) {
        const round = {
          number: n,
          base: "a".repeat(40),
          head: String(n).repeat(40),
          context: "pinned",
          installation: host,
          reviewers: ["architecture", "correctness", "deslop"].map((focus) => ({
            focus,
            session: `r${n}-${focus}`,
          })),
        };
        journal.body.rounds.push(round);
        journal.revision = await saveBody(journal.body);
        await expect(
          saveBody({ state: "working", rounds: [] }),
        ).rejects.toThrow();
        for (const reviewer of round.reviewers as any[])
          reviewer.verdict = { verdict: "clean" };
        journal.revision = await saveBody(journal.body);
        const changed = structuredClone(journal.body);
        changed.rounds[0].reviewers[0].verdict = { verdict: "changes" };
        await expect(saveBody(changed)).rejects.toThrow();
        if (n === 1) {
          const old = run;
          run = await machine.rotate(run, "replacement-review-owner");
          await expect(
            raw.agentCall(
              "inst_agent_review_load",
              { p_run: old.id, p_fence: old.fence },
              z.any(),
            ),
          ).rejects.toThrow();
          expect((await load()).body.rounds).toEqual(journal.body.rounds);
        }
      }
      const fourth = structuredClone(journal.body);
      fourth.rounds.push({ ...fourth.rounds[2], number: 4 });
      await expect(saveBody(fourth)).rejects.toThrow();
      const prepared = await machine.prepare(run, crypto.randomUUID(), {
        kind: "open_pr",
        repo: "fixture/repo",
        title: "[VULCAN · Accountable human] Prepared fix",
        body: "Related to issue 90900",
        base: "main",
        head: "3".repeat(40),
      });
      await alice.agents.decide(prepared.id, true);
      await machine.dispatch(run, prepared.id);
      const proof = {
        base: "a".repeat(40),
        head: "3".repeat(40),
        tree: "b".repeat(40),
        remoteHead: "c".repeat(40),
      };
      const record = (mapping: unknown) =>
        raw.agentCall(
          "inst_agent_publication_record",
          {
            p_run: run.id,
            p_fence: run.fence,
            p_action: prepared.id,
            p_mapping: mapping,
          },
          z.unknown(),
        );
      await record(proof);
      await expect(
        record({ ...proof, remoteHead: "d".repeat(40) }),
      ).rejects.toThrow();
      await machine.actionResult(
        prepared.id,
        "sent",
        "https://github.com/fixture/repo/pull/123",
      );
      await machine.report(run, "stopped");
      await expect(load()).rejects.toThrow();
      const nextHost = await alice.api.registerInstallation(
        ws,
        `handoff-${tag}`,
        { scopes: ["agents:execute"] },
      );
      await alice.agents.authorize(a.id, nextHost.installation.id, true);
      a = await save(a, { executor: nextHost.installation.id });
      const nextRaw = new InstallationCloud(supabaseFor(cfg), nextHost.secret),
        nextMachine = new InstallationAgents(nextRaw);
      const queuedAgain = await alice.agents.run(
        await fresh(work),
        crypto.randomUUID(),
      );
      const nextRun = await nextMachine.report(
        await nextMachine.claim(queuedAgain.id),
        "running",
        { session: "next-host-owner" },
      );
      const moved = await nextRaw.agentCall(
        "inst_agent_review_load",
        { p_run: nextRun.id, p_fence: nextRun.fence },
        z.any(),
      );
      expect(moved.body.rounds).toEqual(journal.body.rounds);
      const lookup = (number: number) =>
        nextRaw.agentCall(
          "inst_agent_publication_lookup",
          {
            p_run: nextRun.id,
            p_fence: nextRun.fence,
            p_head: proof.remoteHead,
            p_number: number,
          },
          z.any(),
        );
      expect(await lookup(123)).toEqual(proof);
      expect(await lookup(124)).toBeNull();
      await expect(
        raw.agentCall(
          "inst_agent_review_load",
          { p_run: nextRun.id, p_fence: nextRun.fence },
          z.any(),
        ),
      ).rejects.toThrow();
      await nextMachine.report(nextRun, "stopped");
      a = await save(a, { executor: host });
    });

    test("canonical sources deduplicate across different humans and agents", async () => {
      const one = await intake(1);
      const two = await bob.agents.intake(b.id, {
        source: "https://GITHUB.com/Fixture/Repo/pull/1?x=y#comment",
        title: "same",
        acceptance: "",
      });
      expect(two.id).toBe(one.id);
      expect(two.agent_id).toBe(a.id);
      await expect(bob.agents.assign(two, bob.id, b.id)).rejects.toThrow();
      const assigned = await alice.agents.assign(one, bob.id);
      expect(assigned.assignee).toBe(bob.id);
      await expect(alice.agents.assign(one, alice.id)).rejects.toThrow();
    });

    test("atomic run/claim, takeover acknowledgment and rotation fence", async () => {
      let w = await intake(2);
      const requests = await Promise.allSettled([
        alice.agents.run(w, crypto.randomUUID()),
        alice.agents.run(w, crypto.randomUUID()),
      ]);
      expect(requests.filter((x) => x.status === "fulfilled").length).toBe(1);
      const r = requests.find((x) => x.status === "fulfilled")!;
      if (r.status !== "fulfilled") throw new Error("no run");
      expect((await alice.agents.run(w, r.value.id)).id).toBe(r.value.id);
      await expect(other.claim(r.value.id)).rejects.toThrow();
      const claims = await Promise.allSettled([
        machine.claim(r.value.id),
        machine.claim(r.value.id),
      ]);
      expect(claims.filter((x) => x.status === "fulfilled").length).toBe(1);
      const claim = claims.find((x) => x.status === "fulfilled")!;
      if (claim.status !== "fulfilled") throw new Error("no claim");
      let live = await machine.report(claim.value, "running", {
        session: "original",
      });
      const old = live;
      live = await machine.rotate(live, "replacement");
      expect(live.previous_session_id).toBe("original");
      await expect(machine.report(old, "running")).rejects.toThrow();
      await expect(
        machine.report(live, "running", { session: "unfenced" }),
      ).rejects.toThrow();
      w = await fresh(w);
      const taken = await alice.agents.takeover(w);
      expect(taken.control).toBe("takeover_requested");
      await expect(
        alice.agents.run(taken, crypto.randomUUID()),
      ).rejects.toThrow();
      await expect(machine.rotate(live, "another")).rejects.toThrow();
      await expect(machine.report(live, "running")).rejects.toThrow();
      await machine.report(live, "stopped");
      w = await fresh(w);
      expect(w.control).toBe("human");
      const handed = await alice.agents.assign(w, bob.id);
      expect(handed.assignee).toBe(bob.id);
    });

    test("an expired writer remains exclusive; pause and malformed progress fail closed", async () => {
      let w = await intake(3);
      const queued = await alice.agents.run(w, crypto.randomUUID());
      const claimed = await machine.claim(queued.id);
      const live = await machine.report(claimed, "running", {
        session: "expire",
      });
      expect(
        (
          await raw.sb.rpc("inst_agent_progress", {
            p_secret: secret,
            p_run: live.id,
            p_fence: live.fence,
            p_stage: "pr_opened",
            p_next: "",
            p_outcome: "",
            p_evidence: [{}],
          })
        ).error,
      ).not.toBeNull();
      expect(
        (
          await raw.sb.rpc("inst_agent_progress", {
            p_secret: secret,
            p_run: live.id,
            p_fence: null,
            p_stage: "blocked",
            p_next: "",
            p_outcome: "",
            p_evidence: [],
          })
        ).error,
      ).not.toBeNull();
      sql(
        `update public.agent_runs set lease_until=now()-interval '1 second' where id='${live.id}'`,
      );
      expect(
        (await machine.board()).runs.find((x) => x.id === live.id)?.state,
      ).toBe("uncertain");
      await expect(machine.report(live, "running")).rejects.toThrow();
      w = await fresh(w);
      await expect(alice.agents.run(w, crypto.randomUUID())).rejects.toThrow();
      await expect(alice.agents.assign(w, bob.id)).rejects.toThrow();
      await machine.report(live, "stopped");
      a = await save(a, { enabled: false });
      await expect(
        machine.intake(a.id, {
          source: "https://example.test/paused",
          title: "pending locally",
          acceptance: "",
        }),
      ).rejects.toThrow();
      await expect(
        alice.agents.run(await fresh(w), crypto.randomUUID()),
      ).rejects.toThrow();
      a = await save(a, { enabled: true });
    });

    test("contact is opt-in, OAuth bound, human-only and rechecked after revocation", async () => {
      const login = `verified-${tag}`;
      await bob.agents.expertise(ws, {
        areas: ["database"],
        login,
        emails: [],
        paths: ["supabase/"],
      });
      expect(
        (await machine.contacts(a.id, "fixture/repo", [login]))[0]?.allowed,
      ).toBe(false);
      await expect(
        bob.agents.consent(ws, "fixture/repo", a.id, true),
      ).rejects.toThrow();
      // The fixture represents a completed provider OAuth flow. Product APIs
      // cannot create these identities or trust editable user_metadata instead.
      sql(
        `insert into auth.identities(id,user_id,provider_id,provider,identity_data) values(gen_random_uuid(),'${bob.id}','992${tag.replace(/[^0-9]/g, "1")}','github',jsonb_build_object('sub','992${tag.replace(/[^0-9]/g, "1")}','user_name','${login}'))`,
      );
      await bob.agents.consent(ws, "fixture/repo", a.id, true);
      const queued = (
        await machine.contacts(a.id, "fixture/repo", [login])
      )[0]!;
      expect(queued.allowed).toBe(true);
      expect(queued.user_id).toBe(bob.id);
      expect(
        (await machine.contacts(a.id, "fixture/elsewhere", [login]))[0]
          ?.allowed,
      ).toBe(false);
      expect(
        (
          await raw.sb.rpc("agent_contact_preference", {
            p_workspace: ws,
            p_repo: "*",
            p_agent: null,
            p_allowed: true,
          })
        ).error,
      ).not.toBeNull();
      // Alice cannot opt Bob in by changing her editable profile to his login.
      await alice.api.sb.auth.updateUser({
        data: { user_name: login, provider: "github" },
      });
      await expect(alice.agents.consent(ws, "*", null, true)).rejects.toThrow();
      await bob.agents.consent(ws, "fixture/repo", a.id, false);
      expect(
        (await machine.contacts(a.id, "fixture/repo", [queued.login]))[0]
          ?.allowed,
      ).toBe(false);
      await bob.agents.consent(ws, "*", null, true);
      expect(
        (await machine.contacts(a.id, "fixture/repo", [login]))[0]?.allowed,
      ).toBe(false); // scoped veto
      sql(
        `delete from auth.identities where user_id='${bob.id}' and provider='github'`,
      );
      expect(
        (await machine.contacts(a.id, "fixture/elsewhere", [login]))[0]
          ?.allowed,
      ).toBe(false);
      await bob.agents.consent(ws, "*", null, false); // can revoke after unlink
    });

    test("only an accountable human approves an immutable action, once, at its current revision", async () => {
      const w = await intake(4),
        queued = await alice.agents.run(w, crypto.randomUUID());
      const r = await machine.report(
        await machine.claim(queued.id),
        "running",
        { session: "actions" },
      );
      const spec = {
        kind: "comment",
        repo: "fixture/repo",
        number: 4,
        body: "Prepared fix evidence.",
      };
      const action = await machine.prepare(r, crypto.randomUUID(), spec);
      await expect(bob.agents.decide(action.id, true)).rejects.toThrow();
      await expect(outsider.agents.decide(action.id, true)).rejects.toThrow();
      expect(
        (
          await raw.sb.rpc("agent_action_decide", {
            p_action: action.id,
            p_approve: true,
          })
        ).error,
      ).not.toBeNull();
      await expect(machine.dispatch(r, action.id)).rejects.toThrow();
      await alice.agents.decide(action.id, true);
      await expect(
        machine.prepare(r, action.id, {
          ...spec,
          body: "Changed after approval",
        }),
      ).rejects.toThrow();
      const attempts = await Promise.allSettled([
        machine.dispatch(r, action.id),
        machine.dispatch(r, action.id),
      ]);
      expect(attempts.filter((x) => x.status === "fulfilled").length).toBe(1);
      await machine.actionResult(
        action.id,
        "uncertain",
        "Simulated network interruption",
      );
      await expect(machine.dispatch(r, action.id)).rejects.toThrow();
      expect(
        (
          await machine.actionResult(
            action.id,
            "pending",
            "Known remote receipt; reconciliation pending",
          )
        ).state,
      ).toBe("pending");
      expect(
        (
          await machine.actionResult(
            action.id,
            "sent",
            "Remote result confirmed without another dispatch",
          )
        ).state,
      ).toBe("sent");
      await expect(machine.dispatch(r, action.id)).rejects.toThrow();
      const second = await machine.prepare(r, crypto.randomUUID(), spec);
      await alice.agents.decide(second.id, true);
      a = await save(a, {
        definition: { ...a.definition, actions: ["investigate"] },
      });
      await expect(machine.dispatch(r, second.id)).rejects.toThrow();
      await machine.report(r, "stopped");
    });

    test("release leases exclude two agents in the same environment and survive uncertainty", async () => {
      const release = {
        repo: "fixture/repo",
        environment: "production",
        artifact: "release-1",
      };
      a = await save(a, { definition: { ...a.definition, release } });
      let c = await alice.agents.clone(a, alice.id);
      await alice.agents.authorize(c.id, host, true);
      c = await save(c, {
        enabled: true,
        executor: host,
        definition: {
          ...c.definition,
          release: { ...release, artifact: "release-2" },
        },
      });
      const w1 = await intake(5),
        w2 = await intake(6, c);
      const r1 = await machine.claim(
        (await alice.agents.run(w1, crypto.randomUUID())).id,
      );
      const r2 = await alice.agents.run(w2, crypto.randomUUID());
      await expect(machine.claim(r2.id)).rejects.toThrow("environment");
      sql(
        `update public.agent_runs set lease_until=now()-interval '1 second' where id='${r1.id}'`,
      );
      await machine.board();
      await expect(machine.claim(r2.id)).rejects.toThrow("environment");
      await machine.report(r1, "stopped");
      const winner = await machine.claim(r2.id);
      await machine.report(winner, "stopped");
    });

    test("an idle coordinator leaves configured worker capacity and exclusive claims intact", async () => {
      let c = await alice.agents.clone(a, alice.id);
      await alice.agents.authorize(c.id, host, true);
      c = await save(c, {
        enabled: true,
        executor: host,
        definition: {
          ...c.definition,
          release: null,
          maxConcurrent: 1,
          activation: { mode: "schedule", when: "every 5 minutes" },
        },
      });
      expect(
        (
          await outsider.api.sb.rpc("agent_conversation_start", {
            p_agent: c.id,
            p_request: crypto.randomUUID(),
          })
        ).error,
      ).not.toBeNull();
      const begun = await bob.api.sb.rpc("agent_conversation_start", {
        p_agent: c.id,
        p_request: crypto.randomUUID(),
      });
      expect(begun.error).toBeNull();
      let coordinator = await machine.claim(begun.data.id);
      coordinator = await machine.report(coordinator, "waiting", {
        session: "coordinator",
      });
      await expect(
        machine.prepare(coordinator, crypto.randomUUID(), {
          kind: "comment",
          repo: "fixture/repo",
          number: 11,
          body: "Forbidden coordinator action",
        }),
      ).rejects.toThrow("coordinator");
      const work = await machine.intake(c.id, {
        source: "https://github.com/fixture/repo/issues/911",
        title: "Scheduled issue",
        acceptance: "Investigate safely",
      });
      const queued = await machine.enqueue(work.id);
      let worker = await machine.claim(queued.id);
      worker = await machine.report(worker, "running", { session: "worker" });
      const proposal = await raw.agentCall(
        "inst_agent_propose",
        {
          p_run: worker.id,
          p_fence: worker.fence,
          p_id: crypto.randomUUID(),
          p_proposal: {
            title: "Check the regression",
            finding: "Scheduled source identified a reproducer",
            reason: "It affects the source",
            next: "Run a focused local check",
            evidence: [],
            action: null,
          },
        },
        Proposal,
      );
      expect(proposal.run_id).toBe(worker.id);
      await alice.agents
        .progress({ ...work, control: "human" } as WorkItem, {
          stage: "in_progress",
          next: "",
          outcome: "",
          evidence: [],
        })
        .then(
          () => {
            throw new Error("writer bypass");
          },
          () => {},
        );
      expect((await machine.enqueue(work.id)).id).toBe(worker.id);
      const second = await machine.intake(c.id, {
        source: "https://github.com/fixture/repo/issues/912",
        title: "Second issue",
        acceptance: "Wait for worker slot",
      });
      await expect(
        machine.claim((await machine.enqueue(second.id)).id),
      ).rejects.toThrow("workload limit");
      await machine.report(worker, "stopped");
      await machine.report(coordinator, "stopped");
    });

    test("shared Feed and live reads require current human membership, immutable proposals and scoped host authority", async () => {
      let c = await alice.agents.clone(a, alice.id);
      await alice.agents.authorize(c.id, host, true);
      c = await save(c, {
        enabled: true,
        executor: host,
        definition: { ...c.definition, release: null },
      });
      const work = await intake(900, c);
      let run = await machine.claim(
        (await alice.agents.run(work, crypto.randomUUID())).id,
      );
      run = await machine.report(run, "waiting", {
        session: "verified-chat-session",
      });
      const p = {
        title: "Investigate repeated failures",
        finding: "The linked issue contains a reproducible failure.",
        reason: "It affects the reported path.",
        next: "Reproduce locally and report evidence.",
        evidence: [
          { url: "https://github.com/fixture/repo/issues/900", label: "Issue" },
        ],
        action: null,
      };
      const id = crypto.randomUUID();
      const proposal = await raw.agentCall(
        "inst_agent_propose",
        { p_run: run.id, p_fence: run.fence, p_id: id, p_proposal: p },
        Proposal,
      );
      await expect(
        other.installation.agentCall(
          "inst_agent_propose",
          {
            p_run: run.id,
            p_fence: run.fence,
            p_id: crypto.randomUUID(),
            p_proposal: p,
          },
          Proposal,
        ),
      ).rejects.toThrow();
      await expect(
        raw.agentCall(
          "inst_agent_propose",
          {
            p_run: run.id,
            p_fence: run.fence,
            p_id: id,
            p_proposal: { ...p, next: "Merge everything" },
          },
          Proposal,
        ),
      ).rejects.toThrow();
      const bobChat = new AgentConversation(bob.api),
        aliceChat = new AgentConversation(alice.api),
        outsideChat = new AgentConversation(outsider.api);
      expect((await bobChat.proposals(c.id)).map((p) => p.id)).toContain(id);
      expect(await outsideChat.proposals(c.id)).toEqual([]);
      await expect(
        bobChat.decide(id, "approved", crypto.randomUUID()),
      ).rejects.toThrow();
      const message = crypto.randomUUID();
      await bobChat.guide(
        c.id,
        run.id,
        message,
        "Please explain the evidence",
        proposal.id,
      );
      await expect(
        bobChat.guide(c.id, run.id, message, "Changed body", proposal.id),
      ).rejects.toThrow();
      await expect(
        outsideChat.guide(
          c.id,
          run.id,
          crypto.randomUUID(),
          "Spoofed guidance",
        ),
      ).rejects.toThrow();
      expect(
        (await bob.api.sb.from("agent_commands").select("body")).error,
      ).not.toBeNull();
      await expect(aliceChat.receipt(message)).rejects.toThrow();
      const claimed = await raw.agentCall(
        "inst_agent_command_claim",
        { p_id: message },
        z.object({ body: z.string(), session_id: z.string() }),
      );
      expect(claimed.session_id).toBe("verified-chat-session");
      await raw.agentCall(
        "inst_agent_command_result",
        { p_id: message, p_state: "sent", p_result: "" },
        z.unknown(),
      );
      expect((await bobChat.receipt(message)).state).toBe("sent");
      await expect(
        raw.agentCall(
          "inst_agent_command_claim",
          { p_id: message },
          z.unknown(),
        ),
      ).rejects.toThrow();
      expect(
        (await aliceChat.decide(id, "approved", crypto.randomUUID())).state,
      ).toBe("approved");
      expect(
        (await aliceChat.decide(id, "approved", crypto.randomUUID())).state,
      ).toBe("approved");
      const reader = await relayIdentity(),
        hostKey = await relayIdentity(),
        read = crypto.randomUUID();
      expect(
        (
          await outsider.api.sb.rpc("agent_read_request", {
            p_id: crypto.randomUUID(),
            p_agent: c.id,
            p_key: reader.key,
            p_cursor: { session: 0, before: null },
          })
        ).error,
      ).not.toBeNull();
      expect(
        (
          await bob.api.sb.rpc("agent_read_request", {
            p_id: read,
            p_agent: c.id,
            p_key: reader.key,
            p_cursor: { session: 0, before: null },
          })
        ).error,
      ).toBeNull();
      await expect(
        other.installation.agentCall(
          "inst_agent_read_offer",
          { p_id: read, p_key: hostKey.key },
          z.unknown(),
        ),
      ).rejects.toThrow();
      await raw.agentCall(
        "inst_agent_read_offer",
        { p_id: read, p_key: hostKey.key },
        z.unknown(),
      );
      expect(
        (await bob.api.sb.rpc("agent_read_key", { p_id: read })).data,
      ).toBe(hostKey.key);
      expect(
        (await alice.api.sb.rpc("agent_read_key", { p_id: read })).error,
      ).not.toBeNull();
      const after = crypto.randomUUID();
      await bobChat.guide(c.id, run.id, after, "Queued before removal");
      sql(
        `delete from public.workspace_members where workspace_id='${ws}' and user_id='${bob.id}'`,
      );
      await expect(
        raw.agentCall("inst_agent_command_claim", { p_id: after }, z.unknown()),
      ).rejects.toThrow();
      expect(
        (await bob.api.sb.rpc("agent_read_key", { p_id: read })).error,
      ).not.toBeNull();
      await expect(
        raw.agentCall(
          "inst_agent_read_offer",
          { p_id: read, p_key: hostKey.key },
          z.unknown(),
        ),
      ).rejects.toThrow();
      await machine.report(run, "stopped");
    });
  },
);
