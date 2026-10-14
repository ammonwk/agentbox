import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, TimelineEvent } from "../types";
import { agentFile, agentTimeline } from "../work";

// A Claude session's directory beside its transcript, with one agent of its
// own and one a workflow runs; and a file outside it that no id may reach.
const root = mkdtempSync(join(tmpdir(), "agentbox-agentfile-"));
const sid = "5f0c2a8e-1111-2222-3333-444455556666";
const dir = join(root, sid);
mkdirSync(join(dir, "subagents", "workflows", "wf_0f98cd63-6bd"), { recursive: true });
const own = join(dir, "subagents", "agent-aa89d6c9c0a3a2c34.jsonl");
const run = join(dir, "subagents", "workflows", "wf_0f98cd63-6bd", "agent-r2-builder-247e0c1c9f09ae60.jsonl");
writeFileSync(join(root, "agent-outside.jsonl"), "{}\n");
writeFileSync(join(dir, "subagents", "agent-outside.jsonl.bak"), "{}\n");

const rec = (r: object) => JSON.stringify({ isSidechain: true, agentId: "aa89d6c9c0a3a2c34", sessionId: sid, ...r });
writeFileSync(
  own,
  [
    rec({ type: "user", uuid: "u1", timestamp: "2026-10-12T10:00:00.000Z", message: { role: "user", content: "Find every caller of place()." } }),
    rec({ type: "assistant", uuid: "a1", timestamp: "2026-10-12T10:00:02.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "place\\(" } }], stop_reason: "tool_use" } }),
    rec({ type: "user", uuid: "u2", timestamp: "2026-10-12T10:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "src/core/fleet.ts:2391" }] } }),
    rec({ type: "assistant", uuid: "a2", timestamp: "2026-10-12T10:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "One caller, in fleet.ts." }], stop_reason: "end_turn" } }),
  ].join("\n") + "\n",
);
writeFileSync(run, rec({ type: "user", uuid: "w1", timestamp: "2026-10-12T10:01:00.000Z", message: { role: "user", content: "Review it." } }) + "\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("agentFile", () => {
  test("an agent of the session's own, and one a workflow runs", () => {
    expect(agentFile(dir, "aa89d6c9c0a3a2c34")).toBe(own);
    expect(agentFile(dir, "r2-builder-247e0c1c9f09ae60")).toBe(run);
  });

  test("an id that is not one never leaves the session's subagents directory", () => {
    for (const id of ["../agent-outside", "../../agent-outside", "..", ".", "", "a/b", "outside.jsonl.bak", "-x", `a${"b".repeat(200)}`]) {
      expect(agentFile(dir, id)).toBeNull();
    }
  });

  test("an id with no file is null", () => {
    expect(agentFile(dir, "a000000000000000")).toBeNull();
  });
});

describe("agentTimeline", () => {
  const session = { id: "x", provider: "claude", accountId: "acct", agentSessionId: sid, transcriptPath: join(root, `${sid}.jsonl`), pid: null } as unknown as Session;

  test("reads the agent's own records, which Claude flags as a sidechain", async () => {
    const t = await agentTimeline(session, "aa89d6c9c0a3a2c34", null);
    expect(t).not.toBeNull();
    expect(t!.reset).toBe(true);
    expect(t!.state).toBe("done");
    expect(t!.events.map((e) => e.kind)).toEqual(["user", "tool", "assistant"]);
    const tool = t!.events[1] as Extract<TimelineEvent, { kind: "tool" }>;
    expect(tool.status).toBe("ok");
    const again = await agentTimeline(session, "aa89d6c9c0a3a2c34", t!.cursor);
    expect(again!.events).toEqual([]);
    expect(again!.reset).toBe(false);
  });

  test("an unfinished agent with no process is stopped; a session with no such agent is null", async () => {
    expect((await agentTimeline(session, "r2-builder-247e0c1c9f09ae60", null))!.state).toBe("stopped");
    expect(await agentTimeline(session, "../agent-outside", null)).toBeNull();
    expect(await agentTimeline({ ...session, provider: "codex" } as Session, "aa89d6c9c0a3a2c34", null)).toBeNull();
  });
});
