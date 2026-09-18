import { describe, expect, test } from "bun:test";
import { HttpError } from "../router";
import { beforeParam, limitParam, parseSettingsPatch, requireBoolean, requireString, sinceParam } from "../validate";

function rejects(body: Record<string, unknown>): string {
  try {
    parseSettingsPatch(body);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return (e as HttpError).message;
  }
  throw new Error(`expected ${JSON.stringify(body)} to be rejected`);
}

describe("the key/label separation", () => {
  // Passing the label as the lookup key is what broke Settings: the reader
  // looked up `supervisor["supervisor.enabled"]`, found undefined, and
  // insisted a field that was right there was missing.
  test("a reader looks up `key` and names `label`", () => {
    expect(requireBoolean({ enabled: true }, "enabled", "supervisor.enabled")).toBe(true);
    try {
      requireBoolean({ enabled: "yes" }, "enabled", "supervisor.enabled");
      throw new Error("expected a rejection");
    } catch (e) {
      expect((e as HttpError).message).toBe("supervisor.enabled is required and must be a boolean");
    }
  });

  test("the label defaults to the key", () => {
    try {
      requireString({}, "prompt");
    } catch (e) {
      expect((e as HttpError).message).toContain("prompt is required");
    }
  });
});

describe("settings patches the UI actually sends", () => {
  // Every one of these 400'd before the fix, which made the whole Supervision
  // section of Settings unreachable from the browser.
  test("a nested partial from one toggle", () => {
    expect(parseSettingsPatch({ supervisor: { enabled: true } })).toEqual({ supervisor: { enabled: true } });
  });

  test("a nested partial from one numeric field", () => {
    expect(parseSettingsPatch({ supervisor: { everyToolCalls: 10 } })).toEqual({
      supervisor: { everyToolCalls: 10 },
    });
  });

  test("the advisor toggle", () => {
    expect(parseSettingsPatch({ advisor: { enabled: true } })).toEqual({ advisor: { enabled: true } });
  });

  test("a complete nested object", () => {
    const body = { supervisor: { enabled: true, everyToolCalls: 5, model: "opencode-zen-responses/muse-spark-1.3-contributor-free" } };
    expect(parseSettingsPatch(body)).toEqual(body);
  });

  test("top-level scalars still work", () => {
    expect(parseSettingsPatch({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(parseSettingsPatch({ autoApprove: false })).toEqual({ autoApprove: false });
    expect(parseSettingsPatch({ model: "x/y" })).toEqual({ model: "x/y" });
  });

  test("an empty systemPrompt is a legitimate value, not a missing one", () => {
    expect(parseSettingsPatch({ systemPrompt: "" })).toEqual({ systemPrompt: "" });
  });

  test("an empty patch is valid and changes nothing", () => {
    expect(parseSettingsPatch({})).toEqual({});
  });

  // A patch that carries keys the caller never sent would reset them on merge —
  // the silent-wipe failure the validator exists to prevent.
  test("a partial patch carries ONLY the keys that were sent", () => {
    const patch = parseSettingsPatch({ supervisor: { enabled: true } });
    expect(Object.keys(patch)).toEqual(["supervisor"]);
    expect(Object.keys(patch.supervisor!)).toEqual(["enabled"]);
    expect("model" in patch.supervisor!).toBe(false);
    expect("everyToolCalls" in patch.supervisor!).toBe(false);
  });
});

describe("settings patches that should be refused", () => {
  test("unknown keys, at the top level and nested", () => {
    expect(rejects({ superviser: {} })).toContain("unknown setting: superviser");
    expect(rejects({ systemPrompot: "x" })).toContain("unknown setting");
  });

  test("wrong types name the full path", () => {
    expect(rejects({ supervisor: { enabled: "yes" } })).toBe(
      "supervisor.enabled is required and must be a boolean",
    );
    expect(rejects({ supervisor: { everyToolCalls: 0 } })).toContain("supervisor.everyToolCalls");
    expect(rejects({ supervisor: { everyToolCalls: 2.5 } })).toContain("supervisor.everyToolCalls");
    expect(rejects({ advisor: { model: "" } })).toContain("advisor.model");
    expect(rejects({ theme: "neon" })).toContain("theme must be");
    expect(rejects({ systemPrompt: 42 })).toContain("systemPrompt");
  });

  test("a nested value that is not an object", () => {
    expect(rejects({ supervisor: true })).toContain("supervisor must be an object");
    expect(rejects({ advisor: [1] })).toContain("advisor must be an object");
  });
});

describe("sinceParam", () => {
  const at = (q: string) => sinceParam(new URL(`http://x/e${q}`));

  test("absent, empty and zero", () => {
    expect(at("")).toBeUndefined();
    expect(at("?since=")).toBeUndefined();
    expect(at("?since=0")).toBe(0);
  });

  test("a real cursor", () => {
    expect(at("?since=42")).toBe(42);
  });

  test("junk is a 400, not NaN silently meaning 'from the start'", () => {
    for (const q of ["?since=-1", "?since=1.5", "?since=abc"]) {
      expect(() => at(q)).toThrow(/non-negative integer/);
    }
  });
});

describe("beforeParam", () => {
  const at = (q: string) => beforeParam(new URL(`http://x/e${q}`));

  test("absent and empty", () => {
    expect(at("")).toBeUndefined();
    expect(at("?before=")).toBeUndefined();
  });

  test("a real bound", () => {
    expect(at("?before=42")).toBe(42);
  });

  test("junk is a 400 — zero is junk too, since the bound is exclusive", () => {
    for (const q of ["?before=0", "?before=-1", "?before=1.5", "?before=abc"]) {
      expect(() => at(q)).toThrow(/positive integer/);
    }
  });
});

describe("limitParam", () => {
  const at = (q: string) => limitParam(new URL(`http://x/e${q}`));

  test("absent and empty", () => {
    expect(at("")).toBeUndefined();
    expect(at("?limit=")).toBeUndefined();
  });

  test("a real bound", () => {
    expect(at("?limit=50")).toBe(50);
  });

  test("junk, zero and anything past the cap are 400s", () => {
    for (const q of ["?limit=0", "?limit=-1", "?limit=1.5", "?limit=abc", "?limit=999999"]) {
      expect(() => at(q)).toThrow(/between 1 and/);
    }
  });
});
