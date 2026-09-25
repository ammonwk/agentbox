import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components";
import { scrollActiveIntoView, useDismiss, useFloating } from "./popover";

/**
 * How hard the model thinks: the CLI's own levels (`--effort`, codex's
 * `model_reasoning_effort`, omp's `--thinking`), lowest first, plus "default"
 * — whatever the CLI or its settings say. Closed, it is a small meter beside
 * the model; ←/→ step the level without opening the list.
 */
export function EffortPicker({ levels, value, onChange }: { levels: readonly string[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const style = useFloating(btnRef, open, 320, 250);
  useDismiss(open, () => setOpen(false), [btnRef, listRef]);

  // Row 0 is "default"; the levels follow.
  const rows = ["", ...levels];
  const index = Math.max(0, rows.indexOf(value));
  useEffect(() => {
    if (open) setActive(index);
  }, [open]);
  useEffect(() => scrollActiveIntoView(listRef.current, active), [active]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
    btnRef.current?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const i = Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowRight" ? 1 : -1)));
        onChange(rows[i]!);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(rows[active]!);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="ns-effort-btn"
        data-default={!value || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="ns-effort-list"
        aria-label={`Effort: ${value || "default"}`}
        title="Reasoning effort · ←/→ to step"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
      >
        <Meter level={value ? levels.indexOf(value) + 1 : 0} of={levels.length} />
        <span className="ns-effort-val">{value || "effort"}</span>
        <Icon.chevronDown size={13} />
      </button>
      {open ? (
        <div ref={listRef} id="ns-effort-list" role="listbox" aria-label="Effort" className="ns-pop" style={style}>
          {rows.map((r, i) => (
            <div
              key={r || "default"}
              data-index={i}
              role="option"
              aria-selected={r === value}
              data-active={i === active || undefined}
              className="ns-effort-opt"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
            >
              <Meter level={i} of={levels.length} />
              <span className={r ? "" : "faint"}>{r || "Default"}</span>
              {!r ? <span className="ns-effort-note faint">the CLI&apos;s own setting</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Bars rising left to right, `level` of `of` lit; zero lit reads "default". */
function Meter({ level, of }: { level: number; of: number }) {
  const bars = Math.min(of, 5);
  // Squeeze longer ladders (omp's seven) onto five bars.
  const lit = level === 0 ? 0 : Math.max(1, Math.round((level / of) * bars));
  return (
    <span className="ns-meter" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} data-on={i < lit || undefined} style={{ height: `${4 + i * 2.5}px` }} />
      ))}
    </span>
  );
}
