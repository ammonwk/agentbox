/** Security rules of shared superagents, against a real Supabase stack
 *  (supabase/migrations/20261015120000_shared_superagents.sql):
 *  only the host owner shares and changes an instance, seeing one gives no
 *  right to change or host it, a non-member reads nothing, claims keep one
 *  holder across the workspace's instances with fences and an exclusive
 *  expiry, the relay's key and commands are checked again at each step, and
 *  contact consent is off by default with a no that wins.
 *
 *  Runs only with a local stack's keys in the environment: bun run test:cloud */

import { beforeAll, describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { CloudError, HumanCloud, InstallationCloud, supabaseFor, type CloudConfig } from "../client";
import { relayIdentity } from "../relay";
import { HumanSuperagents, InstallationSuperagents, type CloudClaim } from "../superagents";

const url = process.env.AGENTBOX_CLOUD_TEST_URL;
const key = process.env.AGENTBOX_CLOUD_TEST_PUBLISHABLE_KEY;
const admin = process.env.AGENTBOX_CLOUD_TEST_SECRET_KEY;
const enabled = Boolean(url && key && admin);
const cfg: CloudConfig = { url: url ?? "", publishableKey: key ?? "" };
const run = Math.random().toString(36).slice(2, 8);
const root = () => createClient(url!, admin!, { auth: { persistSession: false, autoRefreshToken: false } });
const HOST_SCOPES = ["messages:send", "messages:receive", "artifacts:read", "superagents:host"] as const;

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof CloudError) return e.status;
    throw e;
  }
}

async function human(name: string) {
  const email = `${name}-${run}@agentbox.test`;
  const password = `pw-${run}-${name}-Aa1!`;
  const { data, error } = await root().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const sb = supabaseFor(cfg);
  const signed = await sb.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  const api = new HumanCloud(sb);
  await api.me();
  return { api, team: new HumanSuperagents(sb), id: data.user!.id, email };
}

const machine = (secret: string) => new InstallationSuperagents(new InstallationCloud(supabaseFor(cfg), secret));
const uuid = () => crypto.randomUUID();
const GH = "https://github.com/acme/widget/issues/7";
const GH_KEY = "github:acme/widget#7";

