/** Org skills (docs/org.md, Org skills): a GitHub repo of skill directories,
 *  cloned into `<agentbox home>/org/skills` and pulled every few minutes.
 *  Org homes get a `skills` directory of their own, a link per skill: each
 *  personal one (the provider's default home's) and each of the org's, a
 *  personal skill winning a name clash. Personal homes never see them. */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultHome } from "../accounts/homes";
import { listAccounts } from "../db";
import type { Account } from "../types";
import { orgAccountsRoot, orgDir, readOrg } from "./config";

export const orgSkillsDir = (): string => join(orgDir(), "skills");

async function run(cmd: string[], cwd?: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${err.trim().split("\n").at(-1) ?? "failed"}`);
}

/** Clone or pull the org's skills, then link them into every org home. */
export async function syncOrgSkills(): Promise<void> {
  const org = readOrg();
  if (!org?.skills) return;
  const dir = orgSkillsDir();
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(orgDir(), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    await run(Bun.which("gh") ? ["gh", "repo", "clone", org.skills, dir, "--", "--quiet"] : ["git", "clone", "--quiet", `https://github.com/${org.skills}.git`, dir]);
  } else {
    await run(["git", "pull", "--quiet", "--ff-only"], dir);
  }
  for (const a of listAccounts()) if (a.home.startsWith(orgAccountsRoot() + "/")) linkSkills(a);
}

/** Skill directories in `dir`: name → path. */
function skillsIn(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) if (!n.startsWith(".") && existsSync(join(dir, n, "SKILL.md"))) out.set(n, join(dir, n));
  return out;
}

/** An org home's `skills`: the personal ones, then the org's. */
export function linkSkills(a: Pick<Account, "provider" | "home">): void {
  if (a.provider !== "claude" && a.provider !== "codex") return;
  const want = new Map([...skillsIn(orgSkillsDir()), ...skillsIn(join(defaultHome(a.provider), "skills"))]);
  const dir = join(a.home, "skills");
  // A home made before it was an org home's may hold the link to the personal directory.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) rmSync(dir);
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (lstatSync(p).isSymbolicLink() && readlinkSync(p) !== want.get(n)) rmSync(p);
  }
  for (const [n, target] of want) if (!existsSync(join(dir, n))) symlinkSync(target, join(dir, n));
}
