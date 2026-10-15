/** The move of the old local agents into superagents loses nothing, runs
 *  once, and never writes over a directory a person made. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;
const script = join(import.meta.dir, "..", "migrate-local-agents.ts");
const run = (...extra: string[]) => {
  const p = Bun.spawnSync(["bun", script, "--into", join(home, "config"), ...extra], { env: { ...process.env, AGENTBOX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "migrate-local-"));
  mkdirSync(join(home, "agents", "local", "local-scribe"), { recursive: true });
  writeFileSync(join(home, "agents", "local", "local-scribe", "SOUL.md"), "# SOUL\nTerse.\n");
  const db = new Database(join(home, "agents", "runtime.db"));
  db.exec("CREATE TABLE local_agents (id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  db.exec("CREATE TABLE agent_memory (id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, key TEXT, session TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, fingerprint TEXT NOT NULL, checkpoint TEXT, used_by TEXT, retired INTEGER, body TEXT NOT NULL)");
  const agent = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    db.run("INSERT INTO local_agents VALUES (?, ?)", [id, JSON.stringify({ id, name, role: `${name} things`, instructions: `You are ${name}.`, repo: null, session: null, previous: [], enabled: true, ...extra })]);
  agent("local-scribe", "SCRIBE", { loop: { when: "every hour", check: null, prompt: "Write it down.", nextAt: null } });
  agent("local-idle", "IDLE");
  agent("local-mine", "MINE", { loop: { when: "every day at 9am", check: null, prompt: "x", nextAt: null } });
  db.run("INSERT INTO agent_memory VALUES ('rec-1', 'local-scribe', 'note', NULL, 'old-chat', 1, 'agent', 'f', NULL, NULL, NULL, ?)", [JSON.stringify({ decision: "Keep notes short", why: "", refs: [] })]);
  db.close();
  // A directory a person made, under the name the script would use.
  mkdirSync(join(home, "config", "mine"), { recursive: true });
  writeFileSync(join(home, "config", "mine", "superagent.json"), JSON.stringify({ name: "mine" }));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("an agent with something to keep moves, with its journal, loop and SOUL.md; one with nothing does not", () => {
  const first = run();
  expect(first.code).toBe(0);
  expect(first.out).toContain("local-scribe → scribe");
  expect(first.out).not.toContain("local-idle");
  const dir = join(home, "config", "scribe");
  expect(JSON.parse(readFileSync(join(dir, "superagent.json"), "utf8"))).toMatchObject({ name: "scribe", title: "Scribe", memory: true, main: { start: { provider: "auto" }, instructions: "MAIN.md" } });
  expect(readFileSync(join(dir, "MAIN.md"), "utf8")).toBe("You are SCRIBE.\n");
  expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe("# SOUL\nTerse.\n");
  const journal = new Database(join(home, "superagents", "scribe", "memory.db"));
  expect(journal.query("SELECT id, scope FROM agent_memory").all()).toEqual([{ id: "rec-1", scope: "scribe" }]);
  journal.close();
  expect(readFileSync(join(home, "superagents", "scribe", "MEMORY.md"), "utf8")).toContain("Keep notes short");
  const box = new Database(join(home, "box.db"));
  expect(box.query("SELECT name, enabled FROM superagents").all()).toEqual([{ name: "scribe", enabled: 1 }]);
  expect(JSON.parse((box.query("SELECT body FROM superagent_state WHERE name = 'scribe'").get() as { body: string }).body).loops.loop.spec.prompt).toBe("Write it down.");
  box.close();
});

test("a directory the script did not write is left alone, and a second run moves nothing again", () => {
  const second = run();
  expect(second.out).toContain("local-scribe: moved before, to scribe");
  expect(second.out).toContain("SKIPPED");
  expect(JSON.parse(readFileSync(join(home, "config", "mine", "superagent.json"), "utf8"))).toEqual({ name: "mine" });
  expect(existsSync(join(home, "config", "mine", "MAIN.md"))).toBe(false);
  expect(second.out).toContain("0 moved");
});
