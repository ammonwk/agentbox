/** Destructive/security boundaries, exercised through real human and machine
 * credentials against local Supabase. No production service key is accepted. */
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
  },
);
