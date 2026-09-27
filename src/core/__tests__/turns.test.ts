import { describe, expect, test } from "bun:test";
import type { TimelineEvent, TimelinePage } from "../types";
import { answerText, TurnIndex, turnOf, type TurnSource } from "../turns";

const user = (id: string, text: string, at = 0): TimelineEvent => ({ id, at, kind: "user", text });
const said = (id: string, at = 0): TimelineEvent => ({ id, at, kind: "assistant", text: "ok" });
const ask = (id: string, output?: string): TimelineEvent => ({
  id,
  at: 0,
  kind: "tool",
  name: "AskUserQuestion",
  summary: "Which one?",
  status: output ? "ok" : "running",
  ...(output ? { output } : {}),
});

/** A transcript the index reads in pages of `size`, then follows. */
class Source implements TurnSource {
  cursor = 0;
  constructor(
    public events: TimelineEvent[],
    private readonly size = 2,
  ) {}
  async timeline(_id: string, before: string | null, limit: number): Promise<TimelinePage> {
    const end = before === null ? this.events.length : Number(before);
    const start = Math.max(0, end - Math.min(limit, this.size));
    return { events: this.events.slice(start, end), before: start > 0 ? String(start) : null, cursor: String(this.events.length) };
  }
  async since(_id: string, cursor: string) {
    return { events: this.events.slice(Number(cursor)), cursor: String(this.events.length), reset: false };
  }
}

describe("turnOf", () => {
  test("what kind of thing you said", () => {
    expect(turnOf(user("a", "fix the bug"), 0)?.kind).toBe("prompt");
    expect(turnOf(user("a", "/model opus"), 0)?.kind).toBe("command");
    expect(turnOf(user("a", "! ls -la"), 0)?.kind).toBe("command");
    expect(turnOf(user("a", "/home/me/file.ts is broken"), 0)?.kind).toBe("prompt");
    expect(turnOf(user("a", "[via agentbox send] status?"), 0)).toMatchObject({ kind: "agent", text: "status?" });
    expect(turnOf(user("a", "[From the Project session. Dev is away.] go"), 0)?.kind).toBe("agent");
    expect(turnOf(said("a"), 0)).toBeNull();
    expect(turnOf(ask("q"), 0)).toBeNull();
    expect(turnOf(ask("q", 'User has answered your questions: "Which one?"="The left one".'), 0)).toMatchObject({
      kind: "answer",
      text: "Which one?\n→ The left one",
    });
  });

  test("an answer reads as the question and what you chose", () => {
    expect(answerText(["Which?", "And?"], 'User has answered your questions: "Which?"="A", "And?"="B". You can now continue.')).toBe(
      "Which?\n→ A\nAnd?\n→ B",
    );
    // Quotes inside a question are not escaped in the result.
    const q = 'Merge "#6644" now, or wait?';
    expect(answerText([q], `User has answered your questions: "${q}"="Wait for "CI"". You can now continue.`)).toBe(`${q}\n→ Wait for "CI"`);
    expect(answerText(["Which?"], "something else")).toBe("Which?\nsomething else");
  });
});

describe("TurnIndex", () => {
  test("reads every page once, then only what was appended", async () => {
    const src = new Source([user("u1", "one"), said("a1"), said("a2"), user("u2", "two"), said("a3")]);
    const idx = new TurnIndex(src);
    const first = await idx.list("s");
    expect(first.turns.map((t) => [t.id, t.seq])).toEqual([["u1", 0], ["u2", 3]]);
    expect(first.total).toBe(5);

    src.events.push(user("u3", "three"));
    const next = await idx.list("s");
    expect(next.turns.map((t) => [t.id, t.seq])).toEqual([["u1", 0], ["u2", 3], ["u3", 5]]);
    expect(next.total).toBe(6);
  });

  test("a question answered later keeps its place, and is not counted twice", async () => {
    const src = new Source([user("u1", "one"), ask("q"), user("u2", "two")]);
    const idx = new TurnIndex(src);
    expect((await idx.list("s")).turns.map((t) => t.id)).toEqual(["u1", "u2"]);

    // The result lands: the tool event comes again under its id.
    const answered = ask("q", 'User has answered your questions: "Which one?"="Left".');
    src.events.push(answered);
    const after = await idx.list("s");
    expect(after.turns.map((t) => [t.id, t.seq])).toEqual([["u1", 0], ["q", 1], ["u2", 2]]);
    expect(after.total).toBe(3);
  });
});
