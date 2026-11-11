/**
 * A codex session started on a model its account's catalog does not offer
 * Daybreak on starts with Daybreak off: with `daybreak = true` in the
 * person's config.toml, codex refuses such a model's first turn.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAdapter } from "../providers/codex";
import type { Account } from "../types";

const dir = mkdtempSync(join(tmpdir(), "agentbox-daybreak-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const home = join(dir, "codex-home");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "models_cache.json"), JSON.stringify({
  models: [
    { slug: "gpt-6.1-sol", available_access_programs: { cyber: ["standard"] } },
    { slug: "gpt-6-sol", available_access_programs: { cyber: ["standard", "daybreak_blue"] } },
  ],
}));
const account: Account = { id: "fixture", provider: "codex", label: "fixture", email: null, plan: null, home, isDefault: false, enabled: true, createdAt: 0 };
const opts = (model?: string) => ({ session: "fixture", account, cwd: dir, autoApprove: true, model });
const argv = (model?: string) => [codexAdapter.spawnCommand(opts(model)).argv, resumed(model)];
// A resume of a launch adopted from another terminal carries that launch's flags.
const resumed = (model?: string, carry?: string[]) => codexAdapter.resumeCommand({ ...opts(model), agentSessionId: "0199a000-0000-7000-8000-000000000000", carry }).argv;

test("a model the catalog offers no Daybreak on starts and resumes with it off", () => {
  for (const a of argv("gpt-6.1-sol")) expect(a.join(" ")).toContain("-c daybreak=false");
  expect(resumed(undefined, ["-m", "gpt-6.1-sol"]).join(" ")).toContain("-c daybreak=false");
  // An unknown model: codex cannot confirm Daybreak for it either.
  for (const a of argv("gpt-7")) expect(a.join(" ")).toContain("-c daybreak=false");
});

test("Daybreak stays as configured where it can run, or where no model is named", () => {
  for (const a of argv("gpt-6-sol")) expect(a.join(" ")).not.toContain("daybreak");
  for (const a of argv()) expect(a.join(" ")).not.toContain("daybreak");
  expect(resumed(undefined, ["-c", "daybreak=true", "--model", "gpt-6.1-sol"]).filter((x) => x.startsWith("daybreak="))).toEqual(["daybreak=true"]);
});
