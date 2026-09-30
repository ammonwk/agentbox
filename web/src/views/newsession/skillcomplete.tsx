import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { SkillInfo } from "../../../../src/core/types";
import { completeSlash, matchSkills, slashToken } from "../../lib/newsession";
import { scrollActiveIntoView, useDismiss, useFloating } from "./popover";

/**
 * `/skill` completion for a prompt textarea: typing `/go` lists the skills
 * that match, Tab or Enter takes the highlighted one, arrows move, Escape
 * dismisses until the next keystroke. The new-session prompt and a session's
 * composer both use it; the textarea spreads `props`, calls `onEdit` from its
 * onChange and `onKeyDown` first from its own, and renders `list`.
 */
export function useSkillComplete({
  value,
  onChange,
  skills,
  textareaRef,
  onComplete,
}: {
  value: string;
  onChange: (v: string) => void;
  skills: readonly SkillInfo[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Before a completion changes the text. */
  onComplete?: () => void;
}) {
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  /** Where the caret goes after a change re-renders the text. */
  const pendingCaret = useRef<number | null>(null);

  const token = slashToken(value, caret);
  const matches = token ? matchSkills(skills, token.query) : [];
  const open = !!token && !dismissed && matches.length > 0;
  const style = useFloating(textareaRef, open, 280);
  useDismiss(open, () => setDismissed(true), [textareaRef, listRef]);

  useEffect(() => setActive(0), [token?.query]);
  useEffect(() => scrollActiveIntoView(listRef.current, active), [active]);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el && pendingCaret.current != null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  function complete(s: SkillInfo) {
    if (!token) return;
    onComplete?.();
    const next = completeSlash(value, caret, token.start, s.name);
    pendingCaret.current = next.caret;
    onChange(next.text);
  }

  const optionId = (i: number) => `${listId}-${i}`;

  return {
    open,
    /** Put the caret at `at` once the next text renders; null cancels. */
    placeCaret(at: number | null) {
      pendingCaret.current = at;
    },
    /** The caret moved without a change to the text. */
    setCaret,
    dismiss: () => setDismissed(true),
    props: {
      role: "combobox",
      "aria-expanded": open,
      "aria-controls": listId,
      "aria-autocomplete": "list",
      "aria-activedescendant": open ? optionId(active) : undefined,
      onSelect() {
        const el = textareaRef.current;
        if (el) setCaret(el.selectionStart ?? 0);
      },
    } as const,
    onEdit(el: HTMLTextAreaElement) {
      setCaret(el.selectionStart ?? 0);
      setDismissed(false);
    },
    /** True when the key was the list's. */
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
      if (!open || e.nativeEvent.isComposing) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + d + matches.length) % matches.length);
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey)) {
        e.preventDefault();
        complete(matches[active]!);
        return true;
      }
      return false;
    },
    list: open ? (
      <div ref={listRef} id={listId} role="listbox" aria-label="Skills" className="ns-pop ns-skill-pop" style={style}>
        {matches.map((s, i) => (
          <div
            key={s.path}
            id={optionId(i)}
            data-index={i}
            role="option"
            aria-selected={i === active}
            data-active={i === active || undefined}
            className="ns-skill-opt"
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => complete(s)}
          >
            <span className="ns-skill-name mono">/{s.name}</span>
            <span className="ns-skill-desc">{s.description}</span>
            <span className="ns-tag">{s.source}</span>
          </div>
        ))}
        <div className="ns-pop-foot faint">
          <kbd>Tab</kbd> to complete · <kbd>↑</kbd>
          <kbd>↓</kbd> to choose · <kbd>Esc</kbd> to dismiss
        </div>
      </div>
    ) : null,
  };
}
