/** Transcript readers' positions, kept across restarts.
 *
 * Every reader holds a fold over its whole file — tokens, rate-limit hits,
 * the offset of every record — and a new server used to rebuild all of them
 * from byte 0: a week of transcripts is gigabytes, most of a minute of CPU
 * before the board could show anything. Each reader's `saveState` goes to a
 * file of its own here, and the next server's reader takes it up and reads
 * only what was appended since.
 *
 * Nothing of the conversation is kept: offsets and the fold's counters and
 * last-seen values, which the transcript remains the record of. A saved state
 * is only as good as the code that folded it, so each is stamped with a hash
 * of the reading code — the reader modules and everything they import at
 * runtime — and a server running other code ignores it and reads from the
 * start, once.
 */

import { deserialize, serialize } from "bun:jsc";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { agentboxHome } from "./paths";
import type { ProviderId } from "./types";

/** Per provider, the modules whose code decides what its saved states mean.
 *  Each provider has a stamp of its own, so editing one reader re-reads only
 *  that provider's transcripts. */
const READER_ROOTS: Record<ProviderId, string[]> = {
  claude: ["providers/jsonl-reader.ts", "providers/claude-transcript.ts", "providers/claude-subagents.ts"],
  codex: ["providers/jsonl-reader.ts", "providers/codex-transcript.ts"],
  devin: ["providers/devin.ts"],
  omp: ["providers/omp.ts"],
};

/** Saved states of transcripts nobody has read in this long are deleted. */
const PRUNE_MS = 30 * 86_400_000;

const cacheDir = (): string => join(agentboxHome(), "cache", "readers");

const stamps = new Map<ProviderId, string>();

/** A hash over a provider's reader modules and their runtime imports,
 *  transitively. Type-only imports are skipped: they change no fold. */
export function readerCodeStamp(provider: ProviderId): string {
  const known = stamps.get(provider);
  if (known) return known;
  const seen = new Set<string>();
  const hash = new Bun.CryptoHasher("sha256");
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    hash.update(file.slice(import.meta.dir.length));
    hash.update(text);
    for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.{1,2}\/[^"]+)"/gms)) {
      const spec = m[1]!;
      visit(resolve(dirname(file), spec.endsWith(".ts") ? spec : `${spec}.ts`));
    }
  };
  for (const r of READER_ROOTS[provider]) visit(join(import.meta.dir, r));
  const stamp = hash.digest("hex").slice(0, 16);
  stamps.set(provider, stamp);
  return stamp;
}

const fileFor = (path: string): string => join(cacheDir(), `${Bun.hash(path).toString(16)}.bin`);

/** A reader's saved state for `path`, if one was saved by this code. */
export function loadReaderState(provider: ProviderId, path: string): unknown {
  let buf: Buffer;
  try {
    buf = readFileSync(fileFor(path));
  } catch {
    return null;
  }
  try {
    const s = deserialize(buf) as { code: string; path: string; state: unknown };
    return s.code === readerCodeStamp(provider) && s.path === path ? s.state : null;
  } catch {
    return null;
  }
}

export function saveReaderState(provider: ProviderId, path: string, state: unknown): void {
  const file = fileFor(path);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(tmp, new Uint8Array(serialize({ code: readerCodeStamp(provider), path, state })));
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    console.error(`agentbox: saving the reader state of ${path}:`, e);
  }
}

/** Delete saved states nothing has written in `PRUNE_MS`: transcripts long
 *  out of the board's window, or ones deleted. */
export function pruneReaderStates(now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(cacheDir());
  } catch {
    return;
  }
  for (const n of names) {
    const f = join(cacheDir(), n);
    try {
      if (now - statSync(f).mtimeMs > PRUNE_MS) rmSync(f, { force: true });
    } catch {
      /* gone already */
    }
  }
}