describe.skipIf(!enabled)("shared superagents", () => {
  let alice: Awaited<ReturnType<typeof human>>, bob: Awaited<ReturnType<typeof human>>, carol: Awaited<ReturnType<typeof human>>, dave: Awaited<ReturnType<typeof human>>;
  let ws: string;
  let a1: InstallationSuperagents, b1: InstallationSuperagents, c1: InstallationSuperagents;
  let a1Id: string, a2Id: string, b1Id: string;
  let instA: string, instB: string;

  beforeAll(async () => {
    [alice, bob, carol, dave] = await Promise.all([human("alice"), human("bob"), human("carol"), human("dave")]);
    ws = (await alice.api.createWorkspace("Team S", `team-s-${run}`)).id;
    const wsC = (await carol.api.createWorkspace("Team T", `team-t-${run}`)).id;
    await bob.api.acceptInvite((await alice.api.createInvite(ws, { email: bob.email })).token);
    await dave.api.acceptInvite((await alice.api.createInvite(ws, { email: dave.email })).token);
    const ra = await alice.api.registerInstallation(ws, `alice-host-${run}`, { scopes: [...HOST_SCOPES] });
    const ra2 = await alice.api.registerInstallation(ws, `alice-plain-${run}`);
    const rb = await bob.api.registerInstallation(ws, `bob-host-${run}`, { scopes: [...HOST_SCOPES] });
    const rc = await carol.api.registerInstallation(wsC, `carol-host-${run}`, { scopes: [...HOST_SCOPES] });
    [a1, b1, c1] = [machine(ra.secret), machine(rb.secret), machine(rc.secret)];
    [a1Id, a2Id, b1Id] = [ra.installation.id, ra2.installation.id, rb.installation.id];
  });

  test("only the host owner shares and changes an instance; seeing it gives no edit or host right", async () => {
    // Someone else's machine, and a machine without superagents:host, are refused.
    expect(await status(bob.team.share({ installation: a1Id, name: "vulcan", title: "Vulcan", visibility: "workspace" }))).toBe(403);
    expect(await status(alice.team.share({ installation: a2Id, name: "vulcan", title: "Vulcan", visibility: "workspace" }))).toBe(403);
    expect(await status(alice.team.share({ installation: a1Id, name: "vulcan", title: "Vulcan", visibility: "workspace", maintainers: [carol.id] }))).toBe(400);
    const a = await alice.team.share({ installation: a1Id, name: "vulcan", title: "Vulcan", visibility: "workspace", maintainers: [bob.id] });
    instA = a.id;
    expect(a.host.installation_id).toBe(a1Id);
    expect(a.maintainers.sort()).toEqual([alice.id, bob.id].sort());

    // Bob sees it and maintains it, and still cannot change, unshare or move it.
    const seen = (await bob.team.directory(ws)).find((i) => i.id === instA)!;
    expect(seen.can_edit).toBe(false);
    expect(seen.maintainer).toBe(true);
    expect(await status(bob.team.update(instA, { title: "Mine now" }))).toBe(403);
    expect(await status(bob.team.unshare(instA))).toBe(403);
    const direct = await bob.api.sb.from("superagent_instances").update({ host_installation_id: b1Id }).eq("id", instA).select();
    expect(direct.error?.code).toBe("42501");
    // The same name shared by Bob is his own instance, on his own machine.
    const b = await bob.team.share({ installation: b1Id, name: "vulcan", title: "Bob's Vulcan", visibility: "workspace" });
    instB = b.id;
    expect(b.id).not.toBe(instA);
    expect(b.host.installation_id).toBe(b1Id);
    expect((await alice.team.directory(ws)).find((i) => i.id === instA)!.host.installation_id).toBe(a1Id);

    // A private instance is invisible to a member who does not maintain it.
    const p = await alice.team.share({ installation: a1Id, name: "secret", title: "Secret", visibility: "private" });
    expect((await dave.team.directory(ws)).map((i) => i.id)).not.toContain(p.id);
    expect(await status(dave.team.readChat(p.id))).not.toBe(200);
    expect(await status(dave.team.guide(p.id, "hi", uuid(), "s1"))).toBe(404);
    expect((await alice.team.update(p.id, { visibility: "workspace" })).visibility).toBe("workspace");
    expect((await alice.team.unshare(p.id)).unshared_at).not.toBeNull();
    expect((await dave.team.directory(ws)).map((i) => i.id)).not.toContain(p.id);
  });

  test("a non-member reads nothing and asks nothing", async () => {
    expect(await status(carol.team.directory(ws))).toBe(404);
    for (const table of ["superagent_instances", "superagent_claims", "superagent_claim_events", "contact_preferences"]) {
      const { data, error } = await carol.api.sb.from(table).select("*").eq("workspace_id", ws);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    for (const table of ["superagent_reads", "superagent_commands"]) {
      const { error } = await bob.api.sb.from(table).select("*").limit(1);
      expect(error?.code).toBe("42501");
    }
    const id = uuid();
    const { error } = await carol.api.sb.rpc("superagent_read_request", { p_id: id, p_instance: instA, p_kind: "chat", p_request: {}, p_key: (await relayIdentity()).key });
    expect(error).not.toBeNull();
    expect(await status(carol.team.guide(instA, "do my work", uuid(), "s1"))).toBe(404);
    // An installation of another workspace hosts nothing here.
    expect(await status(c1.claimAcquire(instA, "work", [{ key: GH_KEY, source: GH }], null, null))).toBe(403);
  });

  test("claims: one holder across the workspace's instances, fences, an exclusive expiry, and a takeover only its host completes", async () => {
    const [c] = await a1.claimAcquire(instA, "work", [{ key: GH_KEY, source: GH }], "s-a", "fix 7");
    expect(c!.fence).toBe(1);
    // Another instance, and the holder itself, are refused; a conflict names the holder.
    const conflict = await b1.claimAcquire(instB, "work", [{ key: GH_KEY, source: "https://github.com/ACME/Widget/pull/7#x" }], null, null).catch((e: CloudError) => e);
    expect((conflict as CloudError).status).toBe(409);
    expect((JSON.parse((conflict as CloudError).detail!) as CloudClaim).instance_id).toBe(instA);
    expect(await status(a1.claimAcquire(instA, "work", [{ key: GH_KEY, source: GH }], null, null))).toBe(409);
    // A raw call cannot make a second key for the same issue.
    expect(await status(b1.claimAcquire(instB, "work", [{ key: "issue-7", source: GH }], null, null))).toBe(400);
    // All or none: a held key in the batch takes nothing.
    expect(await status(b1.claimAcquire(instB, "work", [{ key: "x:free", source: "x:free" }, { key: GH_KEY, source: GH }], null, null))).toBe(409);
    expect((await b1.claims({ key: "x:free" })).length).toBe(0);

    // Fences: each change of holder raises it, and a stale one is refused.
    const attached = await a1.claimAttach(instA, "work", GH_KEY, 1, "s-a2");
    expect(attached.fence).toBe(2);
    expect(await status(a1.claimAttach(instA, "work", GH_KEY, 1, "s-a3"))).toBe(409);
    expect(await status(a1.claimRelease(instA, "work", GH_KEY, 1))).toBe(409);
    // Another machine cannot act on it, through its own instance or the holder's.
    expect(await status(b1.claimRelease(instB, "work", GH_KEY, 2))).toBe(403);
    expect(await status(b1.claimRelease(instA, "work", GH_KEY, 2))).toBe(403);

    // A lease past its end is uncertain and still excludes.
    await root().from("superagent_claims").update({ lease_until: new Date(Date.now() - 60_000).toISOString() }).eq("workspace_id", ws).eq("key", GH_KEY);
    expect((await b1.claims({ key: GH_KEY }))[0]!.state).toBe("uncertain");
    await a1.claimRenew([]);
    expect((await a1.claims({ key: GH_KEY }))[0]!.state).toBe("uncertain");
    expect(await status(b1.claimAcquire(instB, "work", [{ key: GH_KEY, source: GH }], null, null))).toBe(409);

    // A takeover: requested, it still excludes; only the holding instance's host completes it.
    expect(await status(b1.claimTakeoverRequest(instB, "work", GH_KEY, 2))).toBe(403);
    expect((await a1.claimTakeoverRequest(instA, "work", GH_KEY, 2)).state).toBe("takeover_requested");
    expect(await status(b1.claimAcquire(instB, "work", [{ key: GH_KEY, source: GH }], null, null))).toBe(409);
    expect(await status(a1.claimAttach(instA, "work", GH_KEY, 2, "s-x"))).toBe(409);
    expect(await status(b1.claimTakeoverComplete(instA, "work", GH_KEY, 2, "s-b"))).toBe(403);
    const taken = await a1.claimTakeoverComplete(instA, "work", GH_KEY, 2, "s-new");
    expect([taken.fence, taken.state, taken.session]).toEqual([3, "active", "s-new"]);

    // A handover moves it with fence + 1; a release frees it for anyone.
    expect(await a1.claimHandover("s-new", "s-heir")).toBe(1);
    const moved = (await a1.claims({ key: GH_KEY }))[0]!;
    expect([moved.fence, moved.session]).toEqual([4, "s-heir"]);
    await a1.claimRelease(instA, "work", GH_KEY, 4);
    const next = await b1.claimAcquire(instB, "work", [{ key: GH_KEY, source: GH }], null, null);
    expect(next[0]!.fence).toBe(5);
    await b1.claimRelease(instB, "work", GH_KEY, 5);
  });

  test("relay: the host key goes only to a current reader, and commands are checked again when they run", async () => {
    const reader = await relayIdentity();
    const host = await relayIdentity();
    const id = uuid();
    await dave.team.sb.rpc("superagent_read_request", { p_id: id, p_instance: instA, p_kind: "chat", p_request: {}, p_key: reader.key }).then((r) => {
      if (r.error) throw new Error(r.error.message);
    });
    expect((await a1.pending()).reads.map((r) => r.id)).toContain(id);
    expect(await status(b1.readOffer(id, host.key))).toBe(403);
    await a1.readOffer(id, host.key);
    const keyOf = (who: typeof dave, read: string) => who.team.sb.rpc("superagent_read_key", { p_id: read });
    expect((await keyOf(dave, id)).data).toBe(host.key);
    expect((await keyOf(bob, id)).error).not.toBeNull();

    // Guidance queued by Dave; then Dave leaves the workspace before the host runs it.
    const queued = await dave.team.guide(instA, "please look at #7", uuid(), "s-main");
    expect(queued.state).toBe("queued");
    const daveReadsAgain = uuid();
    await dave.team.sb.rpc("superagent_read_request", { p_id: daveReadsAgain, p_instance: instA, p_kind: "view", p_request: {}, p_key: reader.key });
    await alice.api.removeMember(ws, dave.id);
    expect((await keyOf(dave, id)).error).not.toBeNull();
    expect(await status(a1.readOffer(daveReadsAgain, host.key))).toBe(403);
    expect(await status(a1.commandClaim(queued.id, null))).toBe(403);

    // Bob's guidance is claimed, then he can no longer see the instance: the check before typing refuses.
    const g = await bob.team.guide(instA, "ship it", uuid(), "s-main");
    const claimed = await a1.commandClaim(g.id, null);
    expect(claimed.body).toEqual({ text: "ship it" });
    expect(claimed.expected_session).toBe("s-main");
    expect(await status(a1.commandClaim(g.id, null))).toBe(409); // never handed out twice
    await a1.commandCheck(g.id);
    await alice.team.update(instA, { visibility: "private", maintainers: [] });
    expect(await status(a1.commandCheck(g.id))).toBe(403);
    await a1.commandResult(g.id, "refused", "its sender can no longer see it");
    const r = await bob.team.receipt(g.id);
    expect([r.state, r.host_key]).toEqual(["refused", null]);
    const { data: body } = await root().from("superagent_commands").select("body").eq("id", g.id).single();
    expect(body?.body).toBeNull();

    // An unshare refuses what is still queued.
    await alice.team.update(instA, { visibility: "workspace" });
    const late = await bob.team.sb.rpc("superagent_act", { p_id: uuid(), p_instance: instA, p_action: "refresh", p_values: {}, p_tab: null, p_key: reader.key });
    expect(late.error).toBeNull();
    expect((late.data as { state: string }).state).toBe("queued");
    await alice.team.unshare(instA);
    const { data: left } = await root().from("superagent_commands").select("state").eq("instance_id", instA).eq("state", "queued");
    expect(left).toEqual([]);
    expect(await status(a1.claimAcquire(instA, "work", [{ key: "x:after", source: "x:after" }], null, null))).toBe(409);
    await alice.team.share({ installation: a1Id, name: "vulcan", title: "Vulcan", visibility: "workspace", maintainers: [bob.id] });
  });

  test("relay: a page crosses Realtime sealed, and opens for the reader who asked", async () => {
    const answered = (async () => {
      for (let i = 0; i < 40; i++) {
        const r = (await a1.pending()).reads.find((x) => x.instance_id === instA);
        if (r) {
          const { pair, key: hostKey } = await relayIdentity();
          await a1.readOffer(r.id, hostKey);
          await a1.relay(r.id, pair, r.client_key, { view: { blocks: [{ type: "heading", text: "Open work" }] }, request: r.request }, () => a1.readOffer(r.id, hostKey));
          return;
        }
        await Bun.sleep(250);
      }
      throw new Error("no read arrived");
    })();
    const page = await bob.team.readView(instA, "work");
    await answered;
    expect(page).toEqual({ view: { blocks: [{ type: "heading", text: "Open work" }] }, request: { tab: "work" } } as never);
  });

  test("consent: off by default, a verified GitHub id to say yes, and a no that wins", async () => {
    // Saying yes needs a verified GitHub identity; saying no never does.
    expect(await status(alice.team.setContactPreference(ws, { allowed: true }))).toBe(403);
    expect((await alice.team.setContactPreference(ws, { allowed: false, repo: "acme/other" })).allowed).toBe(false);
    await root().auth.admin.updateUserById(alice.id, { app_metadata: { github_id: 1001 } });
    await root().auth.admin.updateUserById(bob.id, { app_metadata: { github_id: 3003 } });
    await alice.team.setContactPreference(ws, { allowed: true });
    const check = (m: InstallationSuperagents, inst: string | null, repo: string, ids: number[]) =>
      m.contactCheck(inst, repo, ids).then((r) => Object.fromEntries(r.map((x) => [x.id, x.allowed])));
    // Alice said yes everywhere; Bob said nothing; 2002 is nobody here.
    expect(await check(a1, instA, "acme/widget", [1001, 3003, 2002])).toEqual({ 1001: true, 3003: false, 2002: false });
    // Her no for one repo wins there, and only there.
    expect(await check(a1, instA, "acme/other", [1001])).toEqual({ 1001: false });
    await alice.team.setContactPreference(ws, { allowed: false, repo: "acme/widget", instance: instB });
    expect(await check(b1, instB, "acme/widget", [1001])).toEqual({ 1001: false });
    expect(await check(a1, instA, "acme/widget", [1001])).toEqual({ 1001: true });
    expect(await check(a1, null, "acme/widget", [1001])).toEqual({ 1001: true });
    // A machine of another workspace learns nothing of her.
    expect(await check(c1, null, "acme/widget", [1001])).toEqual({ 1001: false });
    // An instance on another machine cannot be asked about.
    expect(await status(b1.contactCheck(instA, "acme/widget", [1001]))).toBe(403);
    // Bob cannot read her choices.
    const { data } = await bob.api.sb.from("contact_preferences").select("*").eq("user_id", alice.id);
    expect(data).toEqual([]);
  });
});
