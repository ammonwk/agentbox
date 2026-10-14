/** A skill directory as a cloud bundle, and back.
 *
 *  Reading: every text file under the directory, by relative path, without
 *  dotfiles (the install manifest among them) and without following links.
 *
 *  Installing a pinned revision keeps what you changed by hand. The manifest
 *  (`.agentbox-skill.json`) records which revision is installed and the hash
 *  of each file as that revision had it. A file whose hash still matches is
 *  agentbox's to replace; one that differs is yours, so it stays, and the
 *  revision's copy is put beside the agentbox home for you to compare. With
 *  `force` the revision wins, and your copy is backed up first. A directory
 *  that did not come from the cloud, or came from another skill, is refused.
 *
 *  Node fs only: the local server and the CLI use it, a browser does not. */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { LIMITS, SKILL_NAME_RE, type SkillFileInput, type SkillRevision } from "./protocol";

export const MANIFEST = ".agentbox-skill.json";

export interface SkillManifest {
  v: 1;
  name: string;
  source: { url: string; workspaceId: string; workspaceSlug: string; skillId: string };
  rev: number;
  bundleSha256: string;
  installedAt: string;
  /** Each file's hash as the installed revision has it. */
  files: Record<string, string>;
  /** Files kept as you edited them when this revision was installed. */
  kept: string[];
}

export interface InstallResult {
  dir: string;
  name: string;
  rev: number;
  /** Written from the revision (new, or unchanged since the last install). */
  written: string[];
  /** Already identical. */
  same: string[];
  /** Edited by you and kept; the revision's copy is at `incoming`. */
  kept: { path: string; incoming: string }[];
  /** Edited by you and replaced (`force`); your copy is at `backup`. */
  replaced: { path: string; backup: string }[];
  /** Dropped by the revision and removed (you had not edited them). */
  removed: string[];
  /** Dropped by the revision but edited by you, so left in place. */
  orphaned: string[];
}

export class SkillBundleError extends Error {}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The bundle of a skill directory, ready to publish. */
export function readSkillDir(dir: string): SkillFileInput[] {
  if (!existsSync(join(dir, "SKILL.md"))) throw new SkillBundleError(`${dir} has no SKILL.md, so it is not a skill`);
  const files: SkillFileInput[] = [];
  let total = 0;
  const walk = (at: string): void => {
    for (const entry of readdirSync(at).sort()) {
      if (entry.startsWith(".")) continue;
      const full = join(at, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      const path = relative(dir, full).split(sep).join("/");
      const bytes = readFileSync(full);
      let content: string;
      try {
        content = decoder.decode(bytes);
      } catch {
        throw new SkillBundleError(`${path} is not UTF-8 text; a cloud skill holds text files only`);
      }
      if (content.includes("\0")) throw new SkillBundleError(`${path} is binary; a cloud skill holds text files only`);
      total += bytes.length;
      files.push({ path, content });
    }
  };
  walk(dir);
  if (files.length > LIMITS.skillFiles) throw new SkillBundleError(`${dir} has ${files.length} files; a cloud skill holds at most ${LIMITS.skillFiles}`);
  if (total > LIMITS.skillBytes) throw new SkillBundleError(`${dir} is ${Math.round(total / 1024)} KiB; a cloud skill holds at most ${LIMITS.skillBytes / 1024} KiB`);
  return files;
}

export function readManifest(dir: string): SkillManifest | null {
  const p = join(dir, MANIFEST);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as SkillManifest;
    return m && m.v === 1 && typeof m.files === "object" ? m : null;
  } catch {
    return null;
  }
}

/** Skills installed from the cloud under `roots`, by their manifests. */
export function installedSkills(roots: string[]): { dir: string; manifest: SkillManifest }[] {
  const out: { dir: string; manifest: SkillManifest }[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      const m = readManifest(dir);
      if (m) out.push({ dir, manifest: m });
    }
  }
  return out;
}

function inside(dir: string, path: string): string {
  const full = resolve(dir, path);
  if (!full.startsWith(resolve(dir) + sep)) throw new SkillBundleError(`refusing a path outside the skill: ${path}`);
  return full;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.agentbox-tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const fileSha = (path: string): string | null => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);

/**
 * Install `revision` (with its files) as skill `name` under `root`.
 * `incomingDir` and `backupDir` are outside every skill root, so a copy put
 * there is never read as a skill.
 */
export function installSkill(opts: {
  root: string;
  name: string;
  revision: SkillRevision;
  source: SkillManifest["source"];
  incomingDir: string;
  backupDir: string;
  force?: boolean;
  now?: Date;
}): InstallResult {
  const { root, name, revision, source } = opts;
  if (!SKILL_NAME_RE.test(name) || name.includes("..")) throw new SkillBundleError(`"${name}" is not a skill name`);
  if (!revision.files?.length) throw new SkillBundleError("that revision came without its files");
  // Every hash below decides whose a file is, so a damaged bundle stops here.
  for (const f of revision.files) {
    if (sha(f.content) !== f.sha256) throw new SkillBundleError(`${f.path} does not match its hash; the bundle is damaged`);
  }
  const dir = join(root, name);
  const old = readManifest(dir);
  if (existsSync(dir) && !old) {
    throw new SkillBundleError(`${dir} exists and was not installed from the cloud: move it aside, or publish it to the cloud instead`);
  }
  if (old && (old.source.skillId !== source.skillId || old.source.url !== source.url)) {
    throw new SkillBundleError(`${dir} was installed from another cloud skill (${old.source.workspaceSlug}/${old.name}); refusing to mix them`);
  }
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const result: InstallResult = { dir, name, rev: revision.rev, written: [], same: [], kept: [], replaced: [], removed: [], orphaned: [] };
  const recorded: Record<string, string> = {};
  const kept: string[] = [];
  mkdirSync(dir, { recursive: true });

  for (const f of revision.files) {
    const target = inside(dir, f.path);
    const local = fileSha(target);
    recorded[f.path] = f.sha256;
    if (local === f.sha256) {
      result.same.push(f.path);
      continue;
    }
    const ours = local === null || (old?.files[f.path] !== undefined && old.files[f.path] === local);
    if (ours) {
      writeAtomic(target, f.content);
      result.written.push(f.path);
    } else if (opts.force) {
      const backup = join(opts.backupDir, name, stamp, f.path);
      writeAtomic(backup, readFileSync(target, "utf8"));
      writeAtomic(target, f.content);
      result.replaced.push({ path: f.path, backup });
    } else {
      const incoming = join(opts.incomingDir, name, `rev${revision.rev}`, f.path);
      writeAtomic(incoming, f.content);
      result.kept.push({ path: f.path, incoming });
      kept.push(f.path);
    }
  }

  for (const [path, was] of Object.entries(old?.files ?? {})) {
    if (path in recorded) continue;
    const target = inside(dir, path);
    const local = fileSha(target);
    if (local === null) continue;
    if (local === was || opts.force) {
      if (local !== was) {
        const backup = join(opts.backupDir, name, stamp, path);
        writeAtomic(backup, readFileSync(target, "utf8"));
      }
      rmSync(target);
      result.removed.push(path);
    } else {
      result.orphaned.push(path);
    }
  }

  const manifest: SkillManifest = {
    v: 1,
    name,
    source,
    rev: revision.rev,
    bundleSha256: revision.bundle_sha256,
    installedAt: (opts.now ?? new Date()).toISOString(),
    files: recorded,
    kept,
  };
  writeAtomic(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return result;
}
