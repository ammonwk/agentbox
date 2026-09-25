/**
 * Split a socket byte stream into newline-delimited JSON values.
 *
 * A `data` callback is handed whatever happened to arrive, which is not
 * message-shaped: one write can surface as three callbacks, and three writes
 * as one. Anything that parses the buffer as-is works until a transcript-sized
 * payload spans a chunk boundary and then fails only under load.
 */
export class LineDecoder {
  private buf = "";

  push(chunk: Uint8Array): string[] {
    this.buf += Buffer.from(chunk).toString("utf8");
    const out = this.buf.split("\n");
    // The tail is either empty (the chunk ended on a newline) or a partial
    // line, and either way it is what the next chunk continues.
    this.buf = out.pop() ?? "";
    return out.filter((l) => l.trim() !== "");
  }
}
