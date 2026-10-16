/**
 * The server runs from a commit, not from the shared working tree.
 *
 * Several sessions edit the checkout at once, and a restart used to put all
 * of their unfinished edits live: one session restarted for its own fix and
 * the server loaded another's half-written `conversation.ts`. With this on,
 * `agentbox serve` in the checkout first moves a worktree of its own
 * (`$AGENTBOX_HOME/live`, detached) to the checkout's HEAD commit, builds
 * that commit's UI there when its `web/` changed, and then replaces itself
 * with the server from that worktree (`process.execve`: the same process, so
 * launchd and systemd still watch the server itself). A restart puts what is
 * committed live, and only that.
 *
 * It is a choice of this machine, not of the code: a file in AGENTBOX_HOME
 * (`agentbox serve-from-commit on|off`), or AGENTBOX_FROM_COMMIT=1|0 for
 * one run.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "./paths";

export const snapshotDir = (): string => join(agentboxHome(), "live");
const flagFile = (): string => join(agentboxHome(), "serve-from-commit");
/** The `web/` tree its UI build was made from, in the build itself. */
const STAMP = ".agentbox-web-tree";

export function servesFromCommit(): boolean {
  const env = process.env.AGENTBOX_FROM_COMMIT;
  if (env !== undefined && env !== "") return env !== "0";
  return existsSync(flagFile());
}

export function setServesFromCommit(on: boolean): void {
  if (on) {
    mkdirSync(agentboxHome(), { recursive: true });
    writeFileSync(flagFile(), "The server runs from the checkout's HEAD commit (src/core/snapshot.ts).\n");
  } else if (existsSync(flagFile())) unlinkSync(flagFile());
}

/** True when `root` is the snapshot itself: the server is already there. */
export function isSnapshot(root: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
  return real(root) === real(snapshotDir());
}

/** The checkout `root` stands for: itself, or for the snapshot, the checkout
 *  it was made from (the main worktree of its repository). */
export function sourceCheckout(root: string): string {
  if (!isSnapshot(root)) return root;
  return dirname(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

export type Synced = { dir: string; commit: string; built: boolean };

/**
 * Move the snapshot to `source`'s HEAD commit and build its UI when `web/`
 * changed. A failed UI build keeps the build that was there; with none there,
 * it throws. Nothing in `source` is touched.
 */
export function syncSnapshot(source: string, dir = snapshotDir(), log: (line: string) => void = () => {}): Synced {
  const commit = git(source, "rev-parse", "HEAD");
  if (!existsSync(join(dir, ".git"))) {
    if (existsSync(dir)) throw new Error(`${dir} exists and is not a worktree; move it away`);
    git(source, "worktree", "add", "--detach", dir, commit);
  } else {
    const common = (cwd: string) => realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    if (common(dir) !== common(source)) throw new Error(`${dir} is a worktree of another repository`);
    // The snapshot is agentbox's own: nobody edits it, so a change there is discarded.
    if (git(dir, "rev-parse", "HEAD") !== commit) git(dir, "checkout", "--quiet", "--detach", "--force", commit);
  }
  // Dependencies are the checkout's: a commit that adds one was installed there to be tested.
  const modules = join(dir, "node_modules");
  if (!existsSync(modules) && existsSync(join(source, "node_modules"))) symlinkSync(join(source, "node_modules"), modules);

  const tree = git(dir, "rev-parse", `${commit}:web`);
  const dist = join(dir, "web", "dist");
  const stamp = join(dist, STAMP);
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === tree) return { dir, commit, built: false };
  // Built beside the old one and swapped in, so the server never sees half a build.
  const next = join(dir, "web", "dist.next");
  rmSync(next, { recursive: true, force: true });
  log(`building the UI of ${commit.slice(0, 8)}`);
  const p = Bun.spawnSync([process.execPath, "run", "web:build", "--outDir", next, "--emptyOutDir"], {
    cwd: dir, stdout: "pipe", stderr: "pipe", env: process.env,
  });
  if (p.exitCode !== 0 || !existsSync(join(next, "index.html"))) {
    const why = p.stderr.toString().trim().split("\n").slice(-5).join("\n");
    if (existsSync(join(dist, "index.html"))) {
      log(`the UI build of ${commit.slice(0, 8)} failed; serving the previous build:\n${why}`);
      return { dir, commit, built: false };
    }
    throw new Error(`the UI build of ${commit.slice(0, 8)} failed:\n${why}`);
  }
  writeFileSync(join(next, STAMP), `${tree}\n`);
  const old = join(dir, "web", "dist.old");
  rmSync(old, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, old);
  renameSync(next, dist);
  rmSync(old, { recursive: true, force: true });
  return { dir, commit, built: true };
}

/**
 * For `agentbox serve`: the snapshot to run from, or null to run here. A
 * failed sync runs the snapshot as it was, when there is one, so a broken
 * commit or a git error leaves the board up on the last good one.
 */
export function prepareServe(source: string, log: (line: string) => void): string | null {
  if (!servesFromCommit() || isSnapshot(source)) return null;
  try {
    const s = syncSnapshot(source, snapshotDir(), log);
    log(`serving commit ${s.commit.slice(0, 8)} from ${s.dir}${s.built ? " (UI rebuilt)" : ""}`);
    return s.dir;
  } catch (e) {
    const dir = snapshotDir();
    if (existsSync(join(dir, "bin", "agentbox")) && existsSync(join(dir, "web", "dist", "index.html"))) {
      log(`could not move the snapshot to ${source}'s HEAD, so it serves the commit it has: ${(e as Error).message}`);
      return dir;
    }
    log(`could not prepare a snapshot, so it serves the working tree: ${(e as Error).message}`);
    return null;
  }
}
