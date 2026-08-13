import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { run } from "./git";
import { getRepo } from "./db";
import type { DiffFile, Session, SessionDiff } from "./types";

/**
 * Caps. A runaway agent can produce a diff far larger than a browser should be
 * asked to hold, and this is serialised straight into a WebSocket message. The
 * counts are always exact — only the patch bodies are bounded — so the summary
 * a human skims stays true even when the text is clipped.
 */
const MAX_PATCH_BYTES = 96 * 1024;
const MAX_TOTAL_PATCH_BYTES = 3 * 1024 * 1024;
/** Beyond this, per-file `git diff` spawns cost more than the review is worth. */
const MAX_PATCH_FILES = 400;

/**
 * Which branch a session's work should be judged against. Knowing that a
 * session's `repo` field is a Repo `ref`, and that a Repo carries a
 * `defaultBranch`, is data's business — a transport that has to look it up
 * would be reimplementing this alongside its own fallback.
 */
export function baseFor(session: Session): string {
  return getRepo(session.repo)?.defaultBranch ?? "main";
}

/**
 * The diff a human reviews: this session's worktree against where it branched
 * from `base`. Omit `base` to use the session's repo default.
 *
 * Untracked files are included. An agent's most common single act is creating a
 * file, and `git diff` alone renders that as nothing at all — a review screen
 * that silently omits new files is worse than no review screen.
 */
