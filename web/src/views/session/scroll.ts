/** The auto-scroll pinning decision, isolated so it can be tested.
 *
 * Yanking the viewport while someone is reading a tool call from three minutes
 * ago is worse than never auto-scrolling, so the rule is: follow the tail only
 * while the reader is already at (or within a hair of) the bottom.
 */

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Pixels from the bottom that still count as "at the bottom". */
export const PIN_SLACK = 48;

export function distanceFromBottom(box: ScrollBox): number {
  return Math.max(0, box.scrollHeight - box.scrollTop - box.clientHeight);
}

export function isPinnedToBottom(box: ScrollBox, slack: number = PIN_SLACK): boolean {
  // Content shorter than the viewport is trivially pinned — there is nowhere
  // to scroll, and a new event must not be treated as "the reader scrolled up".
  if (box.scrollHeight <= box.clientHeight) return true;
  return distanceFromBottom(box) <= slack;
}

/**
 * Should we scroll to the tail after this render?
 *
 * `wasPinned` is sampled *before* the new content lands: once it is in the DOM
 * the box is no longer at the bottom, so measuring after the fact would always
 * say no.
 */
export function shouldAutoScroll(args: {
  wasPinned: boolean;
  grew: boolean;
  /** First paint of a session: jump to the tail regardless of anything. */
  initial: boolean;
}): boolean {
  if (args.initial) return true;
  return args.grew && args.wasPinned;
}

/** Pixels from the top that still count as "at the top" for loading older
 *  history. Generous, so the fetch is underway before the reader hits the
 *  hard ceiling of what is loaded. */
export const TOP_SLACK = 120;

export function isAtTop(box: ScrollBox, slack: number = TOP_SLACK): boolean {
  return box.scrollTop <= slack;
}

/**
 * Where `scrollTop` must go when older events are prepended above the reader.
 *
 * Prepending shifts every row down by the height of the new content, which
 * would otherwise yank the viewport off what the reader was looking at — the
 * same rudeness auto-scroll exists to prevent, mirrored. Anchoring keeps the
 * pixel offset from the *bottom* constant, so the rows under the viewport
 * stay under it.
 */
export function anchoredScrollTop(
  prev: { scrollTop: number; scrollHeight: number },
  next: { scrollHeight: number },
): number {
  return next.scrollHeight - prev.scrollHeight + prev.scrollTop;
}
