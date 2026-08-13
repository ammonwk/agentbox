import { describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, mergeSettings } from "../db";

describe("mergeSettings", () => {
  test("a partial nested group keeps the siblings it did not mention", () => {
    // The bug this exists to prevent: a flat spread replaces `supervisor`
    // wholesale, so a toggle sending only `enabled` silently resets the model
    // and the interval.
    const next = mergeSettings(DEFAULT_SETTINGS, { supervisor: { enabled: false } });
    expect(next.supervisor.enabled).toBe(false);
    expect(next.supervisor.everyToolCalls).toBe(DEFAULT_SETTINGS.supervisor.everyToolCalls);
    expect(next.supervisor.model).toBe(DEFAULT_SETTINGS.supervisor.model);
  });

  test("untouched groups survive a patch to a different group", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { advisor: { enabled: true } });
    expect(next.supervisor).toEqual(DEFAULT_SETTINGS.supervisor);
    expect(next.advisor).toEqual({ ...DEFAULT_SETTINGS.advisor, enabled: true });
  });

  test("scalars replace", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { theme: "dark", maxMinutes: 5 });
    expect(next.theme).toBe("dark");
    expect(next.maxMinutes).toBe(5);
  });

  test("false and empty string are values, not absences", () => {
    const base = mergeSettings(DEFAULT_SETTINGS, { autoApprove: true, systemPrompt: "be terse" });
    const next = mergeSettings(base, { autoApprove: false, systemPrompt: "" });
    expect(next.autoApprove).toBe(false);
    expect(next.systemPrompt).toBe("");
  });

  test("an explicit undefined does not erase the current value", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { model: undefined });
    expect(next.model).toBe(DEFAULT_SETTINGS.model);
  });

  test("the base is not mutated", () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    mergeSettings(base, { supervisor: { everyToolCalls: 1 } });
    expect(base).toEqual(DEFAULT_SETTINGS);
  });

  test("merging an empty patch is the identity", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, {})).toEqual(DEFAULT_SETTINGS);
  });

  test("a stored partial from an older version gains the new defaults", () => {
    // What getSettings() does with a row written before `supervisor` existed.
    const stored = { theme: "dark", model: "old-model" } as const;
    const next = mergeSettings(DEFAULT_SETTINGS, stored);
    expect(next.supervisor).toEqual(DEFAULT_SETTINGS.supervisor);
    expect(next.systemPrompt).toBe(DEFAULT_SETTINGS.systemPrompt);
    expect(next.model).toBe("old-model");
  });
});
