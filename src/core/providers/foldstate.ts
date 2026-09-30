/** A fold's running state as data, so a reader can pick up after a restart
 *  where the last server left off instead of re-reading the file.
 *
 * Folds are classes whose fields are plain data (numbers, strings, arrays,
 * Maps, Sets, plain objects) plus, sometimes, a nested fold (`PrRepoFold`,
 * `ClaudeTokenFold`). Saving takes every own field but functions and the
 * named references; a nested fold is saved field by field and restored into
 * the instance the constructor already made, so it keeps its prototype.
 * Whatever the saved value is must survive `bun:jsc`'s structured clone.
 */

const NESTED = "\u0000fold";

const PLAIN = new Set<unknown>([Object.prototype, null, Array.prototype, Map.prototype, Set.prototype, Date.prototype]);

function isFold(v: unknown): v is object {
  return typeof v === "object" && v !== null && !ArrayBuffer.isView(v) && !PLAIN.has(Object.getPrototypeOf(v));
}

export function saveFields(o: object, skip: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "function" || skip.includes(k)) continue;
    out[k] = isFold(v) ? { [NESTED]: saveFields(v) } : v;
  }
  return out;
}

/** Put saved fields back. Only fields the object already has are touched, so
 *  a field since removed from the class is dropped rather than resurrected. */
export function loadFields(o: object, s: unknown): void {
  if (!s || typeof s !== "object") throw new Error("no saved fold state");
  const target = o as Record<string, unknown>;
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (!(k in target) || typeof target[k] === "function") continue;
    const nested = v && typeof v === "object" ? (v as Record<string, unknown>)[NESTED] : undefined;
    if (nested !== undefined && isFold(target[k])) loadFields(target[k] as object, nested);
    else target[k] = v;
  }
}
