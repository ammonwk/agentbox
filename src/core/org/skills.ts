/** Org skills (docs/org.md, Org skills): a GitHub repo of skill directories,
 *  cloned into `<agentbox home>/org/skills`, pulled every few minutes, and
 *  linked into each CLI's user-level skills directory: the one every account
 *  home of claude, codex and muse links to (accounts/homes.ts), and the one
 *  omp and opencode read for every account. So an org skill reaches every
 *  session on a member's machine, personal ones too, and a personal skill of
 *  the same name wins. */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultHome } from "../accounts/homes";
import { userHome } from "../paths";
import { orgDir, readOrg } from "./config";

export const orgSkillsDir = (): string => join(orgDir(), "skills");

async function run(cmd: string[], cwd?: string): Promise<void> {
  const p = Bun.spawn(cmd, { cwd, stdout: "ignore", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")}: ${err.trim().split("\n").at(-1) ?? "failed"}`);
}

/** Clone or pull the org's skills, then link them where each CLI reads them. */
export async function syncOrgSkills(): Promise<void> {
  const org = readOrg();
  if (!org) return;
  if (!org.skills) {
    // No repo: the clone may still be on disk, but its skills are not the
    // org's any more, so every link we made for them goes.
    linkOrgSkills(new Map());
    return;
  }
  const dir = orgSkillsDir();
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(orgDir(), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    await run(Bun.which("gh") ? ["gh", "repo", "clone", org.skills, dir, "--", "--quiet"] : ["git", "clone", "--quiet", `https://github.com/${org.skills}.git`, dir]);
  } else {
    await run(["git", "pull", "--quiet", "--ff-only"], dir);
  }
  linkOrgSkills();
}

/** Where each CLI reads its user-level skills, for every account. */
const skillRoots = (): string[] => [
  join(defaultHome("claude"), "skills"),
  join(defaultHome("codex"), "skills"),
  join(defaultHome("muse"), "muse", "skills"),
  join(userHome(), ".config", "opencode", "skills"),
  join(userHome(), ".omp", "agent", "skills"),
];

/** A link in a skills root that we made into the org's skills. */
function isOrgLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path).startsWith(orgSkillsDir() + "/");
  } catch {
    return false;
  }
}

/** The org's skills, linked into the skills root of each CLI installed here:
 *  only our own links are touched, a personal name in any root wins, and a
 *  name the org no longer has loses its link. */
function linkOrgSkills(skills: Map<string, string> = skillsIn(orgSkillsDir())): void {
  const roots = skillRoots().filter((dir) => existsSync(dirname(dir)));
  const personal = new Set<string>();
  for (const root of [...roots, join(userHome(), ".agents", "skills")]) {
    for (const [name, path] of skillsIn(root)) if (!isOrgLink(path)) personal.add(name);
  }
  for (const dir of roots) {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (isOrgLink(path) && (!skills.has(name) || personal.has(name))) rmSync(path);
    }
    for (const [name, target] of skills) {
      if (personal.has(name) || existsSync(join(dir, name))) continue;
      symlinkSync(target, join(dir, name));
    }
  }
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
