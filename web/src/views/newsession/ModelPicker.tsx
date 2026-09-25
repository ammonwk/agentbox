import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components";
import { ago } from "../../lib/format";
import { filterModels, type ModelChoice } from "../../lib/newsession";
import { scrollActiveIntoView, useDismiss, useFloating } from "./popover";

/**
 * A combobox: a dropdown of what this account can run, recently used first
 * then newest release first, that still takes any string — a model the
 * catalog has not heard of is the CLI's business, not ours.
 */
export function ModelPicker({
  models,
  value,
  onChange,
  defaultLabel,
  id,
}: {
  models: ModelChoice[];
  value: string;
  onChange: (model: string) => void;
  /** What an empty value means: the settings default or the CLI's own. */
  defaultLabel: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  /** Typing filters; opening with the arrow shows everything. */
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const style = useFloating(wrapRef, open, 360);
  useDismiss(open, () => setOpen(false), [wrapRef, listRef]);

  const shown = filterModels(models, query ?? "");
  // Row 0 is always "default"; models follow.
  const rows: (ModelChoice | null)[] = [null, ...shown];
  const firstUnused = shown.findIndex((m) => m.lastUsedAt == null);

  useEffect(() => {
    if (!open) return;
    const i = rows.findIndex((m) => (m?.id ?? "") === value);
    setActive(query ? Math.min(1, rows.length - 1) : Math.max(0, i));
  }, [open, query]);
  useEffect(() => scrollActiveIntoView(listRef.current, active), [active]);

  const current = models.find((m) => m.id === value);

  function pick(m: ModelChoice | null) {
    onChange(m?.id ?? "");
    setQuery(null);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(rows.length - 1, i + d)));
    } else if (e.key === "Enter" && open && !(e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      pick(rows[active] ?? null);
    } else if (e.key === "Tab" && open) {
      setOpen(false);
    }
  }

  return (
    <div className="ns-model" ref={wrapRef}>
      <input
        id={id}
        ref={inputRef}
        className="mono"
        role="combobox"
        aria-expanded={open}
        aria-controls="ns-model-list"
        aria-autocomplete="list"
        aria-activedescendant={open ? `ns-model-${active}` : undefined}
        value={query ?? value}
        placeholder={defaultLabel}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value.trim());
          setOpen(true);
        }}
        onFocus={() => setQuery(null)}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {current && current.label !== current.id && query == null ? (
        <span className="ns-model-name" aria-hidden="true">
          {current.label}
        </span>
      ) : null}
      <button
        type="button"
        className="ns-model-caret"
        tabIndex={-1}
        aria-label="Show models"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          setQuery(null);
          setOpen((o) => !o);
          inputRef.current?.focus();
        }}
      >
        <Icon.chevronDown size={14} />
      </button>

      {open ? (
        <div ref={listRef} id="ns-model-list" role="listbox" aria-label="Model" className="ns-pop ns-model-pop" style={style}>
          {rows.map((m, i) => (
            <div key={m?.id ?? ""}>
              {i === 1 && m?.lastUsedAt != null ? <div className="ns-pop-group">Recently used</div> : null}
              {i - 1 === firstUnused && firstUnused >= 0 ? <div className="ns-pop-group">Newest first</div> : null}
              <div
                id={`ns-model-${i}`}
                data-index={i}
                role="option"
                aria-selected={(m?.id ?? "") === value}
                data-active={active === i || undefined}
                className="ns-model-opt"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(m)}
              >
                {m ? (
                  <>
                    <span className="ns-model-label">{m.label}</span>
                    {m.label !== m.id ? <span className="ns-model-id mono">{m.id}</span> : null}
                    <span className="ns-model-when">
                      {m.lastUsedAt != null ? ago(m.lastUsedAt) : m.releasedAt ? fmtRelease(m.releasedAt) : ""}
                    </span>
                  </>
                ) : (
                  <span className="ns-model-label faint">{defaultLabel}</span>
                )}
              </div>
            </div>
          ))}
          {shown.length === 0 && query ? <div className="ns-pop-empty">No match — “{query}” will be passed as is.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Sep 2026". */
function fmtRelease(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : date;
}
