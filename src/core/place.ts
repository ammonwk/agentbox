/** Where an agent is working, said out loud.
 *
 * An omp subagent runs in a directory it did not choose and its caller did not
 * necessarily look at. `cwd` defaults to the MCP server's own working
 * directory — whatever the client was started in, fixed for the life of the
 * process — so a caller that has since moved into a worktree has no way to
 * notice the difference. The failure is silent and expensive: the agent runs,
 * edits real files, reports success, and the edits are in another repository.
 *
 * Nothing in this file prevents that by itself. What it does is make the place
 * *sayable* — one short line, in every spot the caller already reads: the tool
 * descriptions, the report, the agent's own system prompt, the status line.
 * The bug is invisible precisely because the answer never mentions where it
 * happened.
 *
 * The one thing here that does refuse is `foreignRepoPaths`, which asks a
 * narrower question than "is this path outside the directory": it asks whether
 * the prompt names files belonging to a *different git work tree*. That is the
 * mistake worth blocking, and it is cheap to be sure about — a brief that says
 * `/tmp/out.json` is fine, and one that says `/home/me/other-repo/src/x.ts`
 * while the agent runs in `this-repo` is not.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";
import { currentBranch, run } from "./git";

export interface Place {
  /** Absolute path the agent runs in. */
  path: string;
  /** The git work tree containing it, or null when it is not in one. */
  toplevel: string | null;
  /** Branch name; null on a detached HEAD or outside a repository. */
  branch: string | null;
  /** Tracked-file modifications. Null when not asked for, or not a repo. */
  dirty: boolean | null;
}

/**
 * Work-tree lookups, memoized.
 *
 * `git rev-parse` is a process spawn, and the scanners below ask about every
 * path a prompt mentions — a brief that lists forty files would otherwise pay
 * forty forks to learn the same answer about one directory.
 */
const toplevels = new Map<string, string | null>();

export function toplevelOf(path: string): string | null {
  const hit = toplevels.get(path);
  if (hit !== undefined) return hit;
  const r = run(["git", "rev-parse", "--show-toplevel"], path);
  const top = r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  toplevels.set(path, top);
  return top;
}

/**
 * Describe a directory.
 *
 * `dirty` is opt-in because it is the expensive half — a `git status` over a
 * large tree, against a `rev-parse` that is nearly free. It is worth paying
 * once, in the agent's system prompt, where "you are in a tree with
 * uncommitted changes" is the sentence that makes an agent careful.
 */
export function describePlace(path: string, opts: { dirty?: boolean } = {}): Place {
  const toplevel = toplevelOf(path);
  if (toplevel === null) return { path, toplevel: null, branch: null, dirty: null };
  const branch = currentBranch(path) || null;
  let dirty: boolean | null = null;
  if (opts.dirty) {
    const r = run(["git", "status", "--porcelain", "--untracked-files=no"], path);
    dirty = r.code === 0 ? r.stdout.trim().length > 0 : null;
  }
  return { path, toplevel, branch, dirty };
}

/** The long form. Leads with the absolute path, because the path is the thing
 *  a caller compares against what it believed. */
export function renderPlace(p: Place): string {
  if (p.toplevel === null) return `${p.path} (not a git repository)`;
  const branch = p.branch ?? "detached HEAD";
  return `${p.path} @ ${branch}${p.dirty === true ? " (uncommitted changes)" : ""}`;
}

/** The short form, for a status line where every agent shares one row. */
export function shortPlace(p: Place): string {
  const name = basename(p.toplevel ?? p.path) || p.path;
  return p.branch ? `${name}@${p.branch}` : name;
}

/**
 * Resolve a caller-supplied path and require it to live under one of `roots`.
 *
 * Uses realpath so that a symlink pointing out of an allowed root is caught —
 * checking the textual path alone would let a link masquerade as living
 * inside. Compares with a trailing separator so `/a/bcd` cannot pass as living
 * under `/a/bc`.
 */
export function containedIn(candidate: string, roots: string[]): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  if (candidate.includes("\0")) return null;

  let real: string;
  try {
    real = realpathSync(resolve(candidate));
  } catch {
    // Does not exist yet. Fall back to the lexical resolution so that writing a
    // new file inside an allowed root still works, while traversal is still
    // blocked by the prefix test below.
    real = resolve(candidate);
  }

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) return real;
  }
  return null;
}

