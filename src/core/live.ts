/** Live status for calls that have not answered yet, published to disk.
 *
 * MCP has exactly one channel for saying "still working": a progress
 * notification against the caller's request. It is the right channel and it is
 * not enough, because the client decides how long to look at it. Claude Code
 * moves a slow tool call to the background after two minutes and stops
 * forwarding progress at that moment — which is precisely when a twenty-minute
 * fan-out becomes worth watching, and precisely when a caller has gone off to
 * do something else and *wants* it backgrounded. Progress is only shown while
 * you are not doing anything else.
 *
 * So the status is also written somewhere that outlives the client's
 * attention: one small file per in-flight call, replaced every couple of
 * seconds, removed when the call answers. Anything can read it — a status
 * line, a second terminal, a script — and nothing has to be running for it to
 * work.
 *
 * The file holds a line that is already rendered. That is a deliberate
 * inversion: the natural design publishes structured state and lets the reader
 * format it, but the reader here is a shell script re-run every few seconds by
 * a terminal, where a JSON parse is a fork and a fork is most of the frame
 * budget. Formatting is cheap on this side and expensive on that one, so it
 * happens here.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveRoot } from "./paths";

/**
 * How long a line stays believable.
 *
 * Writers refresh every couple of seconds, so anything older than this is not
 * slow — it is the residue of a process that was killed, and a reader showing
 * it is reporting a workflow that has not existed since Tuesday. Readers judge
 * this themselves off the timestamp in the file; the constant is here so they
 * agree.
 */
export const STALE_AFTER_S = 15;

export interface LiveEntry {
  /** Unix seconds when the line was written. */
  at: number;
  /** Where the work is happening, so a reader can show only its own. */
  cwd: string;
  /**
   * The client session this work belongs to.
   *
   * `cwd` was the original filter and it is not enough: two windows open on
   * the same repository share a working directory, so each was shown the
   * other's agents. That is worse than showing nothing — a roster on the wrong
   * window is indistinguishable from your own work, and being trustworthy is
   * the entire job of a status line.
   */
  owner: string;
  /** The rendered line. One line, no escapes, no markup. */
  text: string;
}

/** `<unix seconds>\t<cwd>\t<owner>\t<text>` — four fields a shell can split
 *  with `IFS=$'\t' read`, cheapest tests first. */
function encode(e: LiveEntry): string {
  return `${e.at}\t${e.cwd}\t${e.owner}\t${e.text.replace(/[\t\r\n]+/g, " ")}\n`;
}

export function decode(line: string): LiveEntry | null {
  const [at, cwd, by, ...rest] = line.trimEnd().split("\t");
  const seconds = Number(at);
  if (!Number.isFinite(seconds) || cwd === undefined) return null;
  if (by === undefined || by === "" || rest.length === 0) return null;
  return { at: seconds, cwd, owner: by, text: rest.join("\t") };
}

/**
 * The client session id from the parent process's command line, if it is
 * there.
 *
 * A stdio MCP server is a direct child of its client, and Claude Code runs as
 * `claude --session-id <uuid> …`. That id is also handed to the status line on
 * stdin, so publishing it gives the reader an exact string to compare against
 * — no pid arithmetic, no walking an ancestor chain in a script that has to
 * finish inside a frame budget.
 */
function clientSessionId(): string | null {
  try {
    const argv = readFileSync(`/proc/${process.ppid}/cmdline`, "utf8").split("\0");
    const at = argv.indexOf("--session-id");
    const id = at === -1 ? undefined : argv[at + 1];
    return id !== undefined && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch {
    // Not Linux, no /proc, or a client that does not say. The pid below is a
    // worse key but still a key: what must not happen is two windows sharing
    // one, and they never share a parent.
    return null;
  }
}

let ownerCache: string | null = null;

/** Who owns the work this process is doing. Stable for the process's life —
 *  our parent cannot change without us being orphaned. */
export function owner(): string {
  if (ownerCache === null) ownerCache = clientSessionId() ?? `pid:${process.ppid}`;
  return ownerCache;
}

function fileFor(id: string): string {
  // The id reaches here from a tool call, so it is not trusted to be a
  // filename. Anything that could climb out of the directory is flattened
  // rather than rejected: a status line is not worth failing a workflow over.
  return join(liveRoot(), `${id.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64)}.live`);
}

/**
 * Publish one call's current line.
 *
 * Written to a sibling and renamed, because a reader polling on its own clock
 * will otherwise eventually read a file mid-write and show half a line. Rename
 * is atomic within a directory, so a reader sees either the previous line or
 * the new one and never a splice of the two.
 */
export function publish(id: string, cwd: string, text: string): void {
  const path = fileFor(id);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(liveRoot(), { recursive: true });
    writeFileSync(tmp, encode({ at: Math.floor(Date.now() / 1000), cwd, owner: owner(), text }));
    renameSync(tmp, path);
  } catch {
    // Status is a courtesy. It must never be the reason a tool call fails, and
    // there is nobody to tell: this process's stdout is a JSON-RPC stream.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing left to try.
    }
  }
}

/** Retract a call's line. Called when it answers, however it answers. */
export function retract(id: string): void {
  try {
    rmSync(fileFor(id), { force: true });
  } catch {
    // See publish.
  }
}

/**
 * Read every line worth showing, newest first.
 *
 * `cwd` filters to one working directory and `owners` to named client sessions.
 * Both, because neither is sufficient alone: two sessions in two repositories
 * share one status line script, and two sessions in the *same* repository
 * share a working directory as well. A roster belonging to another window is
 * not just noise — it is indistinguishable from your own work.
 */
export function read(cwd?: string, owners?: string[]): LiveEntry[] {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_S;
  let names: string[];
  try {
    names = readdirSync(liveRoot());
  } catch {
    return [];
  }
  const out: LiveEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".live")) continue;
    try {
      const entry = decode(readFileSync(join(liveRoot(), name), "utf8"));
      if (!entry || entry.at < cutoff) continue;
      if (cwd !== undefined && entry.cwd !== cwd) continue;
      if (owners !== undefined && !owners.includes(entry.owner)) continue;
      out.push(entry);
    } catch {
      // A file removed between the listing and the read is the normal race,
      // not an error: it means that call just answered.
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * Delete lines nothing will ever refresh.
 *
 * A killed server leaves its files behind — there is no exit handler for
 * SIGKILL — and while readers already ignore them by age, they otherwise
 * accumulate one per workflow forever. Called at startup, which is exactly
 * when the previous process is known to be gone.
 */
export function prune(): number {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_S;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(liveRoot());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".live") && !name.endsWith(".tmp")) continue;
    const path = join(liveRoot(), name);
    try {
      const entry = name.endsWith(".tmp") ? null : decode(readFileSync(path, "utf8"));
      if (entry && entry.at >= cutoff) continue;
      rmSync(path, { force: true });
      removed++;
    } catch {
      // See read.
    }
  }
  return removed;
}
