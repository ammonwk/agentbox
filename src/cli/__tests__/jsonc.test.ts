import { describe, expect, test } from "bun:test";
import { findObject, insertMember, objectMembers, removeMember, rootObjectStart, validates } from "../jsonc";

const ENTRY = { type: "local", command: ["bun", "/x/bin/agentbox", "mcp"] };

/** Strip comments the crude way, only so tests can assert on structure. */
function structure(src: string): unknown {
  return JSON.parse(
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  );
}

describe("scanning", () => {
  test("finds members past comments, nesting and awkward whitespace", () => {
    const src = `{
  // a comment containing "mcp": { which is not a section
  /* and a block one */
  "theme": "dark",
  "mcp":{"existing":{"type":"local"}},
  "trailing": [1, 2, {"a": "}"}]
}`;
    const members = objectMembers(src, rootObjectStart(src));
    expect(members.map((m) => m.key)).toEqual(["theme", "mcp", "trailing"]);
    const mcp = findObject(src, ["mcp"]);
    expect(mcp?.members.map((m) => m.key)).toEqual(["existing"]);
  });

  test("a string containing braces does not end the object", () => {
    const src = `{ "a": "}{", "b": 1 }`;
    expect(objectMembers(src, rootObjectStart(src)).map((m) => m.key)).toEqual(["a", "b"]);
  });

  test("escaped quotes do not end the string", () => {
    const src = String.raw`{ "a": "he said \"hi\"", "b": 1 }`;
    expect(objectMembers(src, rootObjectStart(src)).map((m) => m.key)).toEqual(["a", "b"]);
  });

  test("a missing section is null, not a throw", () => {
    expect(findObject(`{ "theme": "dark" }`, ["mcp"])).toBeNull();
  });

  test("a non-object top level is refused", () => {
    expect(() => rootObjectStart("[1,2]")).toThrow();
    expect(validates("[1,2]", ["mcp"])).toBe(false);
  });
});

describe("insertMember", () => {
  test("adds an entry and leaves every comment in place", () => {
    const src = `{
  // keep me
  "theme": "dark",
  "mcp": {
    // and me
    "other": { "type": "local" }
  }
}`;
    const out = insertMember(src, ["mcp"], "agentbox", ENTRY);
    expect(out).toContain("// keep me");
    expect(out).toContain("// and me");
    const parsed = structure(out) as { mcp: Record<string, unknown> };
    expect(parsed.mcp.agentbox).toEqual(ENTRY);
    expect(parsed.mcp.other).toEqual({ type: "local" });
  });

  test("adds an entry to an empty mcp object", () => {
    const out = insertMember(`{\n  "mcp": {}\n}`, ["mcp"], "agentbox", ENTRY);
    expect((structure(out) as { mcp: Record<string, unknown> }).mcp.agentbox).toEqual(ENTRY);
  });

  // The old splice assumed exactly four spaces.
  test("matches the file's existing indentation, whatever it is", () => {
    const twoSpace = `{\n\t"mcp": {\n\t\t"other": 1\n\t}\n}`;
    const out = insertMember(twoSpace, ["mcp"], "agentbox", ENTRY);
    expect(out).toContain('\n\t\t"agentbox": {');
    expect((structure(out) as { mcp: Record<string, unknown> }).mcp.agentbox).toEqual(ENTRY);
  });

  test("refuses when the section is missing or the key already exists", () => {
    expect(() => insertMember(`{ "theme": "dark" }`, ["mcp"], "agentbox", ENTRY)).toThrow(/mcp/);
    expect(() => insertMember(`{ "mcp": { "agentbox": 1 } }`, ["mcp"], "agentbox", ENTRY)).toThrow(/already/);
  });
});

describe("removeMember", () => {
  test("removes only its own entry", () => {
    const src = `{
  "mcp": {
    "agentbox": { "type": "local", "command": ["bun", "x"] },
    "other": { "type": "remote" }
  },
  "theme": "dark"
}`;
    const out = removeMember(src, ["mcp"], "agentbox")!;
    const parsed = structure(out) as { mcp: Record<string, unknown>; theme: string };
    expect(parsed.mcp).toEqual({ other: { type: "remote" } });
    expect(parsed.theme).toBe("dark");
  });

  // The old uninstall sliced from the start marker to the next "\n    },",
  // which for a nested entry cut through an unrelated closing brace.
  test("a nested object inside the entry does not truncate the cut", () => {
    const src = `{
  "mcp": {
    "agentbox": {
      "type": "local",
      "environment": {
        "A": "1"
      }
    },
    "other": { "type": "remote" }
  }
}`;
    const parsed = structure(removeMember(src, ["mcp"], "agentbox")!) as { mcp: unknown };
    expect(parsed.mcp).toEqual({ other: { type: "remote" } });
  });

  test("removing the last entry does not leave a trailing comma", () => {
    const src = `{\n  "mcp": {\n    "other": { "type": "remote" },\n    "agentbox": { "type": "local" }\n  }\n}`;
    const out = removeMember(src, ["mcp"], "agentbox")!;
    expect(out).not.toMatch(/,\s*}/);
    expect(JSON.parse(out)).toEqual({ mcp: { other: { type: "remote" } } });
  });

  test("removing the only entry leaves an empty object", () => {
    const out = removeMember(`{\n  "mcp": {\n    "agentbox": { "type": "local" }\n  }\n}`, ["mcp"], "agentbox")!;
    expect(JSON.parse(out)).toEqual({ mcp: {} });
  });

  test("absent entry or section returns null rather than mangling the file", () => {
    expect(removeMember(`{ "mcp": { "other": 1 } }`, ["mcp"], "agentbox")).toBeNull();
    expect(removeMember(`{ "theme": "dark" }`, ["mcp"], "agentbox")).toBeNull();
  });

  test("round-trips: install then uninstall restores the original bytes", () => {
    const src = `{
  // opencode config
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "other": { "type": "remote", "url": "https://x" }
  },
  "theme": "dark"
}`;
    const installed = insertMember(src, ["mcp"], "agentbox", ENTRY);
    expect(validates(installed, ["mcp"])).toBe(true);
    expect(removeMember(installed, ["mcp"], "agentbox")).toBe(src);
  });
});
