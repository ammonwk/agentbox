import { useCallback, useSyncExternalStore } from "react";

/**
 * The width below which the board shows one pane at a time.
 *
 * Must match the `@media (max-width: 900px)` breakpoint in session.css — the
 * two are a pair: CSS lays the single pane out, this decides which pane is
 * mounted and whether the detail needs a back button.
 */
export const NARROW_PX = 900;

const QUERY = `(max-width: ${NARROW_PX}px)`;

export function useIsNarrow(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    const mql = window.matchMedia(QUERY);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    // No SSR here, but useSyncExternalStore demands the third argument and
    // "not narrow" is the right assumption for a desktop-first local tool.
    () => false,
  );
}
