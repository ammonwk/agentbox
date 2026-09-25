import { describe, expect, test } from "bun:test";
import { HttpError } from "../router";
import { parseSettingsPatch, requireBoolean, requireString } from "../validate";

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
