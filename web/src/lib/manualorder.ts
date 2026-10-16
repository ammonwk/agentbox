/** An order you dragged a list into, kept in this browser: ids, first to
 *  last. One whose id is not in it has no place of its own yet, and each list
 *  says where those go. Pure, apart from the localStorage calls. */

/** At most this many ids in one list: the oldest places are forgotten first. */
const MAX_IDS = 2000;

function readAll(key: string): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

/** The order kept under `key` for one scope (a project, an agent). */
export function readOrder(key: string, scope: string): string[] {
  const ids = readAll(key)[scope];
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

export function saveOrder(key: string, scope: string, ids: readonly string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify({ ...readAll(key), [scope]: ids.slice(0, MAX_IDS) }));
  } catch {
    /* private mode: this tab remembers it */
  }
}

/** Each id's place, for sorting by. */
export const ranksOf = (order: readonly string[]): ReadonlyMap<string, number> => new Map(order.map((id, i) => [id, i]));

/**
 * `order` with `moved` put just before or after `target`, among `siblings`:
 * the list as it is drawn, both of them in it. The siblings take one run of
 * places where the first of them had one, so rows of other lists keep theirs.
 * Unchanged when either is not among the siblings.
 */
export function placeIn(
  order: readonly string[],
  siblings: readonly string[],
  moved: string,
  target: string,
  where: "before" | "after",
): string[] {
  if (moved === target || !siblings.includes(moved)) return [...order];
  const next = siblings.filter((id) => id !== moved);
  const i = next.indexOf(target);
  if (i === -1) return [...order];
  next.splice(where === "before" ? i : i + 1, 0, moved);
  const these = new Set(next);
  const first = order.findIndex((id) => these.has(id));
  const rest = order.filter((id) => !these.has(id));
  const at = first === -1 ? 0 : order.slice(0, first).filter((id) => !these.has(id)).length;
  return [...rest.slice(0, at), ...next, ...rest.slice(at)];
}

/** `order` with `moved` one place up or down among `siblings`, for the keyboard and the menu. */
export function stepIn(order: readonly string[], siblings: readonly string[], moved: string, step: -1 | 1): string[] | null {
  const i = siblings.indexOf(moved);
  const target = siblings[i + step];
  if (i === -1 || target === undefined) return null;
  return placeIn(order, siblings, moved, target, step === -1 ? "before" : "after");
}

/** Which half of a row the pointer is over. */
export const halfOf = (e: { clientY: number; currentTarget: Element }): "before" | "after" => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
};
