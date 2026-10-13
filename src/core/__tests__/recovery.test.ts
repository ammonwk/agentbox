import { describe, expect, test } from "bun:test";
import { leftover, type LiveEntry } from "../recovery";

const entry = (host: LiveEntry["host"]): LiveEntry => ({
  id: "47umeqj6",
  provider: "claude",
  title: "Issue 8021",
  host,
  status: "running",
  blockedOn: null,
  work: null,
  parent: null,
  subagent: null,
  lastActivityAt: 0,
  cacheWarmUntil: null,
  launch: null,
});

describe("leftover", () => {
  const lastSeen = 1_000_000;

  test("the process of a session that ran in our tmux, from before the snapshot, is the one still exiting", () => {
    expect(leftover(entry("tmux"), lastSeen - 60_000, lastSeen)).toBe(true);
  });

  test("a process started since the snapshot is the session picked up again", () => {
    expect(leftover(entry("tmux"), lastSeen + 2_000, lastSeen)).toBe(false);
  });

  test("a session in another terminal is still running there", () => {
    expect(leftover(entry("external"), lastSeen - 60_000, lastSeen)).toBe(false);
  });
});
