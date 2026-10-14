import { AgentWorks } from "./work";
/** Decisions can authorize destructive work. These tests guard replay, races
 * and the proof required before replacing a possibly running conversation. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store";
import { AgentConversations } from "./conversation";
import { AgentsRuntime } from "./runtime";
import {
  closeDb,
  getSessionRecord,
  insertRepo,
  insertSessionRecord,
  updateSessionRecord,
} from "../db";

let home: string,
  previous: string | undefined,
  store: AgentStore,
  conversations: AgentConversations;
let sessions: any[], stopped: number, spawns: any[], closed: number;
let fleet: any, runtime: AgentsRuntime;
beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "agent-conversation-"));
  process.env.AGENTBOX_HOME = home;
  store = new AgentStore(join(home, "runtime.db"));
  sessions = [];
  spawns = [];
  stopped = 0;
  closed = 0;
  fleet = {
    placement: (provider: string) => ({ provider, accountId: `${provider}-1`, mode: "auto", claim: 0, candidates: [], why: "room" }),
    sessions: () => sessions,
    tick: async () => {},
    stopSession: async () => {
      stopped++;
      sessions = [];
    },
    spawn: async (opts: any) => {
      spawns.push(opts);
      throw Error("known preflight failure");
    },
  };
  runtime = {
    store,
    fleet,
    cards: {
      add: () => {},
      list: () => [{ id: 1, key: "agent-proposal:proposal", state: "open" }],
      close: () => {
        closed++;
      },
    },
  } as unknown as AgentsRuntime;
  Object.assign(runtime, {works: new AgentWorks(runtime)});
  conversations = new AgentConversations(runtime);
  Object.assign(runtime, {conversations, sessionOwnership: AgentsRuntime.prototype.sessionOwnership.bind(runtime)});
  conversations.installed = async () => true;
  conversations.local();
});
afterEach(() => {
  store.db.close();
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});
function link(session = "linked") {
  const a = conversations.local().find((a) => a.id === "local-vulcan")!;
  a.session = session;
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [
    JSON.stringify(a),
    a.id,
  ]);
  return a;
}
async function proposal() {
  link();
  return conversations.propose("local-vulcan", "linked", "proposal", {
    title: "Investigate",
    finding: "Observed failure",
    reason: "Users are affected",
    next: "Reproduce the failure",
    evidence: [],
  });
}
function record(id: string, transcriptPath: string | null) {
  insertSessionRecord({
    id,
    provider: "codex",
    agentSessionId: id,
    accountId: null,
    cwd: home,
    worktree: null,
    label: null,
    claim: 0,
    origin: "agentbox",
    tmux: null,
    transcriptPath,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    archivedAt: null,
    facts: null,
    createdAt: Date.now(),
  });
}

test("Feed approval wins its race once, preserves refusal, and never replays under a fresh request", async () => {
  await proposal();
  let calls = 0,
    resolve!: (r: any) => void;
  conversations.localSend = async () => {
    calls++;
    return new Promise((r) => (resolve = r));
  };
  const pending = conversations.localDecide(
    "local-vulcan",
    "proposal",
    "approved",
    "stable-request",
  );
  const persisted = JSON.parse(
    (store.db.query("SELECT body FROM local_proposals").get() as any).body,
  );
  expect(persisted.state).toBe("approved");
  expect(persisted.delivery.request).toBe("stable-request");
  await expect(
    conversations.localDecide(
      "local-vulcan",
      "proposal",
      "dismissed",
      "racing-request",
    ),
  ).rejects.toThrow("Already decided");
  resolve({ state: "refused", result: "Agent paused" });
  expect((await pending).delivery?.state).toBe("refused");
  expect(closed).toBe(0);
  Object.assign(runtime, {works: new AgentWorks(runtime)});
  conversations = new AgentConversations(runtime);
  conversations.installed = async () => true;
  conversations.localSend = async () => {
    calls++;
    throw Error("must not replay");
  };
  expect(
    (
      await conversations.localDecide(
        "local-vulcan",
        "proposal",
        "approved",
        "new-request",
      )
    ).delivery?.state,
  ).toBe("refused");
  expect(calls).toBe(1);
});
test("a crash before decision delivery is visible as uncertain and cannot be replayed or dismissed", async () => {
  const p = await proposal();
  p.state = "approved";
  p.delivery = { request: "lost-request", state: "queued", result: "" };
  store.db.run("UPDATE local_proposals SET body=? WHERE id=?", [
    JSON.stringify(p),
    p.id,
  ]);
  Object.assign(runtime, {works: new AgentWorks(runtime)});
  conversations = new AgentConversations(runtime);
  conversations.installed = async () => true;
  conversations.localSend = async () => {
    throw Error("must not replay");
  };
  expect(conversations.localProposals("local-vulcan")[0]?.delivery?.state).toBe(
    "uncertain",
  );
  expect(
    (
      await conversations.localDecide(
        "local-vulcan",
        "proposal",
        "approved",
        "new-request",
      )
    ).delivery?.state,
  ).toBe("uncertain");
  await expect(
    conversations.localDecide(
      "local-vulcan",
      "proposal",
      "dismissed",
      "new-request",
    ),
  ).rejects.toThrow();
  expect(closed).toBe(0);
});
test("known pre-start failure can start again; a recorded uncertain start never spawns twice", async () => {
  const first = await conversations.localSend("local-vulcan", "first", "Hello");
  expect(first.state).toBe("refused");
  expect(conversations.local()[0]?.session).toBeNull();
  expect(existsSync(spawns[0].cwd)).toBe(true);
  await conversations.localSend("local-vulcan", "second", "Hello again");
  expect(spawns.length).toBe(2);
  fleet.spawn = async (opts: any) => {
    spawns.push(opts);
    record(opts.id, null);
    throw Error("connection lost after start");
  };
  expect(
    (await conversations.localSend("local-vulcan", "third", "Try once")).state,
  ).toBe("uncertain");
  const sid = conversations
    .local()
    .find((a) => a.id === "local-vulcan")!.session;
  expect(sid).toBeTruthy();
  fleet.send = async () => {
    throw Error("still reconciling");
  };
  await conversations.localSend("local-vulcan", "fourth", "Follow up");
  expect(spawns.length).toBe(3);
  expect(conversations.localReceipt("local-vulcan", "third")?.state).toBe(
    "uncertain",
  );
});
test("binding after first Chat preserves history, refuses a running turn and serializes against delivery", async () => {
  link();
  const transcript = join(home, "provider.jsonl");
  writeFileSync(transcript, "provider-owned history");
  record("linked", transcript);
  insertRepo({
    id: "repo",
    kind: "local",
    ref: home,
    displayName: "Test",
    fullName: "fixture/repo",
    defaultBranch: "main",
    addedAt: Date.now(),
    worktreeDefault: true,
    setup: { copy: [], run: "" },
  });
  const input = { provider: "codex", repo: "repo", enabled: true };
  sessions = [{ id: "linked", status: "running", host: "tmux", pid: 123 }];
  await expect(conversations.configure("local-vulcan", input)).rejects.toThrow(
    "current turn",
  );
  expect(stopped).toBe(0);
  sessions[0].status = "waiting";
  let release!: () => void;
  fleet.stopSession = async () => {
    stopped++;
    await new Promise<void>((r) => (release = r));
    sessions = [];
  };
  const change = conversations.configure("local-vulcan", input);
  await expect(
    conversations.localSend("local-vulcan", "racing-send", "New task"),
  ).rejects.toThrow("being delivered");
  release();
  const a = await change;
  expect(a.session).toBeNull();
  expect(a.previous).toEqual(["linked"]);
  expect(a.repo).toBe("repo");
  expect(getSessionRecord("linked")?.transcriptPath).toBe(transcript);
  await conversations.localSend("local-vulcan", "new-task", "Investigate");
  expect(spawns[0].repoId).toBe("repo");
  expect(spawns[0].worktree).toBe(true);
  expect(spawns[0].prompt).toContain("Previous conversation session: linked");
});
test("changing conversation cannot silently authorize an old recommendation in a new workspace", async () => {
  await proposal();
  link("replacement");
  await expect(
    conversations.localDecide(
      "local-vulcan",
      "proposal",
      "approved",
      "request",
    ),
  ).rejects.toThrow("earlier conversation");
  await expect(
    conversations.localSend("local-vulcan", "guidance", "Proceed", {
      proposal: "proposal",
      run: "linked",
    }),
  ).rejects.toThrow("earlier conversation");
  expect(
    (
      await conversations.localDecide(
        "local-vulcan",
        "proposal",
        "dismissed",
        "dismiss",
      )
    ).state,
  ).toBe("dismissed");
});

test("project identity cannot be rebound or consume another project's recommendation", async () => {
  for (const id of ["alpha", "beta"]) insertRepo({ id, kind: "local", ref: join(home, id), displayName: id, fullName: `fixture/${id}`, defaultBranch: "main", addedAt: Date.now(), worktreeDefault: true, setup: { copy: [], run: "" } });
  const a = conversations.local("alpha").find((a) => a.project === "alpha" && a.name === "VULCAN")!;
  const b = conversations.local("beta").find((a) => a.project === "beta" && a.name === "VULCAN")!;
  expect(a.id).not.toBe(b.id);
  expect(spawns).toHaveLength(0);
  expect(stopped).toBe(0);
  expect(new AgentConversations(runtime).local("alpha").filter((x) => x.id === a.id)).toHaveLength(1);
  await expect(conversations.configure(a.id, { provider: "codex", repo: "beta", enabled: true })).rejects.toThrow("separate conversations");
  for (const agent of [a, b]) {
    agent.session = `session-${agent.project}`;
    store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(agent), agent.id]);
  }
  const p = await conversations.propose(a.id, a.session, crypto.randomUUID(), { title: "Alpha only", finding: "Alpha failure", reason: "Fix Alpha", next: "Edit Alpha", evidence: [] });
  await expect(conversations.propose(b.id, a.session, crypto.randomUUID(), { title: "Wrong project", finding: "Alpha", reason: "Alpha", next: "Edit Beta", evidence: [] })).rejects.toThrow();
  await expect(conversations.localDecide(b.id, p.id, "approved", crypto.randomUUID())).rejects.toThrow();
  await expect(conversations.localSend(b.id, crypto.randomUUID(), "Approve Alpha", { proposal: p.id, run: a.session! })).rejects.toThrow();
  expect(conversations.localProposals(b.id)).toEqual([]);
  expect(conversations.local().find((x) => x.id === a.id)?.session).toBe(a.session);
  expect(spawns).toHaveLength(0);
  expect(stopped).toBe(0);
});

test("selected history cannot read a foreign session or resurrect a replaced writer", async () => {
  const a = link("current"); a.previous = ["previous"];
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(a), a.id]);
  for (const id of ["current", "previous", "private"]) record(id, null);
  sessions = [{id:"current",title:"Current",status:"running",lastActivityAt:Date.now()}, {id:"previous",title:"Previous",status:"stopped",lastActivityAt:1}, {id:"private",title:"Standalone private",status:"running",lastActivityAt:Date.now()}];
  let reads = 0, sends = 0;
  fleet.timeline = async (id: string) => { reads++; return { events:[{id,kind:"assistant",text:id,at:1}], before:null }; };
  fleet.send = async () => { sends++; };
  const list = await conversations.page(a.id, {list:true});
  expect(list.counts).toEqual({active:1,inactive:1});
  expect(list.threads?.map((t) => t.id)).toEqual(["current","previous"]);
  expect((await conversations.page(a.id, {target:"previous"})).thread?.writable).toBe(false);
  expect((await conversations.page(a.id, {target:"previous"})).next).toBeNull();
  await expect(conversations.page(a.id,{target:"private"})).rejects.toThrow("does not belong");
  await expect(conversations.page("local-salus",{target:"current"})).rejects.toThrow();
  await expect(conversations.localSend(a.id,"old","Wrong",undefined,"previous")).rejects.toThrow("changed");
  expect(reads).toBe(2); expect(sends).toBe(0); expect(spawns.length).toBe(0);
});
test("creator capability, project and revision bind an idempotent human creation", async () => {
  // Jupiter exists only in the Agentbox project: here, a clone of it.
  insertRepo({id:"project",kind:"local",ref:home,displayName:"Project",fullName:"ammonwk/agentbox",defaultBranch:"main",addedAt:Date.now(),setup:{copy:[],run:""},worktreeDefault:true});
  const creator = conversations.local("project").find((a) => a.capability === "creator" && a.repo === "project")!;
  creator.session = "jupiter-session";
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(creator),creator.id]);
  const spec = { name:"Atlas",role:"Explain this repository",instructions:"Use diagrams and short examples.",provider:"codex" as const, limits:"Do not publish.",automation:"" };
  await expect(conversations.draft("local-vulcan","linked",crypto.randomUUID(),spec)).rejects.toThrow("creator");
  await expect(conversations.draft(creator.id,"foreign",crypto.randomUUID(),spec)).rejects.toThrow("creator");
  const d = await conversations.draft(creator.id,creator.session,crypto.randomUUID(),spec);
  expect(() => conversations.editCreation(creator.id,d.id,1,null,spec,true)).toThrow("project");
  expect(() => conversations.editCreation(creator.id,d.id,1,"project",{...spec,name:"Changed"},true)).toThrow("changed");
  const edited = conversations.editCreation(creator.id,d.id,1,"project",{...spec,name:"Atlas edited"},false);
  expect(() => conversations.editCreation(creator.id,d.id,1,"project",spec,true)).toThrow("changed");
  const made = conversations.editCreation(creator.id,d.id,edited.revision,"project",edited.spec,true);
  expect(conversations.editCreation(creator.id,d.id,edited.revision,"project",edited.spec,true).created).toBe(made.created);
  const saved = new AgentConversations(runtime).local().filter((a) => a.creation === d.id);
  expect(saved.length).toBe(1); expect(saved[0]?.capability).toBeUndefined(); expect(saved[0]?.repo).toBe("project"); expect(saved[0]?.instructions).toContain(spec.instructions);
  expect(spawns.length).toBe(0);
  await conversations.localSend(made.created!,crypto.randomUUID(),"Explain the architecture",undefined,null);
  expect(spawns[0].prompt).toContain(spec.instructions); expect(spawns[0].repoId).toBe("project");
});
test("a created agent is listed and usable in every project, with its own conversation and switch there", async () => {
  insertRepo({id:"agentbox",kind:"local",ref:home,displayName:"agentbox",fullName:"ammonwk/agentbox",defaultBranch:"main",addedAt:Date.now(),setup:{copy:[],run:""},worktreeDefault:true});
  insertRepo({id:"other",kind:"local",ref:join(home,"other"),displayName:"other",fullName:"fixture/other",defaultBranch:"main",addedAt:Date.now(),setup:{copy:[],run:""},worktreeDefault:true});
  const creator = conversations.local("agentbox").find((a) => a.capability === "creator")!;
  creator.session = "jupiter-session";
  store.db.run("UPDATE local_agents SET body=? WHERE id=?", [JSON.stringify(creator),creator.id]);
  const spec = { name:"Terminus",role:"Close stale work",instructions:"Find finished sessions.",provider:"auto" as const,limits:"Ask first.",automation:"daily sweep" };
  const d = await conversations.draft(creator.id,creator.session,crypto.randomUUID(),spec);
  const first = conversations.editCreation(creator.id,d.id,d.revision,"agentbox",d.spec,true).created!;
  await conversations.localSend(first,crypto.randomUUID(),"Start in agentbox",undefined,null);
  const home1 = conversations.local("agentbox").find((a) => a.id === first)!;
  const there = conversations.local("other").filter((a) => a.creation === d.id && a.repo === "other");
  expect(there).toHaveLength(1);
  const copy = there[0]!;
  expect(copy.id).not.toBe(first);
  expect([copy.name, copy.role, copy.instructions, copy.automation, copy.pinned]).toEqual([home1.name, home1.role, home1.instructions, home1.automation, home1.pinned]);
  expect([copy.session, copy.enabled]).toEqual([null, true]);
  expect(new AgentConversations(runtime).local("other").filter((a) => a.creation === d.id)).toHaveLength(2);
  await conversations.localSend(copy.id,crypto.randomUUID(),"Start in other",undefined,null);
  expect(spawns.map((s) => s.repoId)).toEqual(["agentbox","other"]);
  expect(spawns[0].id).not.toBe(spawns[1].id);
  expect(spawns[1].prompt).toContain(spec.instructions);
  await conversations.configure(copy.id,{provider:"auto",repo:"other",enabled:false});
  await expect(conversations.localSend(copy.id,crypto.randomUUID(),"Paused here",undefined,undefined)).rejects.toThrow("paused");
  expect(conversations.local().find((a) => a.id === first)!.enabled).toBe(true);
  expect(conversations.local("agentbox").filter((a) => a.creation === d.id && a.repo === "agentbox").map((a) => a.id)).toEqual([first]);
});
test("a creation proposal from a replaced creator is read-only", async () => {
  insertRepo({id:"agentbox",kind:"local",ref:home,displayName:"agentbox",fullName:"ammonwk/agentbox",defaultBranch:"main",addedAt:Date.now(),setup:{copy:[],run:""},worktreeDefault:true});
  const creator = conversations.local("agentbox").find((a) => a.capability === "creator" && a.repo === "agentbox")!; creator.session = "old";
  store.db.run("UPDATE local_agents SET body=? WHERE id=?",[JSON.stringify(creator),creator.id]);
  const d = await conversations.draft(creator.id,"old",crypto.randomUUID(),{name:"New",role:"Help",instructions:"Help with code",provider:"codex"});
  creator.previous = ["old"]; creator.session = "new";
  store.db.run("UPDATE local_agents SET body=? WHERE id=?",[JSON.stringify(creator),creator.id]);
  expect(() => conversations.editCreation(creator.id,d.id,d.revision,"agentbox",d.spec,true)).toThrow("replaced");
});

// Descendant discovery is read-only and must never cross another agent's link.
test("local chat lists recorded descendants without granting sends or exposing foreign children",async()=>{
  link("coordinator");
  for (const id of ["coordinator","child","grandchild","foreign","foreign-child","unrelated","cycle-a","cycle-b"]) record(id,null);
  updateSessionRecord("child",{parent:"coordinator"});
  updateSessionRecord("grandchild",{parent:"child"});
  updateSessionRecord("foreign",{parent:"coordinator"});
  updateSessionRecord("foreign-child",{parent:"foreign"});
  updateSessionRecord("cycle-a",{parent:"cycle-b"});updateSessionRecord("cycle-b",{parent:"cycle-a"});
  const other=conversations.local().find(a=>a.id!=="local-vulcan")!;
  other.session="foreign";store.db.run("UPDATE local_agents SET body=? WHERE id=?",[JSON.stringify(other),other.id]);
  const threads=conversations.threads("local-vulcan");
  expect(threads.map(t=>t.id).sort()).toEqual(["child","coordinator","grandchild"]);
  expect(threads.find(t=>t.id==="child")?.writable).toBe(false);
  await expect(conversations.localSend("local-vulcan",crypto.randomUUID(),"Do something",undefined,"child")).rejects.toThrow("current session");
  await expect(conversations.page("local-vulcan",{session:0,before:null,target:"foreign-child"})).rejects.toThrow("does not belong");
});
