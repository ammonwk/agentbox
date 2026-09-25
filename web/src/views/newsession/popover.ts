/** A list that floats under (or over) a control inside the new-session dialog.
 *
 * `position: fixed`, because the dialog scrolls (`.modal { overflow: auto }`)
 * and an absolutely placed list would be clipped by it or stretch it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

export function useFloating(anchor: RefObject<HTMLElement | null>, open: boolean, maxHeight = 340, minWidth = 0): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ display: "none" });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      // Flip up only when below is cramped and above is roomier.
      const up = below < Math.min(maxHeight, 220) && above > below;
      // Wider than a small anchor when asked, and pulled left to stay on screen.
      const width = Math.max(r.width, minWidth);
      setStyle({
        position: "fixed",
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        width,
        ...(up
          ? { bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(maxHeight, above) }
          : { top: r.bottom + 4, maxHeight: Math.min(maxHeight, below) }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, maxHeight, minWidth]);
  return style;
}

/**
 * Close on a press outside `refs`, and on Escape without closing the dialog.
 *
 * The Modal listens for Escape on `document` in the capture phase, which runs
 * before any handler on the list — so this listens on `window`, whose capture
 * phase runs first, and stops the event there while the list is open.
 */
export function useDismiss(open: boolean, close: () => void, refs: RefObject<HTMLElement | null>[]): void {
  const latest = useRef({ close, refs });
  latest.current = { close, refs };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!latest.current.refs.some((r) => r.current?.contains(e.target as Node))) latest.current.close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      latest.current.close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
}

/** Keep the active option in view as arrows move it. */
export function scrollActiveIntoView(list: HTMLElement | null, index: number): void {
  const el = list?.querySelector<HTMLElement>(`[data-index="${index}"]`);
  el?.scrollIntoView({ block: "nearest" });
}