export function diffOf(session: Session, base = baseFor(session)): SessionDiff {
  const empty: SessionDiff = { base, files: [], additions: 0, deletions: 0, unavailable: true };
  const wt = session.worktree;
  if (!wt || !existsSync(wt)) return empty;
  if (run(["git", "rev-parse", "--is-inside-work-tree"], wt).code !== 0) return empty;

  const against = mergeBase(wt, base);
  const files: DiffFile[] = [];
  let budget = MAX_TOTAL_PATCH_BYTES;

  const tracked = trackedFiles(wt, against);
  const untracked = untrackedFiles(wt);
  const all = [...tracked, ...untracked];

  for (const [index, entry] of all.entries()) {
    const withinCaps = index < MAX_PATCH_FILES && budget > 0;
    let patch: string | null = null;
    if (entry.binary) {
      // `patch: null` is the type's way of saying "binary" — there is no text
      // to show and a line count would be a lie.
      files.push({ ...entry.file, patch: null });
      continue;
    }
    if (!withinCaps) {
      patch = `… patch omitted: this diff exceeded ${MAX_PATCH_FILES} files or ${megabytes(MAX_TOTAL_PATCH_BYTES)} of patch text. The counts on this row are still exact.`;
    } else {
      const body = entry.untracked ? untrackedPatch(wt, entry.file.path) : trackedPatch(wt, against, entry.file.path);
      patch = clamp(body);
      budget -= patch.length;
    }
    files.push({ ...entry.file, patch });
  }

  return {
    base,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    unavailable: false,
  };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function clamp(patch: string): string {
  if (patch.length <= MAX_PATCH_BYTES) return patch;
  return (
    patch.slice(0, MAX_PATCH_BYTES) +
    `\n… truncated: this file's patch is ${Math.round(patch.length / 1024)} KB, showing the first ${Math.round(MAX_PATCH_BYTES / 1024)} KB …\n`
  );
}

/**
 * Where this branch left `base`. Diffing against the tip of `base` instead would
 * show every commit that landed on main since the agent started as if the agent
 * had reverted them.
 *
 * Falls back to the empty tree when there is no common ancestor — a worktree on
 * an unrelated history still has a real diff, it is just "everything".
 */
function mergeBase(wt: string, base: string): string {
  const candidates = [`origin/${base}`, base];
  for (const ref of candidates) {
    if (run(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], wt).code !== 0) continue;
    const found = run(["git", "merge-base", ref, "HEAD"], wt);
    if (found.code === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  // git's empty tree object: diffing against it yields the whole worktree.
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

interface Entry {
  file: Omit<DiffFile, "patch">;
  binary: boolean;
  untracked: boolean;
}

/** Walk a NUL-delimited git record stream. */
function records(out: string): string[] {
  const parts = out.split("\0");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const STATUS_LETTER: Record<string, DiffFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

function trackedFiles(wt: string, against: string): Entry[] {
  const statuses = new Map<string, DiffFile["status"]>();
  const nameStatus = run(["git", "diff", "--name-status", "-M", "-z", against], wt);
  if (nameStatus.code === 0) {
    const parts = records(nameStatus.stdout);
    for (let i = 0; i < parts.length; ) {
      const code = parts[i++];
      const letter = code[0];
      if (letter === "R" || letter === "C") {
        i++; // old path; the new path is what the reviewer sees
        const to = parts[i++];
        if (to) statuses.set(to, STATUS_LETTER[letter] ?? "modified");
      } else {
        const path = parts[i++];
        if (path) statuses.set(path, STATUS_LETTER[letter] ?? "modified");
      }
    }
  }

  const numstat = run(["git", "diff", "--numstat", "-M", "-z", against], wt);
  if (numstat.code !== 0) return [];
  const out: Entry[] = [];
  const parts = records(numstat.stdout);
  for (let i = 0; i < parts.length; ) {
    const chunk = parts[i++];
    const [add, del, inline] = chunk.split("\t");
    let path = inline;
    if (path === "" || path === undefined) {
      // Rename: the trailing field is empty and old/new follow as their own records.
      i++; // old path
      path = parts[i++];
    }
    if (!path) continue;
    const binary = add === "-" && del === "-";
    out.push({
      file: {
        path,
        status: statuses.get(path) ?? "modified",
        additions: binary ? 0 : Number(add) || 0,
        deletions: binary ? 0 : Number(del) || 0,
      },
      binary,
      untracked: false,
    });
  }
  return out;
}

function untrackedFiles(wt: string): Entry[] {
  const r = run(["git", "ls-files", "--others", "--exclude-standard", "-z"], wt);
  if (r.code !== 0) return [];
  const out: Entry[] = [];
  for (const path of records(r.stdout)) {
    if (!path) continue;
    const probe = probeNew(join(wt, path));
    out.push({
      file: { path, status: "untracked", additions: probe.lines, deletions: 0 },
      binary: probe.binary,
      untracked: true,
    });
  }
  return out;
}

/**
 * Classify a file git has no index entry for. Same test git uses: a NUL byte in
 * the first 8 KB means binary.
 */
function probeNew(abs: string): { binary: boolean; lines: number } {
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    // A dangling symlink or an unreadable path. Show the row, claim nothing
    // about its contents.
    return { binary: true, lines: 0 };
  }
  if (!stat.isFile()) return { binary: true, lines: 0 };
  if (stat.size === 0) return { binary: false, lines: 0 };
  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return { binary: true, lines: 0 };
  }
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, lines: 0 };
  const text = buf.toString("utf8");
  const newlines = text.split("\n").length - 1;
  // A file with no trailing newline still has that last line in the patch.
  return { binary: false, lines: text.endsWith("\n") ? newlines : newlines + 1 };
}

function trackedPatch(wt: string, against: string, path: string): string {
  const r = run(["git", "diff", "-M", against, "--", path], wt);
  return r.code === 0 ? r.stdout : `… could not read this file's patch: ${r.stderr.trim()}\n`;
}

/**
 * A patch for a file git does not track yet. `--no-index` against /dev/null
 * renders it as an addition; it exits 1 when there is a difference, which is
 * the expected outcome, so only a code above 1 is a real failure.
 */
function untrackedPatch(wt: string, path: string): string {
  const r = run(["git", "diff", "--no-index", "--", "/dev/null", path], wt);
  if (r.code > 1) return `… could not read this file's patch: ${r.stderr.trim()}\n`;
  return r.stdout;
}
