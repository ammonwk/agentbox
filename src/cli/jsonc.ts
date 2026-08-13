/** Just enough JSONC to edit one member of one object without touching the rest.
 *
 * `agentbox install` edits the user's opencode config. Corrupting that file is
 * the worst thing this program can do, so the two hard requirements are:
 * comments and formatting survive the edit byte-for-byte outside the span we
 * change, and anything we do not fully understand is refused rather than
 * guessed at.
 *
 * That rules out `JSON.parse` + `JSON.stringify` (drops every comment) and
 * string-splicing on `'"mcp": {'` (the previous implementation, which broke on
 * different indentation and cut to whatever `\n    },` came first). What is
 * left is a scanner that finds the exact character span of a member.
 */

export interface Member {
  key: string;
  /** Index of the key's opening quote — the first character of the member. */
  keyStart: number;
  valueStart: number;
  /** Exclusive. */
  valueEnd: number;
  /** Index of this member's trailing comma, or -1 when it has none. */
  comma: number;
}

class ScanError extends Error {}

/** Advance past whitespace, `//` line comments and `/* *​/` block comments. */
function skipTrivia(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (src[i] === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) throw new ScanError("unterminated block comment");
      i = end + 2;
      continue;
    }
    return i;
  }
}

/** `i` is the opening quote; returns the index just past the closing quote. */
function scanString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    j++;
  }
  throw new ScanError("unterminated string");
}

/** Returns the index just past the value starting at `i`. */
function scanValue(src: string, i: number): number {
  const c = src[i];
  if (c === '"' || c === "'") return scanString(src, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    while (j < src.length) {
      const t = skipTrivia(src, j);
      if (t !== j) {
        j = t;
        continue;
      }
      const ch = src[j]!;
      if (ch === '"' || ch === "'") {
        j = scanString(src, j);
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    throw new ScanError(`unterminated ${c}`);
  }
  // A primitive: run to the next structural character.
  let j = i;
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === "," || ch === "}" || ch === "]" || /\s/.test(ch)) break;
    if (ch === "/" && (src[j + 1] === "/" || src[j + 1] === "*")) break;
    j++;
  }
  if (j === i) throw new ScanError(`expected a value at offset ${i}`);
  return j;
}

/** Parse the members of the object whose `{` is at `open`. */
export function objectMembers(src: string, open: number): Member[] {
  if (src[open] !== "{") throw new ScanError(`expected an object at offset ${open}`);
  const members: Member[] = [];
  let i = open + 1;
  for (;;) {
    i = skipTrivia(src, i);
    if (i >= src.length) throw new ScanError("unterminated object");
    if (src[i] === "}") return members;
    if (src[i] === ",") {
      i++;
      continue;
    }

    const keyStart = i;
    let key: string;
    if (src[i] === '"' || src[i] === "'") {
      const end = scanString(src, i);
      key = src.slice(i + 1, end - 1);
      i = end;
    } else {
      let j = i;
      while (j < src.length && !/[\s:]/.test(src[j]!)) j++;
      if (j === i) throw new ScanError(`expected a key at offset ${i}`);
      key = src.slice(i, j);
      i = j;
    }

    i = skipTrivia(src, i);
    if (src[i] !== ":") throw new ScanError(`expected ':' after key "${key}"`);
    i = skipTrivia(src, i + 1);

    const valueStart = i;
    const valueEnd = scanValue(src, i);
    const after = skipTrivia(src, valueEnd);
    const comma = src[after] === "," ? after : -1;
    members.push({ key, keyStart, valueStart, valueEnd, comma });
    i = comma === -1 ? after : comma + 1;
  }
}

/** Index of the document's top-level `{`. */
export function rootObjectStart(src: string): number {
  const i = skipTrivia(src, 0);
  if (src[i] !== "{") throw new ScanError("the config's top level is not a JSON object");
  return i;
}

export interface ObjectRef {
  open: number;
  members: Member[];
}

/** Locate a nested object by key path, e.g. `["mcp"]`. */
export function findObject(src: string, path: string[]): ObjectRef | null {
  let open = rootObjectStart(src);
  let members = objectMembers(src, open);
  for (const key of path) {
    const member = members.find((m) => m.key === key);
    if (!member) return null;
    if (src[member.valueStart] !== "{") {
      throw new ScanError(`"${key}" is not an object`);
    }
    open = member.valueStart;
    members = objectMembers(src, open);
  }
  return { open, members };
}

/** The whitespace prefix of the line `index` sits on. */
function indentAt(src: string, index: number): string {
  const lineStart = src.lastIndexOf("\n", index - 1) + 1;
  const slice = src.slice(lineStart, index);
  return /^\s*$/.test(slice) ? slice : "";
}

/** The line's leading whitespace, for cuts that should take the whole line. */
function lineStartOf(src: string, index: number): number {
  const nl = src.lastIndexOf("\n", index - 1) + 1;
  return /^[ \t]*$/.test(src.slice(nl, index)) ? nl : index;
}

/**
 * Insert `key: value` as the first member of the object at `path`.
 *
 * Throws when the object does not exist or the member already does — the
 * caller decides whether that is fatal or a no-op.
 */
export function insertMember(src: string, path: string[], key: string, value: unknown): string {
  const ref = findObject(src, path);
  if (!ref) throw new ScanError(`no "${path.join(".")}" section in the config`);
  if (ref.members.some((m) => m.key === key)) throw new ScanError(`"${key}" is already present`);

  const inner = ref.members[0]
    ? indentAt(src, ref.members[0].keyStart)
    : indentAt(src, ref.open) + "  ";
  const body = JSON.stringify(value, null, 2)
    .split("\n")
    .map((line, n) => (n === 0 ? line : inner + line))
    .join("\n");
  const entry = `\n${inner}${JSON.stringify(key)}: ${body}${ref.members.length > 0 ? "," : ""}`;
  return src.slice(0, ref.open + 1) + entry + src.slice(ref.open + 1);
}

/**
 * Remove `key` from the object at `path`. Returns null when it is not there.
 *
 * Removing the last member also drops the previous member's trailing comma,
 * so the result stays valid for parsers that reject trailing commas.
 */
export function removeMember(src: string, path: string[], key: string): string | null {
  const ref = findObject(src, path);
  if (!ref) return null;
  const index = ref.members.findIndex((m) => m.key === key);
  if (index === -1) return null;
  const member = ref.members[index]!;

  const previous = ref.members[index - 1];
  if (member.comma === -1 && previous && previous.comma !== -1) {
    // Last member: swallow the previous comma so it does not become trailing.
    return src.slice(0, previous.comma) + src.slice(member.valueEnd);
  }

  const start = lineStartOf(src, member.keyStart);
  let end = member.comma === -1 ? member.valueEnd : member.comma + 1;
  // Take the rest of the line with it when only whitespace follows.
  const nl = src.indexOf("\n", end);
  if (nl !== -1 && /^[ \t]*$/.test(src.slice(end, nl))) end = nl + 1;
  return src.slice(0, start) + src.slice(end);
}

/** Does this text still scan as the JSONC we think it is? */
export function validates(src: string, path: string[]): boolean {
  try {
    objectMembers(src, rootObjectStart(src));
    findObject(src, path);
    return true;
  } catch {
    // A scan failure is exactly the signal the caller wants — it means we are
    // about to write something we can no longer read.
    return false;
  }
}
