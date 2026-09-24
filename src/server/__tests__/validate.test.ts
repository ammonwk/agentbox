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
  test("one balancer knob", () => {
    expect(parseSettingsPatch({ balancer: { claimBig: 25 } })).toEqual({ balancer: { claimBig: 25 } });
  });

  test("one provider's default model", () => {
    expect(parseSettingsPatch({ models: { codex: " gpt-5.5 " } })).toEqual({ models: { codex: "gpt-5.5" } });
  });

  test("top-level scalars", () => {
    expect(parseSettingsPatch({ theme: "dark" })).toEqual({ theme: "dark" });
    expect(parseSettingsPatch({ autoApprove: false })).toEqual({ autoApprove: false });
    expect(parseSettingsPatch({ boardDays: 7 })).toEqual({ boardDays: 7 });
  });

  test("an empty patch is valid and changes nothing", () => {
    expect(parseSettingsPatch({})).toEqual({});
  });

  // A patch that carries keys the caller never sent would reset them on merge.
  test("a partial patch carries ONLY the keys that were sent", () => {
    const patch = parseSettingsPatch({ balancer: { tieBand: 5 } });
    expect(Object.keys(patch)).toEqual(["balancer"]);
    expect(Object.keys(patch.balancer!)).toEqual(["tieBand"]);
  });
});

describe("settings patches that should be refused", () => {
  test("unknown keys, at the top level and nested", () => {
    expect(rejects({ supervisor: {} })).toContain("unknown setting: supervisor");
    expect(rejects({ balancer: { claimHuge: 3 } })).toContain("unknown balancer setting");
    expect(rejects({ models: { gemini: "x" } })).toContain("unknown provider");
  });

  test("out-of-range and wrong-typed values", () => {
    expect(rejects({ balancer: { claimBig: -1 } })).toContain("balancer.claimBig");
    expect(rejects({ balancer: { shortWindowInWeekly: "24" } })).toContain("balancer.shortWindowInWeekly");
    expect(rejects({ theme: "neon" })).toContain("theme must be");
    expect(rejects({ boardDays: 0 })).toContain("boardDays");
  });

  test("a nested value that is not an object", () => {
    expect(rejects({ balancer: true })).toContain("balancer must be an object");
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
