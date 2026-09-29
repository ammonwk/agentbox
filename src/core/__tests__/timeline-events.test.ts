import { describe, expect, test } from "bun:test";
import { capJson } from "../providers/jsonl-reader";
import { isNarration } from "../providers/claude-transcript";
import { inputFields } from "../../../web/src/lib/toolinput";

describe("capJson", () => {
  test("a long input stays parseable, its long strings cut", () => {
    const input = { file_path: "/a/b.ts", content: "x".repeat(20_000) };
    const s = capJson(input, 4096);
    expect(s.length).toBeLessThanOrEqual(4096);
    const back = JSON.parse(s);
    expect(back.file_path).toBe("/a/b.ts");
    expect(back.content).toContain("more chars]");
  });

  test("a short input is unchanged", () => {
    expect(capJson({ command: "ls" }, 4096)).toBe('{"command":"ls"}');
  });
});

describe("inputFields", () => {
  test("Bash: the command first, the description dropped when it is the title", () => {
    const f = inputFields(JSON.stringify({ command: "ls -la", description: "List files", timeout: 5000 }), "List files");
    expect(f).toEqual([
      { key: "command", kind: "shell", text: "ls -la" },
      { key: "timeout", kind: "inline", text: "5000" },
    ]);
  });

  test("Edit: path, then a diff", () => {
    const f = inputFields(JSON.stringify({ file_path: "/x.ts", old_string: "a", new_string: "b" }));
    expect(f).toEqual([
      { key: "file_path", kind: "inline", text: "/x.ts" },
      { key: "change", kind: "diff", old: "a", new: "b" },
    ]);
  });

  test("codex argv through a login shell is just the script", () => {
    const f = inputFields(JSON.stringify({ command: ["bash", "-lc", "git status"], workdir: "/r" }));
    expect(f?.[0]).toEqual({ key: "command", kind: "shell", text: "git status" });
  });

  test("not a JSON object: shown raw", () => {
    expect(inputFields("*** Begin Patch\n")).toBeNull();
    expect(inputFields('{"command":"ls')).toBeNull();
  });
});

describe("isNarration", () => {
  // Real signature heads: the kind field reads `narration` or `thinking`.
  const narration = "CAQShAgKEQgSGAI4AUIJbmFycmF0aW9uEgx1CINhv6KrJsHyD0waDJvACKHgePhNs2WxZyIwvAo0vJUg309hUq7dV+pED37Z";
  const thinking = "CAQSuwYKEAgSGAI4AUIIdGhpbmtpbmcSDFKDe1v1L8ETLHaEPxoMFx8F2zpI0kkGAYvEIjCkIkPGnILZfpYffEw8Uo54X2HL";

  test("text Claude said to the user is narration", () => {
    expect(isNarration({ type: "thinking", thinking: "Found it.", signature: narration })).toBe(true);
  });
  test("thinking stays thinking, and an empty block is neither", () => {
    expect(isNarration({ type: "thinking", thinking: "Weighing it.", signature: thinking })).toBe(false);
    expect(isNarration({ type: "thinking", thinking: "", signature: narration })).toBe(false);
  });
});
