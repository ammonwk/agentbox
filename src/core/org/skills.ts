/** Org skills (docs/org.md, Org skills): a GitHub repo of skill directories,
 *  cloned into `<agentbox home>/org/skills` and pulled every few minutes.
 *  Claude, codex and muse org homes get a `skills` directory of their own, a
 *  link per skill: each personal one (the provider's default home's) and each
 *  of the org's, a personal skill winning a name clash. omp and opencode read
 *  one user-level skills directory for every account, so the org's links go
 *  there instead (and, being user-level, reach personal sessions too). */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultHome } from "../accounts/homes";
import { listAccounts } from "../db";
import { userHome } from "../paths";
import type { Account } from "../types";
import { isOrgHome, orgDir, readOrg } from "./config";

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
    for (const a of listAccounts()) if (isOrgHome(a.home)) linkSkills(a, new Map());
    linkOrgSkillsForEveryAccount(new Map());
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
  for (const a of listAccounts()) if (isOrgHome(a.home)) linkSkills(a);
  linkOrgSkillsForEveryAccount();
}

/** omp and opencode read user-level skills from here, for every account. */
const sharedSkillRoots = (): string[] => [
  join(userHome(), ".config", "opencode", "skills"),
  join(userHome(), ".omp", "agent", "skills"),
];

/** Personal roots that shadow the shared ones: a personal skill of a name
 *  wins, whichever root holds it. */
const personalSkillRoots = (): string[] => [
  join(userHome(), ".claude", "skills"),
  join(userHome(), ".agents", "skills"),
  join(userHome(), ".codex", "skills"),
];

/** A link in a shared root that we made into the org's skills. */
function isOrgLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path).startsWith(orgSkillsDir() + "/");
  } catch {
    return false;
  }
}

/** The org's skills, linked where omp and opencode read every account's:
 *  only our own links are touched, a personal name wins, and a name the org
 *  no longer has loses its link. */
function linkOrgSkillsForEveryAccount(skills: Map<string, string> = skillsIn(orgSkillsDir())): void {
  const personal = new Set<string>();
  for (const root of [...personalSkillRoots(), ...sharedSkillRoots()]) {
    for (const [name, path] of skillsIn(root)) if (!isOrgLink(path)) personal.add(name);
  }
  for (const dir of sharedSkillRoots()) {
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

/** An org home's `skills`: the personal ones, then the org's. */
export function linkSkills(a: Pick<Account, "provider" | "home">, org: Map<string, string> = skillsIn(orgSkillsDir())): void {
  // Where each CLI reads skills from inside its config home.
  const spec =
    a.provider === "claude" || a.provider === "codex"
      ? { dir: join(a.home, "skills"), personal: join(defaultHome(a.provider), "skills") }
      : a.provider === "muse"
        ? { dir: join(a.home, "muse", "skills"), personal: join(defaultHome("muse"), "muse", "skills") }
        : null;
  if (!spec) return;
  const want = new Map([...org, ...skillsIn(spec.personal)]);
  const dir = spec.dir;
  // A home made before it was an org home's may hold the link to the personal directory.
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) rmSync(dir);
  mkdirSync(dir, { recursive: true });
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (lstatSync(p).isSymbolicLink() && readlinkSync(p) !== want.get(n)) rmSync(p);
  }
  for (const [n, target] of want) if (!existsSync(join(dir, n))) symlinkSync(target, join(dir, n));
}
