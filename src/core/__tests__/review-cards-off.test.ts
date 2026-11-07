import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, closeDb, getSettings, saveSettings } from "../db";
import { briefing } from "../providers/briefing";

// Never the live home: a test that opens box.db there migrates the real one.
const old = process.env.AGENTBOX_HOME;
const dir = mkdtempSync(join(tmpdir(), "agentbox-review-cards-"));
beforeAll(() => {
  closeDb();
  process.env.AGENTBOX_HOME = dir;
});
afterAll(() => {
  closeDb();
  if (old === undefined) delete process.env.AGENTBOX_HOME;
  else process.env.AGENTBOX_HOME = old;
  rmSync(dir, { recursive: true, force: true });
});

test("with Review cards off, every session is told to ask the user directly", () => {
  expect(getSettings().reviewCards).toBe(true);
  expect(briefing()).not.toContain("Review cards are off");

  saveSettings({ ...DEFAULT_SETTINGS, reviewCards: false });
  expect(briefing()).toContain("Review cards are off. Do not run `agentbox card add`");

  saveSettings({ ...DEFAULT_SETTINGS, reviewCards: true });
  expect(briefing()).not.toContain("Review cards are off");
});
