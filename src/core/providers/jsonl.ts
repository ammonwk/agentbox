/** Incremental reading of append-only JSONL transcripts.
 *
 * Claude, codex and omp all write one JSON object per line and only ever
 * append. A `JsonlTail` remembers how far it has read, so each poll parses only
 * the new lines, and it remembers where every record starts, so a timeline page
 * from the middle of a 50 MB file is a seek rather than a re-read.
 *
 * Offsets are byte offsets and splitting happens on bytes, not on decoded
 * strings: a multi-byte character straddling a read boundary would otherwise
 * shift every later offset.
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";

const CHUNK = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface JsonlRecord {
  /** Byte offset of the line — stable for the life of the file. */
  offset: number;
  /** Index of the record in the file, counting only lines that parsed. */
  index: number;
  value: any;
}

/** A tail's position, saved so a restart resumes rather than re-reads. */
export interface JsonlTailState {
  offset: number;
  ino: number;
  /** Byte length of each parsed record's span to the next record's start
   *  (the last one's to `offset`): the offset index, a quarter the size. */
  spans: Uint32Array;
  /** Hash of the bytes just before `offset`, to tell a file rewritten in
   *  place (same inode, at least as long) from the one that was read. */
  check: number;
}

/** How far back from `offset` a saved state's check reaches. */
const CHECK_BYTES = 4096;

export class JsonlTail {
  /** Next unread byte. Always at the start of a line. */
  private offset = 0;
  private ino = -1;
  /** Start offset of every parsed record, in order. */
  private starts: number[] = [];

  constructor(readonly path: string) {}

  get recordCount(): number {
    return this.starts.length;
  }

  /**
   * Read every complete line appended since the last call. A trailing partial
   * line (a write in progress) is left for next time. If the file was
   * truncated or replaced, everything is re-read and `reset` is true.
   *
   * With `visit`, each record is handed over as it is parsed and none are
   * collected: the first read of a 200 MB rollout would otherwise hold every
   * parsed record in memory at once. A reset is visible to a visitor as a
   * record whose index is lower than the last one it saw.
   */
  read(visit?: (rec: JsonlRecord) => void): { records: JsonlRecord[]; reset: boolean } {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      return { records: [], reset: false };
    }
    let reset = false;
    if (st.ino !== this.ino || st.size < this.offset) {
      reset = this.ino !== -1;
      this.ino = st.ino;
      this.offset = 0;
      this.starts = [];
    }
    if (st.size === this.offset) return { records: [], reset };

    const records: JsonlRecord[] = [];
    const fd = openSync(this.path, "r");
    try {
      let pos = this.offset;
      let carry: Buffer | null = null;
      let carryStart = pos;
      while (pos < st.size) {
        const len = Math.min(CHUNK, st.size - pos);
        const buf = Buffer.allocUnsafe(len);
        const n = readSync(fd, buf, 0, len, pos);
        if (n <= 0) break;
        const data: Buffer = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const base = carry ? carryStart : pos;
        let lineStart = 0;
        for (let i = 0; i < data.length; i++) {
          if (data[i] !== NEWLINE) continue;
          this.parseLine(data, lineStart, i, base + lineStart, records, visit);
          lineStart = i + 1;
        }
        carry = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : null;
        carryStart = base + lineStart;
        pos += n;
        this.offset = base + lineStart;
      }
    } finally {
      closeSync(fd);
    }
    return { records, reset };
  }

  private parseLine(
    data: Buffer,
    from: number,
    to: number,
    fileOffset: number,
    out: JsonlRecord[],
    visit?: (rec: JsonlRecord) => void,
  ): void {
    if (to <= from) return;
    // Skip lines that cannot be an object without paying for a decode.
    let first = from;
    while (first < to && (data[first] === 0x20 || data[first] === 0x09 || data[first] === 0x0d)) first++;
    if (data[first] !== 0x7b /* { */) return;
    let value: unknown;
    try {
      value = JSON.parse(data.toString("utf8", from, to));
    } catch {
      return;
    }
    const rec = { offset: fileOffset, index: this.starts.length, value };
    this.starts.push(fileOffset);
    if (visit) visit(rec);
    else out.push(rec);
  }

  /** Where this tail is, for `restore` in a later process. */
  state(): JsonlTailState {
    const spans = new Uint32Array(this.starts.length);
    for (let i = 0; i < this.starts.length; i++) spans[i] = (i + 1 < this.starts.length ? this.starts[i + 1]! : this.offset) - this.starts[i]!;
    return { offset: this.offset, ino: this.ino, spans, check: this.checkAt(this.offset) };
  }

  /**
   * Take up a saved position, if it still describes this file: same inode,
   * no shorter, and the same bytes before the offset. False leaves the tail
   * as it was, to read from the start.
   */
  restore(s: JsonlTailState): boolean {
    if (this.ino !== -1 || this.offset !== 0 || s.check < 0) return false;
    try {
      const st = statSync(this.path);
      if (st.ino !== s.ino || st.size < s.offset) return false;
    } catch {
      return false;
    }
    if (this.checkAt(s.offset) !== s.check) return false;
    const starts = new Array<number>(s.spans.length);
    let at = s.offset;
    for (let i = s.spans.length - 1; i >= 0; i--) starts[i] = at -= s.spans[i]!;
    if (at < 0) return false;
    this.starts = starts;
    this.offset = s.offset;
    this.ino = s.ino;
    return true;
  }

  private checkAt(offset: number): number {
    const len = Math.min(CHECK_BYTES, offset);
    if (len === 0) return 0;
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return -1;
    }
    try {
      const buf = Buffer.allocUnsafe(len);
      const n = readSync(fd, buf, 0, len, offset - len);
      return n === len ? Bun.hash.crc32(buf) : -1;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Records `[fromIndex, toIndex)` by index, re-read from disk. Only indices
   * already seen by `read()` are addressable.
   */
  range(fromIndex: number, toIndex: number): JsonlRecord[] {
    const from = Math.max(0, fromIndex);
    const to = Math.min(this.starts.length, toIndex);
    if (to <= from) return [];
    const startByte = this.starts[from]!;
    const endByte = to < this.starts.length ? this.starts[to]! : this.offset;
    const out: JsonlRecord[] = [];
    const fd = openSync(this.path, "r");
    try {
      const buf = Buffer.allocUnsafe(endByte - startByte);
      const n = readSync(fd, buf, 0, buf.length, startByte);
      let idx = from;
      let lineStart = 0;
      const data = buf.subarray(0, n);
      for (let i = 0; i <= data.length; i++) {
        if (i < data.length && data[i] !== NEWLINE) continue;
        if (i > lineStart && idx < to && this.starts[idx] === startByte + lineStart) {
          try {
            out.push({ offset: startByte + lineStart, index: idx, value: JSON.parse(data.toString("utf8", lineStart, i)) });
          } catch {
            // Parsed once already; a failure now means the file changed under us.
          }
          idx++;
        }
        lineStart = i + 1;
      }
    } finally {
      closeSync(fd);
    }
    return out;
  }
}
