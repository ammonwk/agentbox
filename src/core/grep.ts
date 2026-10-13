/** `agentbox grep`: a regular expression over sessions' timelines.
 *
 * It reads every transcript it is given in full, with readers of its own, so
 * it runs in a worker thread (`grepInWorker`): every reader parses on the
 * thread that calls it, and on the server's thread a search over the whole
 * board answered nothing else, the board included, for minutes on a loaded
 * machine. Readers of its own, taken up from their saved states, also leave
 * the fleet's alone, which exist only while a transcript can move.
 */

import { adapterFor } from "./providers";
import type { TranscriptRef } from "./providers/types";
import { openReader } from "./readercache";
import type { GrepHit, TimelinePage } from "./types";

export interface GrepJob {
  pattern: string;
  flags: string;
  sessions: { id: string; ref: TranscriptRef }[];
}

const MAX_HITS = 5000;
const PAGE = 1000;

export async function grepTimelines(job: GrepJob): Promise<GrepHit[]> {
  const re = new RegExp(job.pattern, job.flags);
  const hits: GrepHit[] = [];
  for (const { id, ref } of job.sessions) {
    let before: string | null = null;
    try {
      const { reader } = openReader(adapterFor(ref.provider), ref);
      do {
        const page: TimelinePage = await reader.timeline({ before, limit: PAGE });
        for (const ev of page.events) {
          const text = ev.kind === "tool" ? `${ev.name}: ${ev.summary}` : ev.text;
          for (const line of text.split("\n")) if (re.test(line)) hits.push({ sessionId: id, at: ev.at, kind: ev.kind, line: line.trim().slice(0, 300) });
        }
        before = page.before;
      } while (before && hits.length < MAX_HITS);
    } catch {
      // an unreadable transcript is skipped, not fatal
    }
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/** `grepTimelines` in a worker of its own, ended when `signal` aborts (the
 *  client went away) so an abandoned search stops reading. */
export function grepInWorker(job: GrepJob, signal: AbortSignal): Promise<GrepHit[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("grep: the client went away"));
    const worker = new Worker(new URL("./grep-worker.ts", import.meta.url));
    const end = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      end();
      reject(new Error("grep: the client went away"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (e: MessageEvent<GrepHit[]>) => {
      end();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      end();
      reject(new Error(`grep failed: ${e.message}`));
    };
    worker.postMessage(job);
  });
}
