import { useEffect, useRef, useState } from "react";
import type { PrInfo } from "../../../../src/core/types";
import { matchPrs } from "../../lib/newsession";
import { scrollActiveIntoView, useDismiss, useFloating } from "./popover";

/**
 * "New worktree" as a checkbox; unchecked, a small box that says where else
 * to run: blank for the main checkout, `new` to go back, or a PR number,
 * completed from the repo's open PRs.
 */
export function WorktreeField({
  on,
  onToggle,
  text,
  onText,
  prs,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  text: string;
  onText: (text: string) => void;
  prs: PrInfo[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Set by unchecking, so the box that replaces the checkbox takes focus. */
  const focusNext = useRef(false);
  const style = useFloating(inputRef, open, 320, 420);
  useDismiss(open, () => setOpen(false), [inputRef, listRef]);

  const q = text.trim().toLowerCase();
  const showNew = !q || "new".startsWith(q);
  const matches = matchPrs(prs, text);
  // Row 0 is "new" when it matches; PRs follow.
  const rows: (PrInfo | "new")[] = [...(showNew ? (["new"] as const) : []), ...matches];

  useEffect(() => setActive(0), [text]);
  useEffect(() => scrollActiveIntoView(listRef.current, active), [active]);
  useEffect(() => {
    if (!on && focusNext.current) {
      focusNext.current = false;
      inputRef.current?.focus();
      setOpen(true);
    }
  }, [on]);

  function pick(row: PrInfo | "new") {
    setOpen(false);
    if (row === "new") {
      onText("");
      onToggle(true);
    } else {
      onText(`#${row.number}`);
    }
  }

  if (on) {
    return (
      <label className="ns-wt" title="A fresh branch off the default branch, so it cannot collide with anything else running there. Untick to run in the main checkout or on a PR's branch.">
        <input
          type="checkbox"
          checked
          onChange={() => {
            focusNext.current = true;
            onToggle(false);
          }}
        />
        New worktree
      </label>
    );
  }

  return (
    <div className="ns-wtbox">
      <input
        ref={inputRef}
        aria-label="Worktree: blank for the main checkout, new, or a PR number"
        className="mono"
        role="combobox"
        aria-expanded={open && rows.length > 0}
        aria-controls="ns-wt-list"
        aria-autocomplete="list"
        aria-activedescendant={open && rows.length ? `ns-wt-${active}` : undefined}
        placeholder="main · new · PR #"
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          onText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || rows.length === 0) {
            if (e.key === "ArrowDown") setOpen(true);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const d = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + d + rows.length) % rows.length);
          } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || (e.key === "Tab" && q)) {
            // Tab completes only once something is typed; on an empty box it
            // moves on, leaving "main checkout".
            e.preventDefault();
            pick(rows[active]!);
          } else if (e.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      {open && rows.length > 0 ? (
        <div ref={listRef} id="ns-wt-list" role="listbox" aria-label="Worktree" className="ns-pop" style={style}>
          {rows.map((r, i) => (
            <div
              key={r === "new" ? "new" : r.number}
              id={`ns-wt-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === active}
              data-active={i === active || undefined}
              className="ns-wt-opt"
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
            >
              {r === "new" ? (
                <>
                  <span className="ns-wt-num mono">new</span>
                  <span className="ns-wt-title">A fresh worktree and branch</span>
                </>
              ) : (
                <>
                  <span className="ns-wt-num mono">#{r.number}</span>
                  <span className="ns-wt-title">
                    {r.isDraft ? <span className="ns-tag">draft</span> : null}
                    {r.title}
                  </span>
                  <span className="ns-wt-meta mono">{r.headRef}</span>
                </>
              )}
            </div>
          ))}
          {!q ? <div className="ns-pop-foot faint">Leave blank to run in the main checkout.</div> : null}
        </div>
      ) : null}
    </div>
  );
}
