import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../components";
import { scrollActiveIntoView, useDismiss, useFloating } from "./popover";

export interface MenuItem {
  key: string;
  /** A heading over this row when it differs from the row above's. */
  group?: string;
  disabled?: boolean;
  /** The selected row gets a check unless it says otherwise. */
  noCheck?: boolean;
  children: ReactNode;
}

/**
 * The new-session dialog's one kind of control: a quiet pill that names the
 * choice, and a menu under it. With `search`, the menu opens on a box that
 * filters it — `items` is then called with what is typed, so a menu can offer
 * the typed text itself ("Use …", "Open folder …").
 *
 * Arrows move, Enter picks, Escape and an outside press close (useDismiss).
 * With `onTab`, Tab can put text in the search box instead (a folder's path).
 */
export function Dropdown({
  label,
  trigger,
  title,
  tone,
  items,
  selected,
  onPick,
  search,
  footer,
  width = 280,
  maxHeight = 360,
  align = "start",
  onClosedKey,
  onQuery,
  onTab,
  id,
}: {
  /** The control's name: the pill's aria-label prefix and the list's label. */
  label: string;
  trigger: ReactNode;
  title?: string;
  tone?: "warn" | "danger" | "accent";
  items: MenuItem[] | ((query: string) => MenuItem[]);
  selected: string | null;
  onPick: (key: string, query: string) => void;
  search?: string;
  footer?: ReactNode | ((query: string) => ReactNode);
  width?: number;
  maxHeight?: number;
  align?: "start" | "end";
  /** A key on the closed pill; true when it was handled (effort's ←/→). */
  onClosedKey?: (e: React.KeyboardEvent) => boolean;
  /** What is typed, as it changes ("" on close): for a menu that fetches its rows. */
  onQuery?: (query: string) => void;
  /** Tab on the active row: the text for the search box, or null to close as usual. */
  onTab?: (key: string, query: string) => string | null;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const style = useFloating(btnRef, open, maxHeight, width, align);
  useDismiss(open, () => close(false), [btnRef, popRef]);

  const rows = typeof items === "function" ? items(query) : items;
  const enabled = (i: number) => !!rows[i] && !rows[i]!.disabled;
  const listId = `${id ?? label.toLowerCase()}-menu`;

  // Opening lands on the selected row; typing lands on the first that can be picked.
  useEffect(() => {
    if (!open) return;
    const i = rows.findIndex((r) => r.key === selected && !r.disabled);
    setActive(i >= 0 && !query ? i : Math.max(0, rows.findIndex((r) => !r.disabled)));
  }, [open, query]);
  useEffect(() => scrollActiveIntoView(listRef.current, active), [active]);
  useEffect(() => onQuery?.(query), [query]);
  // Once placed: until useFloating has measured, the menu is display:none,
  // and a hidden box cannot take focus.
  const placed = open && style.display !== "none";
  useEffect(() => {
    if (placed) searchRef.current?.focus();
  }, [placed]);

  // Focus in the menu's search box would fall to <body> with it, so it
  // goes back to the pill; a press elsewhere then moves it on as usual.
  function close(refocus: boolean) {
    const inside = !!popRef.current?.contains(document.activeElement);
    setOpen(false);
    setQuery("");
    if (refocus || inside) btnRef.current?.focus();
  }

  function pick(i: number) {
    const r = rows[i];
    if (!r || r.disabled) return;
    onPick(r.key, query.trim());
    close(true);
  }

  function step(d: 1 | -1) {
    setActive((from) => {
      for (let i = from + d; i >= 0 && i < rows.length; i += d) if (enabled(i)) return i;
      return from;
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (onClosedKey?.(e)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1);
    } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) || (e.key === " " && !search)) {
      // Enter in the search box would submit the dialog: here it picks.
      e.preventDefault();
      pick(active);
    } else if (e.key === "Tab") {
      const r = rows[active];
      const next = r && !r.disabled && !e.shiftKey ? onTab?.(r.key, query) : null;
      if (next != null) {
        e.preventDefault();
        setQuery(next);
        searchRef.current?.focus();
      } else close(false);
    }
  }

  const foot = typeof footer === "function" ? footer(query.trim()) : footer;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ns-pill"
        data-tone={tone}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !search ? `${listId}-${active}` : undefined}
        title={title}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onKeyDown}
      >
        <span className="sr-only">{label}: </span>
        {trigger}
        <Icon.chevronDown size={13} className="ns-pill-chev" />
      </button>
      {open ? (
        <div ref={popRef} className="ns-menu" style={style}>
          {search ? (
            <input
              ref={searchRef}
              className="ns-menu-search"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
              aria-label={search}
              placeholder={search}
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
          ) : null}
          <div ref={listRef} id={listId} role="listbox" aria-label={label} className="ns-menu-list">
            {rows.map((r, i) => (
              <div key={r.key}>
                {r.group && r.group !== rows[i - 1]?.group ? <div className="ns-menu-group">{r.group}</div> : null}
                <div
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={r.key === selected}
                  aria-disabled={r.disabled || undefined}
                  data-active={i === active || undefined}
                  className="ns-item"
                  onMouseEnter={() => !r.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                >
                  {r.children}
                  {r.key === selected && !r.noCheck ? <Icon.check size={14} className="ns-item-check" /> : null}
                </div>
              </div>
            ))}
          </div>
          {foot ? <div className="ns-menu-foot">{foot}</div> : null}
        </div>
      ) : null}
    </>
  );
}
