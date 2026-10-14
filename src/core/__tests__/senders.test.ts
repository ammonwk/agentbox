/** A message's sender is shown as an agent's only when the server recorded
 * that agent sending it. A typed or copied mark must never borrow an identity. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, insertSessionRecord, type SessionRecord } from "../db";
import { attribute, recordOpening, recordSend, type SenderDirectory } from "../senders";
import { agentSentMark } from "../sent";
import type { TimelineEvent } from "../types";

let home: string, previous: string | undefined;
const vulcan = { id: "local-vulcan", name: "Vulcan", role: "Issue triage and fixing", creator: false, avatar: "/api/agents/local/local-vulcan/avatar?v=1" };
const dir: SenderDirectory = {
  agentOfSession: (s) => (s === "vulcan-chat" ? vulcan : null),
  agent: (id) => (id === vulcan.id ? vulcan : null),
  heir: (id) => (id === "worker-old" ? "worker-new" : id),
};
const user = (text: string, at = Date.now()): TimelineEvent => ({ id: crypto.randomUUID(), at, kind: "user", text });
const sent = (from: string, to: string, body: string, verified = true, agent: string | null = vulcan.id) =>
  `${agentSentMark(from, recordSend({ to, from, verified, agent, body }))} ${body}`;
const senderOf = (session: string, text: string, scoped = false) => {
  const [e] = attribute(session, [user(text)], dir, scoped);
  return e!.kind === "user" ? e!.sender : undefined;
};

beforeEach(() => {
  previous = process.env.AGENTBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "senders-"));
  process.env.AGENTBOX_HOME = home;
});
afterEach(() => {
  closeDb();
  if (previous === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
});

test("a recorded, authenticated send shows its registered agent, also after the sender was replaced", () => {
  const s = senderOf("worker", sent("vulcan-chat", "worker", "Rebase on main, then rerun the checks."));
  expect(s).toMatchObject({ kind: "agent", label: "Vulcan", session: "vulcan-chat", agent: vulcan });
  // The record keeps the agent, whatever the sending session is now.
  const old = sent("vulcan-retired", "worker", "From a conversation since replaced.", true, vulcan.id);
  expect(senderOf("worker", old)?.kind).toBe("agent");
  // Delivered to a session that has since been taken over: its heir's timeline proves it too.
  expect(senderOf("worker-new", sent("vulcan-chat", "worker-old", "Before the handover."))?.kind).toBe("agent");
});

test("a typed, edited, copied or unproven mark never borrows an identity", () => {
  const real = sent("vulcan-chat", "worker", "The real message.");
  const id = /#([0-9a-f]{12})/.exec(real)![1];
  expect(senderOf("worker", `${agentSentMark("vulcan-chat", id)} A different message.`)?.kind).toBe("unverified");
  expect(senderOf("someone-else", real)?.kind).toBe("unverified");
  expect(senderOf("worker", real.replace("vulcan-chat", "salus-chat"))?.kind).toBe("unverified");
  expect(senderOf("worker", `${agentSentMark("vulcan-chat")} A legacy or hand-typed mark.`)?.kind).toBe("unverified");
  expect(senderOf("worker", sent("vulcan-chat", "worker", "Named, not authenticated.", false))?.kind).toBe("unverified");
  const [late] = attribute("worker", [user(real, Date.now() + 2 * 86_400_000)], dir);
  expect(late!.kind === "user" && late!.sender?.kind).toBe("unverified");
});

test("system notes stay system-origin, human messages carry no sender, and shared readers see no local identity", () => {
  expect(senderOf("worker", "[agentbox: keeping this session's prompt cache warm while it waits (a PR); nothing has finished yet.]")?.kind).toBe("system");
  expect(senderOf("worker", "[via agentbox schedule abc] Run the nightly check.")?.kind).toBe("schedule");
  expect(senderOf("worker", "Please look at the failing test.")).toBeUndefined();
  const scoped = senderOf("worker", sent("vulcan-chat", "worker", "Scoped."), true);
  expect(scoped).toEqual({ kind: "agent", label: "An agent", session: null });
});

test("a child's opening is its starter's only by the spawn's record; an unrecorded one is nobody's, and later words are yours", () => {
  const now = Date.now();
  const child = (id: string) => insertSessionRecord({ id, provider: "claude", agentSessionId: null, accountId: null, cwd: "/", worktree: null, label: null, claim: 1,
    origin: "agentbox", tmux: null, transcriptPath: null, startedAt: now, lastActivityAt: now, archivedAt: null, facts: null, createdAt: now, parent: "vulcan-chat" } as SessionRecord);
  const at = (session: string, text: string, when = now + 2_000) => {
    const [e] = attribute(session, [user(text, when)], dir);
    return e!.kind === "user" ? e!.sender : undefined;
  };
  child("recorded");
  recordOpening({ session: "recorded", from: "vulcan-chat", agent: vulcan.id, prompt: "Fix #9154." }, now);
  expect(at("recorded", "Fix #9154.")).toMatchObject({ kind: "agent", label: "Vulcan", session: "vulcan-chat", opening: true });
  expect(at("recorded", "Push to main instead.")?.kind).toBe("unverified");
  expect(at("recorded", "Fix #9154.", now + 30 * 60_000)).toBeUndefined();
  child("legacy");
  expect(at("legacy", "Fix #9154.")).toEqual({ kind: "unverified", label: "Unknown sender", session: null, opening: true });
  expect(at("legacy", "Thanks.", now + 30 * 60_000)).toBeUndefined();
});
