import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUntil } from "../waitreads";

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const spec = (cmd: string, cwd = process.cwd()) => ({ kind: "until" as const, cmd, cwd, everyMs: 30_000 });

test("until distinguishes event, not-yet and command failure without GNU timeout", async () => {
  const done = await readUntil(spec('printf "%s:%s" "$AGENTBOX_WAIT" "$AGENTBOX_SESSION"'), 42, "fixture");
  expect(done).toEqual({ yes: true, said: "42:fixture" });
  expect(await readUntil(spec("printf 'still waiting'; exit 1"), 42, "fixture")).toEqual({ yes: false, said: "still waiting" });
  await expect(readUntil(spec("printf 'unavailable' >&2; exit 2"), 42, "fixture")).rejects.toThrow("exited 2: unavailable");
  // A command's own exit 124 is not evidence that our deadline expired.
  await expect(readUntil(spec("exit 124"), 42, "fixture")).rejects.toThrow("exited 124");
});

test("until deadline kills its shell and child, never the server's process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-until-"));
  const pids = join(dir, "pids");
  const observer = Bun.spawn(["sh", "-c", "exec sleep 30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const child = `trap '' TERM; printf '%s\\n' "$$" >> ${quote(pids)}; exec sleep 30`;
    const command = `printf '%s\\n' "$$" > ${quote(pids)}; sh -c ${quote(child)} & wait`;
    await expect(readUntil(spec(command, dir), 43, "fixture", 1000)).rejects.toThrow("did not finish");
    const ids = readFileSync(pids, "utf8").trim().split("\n");
    expect(ids.length).toBe(2);
    for (const pid of ids) {
      const stat = Bun.spawnSync(["ps", "-o", "stat=", "-p", pid]).stdout.toString().trim();
      expect(stat === "" || stat.startsWith("Z")).toBe(true);
    }
    expect(observer.exitCode).toBeNull();
    expect(() => process.kill(observer.pid, 0)).not.toThrow();
  } finally {
    observer.kill("SIGKILL");
    await observer.exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
