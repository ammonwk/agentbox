/** Steward against a fake agentbox and a fake gh: which pull requests it
 *  takes, who owns each, and when it counts one as handed on. Starting an
 *  owner nobody asked for, or two owners on one PR, is the failure these guard. */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { AgentboxError } from "../../lib/sdk";
import { Steward, type Box, type Config, type Pr } from "../steward";
import type { Repo, Session } from "../../../src/core/types";

const REPO = "acme/app";
const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const MAIN = "main0001";
const JUDGE = "judge001";

type Fake = Box & { sessions: Session[]; starts: Record<string, unknown>[]; sends: { id: string; text: string }[]; chats: string[]; holders: Map<string, string> };

function fakeBox(): Fake {
  const box: Fake = {
    sessions: [],
    starts: [],
    sends: [],
    chats: [],
    holders: new Map(),
    state: async () => ({ sessions: box.sessions, repos: [{ id: "r1", fullName: REPO, displayName: "app", ref: "/x/app", kind: "local" } as Repo] }),
    prWho: async (pr) => ({ claim: box.holders.has(pr) ? { sessionId: box.holders.get(pr)! } : null }),
    start: async (spec) => {
      if (box.holders.has(spec.claim)) throw new AgentboxError(`${spec.claim} is held`, 409);
      const id = `own${box.starts.length + 1}`;
      box.starts.push(spec);
      box.sessions.push(session(id));
      box.holders.set(spec.claim, id);
      return { id };
    },
    send: async (id, text) => {
      box.sends.push({ id, text });
      // What agentbox types becomes its last prompt.
      const s = box.sessions.find((x) => x.id === id);
      if (s) s.lastPromptAt = Math.max(Date.now(), s.lastActivityAt + 1);
      return null;
    },
    main: async () => MAIN,
    chat: async (text) => box.chats.push(text),
  };
  box.sessions.push(session(MAIN));
  return box;
}

function session(id: string, status = "waiting", lastMessage: string | null = null): Session {
  return { id, status, lastMessage, lastPromptAt: Date.now(), lastActivityAt: Date.now() } as Session;
}

const pr = (number: number, head: string, over: Partial<Pr> = {}): Omit<Pr, "repo"> => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/${REPO}/pull/${number}`,
  headRefName: `b${number}`,
  headRefOid: head,
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
  state: "OPEN",
  ...over,
});

let box: Fake, prs: Map<number, Omit<Pr, "repo">>, ghCalls: string[][];
const gh = async (args: string[]) => {
  ghCalls.push(args);
  if (args[1] === "list") return JSON.stringify([...prs.values()]);
  if (args[1] === "view") return JSON.stringify(prs.get(Number(args[2])));
  throw new Error(`fake gh: ${args.join(" ")}`);
};
const template = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
function steward(over: Partial<Config> = {}) {
  const cfg: Config = { repos: [], author: "@me", every: 60, owners: { provider: "claude", running: 4, perPass: 2, prompt: "OWNER.md" }, ...over };
  return new Steward(new Database(":memory:"), cfg, box, gh, { name: "cura-app", title: "Cura", project: "r1", bin: "agentbox", template });
}
const caller = (session: string | null = null) => ({ session, via: "api" as const });
const tend = (s: Steward, values: Record<string, unknown>, from: string | null = JUDGE) => s.tend({ repo: REPO, number: 7, head: H1, from, ...values }, caller(from));
const say = (id: string, text: string) => {
  const s = box.sessions.find((x) => x.id === id)!;
  s.lastMessage = text;
  s.lastActivityAt = Math.max(s.lastActivityAt, s.lastPromptAt) + 1;
};

beforeEach(() => {
  box = fakeBox();
  prs = new Map([[7, pr(7, H1, { mergeable: "CONFLICTING" })]]);
  ghCalls = [];
});

test("discover (the default) starts one owner for a PR that needs work, with no hand-off in its prompt", async () => {
  const s = steward();
  await s.pass();
  await s.pass();
  expect(box.starts).toHaveLength(1);
  expect(box.starts[0]).toMatchObject({ claim: `${REPO}#7`, repoId: "r1", branch: "b7", parent: MAIN });
  const prompt = String(box.starts[0]!.prompt);
  expect(prompt).toContain("it conflicts with its base");
  expect(prompt).not.toContain("{{handoff}}");
  expect(prompt).not.toContain("pr ready");
});

test("discover false never lists PRs and starts nobody for a PR nobody handed to it", async () => {
  const s = steward({ discover: false });
  await s.pass();
  expect(ghCalls.some((a) => a[1] === "list")).toBe(false);
  expect(box.starts).toHaveLength(0);
});

test("a hand-off with nobody on the PR starts one fresh owner with the findings, once per head and sender", async () => {
  const s = steward({ discover: false });
  expect(tend(s, { note: "P1: the retry loop never ends" }).already).toBe(false);
  await s.pass();
  expect(tend(s, { note: "P1: the retry loop never ends" }).already).toBe(true);
  await s.pass();
  expect(box.starts).toHaveLength(1);
  expect(box.starts[0]).toMatchObject({ claim: `${REPO}#7`, repoId: "r1", branch: "b7", parent: MAIN });
  const prompt = String(box.starts[0]!.prompt);
  expect(prompt).toContain("P1: the retry loop never ends");
  expect(prompt).toContain(`agentbox pr ready ${REPO}#7 --head <SHA>`);
  expect(prompt).toContain("STATUS: ready <SHA>");
});

