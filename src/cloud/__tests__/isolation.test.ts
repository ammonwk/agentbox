/** Security invariants of the cloud service, against a real Supabase stack:
 *  one workspace's data never reaches another's members, membership is not
 *  permission to deliver into someone's agents, a sender cannot claim
 *  another identity, and revocation holds on the next call.
 *
 *  Needs a local stack with the migrations applied (`supabase start`), and
 *  runs only when its keys are in the environment:
 *    bun run test:cloud
 *  The secret key here only creates the test users; no client under test
 *  holds it. */

import { describe, expect, test, beforeAll } from "bun:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CloudError, HumanCloud, InstallationCloud, supabaseFor, type CloudConfig } from "../client";

const url = process.env.AGENTBOX_CLOUD_TEST_URL;
const key = process.env.AGENTBOX_CLOUD_TEST_PUBLISHABLE_KEY;
const admin = process.env.AGENTBOX_CLOUD_TEST_SECRET_KEY;
const enabled = Boolean(url && key && admin);
const cfg: CloudConfig = { url: url ?? "", publishableKey: key ?? "" };
const run = Math.random().toString(36).slice(2, 8);

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof CloudError) return e.status;
    throw e;
  }
}

async function human(name: string): Promise<{ api: HumanCloud; id: string; email: string }> {
  const email = `${name}-${run}@agentbox.test`;
  const password = `pw-${run}-${name}-Aa1!`;
  const root = createClient(url!, admin!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await root.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const sb = supabaseFor(cfg);
  const signed = await sb.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  const api = new HumanCloud(sb);
  await api.me();
  return { api, id: data.user!.id, email };
}

const machine = (secret: string) => new InstallationCloud(supabaseFor(cfg), secret);

describe.skipIf(!enabled)("cloud tenant isolation and message authorization", () => {
  let alice: Awaited<ReturnType<typeof human>>;
  let bob: Awaited<ReturnType<typeof human>>;
  let carol: Awaited<ReturnType<typeof human>>;
  let mallory: Awaited<ReturnType<typeof human>>;
  let wsA: string;
  let wsC: string;
  let a1: InstallationCloud, a2: InstallationCloud, b1: InstallationCloud, c1: InstallationCloud;
  let a1Id: string, a2Id: string, b1Id: string;

  beforeAll(async () => {
    [alice, bob, carol, mallory] = await Promise.all([human("alice"), human("bob"), human("carol"), human("mallory")]);
    wsA = (await alice.api.createWorkspace("Team A", `team-a-${run}`)).id;
    wsC = (await carol.api.createWorkspace("Team C", `team-c-${run}`)).id;
    const inv = await alice.api.createInvite(wsA, { email: bob.email });
    expect(await status(mallory.api.acceptInvite(inv.token))).toBe(403); // bound to bob's email
    expect((await bob.api.acceptInvite(inv.token)).role).toBe("member");

    const r1 = await alice.api.registerInstallation(wsA, `alice-mac-${run}`);
    const r2 = await alice.api.registerInstallation(wsA, `alice-box-${run}`);
    const rb = await bob.api.registerInstallation(wsA, `bob-mac-${run}`);
    const rc = await carol.api.registerInstallation(wsC, `carol-mac-${run}`, { scopes: ["messages:send", "messages:receive", "artifacts:read", "artifacts:publish"] });
    [a1, a2, b1, c1] = [machine(r1.secret), machine(r2.secret), machine(rb.secret), machine(rc.secret)];
    [a1Id, a2Id, b1Id] = [r1.installation.id, r2.installation.id, rb.installation.id];
  });

  test("a non-member sees nothing of another workspace", async () => {
    await alice.api.publishPlan(wsA, { slug: "roadmap", title: "Roadmap", body: "secret plan" });
    await alice.api.publishSkill(wsA, { name: "deploy", files: [{ path: "SKILL.md", content: "---\nname: deploy\n---\nsecret" }] });
    await a2.send({ clientId: `iso-${run}-0`, target: a1Id, targetAgent: "abc123", body: "hello" });
    const sb = carol.api.sb;
    for (const table of ["workspaces", "workspace_members", "workspace_policies", "workspace_invites", "installations", "plans", "plan_revisions", "skills", "skill_revisions", "messages", "delivery_grants", "agent_identities"]) {
      const { data, error } = await sb.from(table).select("*").eq(table === "workspaces" ? "id" : "workspace_id", wsA);
      expect(error).toBeNull();
      expect(data).toEqual([]);
      // The same query as a member finds rows, so the empty answer above is
      // the policy and not a missing grant.
      if (!["workspace_invites", "delivery_grants", "agent_identities"].includes(table)) {
        const own = await alice.api.sb.from(table).select("*").eq(table === "workspaces" ? "id" : "workspace_id", wsA);
        expect(own.data?.length ?? 0).toBeGreaterThan(0);
      }
    }
    expect(await status(carol.api.publishPlan(wsA, { slug: "x", title: "x", body: "x" }))).toBe(403);
    expect(await status(carol.api.registerInstallation(wsA, `intruder-${run}`))).toBe(404);
    expect(await status(carol.api.createInvite(wsA))).toBe(403);
    expect(await status(carol.api.policy(wsA))).toBe(404);
    // An installation of another workspace can neither address nor read it.
    expect(await status(c1.send({ clientId: `iso-${run}-c`, target: a1Id, targetAgent: "abc123", body: "hi" }))).toBe(403);
    expect((await c1.plans()).map((p) => p.workspace_id)).toEqual([]);
    expect(await status(c1.skill("deploy"))).toBe(404);
  });

  test("nobody signed in reads nothing and calls no human RPC", async () => {
    const anon = supabaseFor(cfg);
    for (const table of ["profiles", "user_settings", "workspaces", "messages", "plans", "installations"]) {
      const { error } = await anon.from(table).select("*").limit(1);
      expect(error?.code).toBe("42501");
    }
    const { error } = await anon.rpc("create_workspace", { p_name: "x", p_slug: `anon-${run}` });
    expect(error).not.toBeNull();
    expect(await status(machine(`abins_${"A".repeat(43)}`).hello("t", "t"))).toBe(401);
  });

  test("personal settings are private to their owner", async () => {
    await alice.api.saveDefaults({ provider: "claude" });
    await alice.api.saveFrontend("agentbox.web", { section: "plans" });
    const { data } = await bob.api.sb.from("user_settings").select("*").eq("user_id", alice.id);
    expect(data).toEqual([]);
    const { data: changed } = await bob.api.sb.from("user_settings").update({ defaults: { provider: "codex" } }).eq("user_id", alice.id).select();
    expect(changed).toEqual([]);
    expect((await alice.api.settings()).defaults.provider).toBe("claude");
    expect(await status(alice.api.saveFrontend("notnamespaced", {}))).toBe(400);
  });

  test("only admins invite; invites expire, run out and can be revoked", async () => {
    expect(await status(bob.api.createInvite(wsA))).toBe(403);
    expect(await status(alice.api.createInvite(wsA, { ttlHours: 10_000 }))).toBe(400);
    const once = await alice.api.createInvite(wsA, { maxUses: 1 });
    await mallory.api.acceptInvite(once.token);
    const dave = await human("dave");
    expect(await status(dave.api.acceptInvite(once.token))).toBe(403); // used up
    const revoked = await alice.api.createInvite(wsA);
    await alice.api.revokeInvite(revoked.invite.id);
    expect(await status(dave.api.acceptInvite(revoked.token))).toBe(403);
    await alice.api.removeMember(wsA, mallory.id);
  });

  test("membership is not permission to deliver; grants are, until revoked", async () => {
    const send = (from: InstallationCloud, id: string, body = "hi") => from.send({ clientId: id, target: a1Id, targetAgent: "abc123", body });
    expect(await status(send(b1, `grant-${run}-1`))).toBe(403);
    const g = await alice.api.grantDelivery(a1Id, { user: bob.id });
    expect((await send(b1, `grant-${run}-2`)).message.state).toBe("queued");
    await alice.api.revokeDelivery(g.id);
    expect(await status(send(b1, `grant-${run}-3`))).toBe(403);
    // Queued before the revocation, refused at delivery after it.
    const fetched = await a1.fetch(50);
    expect(fetched.some((m) => m.client_msg_id === `grant-${run}-2`)).toBe(false);
    const after = await b1.messages("out", { limit: 10 });
    expect(after.find((m) => m.client_msg_id === `grant-${run}-2`)?.state).toBe("refused");
    for (const m of fetched) await a1.ack(m.id, "delivered", null);
    // Bob only grants into his own machines.
    expect(await status(bob.api.grantDelivery(a1Id, { user: bob.id }))).toBe(404);
  });

  test("the sender is who its credential says, and a retry is the same message", async () => {
    const first = await a2.send({ clientId: `dup-${run}-1`, target: a1Id, targetAgent: "s1", body: "same", senderAgent: "w1" });
    const again = await a2.send({ clientId: `dup-${run}-1`, target: a1Id, targetAgent: "s1", body: "same", senderAgent: "w1" });
    expect(again.duplicate).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    expect(await status(a2.send({ clientId: `dup-${run}-1`, target: a1Id, targetAgent: "s1", body: "different" }))).toBe(409);
    expect(first.message.sender_user_id).toBe(alice.id);
    expect(first.message.sender_installation_id).toBe(a2Id);
    expect(first.message.sender_label).toContain(`alice-box-${run}/w1`);
    // Bob is a member, but neither sent it nor owns its target.
    const { data } = await bob.api.sb.from("messages").select("id").eq("id", first.message.id);
    expect(data).toEqual([]);
  });

  test("only the target leases and acks, and the body goes when delivery ends", async () => {
    const sent = await a2.send({ clientId: `ack-${run}-1`, target: a1Id, targetAgent: "s1", body: "payload" });
    expect((await b1.messages("in")).some((m) => m.id === sent.message.id)).toBe(false);
    expect(await status(b1.ack(sent.message.id, "delivered", null))).toBe(404); // not its message
    const leased = (await a1.fetch(50)).find((m) => m.id === sent.message.id)!;
    expect(leased.body).toBe("payload");
    expect(leased.sender.email).toBe(alice.email);
    expect(await status(a2.ack(sent.message.id, "delivered", null))).toBe(404);
    expect((await a1.ack(sent.message.id, "uncertain", "restarted mid-typing")).state).toBe("uncertain");
    expect(await status(a1.ack(sent.message.id, "delivered", null))).toBe(409);
    const { data } = await alice.api.sb.from("messages").select("body, state").eq("id", sent.message.id).single();
    expect(data).toEqual({ body: null, state: "uncertain" });
  });

  test("team policy bounds messages and only admins set it", async () => {
    expect(await status(bob.api.setPolicy(wsA, { messaging: { max_body_bytes: 300 } }))).toBe(403);
    expect(await status(alice.api.setPolicy(wsA, { messaging: { nope: 1 } as never }))).toBe(400);
    await alice.api.setPolicy(wsA, { messaging: { max_body_bytes: 300 } });
    expect(await status(a2.send({ clientId: `pol-${run}-1`, target: a1Id, targetAgent: "s1", body: "x".repeat(400) }))).toBe(400);
    expect(await status(a2.send({ clientId: `pol-${run}-2`, target: a1Id, targetAgent: "s1", body: "wake up", wake: true }))).toBe(403);
    await alice.api.setPolicy(wsA, { messaging: { max_body_bytes: 16384 } });
  });

  test("scopes, accept_own and bundles are checked by the service", async () => {
    expect(await status(a1.publishPlan({ slug: "nope", title: "t", body: "b" }))).toBe(403);
    expect(await status(alice.api.publishSkill(wsA, { name: "bad", files: [{ path: "../SKILL.md", content: "x" }] }))).toBe(400);
    expect(await status(alice.api.publishSkill(wsA, { name: "bad", files: [{ path: "README.md", content: "x" }] }))).toBe(400);
    const { error } = await a1.sb.rpc("inst_sync_providers", { p_secret: "x", p_connections: [] });
    expect(error).not.toBeNull();
    expect(await status(a1.syncProviders([{ provider: "claude", account_label: "work", token: "sk-…" } as never]))).toBe(200); // the client strips it
    const raw = await (a1 as unknown as { sb: SupabaseClient }).sb.rpc("inst_hello", { p_secret: "abins_" + "B".repeat(43) });
    expect(raw.error).not.toBeNull();
    await alice.api.updateInstallation(a1Id, { acceptOwn: false });
    expect(await status(a2.send({ clientId: `own-${run}-1`, target: a1Id, targetAgent: "s1", body: "hi" }))).toBe(403);
    await alice.api.updateInstallation(a1Id, { acceptOwn: true });
  });

  test("plans are versioned and a stale base is refused", async () => {
    const r1 = await alice.api.publishPlan(wsA, { slug: "launch", title: "Launch", body: "v1" });
    const same = await alice.api.publishPlan(wsA, { slug: "launch", title: "Launch", body: "v1" });
    expect(same.unchanged).toBe(true);
    const r2 = await alice.api.publishPlan(wsA, { slug: "launch", title: "Launch", body: "v2", baseRev: r1.revision.rev });
    expect(r2.revision.rev).toBe(r1.revision.rev + 1);
    expect(await status(bob.api.publishPlan(wsA, { slug: "launch", title: "Launch", body: "v3", baseRev: r1.revision.rev }))).toBe(409);
    expect((await bob.api.plan(wsA, "launch", 1)).revision.body).toBe("v1");
    expect((await a1.plan("launch")).revision.body).toBe("v2");
  });

  test("revoking an installation or removing its owner ends its credential at once", async () => {
    await alice.api.revokeInstallation(a2Id);
    expect(await status(a2.hello("t", "t"))).toBe(401);
    expect(await status(a2.send({ clientId: `rev-${run}-1`, target: a1Id, targetAgent: "s1", body: "hi" }))).toBe(401);
    await alice.api.grantDelivery(a1Id, { installation: b1Id });
    await b1.send({ clientId: `rm-${run}-1`, target: a1Id, targetAgent: "s1", body: "queued before removal" });
    await alice.api.removeMember(wsA, bob.id);
    expect(await status(b1.hello("t", "t"))).toBe(401);
    expect((await a1.fetch(50)).some((m) => m.client_msg_id === `rm-${run}-1`)).toBe(false);
    const { data } = await bob.api.sb.from("workspaces").select("id").eq("id", wsA);
    expect(data).toEqual([]);
  });
});
