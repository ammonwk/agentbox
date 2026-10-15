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
import { saveShare } from "./shares";
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
