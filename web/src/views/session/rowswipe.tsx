/** Swiping a row of the session list on a phone, as Mail's list does: left for
 *  Close, right for Pin and More, far enough to do the outermost one outright;
 *  and holding it for the row's menu, which iOS would never fire `contextmenu`
 *  for. One listener for every row, and one row carrying the buttons at a time:
 *  they are portalled into that row, so they move with it if the list reorders.
 *  The row's `--swipe` is the one number all of it is drawn from (session.css). */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components";
import { isPhone } from "../../lib/phone";
import { runningDescendants, type SessionRow } from "../../lib/board";

/** A finger has picked an axis once it has gone this far. */
const AXIS_PX = 10;
/** A swipe from the screen's left edge is the browser's back gesture. */
const EDGE_PX = 20;
const HOLD_MS = 450;
const BUTTON_PX = 78;
/** Let go past this share of the row's width and the outermost button is done. */
const FULL = 0.6;
/** Let go faster than this (px/ms) and the direction decides, not the distance. */
const FLICK = 0.4;
/** session.css's timings for `data-swipe="settle"` and `"leave"`. */
const SETTLE_MS = 280;
const LEAVE_MS = 340;

type Side = "left" | "right";
type Shown = { el: HTMLElement; s: SessionRow; side: Side };
/** The row carrying the buttons. `to` is where it is going or has come to rest. */
type Carried = { el: HTMLElement; s: SessionRow; side: Side | null; to: number; timer?: ReturnType<typeof setTimeout> };
type Gesture = {
  el: HTMLElement;
  s: SessionRow;
  pointer: number;
  x: number;
  y: number;
  width: number;
  /** Where the row was when the finger came down: open, or still moving. */
  base: number;
  locked: boolean;
  /** Where the finger has put the row. */
  at: number;
  lastX: number;
  lastT: number;
  speed: number;
  hold?: ReturnType<typeof setTimeout>;
};

/** Close is what a subagent's row and a closed row do not have, as on a computer,
 *  so a left swipe gives them nothing. */
const closable = (s: SessionRow) => s.host !== "subagent" && s.status !== "closed";
const place = (el: HTMLElement, px: number) => el.style.setProperty("--swipe", `${px}px`);