/**
 * Absolute-looking paths in a blob of text.
 *
 * Deliberately loose. Everything it hands back is checked against the
 * filesystem by the callers, and that check is what does the real filtering —
 * a URL's `//host/path` matches this pattern and then fails to exist, which
 * costs one `stat` and saves the pattern from having to be clever.
 */
const ABSOLUTE_PATH = /(?:\/[A-Za-z0-9._@+-]+)+/g;

/** Bound on how many candidates are checked, so a pathological prompt cannot
 *  turn one spawn into thousands of stats. */
const MAX_CANDIDATES = 200;

function candidates(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(ABSOLUTE_PATH)) {
    const path = m[0];
    // A single segment is `/tmp`, `/home`, `/usr` — never a file someone means
    // for an agent to edit, and the source of most of the noise.
    if (path.indexOf("/", 1) === -1) continue;
    seen.add(path);
    if (seen.size >= MAX_CANDIDATES) break;
  }
  return [...seen];
}

const SCRATCH_ROOTS = [tmpdir(), "/tmp", "/var/tmp", "/dev", "/proc", "/sys", "/run"];

/**
 * Scratch space — but only relative to somewhere that isn't itself scratch.
 *
 * An agent working in a real checkout that writes to `/tmp/out.json` has done
 * nothing worth a warning. An agent whose working directory *is* under `/tmp`
 * has no notion of "scratch elsewhere" at all, and applying the exclusion
 * there would blind the check in exactly the case a throwaway checkout is
 * being worked on. So the question is relative, and the answer is no whenever
 * the agent is already living in the temp directory.
 */
function isScratch(path: string, cwd: string): boolean {
  if (SCRATCH_ROOTS.some((root) => containedIn(cwd, [root]) !== null)) return false;
  return SCRATCH_ROOTS.some((root) => containedIn(path, [root]) !== null);
}

export interface ForeignPath {
  path: string;
  /** The work tree it belongs to — the thing worth naming in the refusal. */
  toplevel: string;
}

/**
 * Paths in `text` that exist, sit outside `cwd`, and belong to a different git
 * work tree.
 *
 * This is the pre-flight check on a spawn. The narrow rule is the point: it
 * fires on exactly the mistake that has actually happened — a brief written
 * about one checkout, handed to an agent running in another — and stays quiet
 * about scratch files, system binaries and paths that merely resemble paths.
 * Belonging to a work tree does that filtering on its own: `/tmp/out.json` and
 * `/usr/bin/python3` are in no repository, so neither can trip it.
 */
export function foreignRepoPaths(text: string, cwd: string): ForeignPath[] {
  const here = toplevelOf(cwd);
  const out: ForeignPath[] = [];
  const seenTops = new Set<string>();
  for (const path of candidates(text)) {
    if (!existsSync(path)) continue;
    if (containedIn(path, [cwd]) !== null) continue;
    let dir: string;
    try {
      dir = statSync(path).isDirectory() ? path : dirname(path);
    } catch {
      continue;
    }
    const top = toplevelOf(dir);
    if (top === null || top === here) continue;
    // One example per foreign work tree. A brief listing thirty files from the
    // same wrong checkout is one mistake, and thirty lines of it in an error
    // message buries the sentence that says what to do about it.
    if (seenTops.has(top)) continue;
    seenTops.add(top);
    out.push({ path, toplevel: top });
  }
  return out;
}

/**
 * Paths in `text` that exist and sit outside `cwd`, scratch space aside.
 *
 * Broader than `foreignRepoPaths`, and used for the opposite purpose: this
 * runs over a finished turn's tool inputs, where the question is not "should
 * this be allowed" but "did anything land somewhere the caller would not
 * expect". A warning can afford to be less sure than a refusal, and an agent
 * that wrote to a home-directory dotfile is worth a line either way.
 */
export function outsidePaths(text: string, cwd: string): string[] {
  const out: string[] = [];
  for (const path of candidates(text)) {
    if (!existsSync(path)) continue;
    if (containedIn(path, [cwd]) !== null) continue;
    if (isScratch(path, cwd)) continue;
    out.push(path);
  }
  return out;
}
