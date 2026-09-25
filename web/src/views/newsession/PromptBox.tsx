import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";
import type { SkillInfo } from "../../../../src/core/types";
import { AttachFrame, type Attachments } from "../../attachments";
import { completeSlash, matchSkills, slashToken } from "../../lib/newsession";
import { scrollActiveIntoView, useDismiss, useFloating } from "./popover";

/**
 * The prompt, with `/skill` completion: typing `/go` lists the skills that
 * match, Tab or Enter takes the highlighted one, arrows move, Escape dismisses
 * until the next keystroke. Images pasted or dropped in attach to it.
 */
export function PromptBox({
  value,
  onChange,
  skills,
  textareaRef,
  attachments,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  skills: SkillInfo[];
  textareaRef: Ref<HTMLTextAreaElement>;
  attachments: Attachments;
  id?: string;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  /** Where the caret goes after a completion re-renders the text. */
  const pendingCaret = useRef<number | null>(null);

  const token = slashToken(value, caret);
  const matches = token ? matchSkills(skills, token.query) : [];
  const open = !!token && !dismissed && matches.length > 0;
  const style = useFloating(localRef, open, 280);
  useDismiss(open, () => setDismissed(true), [localRef, listRef]);

  useEffect(() => setActive(0), [token?.query]);
  useEffect(() => scrollActiveIntoView(listRef.current, active), [active]);
  useLayoutEffect(() => {
    const el = localRef.current;
    if (el && pendingCaret.current != null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  function complete(s: SkillInfo) {
    if (!token) return;
    const next = completeSlash(value, caret, token.start, s.name);
    pendingCaret.current = next.caret;
    onChange(next.text);
  }

  function syncCaret() {
    const el = localRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }

  return (
    <AttachFrame a={attachments} className="ns-promptbox">
      <textarea
        id={id}
        className="ns-prompt"
        ref={(el) => {
          localRef.current = el;
          if (typeof textareaRef === "function") textareaRef(el);
          else if (textareaRef) textareaRef.current = el;
        }}
        value={value}
        placeholder="What should it do? Type / for skills; paste or drop images."
        rows={6}
        role="combobox"
        aria-expanded={open}
        aria-controls="ns-skill-list"
        aria-autocomplete="list"
        aria-activedescendant={open ? `ns-skill-${active}` : undefined}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? 0);
          setDismissed(false);
        }}
        onSelect={syncCaret}
        onKeyDown={(e) => {
          if (!open) {
            attachments.onKeyDown(e);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const d = e.key === "ArrowDown" ? 1 : -1;
            setActive((i) => (i + d + matches.length) % matches.length);
          } else if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey)) {
            e.preventDefault();
            complete(matches[active]!);
          }
        }}
      />
      {open ? (
        <div ref={listRef} id="ns-skill-list" role="listbox" aria-label="Skills" className="ns-pop ns-skill-pop" style={style}>
          {matches.map((s, i) => (
            <div
              key={s.path}
              id={`ns-skill-${i}`}
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
      ) : null}
    </AttachFrame>
  );
}
