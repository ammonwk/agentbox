/**
 * The bell at the foot of the icon rail, and the inbox it opens: what ran as
 * banners across the top of every page — the first-run checklist, sessions
 * to adopt, the server's warnings, a theme that did not save, a server that
 * is starting or restarting. Pointing at the bell opens the inbox; a click
 * keeps it open; Escape or a click outside closes it. The rail stays open
 * while the inbox is, so the inbox sits against its edge.
 *
 * On a phone the bell is a tab of the bottom bar, and the inbox a sheet
 * above that bar. A lost connection stays a banner (App.tsx StaleBanner): it
 * says that the whole page is out of date, which you must see without asking.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AppState } from "../../src/core/types";
import { useConnection } from "./api";
import { Icon, type IconComponent } from "./components";
import { isPhone } from "./lib/phone";
import { useDismiss } from "./views/newsession/popover";
import { useOnboardingInbox } from "./views/Onboarding";

/** How long the pointer rests on the bell before the inbox opens, and how
 *  long it can be away before the inbox closes. */
const OPEN_MS = 120;
const CLOSE_MS = 220;

export function InboxBell({ state, themeError }: { state: AppState | null; themeError: string | null }) {
  const setup = useOnboardingInbox(state?.onboarding ?? null, state?.sessions ?? []);
  const server = useServerNotice();
  const warnings = state?.warnings ?? [];
  const alerts = warnings.length + (themeError ? 1 : 0);
  const count = setup.count + alerts + (server ? 1 : 0);

  const [open, setOpen] = useState(false);
  // Whether a click keeps it open. A ref: the blur that follows the click
  // must see it set.
  const pinned = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const canHover = useMemo(() => window.matchMedia("(hover: hover)").matches, []);
  const later = (fn: () => void, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
    pinned.current = false;
  };
  useDismiss(open, close, [wrap]);

  // Its foot level with the bell's; on a phone, above the tab bar.
  const [bottom, setBottom] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = bell.current?.getBoundingClientRect();
      if (r) setBottom(isPhone() ? window.innerHeight - r.top + 8 : window.innerHeight - r.bottom);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  return (
    <div
      className="inbox-wrap"
      ref={wrap}
      onMouseEnter={canHover ? () => later(() => setOpen(true), OPEN_MS) : undefined}
      onMouseLeave={canHover ? () => (pinned.current ? clearTimeout(timer.current) : later(() => setOpen(false), CLOSE_MS)) : undefined}
      onBlur={(e) => {
        if (!pinned.current && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={bell}
        type="button"
        className="nav-item nav-bell"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={count ? `Notifications: ${count}` : "Notifications"}
        onClick={(e) => {
          clearTimeout(timer.current);
          if (pinned.current) close();
          else {
            setOpen(true);
            pinned.current = true;
          }
          // A mouse click lets go of the focus, as New session does: a later
          // Escape would make it keyboard focus and hold the rail open.
          if (e.detail > 0) e.currentTarget.blur();
        }}
        onFocus={(e) => {
          if (e.currentTarget.matches(":focus-visible")) setOpen(true);
        }}
      >
        <Icon.bell />
        <span className="nav-label">Inbox</span>
        {count > 0 ? <span className={`count${alerts ? " count-warn" : ""}`}>{count}</span> : null}
      </button>
      {open ? (
        <div className="inbox" role="dialog" aria-label="Notifications" style={{ bottom } as CSSProperties}>
          <div className="inbox-panel">
            <div className="inbox-head">
              Notifications
              {count ? <span className="inbox-n">{count}</span> : null}
            </div>
            {count === 0 ? (
              <p className="inbox-empty">
                <Icon.check size={14} /> Nothing needs you
              </p>
            ) : (
              <div className="inbox-list">
                {server}
                {themeError ? <Row icon={Icon.alert} tone="warn">Theme not saved: {themeError}</Row> : null}
                {warnings.map((w) => (
                  <Row key={w} icon={Icon.alert} tone="warn">
                    {w}
                  </Row>
                ))}
                {setup.node}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ icon: IconCmp, tone, children }: { icon: IconComponent; tone?: "warn"; children: ReactNode }) {
  return (
    <div className="inbox-row" data-tone={tone}>
      <IconCmp size={14} className="inbox-icon" />
      <span className="inbox-text">{children}</span>
    </div>
  );
}

/** The server starting or restarting: expected, over in seconds, and the
 *  page shows what it had until then. */
function useServerNotice(): ReactNode {
  const { connected, restarting, starting } = useConnection();
  if (connected && starting) {
    return (
      <Row icon={Icon.clock}>
        <strong>agentbox is starting.</strong> Reading transcripts
        {starting.of > 0 ? ` (${starting.read} of ${starting.of})` : ""}; what you see is from before the restart until it is done.
      </Row>
    );
  }
  if (!connected && restarting) {
    return (
      <Row icon={Icon.refresh}>
        <strong>agentbox is restarting…</strong> Reconnecting as soon as it is back; what you see is from before the restart.
      </Row>
    );
  }
  return null;
}
