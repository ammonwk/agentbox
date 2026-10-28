/**
 * Which omp process runs which conversation. Nine omp sessions started within
 * four seconds in one checkout, none yet holding its file open, were each
 * given a sibling's conversation by the newest-file guess, and two of them
 * were refused their own `agentbox pr claim` as held by themselves.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeOmp, slugDirFor } from "../providers/omp";

const root = mkdtempSync(join(tmpdir(), "omp-attr-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cwd = "/work/checkout";
const t0 = Date.parse("2026-10-10T16:22:36.000Z");
const ids = ["01a1269f-9c72-7000-9d56-44cfda9eee9c", "01a1269f-9e68-7000-a513-6fb2bce65ff6", "01a1269f-a54c-7000-b49c-d8c74e748feb"];
const dir = slugDirFor(root, cwd);
mkdirSync(dir, { recursive: true });
ids.forEach((id, i) => {
  const born = new Date(t0 + i * 600 + 400);
  const f = join(dir, `${born.toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
  writeFileSync(f, "{}\n");
  // The last started wrote last, and the first started looks first.
  utimesSync(f, new Date(t0 + 10_000 + i * 1000), new Date(t0 + 10_000 + i * 1000));
});
const procs = ids.map((_, i) => ({ pid: 100 + i, ppid: 1, argv: ["omp"], cwd, startedAt: t0 + i * 600 }));
const noFiles = () => [];

test("the newest-file guess alone crosses siblings started together", () => {
  const got = attributeOmp(procs, root, noFiles);
  expect(ids.some((id, i) => got.get(100 + i) !== id)).toBe(true);
});

test("each one is the conversation of the agentbox session it was started as", () => {
  const got = attributeOmp(procs, root, noFiles, (pid) => ids[pid - 100] ?? null);
  ids.forEach((id, i) => expect(got.get(100 + i)).toBe(id));
});

test("a sibling not yet matched never takes one that was", () => {
  const got = attributeOmp(procs, root, noFiles, (pid) => (pid === 102 ? ids[2]! : null));
  expect(got.get(102)).toBe(ids[2]);
  expect([got.get(100), got.get(101)]).not.toContain(ids[2]);
});

/**
 * Two starts in one checkout, the first slow to write: sihfi7cr (10-28) was
 * given the file of a start made twenty minutes after it, whose brief it then
 * showed as its own.
 */
test("a slow start is never given the file of a sibling started after it", () => {
  const dir2 = slugDirFor(root, "/work/other");
  mkdirSync(dir2, { recursive: true });
  const fast = "01a181d1-cadd-7330-ab9d-57c4642eb0b0";
  const born = new Date(t0 + 20 * 60_000);
  const lines = [
    { type: "session", version: 3, id: fast, timestamp: born.toISOString(), cwd: "/work/other" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "You lost #12 to a restart.\n\nSteward: you take over\nowed:1260" }] } },
  ];
  writeFileSync(join(dir2, `${born.toISOString().replace(/[:.]/g, "-")}_${fast}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const two = [
    { pid: 200, ppid: 1, argv: ["omp"], cwd: "/work/other", startedAt: t0 },
    { pid: 201, ppid: 1, argv: ["omp"], cwd: "/work/other", startedAt: t0 + 19 * 60_000 },
  ];
  const prompts: Record<number, string> = { 200: "Steward: recheck #10847", 201: "Steward: you take over  owed:1260" };

  // The newest-file guess hands the slow one its sibling's file.
  expect(attributeOmp(two, root, noFiles).get(200)).toBe(fast);

  const got = attributeOmp(two, root, noFiles, () => null, (pid) => prompts[pid] ?? null);
  expect(got.get(200)).toBeNull();
  expect(got.get(201)).toBe(fast);
});
