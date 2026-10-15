/** What a teammate reads of a shared superagent carries no credential and no
 *  tool payload, and their guidance is typed only into the conversation they
 *  saw, after the cloud has checked them again. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudError } from "../../cloud/config";
import type { ClaimedCommand } from "../../cloud/superagents";
import { closeDb } from "../db";
import type { TimelineEvent } from "../types";
import { CHECKPOINT_MARK } from "./marks";
import { saveShare, shareOf } from "./shares";
import { guideTarget, redact, teamChatEvents, TeamHost, type TeamDeps } from "./team";

let home: string, previous: string | undefined;
beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "superagent-team-"));
  process.env.AGENTBOX_HOME = home;
});
afterEach(() => {
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

const token = `ghp_${"a".repeat(36)}`;
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXRleHQ";

test("a teammate's chat page has what was said and asked, with credentials redacted", () => {
  const events: TimelineEvent[] = [
    { id: "1", at: 1, kind: "user", text: `use ${token} for the push` },
    { id: "2", at: 2, kind: "assistant", text: `Bearer ${jwt} works` },
    { id: "3", at: 3, kind: "thinking", text: `private ${token}` },
    { id: "4", at: 4, kind: "tool", name: "Bash", summary: "cat .env", input: `TOKEN=${token}`, output: token, status: "ok" },
    {
      id: "5", at: 5, kind: "tool", name: "AskUserQuestion", summary: "ask", status: "ok",
      ask: { id: "q", questions: [{ question: `Rotate ${token}?`, header: "h", multiSelect: false, options: [{ label: "yes" }, { label: token }] }], answers: { [`Rotate ${token}?`]: "yes" } },
    },
    { id: "6", at: 6, kind: "meta", text: token },
  ];
  const page = teamChatEvents(events);
  expect(page.map((e) => e.id)).toEqual(["1", "2", "5"]);
  const text = JSON.stringify(page);
  expect(text).not.toContain(token);
  expect(text).not.toContain(jwt);
  expect(text).not.toContain("cat .env");
  expect(redact("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("[redacted]");
  expect(redact("nothing secret here")).toBe("nothing secret here");
});

test("a teammate's chat page leaves out the main's private opening, agentbox's notes and other senders' messages", () => {
  const preamble = "MAIN.md: the private instructions\n\n---\n\nSOUL.md and memory";
  const events: TimelineEvent[] = [
    { id: "1", at: 1, kind: "user", text: `${preamble}\n\n---\n\nWhat is due today?` },
    { id: "2", at: 2, kind: "assistant", text: "Two PRs." },
    { id: "3", at: 3, kind: "user", text: `${CHECKPOINT_MARK} for handoff] write a handoff` },
    { id: "4", at: 4, kind: "user", text: "from another session", sender: { kind: "session", label: "s-9", session: "s-9" } },
    { id: "5", at: 5, kind: "user", text: "agentbox's note", sender: { kind: "system", label: "agentbox", session: null } },
    { id: "6", at: 6, kind: "user", text: "a later message\n\n---\n\nwith a rule in it" },
  ];
  const page = teamChatEvents(events, true);
  expect(page.map((e) => e.id)).toEqual(["1", "2", "6"]);
  expect(page[0]).toMatchObject({ text: "What is due today?" });
  expect(page[2]).toMatchObject({ text: "a later message\n\n---\n\nwith a rule in it" });
  expect(JSON.stringify(page)).not.toContain("private instructions");
  // A page that does not reach the start has no opening to cut.
  expect(teamChatEvents(events.slice(1), false).map((e) => e.id)).toEqual(["2", "6"]);
});

test("guidance goes to the main conversation the teammate saw, or nowhere", () => {
  expect(guideTarget("s1", "s1")).toEqual({ session: "s1" });
  expect(guideTarget("s2", "s1")).toHaveProperty("refused");
  expect(guideTarget(null, "s1")).toHaveProperty("refused");
  expect(guideTarget("s1", null)).toHaveProperty("refused");
});

function host(main: { id: string | null }) {
  const sent: { session: string; text: string }[] = [];
  const deps = {
    fleet: { send: async (session: string, text: string, attempt?: () => void) => (attempt?.(), void sent.push({ session, text })), sessions: () => [], timeline: async () => ({ events: [], before: null, cursor: "" }) },
    superagents: { has: () => true, get: () => ({ main: main.id, enabled: true, previous: [], title: "Vulcan" }), view: async () => null, action: async () => null },
    cloud: { api: () => { throw new CloudError("not set up", 409); }, status: () => ({ installation: { id: "inst-1" } }) },
    claims: { local: {}, backends: [], backendOf: () => ({}) },
  } as unknown as TeamDeps;
  saveShare({ name: "vulcan", instance: "i-1", workspace: "w-1", installation: "inst-1", visibility: "workspace", maintainers: ["u-1"], source: null });
  return { team: new TeamHost(deps), sent };
}

function api(check: () => Promise<void> = async () => {}) {
  const results: { id: string; state: string; result: string }[] = [];
  return { results, commandCheck: check, commandResult: async (id: string, state: string, result: string) => void results.push({ id, state, result }) };
}

const command = (id: string, expected: string): ClaimedCommand => ({
  id, instance_id: "i-1", kind: "guide", body: { text: "Please look at #12 first" }, expected_session: expected, client_key: null,
  sender: { user_id: "u-2", email: "bob@example.com", display_name: "Bob" },
});

type Guide = (api: unknown, name: string, c: ClaimedCommand) => Promise<void>;

test("a teammate's guidance is typed once into the conversation they saw", async () => {
  const main = { id: "s1" as string | null };
  const { team, sent } = host(main);
  const a = api();
  const guideOf = (team as unknown as { guide: Guide }).guide.bind(team);
  await guideOf(a, "vulcan", command("c-1", "s1"));
  expect(sent.map((s) => s.session)).toEqual(["s1"]);
  expect(sent[0]!.text).toContain("not from the owner of this machine");
  expect(a.results.at(-1)!.state).toBe("sent");
  // The same command again (a retry) is not typed twice.
  await guideOf(a, "vulcan", command("c-1", "s1"));
  expect(sent).toHaveLength(1);

  // The main rolled over before the host ran it: nothing is typed anywhere.
  main.id = "s2";
  await guideOf(a, "vulcan", command("c-2", "s1"));
  expect(sent).toHaveLength(1);
  expect(a.results.at(-1)).toMatchObject({ id: "c-2", state: "refused" });
});

test("guidance is checked again right before it is typed", async () => {
  const main = { id: "s1" as string | null };
  const { team, sent } = host(main);
  const guideOf = (team as unknown as { guide: Guide }).guide.bind(team);
  // The teammate was removed from the workspace after the claim.
  const revoked = api(async () => { throw new CloudError("its sender can no longer see this superagent", 403); });
  await guideOf(revoked, "vulcan", command("c-3", "s1"));
  // The main changed between the claim and the typing.
  const moved = api(async () => void (main.id = "s9"));
  await guideOf(moved, "vulcan", command("c-4", "s1"));
  expect(sent).toHaveLength(0);
  expect(revoked.results.at(-1)).toMatchObject({ state: "refused" });
  expect(moved.results.at(-1)).toMatchObject({ state: "refused" });
});

const claim = (instance: string, host: string) => ({
  key: `x:${instance}`, source: `x:${instance}`, scope: "work", fence: 1, lease_until: 0, state: "active",
  instance_id: instance, instance_name: "n", host_installation_id: host, host_name: null, session: null, note: null,
});

test("a share the cloud stopped listing stays while the cloud lists claims of it, and the cloud keeps its claims", async () => {
  const { team } = host({ id: "s1" });
  saveShare({ name: "atlas", instance: "i-2", workspace: "w-1", installation: "inst-1", visibility: "private", maintainers: ["u-1"], source: null });
  // The cloud lists neither (unshared, or superagents:host turned off), and still lists a claim of vulcan's instance.
  const cloud = {
    instances: async () => { throw new CloudError("this installation was not granted superagents:host", 403); },
    claims: async () => [claim("i-1", "inst-1")],
  };
  await team.sync(cloud as never, "inst-1");
  expect(shareOf("vulcan")?.instance).toBe("i-1");
  expect(shareOf("atlas")).toBeNull();
  expect(team.kept.get("vulcan")).toBe(1);
  expect(team.lastError?.message).toContain("vulcan (1 claim)");
  // A claims list that cannot be read changes nothing.
  await expect(team.sync({ instances: async () => [], claims: async () => { throw new CloudError("offline", 0); } } as never, "inst-1")).rejects.toThrow("offline");
  expect(shareOf("vulcan")).not.toBeNull();
  // Released: the share goes, and the claims stay looked up in the cloud from here.
  await team.sync({ instances: async () => [], claims: async () => [] } as never, "inst-1");
  expect(shareOf("vulcan")).toBeNull();
  expect(team.kept.size).toBe(0);
  expect(team.lastError).toBeNull();
  expect(team.hostsOrHosted()).toBe(true);
});
