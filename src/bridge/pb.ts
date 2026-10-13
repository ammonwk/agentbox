/** Protobuf wire format, without schemas: a message is a list of numbered
 * fields, each a varint, a fixed 4 or 8 bytes, or a length-delimited run of
 * bytes (a string, or a nested message to decode again). Enough to read the
 * few fields the bridge needs and to rebuild a message around the ones it
 * changes, leaving every field it does not know as it was. */

export type Field =
  | { no: number; wire: 0; value: bigint }
  | { no: number; wire: 1 | 5 | 2; value: Uint8Array };

const utf8 = new TextEncoder();
const text = new TextDecoder();

export function decode(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  const varint = (): bigint => {
    let r = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error("protobuf: truncated varint");
      const c = buf[i++]!;
      r |= BigInt(c & 0x7f) << shift;
      if (!(c & 0x80)) return r;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    if (no === 0) throw new Error("protobuf: field 0");
    if (wire === 0) out.push({ no, wire, value: varint() });
    else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (i + n > buf.length) throw new Error("protobuf: truncated fixed");
      out.push({ no, wire, value: buf.subarray(i, i + n) });
      i += n;
    } else if (wire === 2) {
      const n = Number(varint());
      if (i + n > buf.length) throw new Error("protobuf: truncated bytes");
      out.push({ no, wire, value: buf.subarray(i, i + n) });
      i += n;
    } else throw new Error(`protobuf: wire type ${wire}`);
  }
  return out;
}

function pushVarint(out: number[], v: bigint): void {
  let x = BigInt.asUintN(64, v);
  while (x >= 0x80n) {
    out.push(Number(x & 0x7fn) | 0x80);
    x >>= 7n;
  }
  out.push(Number(x));
}

export function encode(fields: Field[]): Uint8Array {
  const head: number[] = [];
  const parts: Uint8Array[] = [];
  let size = 0;
  const flush = () => {
    if (!head.length) return;
    parts.push(Uint8Array.from(head));
    size += head.length;
    head.length = 0;
  };
  for (const f of fields) {
    pushVarint(head, BigInt((f.no << 3) | f.wire));
    if (f.wire === 0) pushVarint(head, f.value);
    else {
      if (f.wire === 2) pushVarint(head, BigInt(f.value.length));
      flush();
      parts.push(f.value);
      size += f.value.length;
    }
  }
  flush();
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const int = (no: number, v: number | bigint): Field => ({ no, wire: 0, value: BigInt(v) });
export const str = (no: number, s: string): Field => ({ no, wire: 2, value: utf8.encode(s) });
export const msg = (no: number, fields: Field[]): Field => ({ no, wire: 2, value: encode(fields) });
export function f64(no: number, v: number): Field {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v, true);
  return { no, wire: 1, value: b };
}
export function f32(no: number, v: number): Field {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return { no, wire: 5, value: b };
}

/** The first field numbered `no` as a string, or null. */
export function strOf(fields: Field[], no: number): string | null {
  const f = fields.find((x) => x.no === no && x.wire === 2);
  return f ? text.decode(f.value as Uint8Array) : null;
}
export function intOf(fields: Field[], no: number): number | null {
  const f = fields.find((x) => x.no === no && x.wire === 0);
  return f ? Number(f.value) : null;
}
export function f64Of(fields: Field[], no: number): number | null {
  const f = fields.find((x) => x.no === no && x.wire === 1);
  if (!f) return null;
  const v = f.value as Uint8Array;
  return new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true);
}
/** Every field numbered `no`, decoded as a nested message. */
export function msgsOf(fields: Field[], no: number): Field[][] {
  return fields.filter((x) => x.no === no && x.wire === 2).map((x) => decode(x.value as Uint8Array));
}
export const msgOf = (fields: Field[], no: number): Field[] | null => msgsOf(fields, no)[0] ?? null;

/** `fields` with every field numbered `no` replaced by `put` (at the first
 *  one's place, or the end), or dropped when `put` is empty. */
export function replace(fields: Field[], no: number, ...put: Field[]): Field[] {
  const at = fields.findIndex((x) => x.no === no);
  const rest = fields.filter((x) => x.no !== no);
  if (at < 0) return [...rest, ...put];
  const before = fields.slice(0, at).filter((x) => x.no !== no).length;
  return [...rest.slice(0, before), ...put, ...rest.slice(before)];
}
