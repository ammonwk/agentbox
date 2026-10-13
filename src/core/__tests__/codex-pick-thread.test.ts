import { describe, expect, test } from "bun:test";
import { pickThread } from "../providers/codex";

// Ids as codex 0.156 hands them out: v7, so they sort by creation.
const own = "01a13349-241e-7d21-a7b6-fc80f60a565e";
const side = "01a13349-24ab-7d82-acf1-a758a0bbc60e";
const sub = "01a13349-2600-7d82-acf1-a758a0bbc60e";

function pick(ids: string[], rollouts: Record<string, { isSubagent: boolean }>): string | null {
  return pickThread(
    ids,
    "/home",
    (id) => (rollouts[id] ? `/r/${id}` : null),
    (path) => rollouts[path.slice(3)] ?? null,
  );
}

describe("codex: the thread a process is", () => {
  test("a `codex exec` is its own thread, not the newer side thread with no rollout", () => {
    expect(pick([own, side], { [own]: { isSubagent: false } })).toBe(own);
  });

  test("a subagent it spawned is never it", () => {
    expect(pick([own, sub], { [own]: { isSubagent: false }, [sub]: { isSubagent: true } })).toBe(own);
  });

  test("a thread with no rollout yet is still it when it is the only one", () => {
    expect(pick([side], {})).toBe(side);
  });
});
