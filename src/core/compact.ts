/** Reclaiming a transcript that a fan-out made enormous.
 *
 * A session's log is append-only and is meant to stay that way: it is the
 * record, and rewriting history is not a thing this app does lightly. There is
 * exactly one kind of line it rewrites, and only because that line was never
 * history in the first place.
 *
 * While a fan-out runs, omp streams a progress snapshot every couple of
 * seconds per dispatched batch. Those used to be appended to the transcript as
 * a full copy of the parent tool call — snapshot, arguments, every subagent's
 * assignment — once per heartbeat. One fifty-way run wrote 14,076 such lines
 * totalling 802 MB, in a log whose other 1,372 lines came to 3 MB. Opening
 * that session read all 805 MB back and parsed every line of it.
 *
 * The host no longer writes them (see `host.ts`; progress goes to the roster,
 * which is state, and transitions go to the log, which is history). This is
 * for the ones already on disk. It keeps the newest snapshot of each call —
 * so the roster a legacy transcript can still be folded out of is unchanged —
 * and drops the superseded ones.
 *
 * Everything here streams. The file that most needs compacting is the one that
 * must not be read into memory to do it.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { logPathFor } from "./paths";
import type { SubagentProgress, TranscriptEvent } from "./types";

/** Bytes read or written at a time. Large enough that a gigabyte is a few
 *  hundred reads, small enough to stay off the heap. */
const CHUNK = 8 * 1024 * 1024;

export interface CompactResult {
  path: string;
  bytesBefore: number;
  bytesAfter: number;
  /** Lines removed. Zero means the file was left untouched. */
  dropped: number;
  kept: number;
}

/**
 * A line that is a candidate for dropping, and what it says.
 *
 * Deliberately narrow. A tool event is only a candidate when it carries a
 * subagent snapshot AND has not finished — a call's terminal event is its
 * result and is never touched. Anything this cannot parse is kept: an
 * unreadable line is not evidence that it is disposable.
 */
function candidateOf(line: string): { callId: string; subs: SubagentProgress[] } | null {
  // Cheap reject first: this runs on every line of a gigabyte file, and most
  // logs have no snapshots in them at all.
  if (!line.includes('"subs"')) return null;
  let event: TranscriptEvent | undefined;
  try {
    event = (JSON.parse(line) as { event?: TranscriptEvent }).event;
  } catch {
    return null;
  }
  if (!event || event.type !== "tool") return null;
  const call = event.call;
  if (!call.subs || call.subs.length === 0) return null;
  if (call.status !== "pending" && call.status !== "running") return null;
  return { callId: call.id, subs: call.subs };
}

/**
 * Rewrite one session's log without its superseded heartbeats.
 *
 * The caller must know that nothing is appending to the file. A host owns its
 * session's log for as long as it lives, and compacting underneath it would
 * interleave a rename with an append — see the callers, which check.
 */
export function compactLog(path: string): CompactResult {
  const before = existsSync(path) ? statSync(path).size : 0;
  const result: CompactResult = {
    path,
    bytesBefore: before,
    bytesAfter: before,
    dropped: 0,
    kept: 0,
  };
  if (before === 0) return result;

  // Pass one: which heartbeat lines are worth keeping.
  //
  // Two kinds are. The last one for a call, because a legacy transcript's
  // roster is folded out of the newest snapshot it can find — dropping that
  // would change what a reader sees. And any line where a subagent's status
  // first changes, because that is when it started or finished, and a
  // timestamp is the whole value of knowing. Keeping only the last would
  // record a fan-out's completions as having all happened at once, hours late.
  //
  // Both are held as line numbers so pass two decides nothing for itself and
  // cannot reach a different answer.
  const lastHeartbeat = new Map<string, number>();
  const transitions = new Set<number>();
  const statusOf = new Map<string, string>();
  let line = 0;
  let candidates = 0;
  forEachLine(path, (text) => {
    const candidate = candidateOf(text);
    if (candidate !== null) {
      lastHeartbeat.set(candidate.callId, line);
      candidates++;
      for (const sub of candidate.subs) {
        if (!sub?.id) continue;
        if (statusOf.get(sub.id) !== sub.status) {
          statusOf.set(sub.id, sub.status);
          transitions.add(line);
        }
      }
    }
    line++;
  });
  const keeping = new Set([...lastHeartbeat.values(), ...transitions]);
  if (candidates === 0 || candidates === keeping.size) return result;

  // Pass two: copy everything except the superseded ones.
  const tmp = `${path}.compacting`;
  let out: number | null = null;
  let written = 0;
  try {
    out = openSync(tmp, "w");
    let n = 0;
    let buf = "";
    forEachLine(path, (text) => {
      const drop = !keeping.has(n) && candidateOf(text) !== null;
      n++;
      if (drop) {
        result.dropped++;
        return;
      }
      result.kept++;
      buf += `${text}\n`;
      if (buf.length >= CHUNK) {
        written += writeAll(out!, buf);
        buf = "";
      }
    });
    if (buf.length > 0) written += writeAll(out, buf);
  } catch (err) {
    if (out !== null) closeSync(out);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(out);

  // The rename is the commit point, and it is atomic within a directory — a
  // crash mid-compaction leaves the original log intact and a stray temp file.
  renameSync(tmp, path);
  result.bytesAfter = written;
  return result;
}

/** Read `path` a chunk at a time, handing over one complete line at a time.
 *  A trailing fragment with no newline is passed on at the end, because the
 *  last line of a log written by a process that is still running has one. */
function forEachLine(path: string, onLine: (line: string) => void): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = "";
    let pos = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, CHUNK, pos);
      if (read <= 0) break;
      pos += read;
      const text = carry + buf.subarray(0, read).toString("utf8");
      let start = 0;
      for (;;) {
        const nl = text.indexOf("\n", start);
        if (nl === -1) break;
        onLine(text.slice(start, nl));
        start = nl + 1;
      }
      carry = text.slice(start);
    }
    if (carry.length > 0) onLine(carry);
  } finally {
    closeSync(fd);
  }
}

/** `writeSync` may write less than it was given. Returns bytes written. */
function writeAll(fd: number, text: string): number {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  return buf.length;
}

export interface LogSize {
  sessionId: string;
  path: string;
  bytes: number;
}

/** One session's log and its size, for callers deciding what to compact. */
export function logSizeOf(sessionId: string): LogSize | null {
  const path = logPathFor(sessionId);
  try {
    return { sessionId, path, bytes: statSync(path).size };
  } catch {
    return null;
  }
}
