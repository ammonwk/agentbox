import { describe, expect, test } from "bun:test";
import { spawnHookOutput, subagentScopeNote, type SpawnHookInput } from "../providers/claude-spawn-hook";

const call = (over: Partial<SpawnHookInput> = {}): SpawnHookInput => ({
  hook_event_name: "PreToolUse",
  tool_input: { description: "Merge: routers", prompt: "Resolve the conflicts.", subagent_type: "general-purpose" },
  ...over,
});

const promptOf = (out: object | null): string =>
  (out as { hookSpecificOutput: { updatedInput: { prompt: string } } }).hookSpecificOutput.updatedInput.prompt;

describe("claude spawn hook", () => {
  test("the main conversation's spawns are told what a subagent is for, and not who started them: main is the coordinator", () => {
    const prompt = promptOf(spawnHookOutput(call(), {}));
    expect(prompt.startsWith("Resolve the conflicts.\n\n")).toBe(true);
    expect(prompt).toContain(subagentScopeNote());
    expect(prompt).not.toContain("SendMessage to");
  });

  test("a named subagent's child is told to write to that name, and keeps the rest of its call", () => {
    const out = spawnHookOutput(call({ agent_id: "aseats-7155-d06765d86802abe5", agent_type: "seats-7155" }), {
      "aseats-7155-d06765d86802abe5": { name: "seats-7155" },
    });
    const prompt = promptOf(out);
    expect(prompt.startsWith("Resolve the conflicts.\n\n")).toBe(true);
    expect(prompt).toContain("SendMessage to `seats-7155`");
    expect(prompt).toContain(subagentScopeNote());
    expect(prompt).not.toContain("d06765d86802abe5");
    expect((out as any).hookSpecificOutput.updatedInput.subagent_type).toBe("general-purpose");
  });

  test("an unnamed subagent is addressed by its id, with or without a meta file", () => {
    expect(promptOf(spawnHookOutput(call({ agent_id: "a9f6c7acec975f339" }), {}))).toContain("SendMessage to `a9f6c7acec975f339`");
    expect(
      promptOf(spawnHookOutput(call({ agent_id: "a9f6c7acec975f339" }), { a9f6c7acec975f339: {} })),
    ).toContain("SendMessage to `a9f6c7acec975f339`");
  });

  test("a call with no prompt to add to is left alone", () => {
    expect(spawnHookOutput(call({ agent_id: "a1", tool_input: { description: "x" } }), {})).toBeNull();
  });
});
