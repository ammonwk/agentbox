/** Transcripts as a thing that takes up disk.
 *
 * The Disk page already reclaims worktrees, which are the big obvious cost. It
 * did not know about logs at all, and logs turned out to have their own way of
 * getting large: a fan-out's progress heartbeats, appended every couple of
 * seconds with a full copy of the dispatching call's arguments, reached 800 MB
 * in one session. The host no longer writes them; this is how the ones already
 * on disk are found and rewritten.
 *
 * Same shape as every other reclaim in this app: a scan a human reads, then an
 * explicit act. Nothing is compacted for being large.
 */

import { compactLog, logSizeOf, type CompactResult } from "../core/compact";
import { listSessions } from "../core/db";
import { hasHost } from "../core/sessions";

/** Transcripts smaller than this are not offered. Compaction has to read the
 *  whole file to learn whether there is anything in it to drop, and on a small
 *  log that is work in exchange for kilobytes. */
const WORTH_IT_BYTES = 8 * 1024 * 1024;

export interface TranscriptInfo {
  sessionId: string;
  title: string;
  status: string;
  bytes: number;
  /** A live host is appending to this log, so it may not be rewritten. */
  busy: boolean;
}

export interface TranscriptScan {
  transcripts: TranscriptInfo[];
  /** Every transcript's bytes, including the ones too small to offer — the
   *  number that answers "what is this costing me". */
  totalBytes: number;
}

export function scanTranscripts(): TranscriptScan {
  const transcripts: TranscriptInfo[] = [];
  let totalBytes = 0;
  for (const s of listSessions(true)) {
    const size = logSizeOf(s.id);
    if (!size) continue;
    totalBytes += size.bytes;
    if (size.bytes < WORTH_IT_BYTES) continue;
    transcripts.push({
      sessionId: s.id,
      title: s.title,
      status: s.status,
      bytes: size.bytes,
      busy: hasHost(s.id),
    });
  }
  transcripts.sort((a, b) => b.bytes - a.bytes);
  return { transcripts, totalBytes };
}

export interface CompactReport {
  results: (CompactResult & { sessionId: string })[];
  skipped: { sessionId: string; reason: string }[];
  reclaimedBytes: number;
}

/**
 * Compact the named sessions' transcripts.
 *
 * A session with a live host is skipped rather than failed: its log has one
 * writer and this is not it, and rewriting the file underneath an append would
 * interleave a rename with a write. The answer "not this one, it is busy" is a
 * result, not an error.
 */
export function compactTranscripts(sessionIds: string[]): CompactReport {
  const report: CompactReport = { results: [], skipped: [], reclaimedBytes: 0 };
  for (const sessionId of sessionIds) {
    const size = logSizeOf(sessionId);
    if (!size) {
      report.skipped.push({ sessionId, reason: "no transcript on disk" });
      continue;
    }
    if (hasHost(sessionId)) {
      report.skipped.push({ sessionId, reason: "its agent is running and still writing this log" });
      continue;
    }
    try {
      const result = compactLog(size.path);
      report.reclaimedBytes += result.bytesBefore - result.bytesAfter;
      report.results.push({ ...result, sessionId });
    } catch (err) {
      // The original is still there — compaction commits with a rename.
      report.skipped.push({ sessionId, reason: (err as Error).message });
    }
  }
  return report;
}
