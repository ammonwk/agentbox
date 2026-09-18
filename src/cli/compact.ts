/** `agentbox compact` — give back the disk a fan-out's heartbeats took.
 *
 * Transcripts written before subagent progress stopped going to the log hold
 * one full copy of the dispatching tool call per snapshot, every couple of
 * seconds, for as long as the fan-out ran. The record inside them is fine and
 * stays; see `compact.ts` for exactly which lines go and why the roster a
 * reader folds out of the file does not change.
 *
 * Prints what it would do and does nothing, unless asked. This rewrites files
 * that are somebody's history, and the whole point of a reclaim is that a
 * person read it first.
 */

import { compactLog, logSizeOf } from "../core/compact";
import { listSessions } from "../core/db";
import type { Session } from "../core/types";

/** Below this a transcript is not worth rewriting, and compaction has to read
 *  the whole file to find out whether there is anything in it to drop. */
const WORTH_IT_BYTES = 8 * 1024 * 1024;

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A session whose host is running owns its log and is appending to it.
 *
 * A live pid is believed here, unlike everywhere else in the app, because the
 * two ways it can be wrong point in opposite directions: a reused pid means we
 * skip a file we could have compacted, which costs nothing, while a host that
 * is really alive always has a live pid. The cautious answer is the safe one.
 */
function busy(s: Session): boolean {
  if (s.hostPid === null) return false;
  try {
    process.kill(s.hostPid, 0);
    return true;
  } catch {
    return false;
  }
}

export function compact(argv: string[]): number {
  const apply = argv.includes("--apply");
  const wanted = argv.find((a) => !a.startsWith("-")) ?? null;

  const targets = listSessions(true)
    .filter((s) => (wanted ? s.id === wanted || s.id.startsWith(wanted) : true))
    .map((s) => ({ session: s, size: logSizeOf(s.id) }))
    .filter((t) => t.size !== null && (wanted !== null || t.size.bytes >= WORTH_IT_BYTES))
    .sort((a, b) => b.size!.bytes - a.size!.bytes);

  if (targets.length === 0) {
    console.log(
      wanted
        ? `no transcript on disk for a session matching "${wanted}"`
        : `no transcript is larger than ${mb(WORTH_IT_BYTES)} — nothing worth compacting`,
    );
    return 0;
  }

  const total = targets.reduce((n, t) => n + t.size!.bytes, 0);
  console.log(
    `${targets.length} transcript${targets.length === 1 ? "" : "s"}, ${mb(total)} in total:\n`,
  );

  let reclaimed = 0;
  for (const { session, size } of targets) {
    const label = `${session.id.slice(0, 8)}  ${mb(size!.bytes).padStart(9)}  ${session.title.slice(0, 48)}`;
    if (busy(session)) {
      console.log(`${label}\n          skipped — its host is running and still writing this log`);
      continue;
    }
    if (!apply) {
      console.log(label);
      continue;
    }
    try {
      const r = compactLog(size!.path);
      reclaimed += r.bytesBefore - r.bytesAfter;
      console.log(
        r.dropped === 0
          ? `${label}\n          nothing to drop`
          : `${label}\n          ${mb(r.bytesBefore)} → ${mb(r.bytesAfter)} · dropped ${r.dropped} superseded snapshots`,
      );
    } catch (err) {
      console.log(`${label}\n          FAILED — ${(err as Error).message} (the log is untouched)`);
    }
  }

  console.log(
    apply
      ? `\nreclaimed ${mb(reclaimed)}`
      : `\nnothing was changed. Re-run with --apply to compact these.`,
  );
  return 0;
}
