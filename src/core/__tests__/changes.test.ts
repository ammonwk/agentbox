import { describe, expect, test } from "bun:test";
import { ChangeWatcher, type ChangeRow } from "../changes";

const row = (id: string, status: ChangeRow["status"], lastMessage: string | null = null): ChangeRow => ({
  id, status, lastMessage, label: id, title: id, firstPrompt: null,
});

describe("ChangeWatcher", () => {
  test("the first look is only a snapshot", () => {
    const w = new ChangeWatcher();
    expect(w.next([row("a", "waiting", "done"), row("b", "blocked")])).toEqual([]);
    expect(w.next([row("a", "running")]).map((c) => c.kind)).toEqual(["running"]);
  });

  test("current reports where each session already stands, then only changes", () => {
    const w = new ChangeWatcher({ current: true });
    const first = w.next([row("a", "waiting", "cut short"), row("b", "running"), row("c", "stopped"), row("d", "blocked")]);
    expect(first.map((c) => [c.id, c.kind])).toEqual([["a", "waiting"], ["c", "stopped"], ["d", "blocked"]]);
    expect(first[0]!.detail).toBe("cut short");
    expect(w.next([row("a", "waiting", "cut short"), row("b", "running"), row("c", "stopped"), row("d", "blocked")])).toEqual([]);
    expect(w.next([row("b", "waiting", "PR open")]).map((c) => [c.id, c.kind])).toEqual([["b", "waiting"]]);
  });
});