test("a PR a session already holds goes to that session, with its context, and it is followed from then on", async () => {
  box.sessions.push(session("writer1"));
  box.holders.set(`${REPO}#7`, "writer1");
  const s = steward({ discover: false });
  tend(s, { note: "P1: missing test" });
  await s.pass();
  expect(box.starts).toHaveLength(0);
  expect(box.sends).toHaveLength(1);
  expect(box.sends[0]!.id).toBe("writer1");
  expect(box.sends[0]!.text).toContain("you keep it");
  expect(box.sends[0]!.text).toContain("P1: missing test");
  // Its question reaches the main conversation, as a session it started would.
  say("writer1", "STATUS: needs the person — ship the flag on or off? I recommend off.");
  await s.pass();
  expect(box.sends.filter((x) => x.id === MAIN)).toHaveLength(1);
  expect(box.sends.find((x) => x.id === MAIN)!.text).toContain("ship the flag on or off");
});

test("a session that hands on the PR it holds gets a fresh owner in its place, not the hand-off back", async () => {
  box.sessions.push(session("person1"));
  // The route released it; were the release late, the sender is still never its own owner.
  box.holders.set(`${REPO}#7`, "person1");
  const s = steward({ discover: false });
  tend(s, { note: null }, "person1");
  await s.pass();
  expect(box.sends.filter((x) => x.id === "person1")).toHaveLength(0);
  box.holders.delete(`${REPO}#7`);
  await s.pass();
  expect(box.starts).toHaveLength(1);
});

test("ready counts only on the head GitHub shows green; otherwise the owner is told once", async () => {
  prs.set(7, pr(7, H1));
  const s = steward({ discover: false });
  tend(s, { note: "fix it" });
  await s.pass();
  const owner = String(box.holders.get(`${REPO}#7`));

  // It says done: it is reminded to hand it on with pr ready, once.
  say(owner, "All fixed.\nSTATUS: done");
  await s.pass();
  await s.pass();
  const told = box.sends.filter((x) => x.id === owner);
  expect(told).toHaveLength(1);
  expect(told[0]!.text).toContain(`agentbox pr ready ${REPO}#7 --head ${H1}`);

  // It says ready on a head that moved: told what GitHub shows.
  prs.set(7, pr(7, H2, { statusCheckRollup: [{ name: "ci", status: "IN_PROGRESS" }] }));
  say(owner, `STATUS: ready ${H1}`);
  await s.pass();
  expect(box.sends.filter((x) => x.id === owner).at(-1)!.text).toContain("checks are running");

  // Ready on the head GitHub shows green: done, and nobody is told anything more.
  prs.set(7, pr(7, H2));
  say(owner, `STATUS: ready ${H2.slice(0, 12)}`);
  const before = box.sends.length;
  await s.pass();
  await s.pass();
  expect(box.sends.length).toBe(before);
  expect(s.view("prs").blocks.some((b) => b.type === "item" && b.title === `${REPO}#7 ready`)).toBe(true);
});

test("the judge sends it back: the findings go to its own owner, and no second owner starts", async () => {
  prs.set(7, pr(7, H1));
  const s = steward({ discover: false });
  tend(s, { note: "first findings" });
  await s.pass();
  const owner = String(box.holders.get(`${REPO}#7`));
  say(owner, `STATUS: ready ${H1}`);
  await s.pass();

  prs.set(7, pr(7, H2));
  tend(s, { head: H2, note: "P1: second findings" });
  await s.pass();
  expect(box.starts).toHaveLength(1);
  const back = box.sends.filter((x) => x.id === owner).at(-1)!;
  expect(back.text).toContain("came back to you");
  expect(back.text).toContain("P1: second findings");
  // The first hand-off is over: only the newer one shows.
  expect(s.view("prs").blocks.filter((b) => b.type === "item").map((b) => (b as { title: string }).title)).toEqual([`${REPO}#7 owned`]);
});

test("a STATUS line from before a hand-off never counts for it", async () => {
  prs.set(7, pr(7, H1));
  box.sessions.push(session("writer1", "waiting", `STATUS: ready ${H1}`));
  box.sessions.find((x) => x.id === "writer1")!.lastActivityAt += 5;
  box.holders.set(`${REPO}#7`, "writer1");
  const s = steward({ discover: false });
  tend(s, { note: "P1: still broken" });
  await s.pass();
  await s.pass();
  expect(s.view("prs").blocks.some((b) => b.type === "item" && b.title === `${REPO}#7 owned`)).toBe(true);
  // Its answer to the hand-off does count.
  say("writer1", `STATUS: ready ${H1}`);
  await s.pass();
  expect(s.view("prs").blocks.some((b) => b.type === "item" && b.title === `${REPO}#7 ready`)).toBe(true);
});

test("an owner that stops before ready is one item for the main conversation", async () => {
  const s = steward({ discover: false });
  tend(s, { note: "fix it" });
  await s.pass();
  const owner = String(box.holders.get(`${REPO}#7`));
  box.sessions.find((x) => x.id === owner)!.status = "stopped";
  await s.pass();
  await s.pass();
  const toMain = box.sends.filter((x) => x.id === MAIN);
  expect(toMain).toHaveLength(1);
  expect(toMain[0]!.text).toContain("before it was ready");
  expect(box.starts).toHaveLength(1);
});

test("a hand-off outside its repositories, or of a closed PR, starts nobody", async () => {
  const s = steward({ discover: false });
  s.tend({ repo: "other/thing", number: 3, head: H1, from: JUDGE }, caller(JUDGE));
  prs.set(8, pr(8, H1, { state: "MERGED" }));
  s.tend({ repo: REPO, number: 8, head: H1, from: JUDGE }, caller(JUDGE));
  await s.pass();
  expect(box.starts).toHaveLength(0);
  expect(() => steward({ discover: false, repos: [REPO] }).tend({ repo: "other/thing", number: 3, head: H1 }, caller())).toThrow("looks after acme/app");
});
