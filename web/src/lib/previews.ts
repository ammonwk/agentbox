/** ← and → in a preview step to the next thing of its kind beside the one
 *  opened. Whatever opens a preview is marked `data-preview="image"` (its
 *  `data-target` the image's URL) or `data-preview="file"` (a viewer entry
 *  as JSON), with a `data-label`. A trail is every such mark in page order,
 *  taken when the preview opens, among those in the same
 *  `[data-preview-scope]` (the file viewer, the composer's attachments) or
 *  outside any: the timeline's images are one trail, a viewed file's another.
 *  The same target twice is one stop. */

export interface Trail {
  items: { target: string; label: string }[];
  at: number;
}

const SCOPE = "[data-preview-scope]";

export function trailFrom(from: HTMLElement): Trail {
  const kind = from.dataset.preview;
  const scope = from.closest(SCOPE);
  const items: Trail["items"] = [];
  const index = new Map<string, number>();
  let at = 0;
  for (const el of document.querySelectorAll<HTMLElement>(`[data-preview="${kind}"]`)) {
    if (el.closest(SCOPE) !== scope) continue;
    const target = el.dataset.target ?? "";
    if (!index.has(target)) {
      index.set(target, items.length);
      items.push({ target, label: el.dataset.label ?? "" });
    }
    if (el === from) at = index.get(target)!;
  }
  if (items.length === 0) items.push({ target: from.dataset.target ?? "", label: from.dataset.label ?? "" });
  return { items, at };
}

/** The step a key asks for: a bare ← or →, toward a stop the trail has.
 *  Otherwise 0, and the key does what it would. A preview is modal and has
 *  no text field of its own, so a focused one under it gets no say. */
export function stepOf(e: KeyboardEvent, trail: Trail | null): -1 | 0 | 1 {
  if (!trail || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return 0;
  const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
  return step && trail.items[trail.at + step] ? step : 0;
}
