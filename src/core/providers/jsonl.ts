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
