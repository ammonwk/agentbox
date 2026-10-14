/** Decisions can authorize destructive work. These tests guard replay, races
 * and the proof required before replacing a possibly running conversation. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store";
import { AgentConversations } from "./conversation";
import type { AgentsRuntime } from "./runtime";
import {
  closeDb,
  getSessionRecord,
  insertRepo,
  insertSessionRecord,
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
  conversations = new AgentConversations(runtime);
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
  conversations = new AgentConversations(runtime);
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
  conversations = new AgentConversations(runtime);
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
