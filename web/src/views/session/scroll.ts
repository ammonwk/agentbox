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
