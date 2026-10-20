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
import { transcriptFile, type TranscriptRef } from "./providers/types";
import { openReader } from "./readercache";
import type { GrepHit, TimelineEvent, TimelinePage } from "./types";

export interface GrepJob {
  pattern: string;
  flags: string;
  sessions: { id: string; ref: TranscriptRef }[];
}

export const MAX_HITS = 5000;
const PAGE = 1000;
/** A search is user-facing, not a batch job: four readers at once cuts a
 *  board-wide scan enough without taking the machine the agents run on. */
const MAX_WORKERS = 4;

/** The text one event contributes. Tool output is what a session's answer
 *  usually lives in — an error, a test summary, a log line — so search it
 *  too, as far as the timeline keeps it (`OUTPUT_CAP`). */
function eventText(ev: TimelineEvent): string {
  if (ev.kind === "tool") return [ev.name, ev.title, ev.summary, ev.output].filter(Boolean).join("\n");
  return ev.text;
}

/** Split sessions into contiguous slices, one per worker, keeping the board's
 *  order so merged hits read the same as a one-worker scan. */
function slices<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.ceil((items.length - at) / (n - i));
    out.push(items.slice(at, at + size));
    at += size;
  }
  return out;
}

/** How many files the readers parse once ripgrep has narrowed the board. */
const NARROWED_FILES = 64;

/** Let ripgrep find the transcript files that can match before the readers
 *  parse them. `-l` stops at the first match in each file, so this is a byte
 *  scan over the board instead of a timeline fold of every session. Null when
 *  the prefilter cannot be trusted — no `rg`, or a pattern Rust's regex reads
 *  differently (lookaround, backreferences, a quote JSONL escapes) — and the
 *  readers scan everything. */
async function narrow(job: GrepJob, signal: AbortSignal): Promise<GrepJob["sessions"] | null> {
  const rg = Bun.which("rg");
  if (!rg || /\(\?|\\[1-9]|\\k<|"/.test(job.pattern)) return null;
  const paths = [...new Set(job.sessions.map(({ ref }) => transcriptFile(ref.path)))];
  if (paths.length === 0 || paths.length > 2000) return null;
  const threads = Math.min(8, globalThis.navigator?.hardwareConcurrency ?? 8);
  const proc = Bun.spawn(
    [rg, "--files-with-matches", "--null", "--no-ignore", "--text", "--threads", String(threads), ...(job.flags.includes("i") ? ["-i"] : []), "-e", job.pattern, ...paths],
    { stdout: "pipe", stderr: "ignore" },
  );
  const abort = () => proc.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const out = await new Response(proc.stdout).arrayBuffer();
    const code = await proc.exited;
    if (signal.aborted) throw new Error("grep: the client went away");
    if (code !== 0 && code !== 1) return null; // ripgrep failed: scan everything
    const found = new Set(new TextDecoder().decode(out).split("\0").filter(Boolean));
    return job.sessions.filter(({ ref }) => found.has(transcriptFile(ref.path))).slice(0, NARROWED_FILES);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

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
          for (const line of eventText(ev).split("\n")) {
            if (re.test(line)) hits.push({ sessionId: id, at: ev.at, kind: ev.kind, line: line.trim().slice(0, 300) });
            if (hits.length >= MAX_HITS) break;
          }
          if (hits.length >= MAX_HITS) break;
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

/** One worker over one slice, ended when `signal` aborts (the client went
 *  away) so an abandoned search stops reading. */
function grepInOneWorker(job: GrepJob, signal: AbortSignal): Promise<GrepHit[]> {
  const { promise, resolve, reject } = Promise.withResolvers<GrepHit[]>();
  if (signal.aborted) {
    reject(new Error("grep: the client went away"));
    return promise;
  }
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
  return promise;
}

/** `grepTimelines` across a few workers at once. Each reads its own slices of
 *  the board's sessions; `Promise.all` keeps the slices in board order. */
export async function grepInWorker(job: GrepJob, signal: AbortSignal): Promise<GrepHit[]> {
  if (signal.aborted) throw new Error("grep: the client went away");
  if (job.sessions.length === 0) return [];
  const narrowed = await narrow(job, signal);
  if (narrowed !== null && narrowed.length === 0) return [];
  const sessions = narrowed ?? job.sessions;
  const cpus = globalThis.navigator?.hardwareConcurrency ?? MAX_WORKERS;
  const n = Math.max(1, Math.min(MAX_WORKERS, cpus, sessions.length));
  const all = await Promise.all(slices(sessions, n).map((part) => grepInOneWorker({ ...job, sessions: part }, signal)));
  return all.flat().slice(0, MAX_HITS);
}
