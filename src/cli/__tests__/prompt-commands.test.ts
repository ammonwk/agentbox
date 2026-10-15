/**
 * Every CLI command a superagent's prompt or the CLI guide names must parse.
 * An agent prompt once told every agent to read `agentbox show --json`, which
 * `show` did not take, so each close an agent tried started with a failed command.
 * Each command here runs through the real CLI against a server that answers
 * everything with nothing; the test checks only that the CLI accepts its words.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  const board = { sessions: [{ id: "abc12345", lastActivityAt: 42 }], accounts: [], prs: [], prClaims: [], serverTime: 0 };
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => Response.json({ ok: true, data: new URL(req.url).pathname === "/api/state" ? board : [] }) });
});
afterAll(() => server.stop(true));

const core = join(import.meta.dir, "../../core");
const sources = [join(core, "cli-guide.ts"), ...readdirSync(join(core, "superagent")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(core, "superagent", f))];

/** "agentbox show <id> --json" → ["show", "x", "--json"]: each placeholder a
 *  word, each choice its first word, the text after the command cut off. */
export function commandsIn(text: string): string[][] {
  const found = new Map<string, string[]>();
  for (const m of text.matchAll(/agentbox (?=((?:superagent|agent|report|show|log|card) (?:"[^"\n]*"|[^`"\n#|;\\])*))/g)) {
    // A command quoted inside a placeholder ends where the placeholder does;
    // a quoted value ("every hour") is one word.
    const words = m[1]!
      .replace(/"[^"\n]*"/g, "x")
      .replace(/<[^<>]*>/g, "x")
      .split(/(?:\. |, | and | with | using | from | to |\(|\)|>)/)[0]!
      .replace(/\$\{[^}]*\}/g, "x")
      .replace(/\{[^}]*\}/g, "")
      .replace(/[[\]<>]/g, " ")
      .trim()
      .split(/\s+/)
      .map((w) => w.split("|")[0]!);
    const end = words.findIndex((w, i) => w.endsWith(":") || w.endsWith(".") || (/^[A-Z][a-z]/.test(w) && !words[i - 1]?.startsWith("--")));
    if (end >= 0) words.splice(end, words.length, ...(words[end]!.endsWith(".") ? [words[end]!.slice(0, -1)] : []));
    for (const [i, w] of words.entries()) if (/^[A-Z]+$/.test(w)) words[i] = "x";
    if (words.length > 1) found.set(words.join(" "), words);
  }
  return [...found.values()];
}

export const commands = sources.flatMap((f) => commandsIn(readFileSync(f, "utf8")));
test("the prompts name commands to check", () => expect(commands.length).toBeGreaterThan(10));
for (const words of commands) {
  test(`agentbox ${words.join(" ")} parses`, async () => {
    const env: Record<string, string | undefined> = { ...process.env, AGENTBOX_PORT: String(server.port), AGENTBOX_SESSION: "s0000000" };
    const p = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/agentbox"), ...words], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const err = await new Response(p.stderr).text();
    await p.exited;
    expect(err).not.toMatch(/unknown option|no session "-|needs a value|unknown command|takes [a-z-]+(, [a-z-]+)* or /i);
  });
}

test("agentbox show <id> --json prints the session's record", async () => {
  const env: Record<string, string | undefined> = { ...process.env, AGENTBOX_PORT: String(server.port), AGENTBOX_SESSION: "s0000000" };
  const p = Bun.spawn(["bun", join(import.meta.dir, "../../../bin/agentbox"), "show", "abc1", "--json"], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  expect(JSON.parse(out)).toEqual({ id: "abc12345", lastActivityAt: 42 });
});