export function RowSwipe(props: {
  sessions: readonly SessionRow[];
  rowOf: (id: string) => SessionRow | undefined;
  onClose: (s: SessionRow) => void;
  onPin: (s: SessionRow) => void;
  onMore: (s: SessionRow) => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const [shown, setShown] = useState<Shown | null>(null);
  const carried = useRef<Carried | null>(null);
  const gesture = useRef<Gesture | null>(null);
  /** The click the gesture would end in opens nothing, nor dismisses anything. */
  const swallow = useRef(false);

  // Asks first, in the dialog that says which: closing would stop those too.
  const holdsWork = (s: SessionRow) => runningDescendants(s, latest.current.sessions).length > 0;
  const widthOf = (s: SessionRow, side: Side) => (side === "right" ? 2 * BUTTON_PX : closable(s) ? BUTTON_PX : 0);
  const canFull = (s: SessionRow, side: Side) => side === "right" || closable(s);

  const clear = (c: Carried) => {
    clearTimeout(c.timer);
    delete c.el.dataset.swipe;
    delete c.el.dataset.swipeFull;
    c.el.style.removeProperty("--swipe");
    c.el.style.removeProperty("height");
    if (carried.current !== c) return;
    carried.current = null;
    setShown(null);
  };

  const settle = (c: Carried, to: number) => {
    clearTimeout(c.timer);
    c.to = to;
    c.el.dataset.swipe = "settle";
    delete c.el.dataset.swipeFull;
    place(c.el, to);
    if (to === 0) c.timer = setTimeout(() => clear(c), SETTLE_MS);
  };

  const pin = (c: Carried) => {
    latest.current.onPin(c.s);
    settle(c, 0);
  };

  /** Off the screen, and the rows below come up into its place. Unless it is
   *  staying: a pinned row is listed closed, and one that started work asks
   *  first. A row the server then keeps is put back too. */
  const close = (c: Carried) => {
    const { s, el } = c;
    if (holdsWork(s) || s.pinOrder !== null) {
      settle(c, 0);
      latest.current.onClose(s);
      return;
    }
    clearTimeout(c.timer);
    c.to = 0;
    el.style.height = `${el.offsetHeight}px`;
    el.dataset.swipe = "leave";
    place(el, -el.offsetWidth);
    c.timer = setTimeout(() => {
      latest.current.onClose(s);
      c.timer = setTimeout(() => clear(c), SETTLE_MS);
    }, LEAVE_MS);
  };

  const more = (c: Carried) => {
    latest.current.onMore(c.s);
    settle(c, 0);
  };

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      swallow.current = false;
      if (e.pointerType === "mouse" || !isPhone()) return;
      const target = e.target as Element;
      if (target.closest(".rail-swipe")) return;
      const el = target.closest<HTMLElement>('.rail-row[data-nav-id^="session:"]');
      if (el?.dataset.swipe === "leave") return;
      const c = carried.current;
      // A touch anywhere else puts an open row away, and does nothing else.
      if (c && c.el !== el && c.to !== 0) {
        settle(c, 0);
        swallow.current = !!el;
      }
      if (!el || e.clientX < EDGE_PX) return;
      const s = latest.current.rowOf(el.dataset.navId!.slice("session:".length));
      if (!s) return;
      // The row may still be on its way: carry on from where it is, not where it was going.
      const base = c?.el === el ? parseFloat(getComputedStyle(el).getPropertyValue("--swipe")) || 0 : 0;
      const g: Gesture = { el, s, pointer: e.pointerId, x: e.clientX, y: e.clientY, width: el.offsetWidth, base, locked: false, at: base, lastX: e.clientX, lastT: e.timeStamp, speed: 0 };
      // A touch that put a row away has done its work, however long it lingers.
      if (!base && !swallow.current) {
        g.hold = setTimeout(() => {
          gesture.current = null;
          swallow.current = true;
          latest.current.onMore(s);
        }, HOLD_MS);
      }
      gesture.current = g;
    };

    const move = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.pointer !== e.pointerId) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.locked) {
        if (Math.hypot(dx, dy) < AXIS_PX) return;
        clearTimeout(g.hold);
        if (Math.abs(dy) >= Math.abs(dx)) {
          // The list's to scroll (`touch-action: pan-y`), which puts an open row away.
          gesture.current = null;
          if (carried.current?.to) settle(carried.current, 0);
          return;
        }
        g.locked = true;
        // Less what it took to decide, so the row does not jump; a fast flick's
        // first move may be all of it, and keeps the rest.
        g.x += Math.sign(dx) * AXIS_PX;
        swallow.current = true;
        let c = carried.current;
        if (c?.el !== g.el) {
          if (c && c.el.dataset.swipe !== "leave") settle(c, 0);
          c = carried.current = { el: g.el, s: g.s, side: null, to: 0 };
        }
        clearTimeout(c.timer);
        c.el.dataset.swipe = "drag";
      }
      const c = carried.current!;
      const raw = g.base + e.clientX - g.x;
      const side: Side = raw < 0 ? "left" : "right";
      if (c.side !== side) {
        c.side = side;
        setShown({ el: c.el, s: c.s, side });
      }
      const max = widthOf(c.s, side);
      const far = Math.abs(raw);
      const full = canFull(c.s, side);
      // Past its buttons it goes on toward the full swipe, or else drags and resists.
      const off = full ? Math.min(far, g.width) : far <= max ? far : max + (far - max) * 0.25;
      if (full && far >= FULL * g.width) c.el.dataset.swipeFull = "";
      else delete c.el.dataset.swipeFull;
      g.at = side === "left" ? -off : off;
      place(c.el, g.at);
      if (e.timeStamp > g.lastT) g.speed = (e.clientX - g.lastX) / (e.timeStamp - g.lastT);
      g.lastX = e.clientX;
      g.lastT = e.timeStamp;
    };

    const up = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.pointer !== e.pointerId) return;
      gesture.current = null;
      clearTimeout(g.hold);
      const c = carried.current;
      if (!c) return;
      // A tap on the open row puts it away.
      if (!g.locked) {
        if (c.el === g.el && g.base) {
          settle(c, 0);
          swallow.current = true;
        }
        return;
      }
      const side = c.side!;
      if (c.el.dataset.swipeFull !== undefined) return side === "left" ? close(c) : pin(c);
      const max = widthOf(c.s, side);
      const sign = side === "left" ? -1 : 1;
      // A finger that stopped before it lifted did not flick.
      const speed = e.timeStamp - g.lastT < 100 ? g.speed : 0;
      const stays = Math.abs(speed) > FLICK ? speed * sign > 0 : Math.abs(g.at) > max / 2;
      settle(c, stays ? sign * max : 0);
    };

    // The browser took the touch over, for a scroll or a gesture of its own.
    const cancel = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || g.pointer !== e.pointerId) return;
      gesture.current = null;
      clearTimeout(g.hold);
      if (carried.current?.to || g.locked) settle(carried.current!, 0);
    };

    const stop = (e: Event) => {
      if (!swallow.current) return;
      e.preventDefault();
      e.stopPropagation();
    };

    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("mousedown", stop, true);
    document.addEventListener("click", stop, true);
    return () => {
      clearTimeout(gesture.current?.hold);
      if (carried.current) clear(carried.current);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      document.removeEventListener("mousedown", stop, true);
      document.removeEventListener("click", stop, true);
    };
    // Everything it calls reads refs and setters that do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!shown) return null;
  const { el, s, side } = shown;
  /** Inside the row's link: do this, do not open it. */
  const tap = (act: (c: Carried) => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (carried.current) act(carried.current);
  };
  return createPortal(
    <div className="rail-swipe" data-side={side} role="group" aria-label="Actions">
      {side === "right" ? (
        <>
          <button type="button" className="rail-swipe-pin" onClick={tap(pin)}>
            <Icon.pin size={18} />
            {s.pinOrder !== null ? "Unpin" : "Pin"}
          </button>
          <button type="button" className="rail-swipe-more" onClick={tap(more)}>
            <Icon.dots size={18} />
            More
          </button>
        </>
      ) : closable(s) ? (
        <button type="button" className="rail-swipe-close" onClick={tap(close)}>
          <Icon.x size={18} />
          {s.status === "running" ? "Stop & close" : "Close"}
        </button>
      ) : null}
    </div>,
    el,
  );
}
