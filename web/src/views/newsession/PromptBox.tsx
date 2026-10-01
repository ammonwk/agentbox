import { useEffect, useRef, useState, type Ref } from "react";
import type { SkillInfo } from "../../../../src/core/types";
import { AttachFrame, type Attachments } from "../../attachments";
import { recallPrompt, type PromptHistoryEntry } from "../../lib/prompthistory";
import { useSkillComplete } from "./skillcomplete";

/**
 * The prompt, with `/skill` completion (skillcomplete.tsx) and, while empty,
 * earlier prompts on Up. Enter submits, Shift+Enter is a new line. Images
 * pasted or dropped in attach to it.
 */
export function PromptBox({
  value,
  onChange,
  skills,
  history,
  textareaRef,
  attachments,
  onSubmit,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  skills: SkillInfo[];
  history: readonly PromptHistoryEntry[];
  textareaRef: Ref<HTMLTextAreaElement>;
  attachments: Attachments;
  onSubmit: () => void;
  id?: string;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const skill = useSkillComplete({ value, onChange, skills, textareaRef: localRef, onComplete: leaveHistory });
  // Snapshot the list on the first Up, so board updates cannot move it under
  // the reader. Any edit, including a paste or attachment, leaves history.
  const browsing = useRef<{ entries: readonly PromptHistoryEntry[]; index: number; text: string } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    if (browsing.current && value !== browsing.current.text) leaveHistory();
  }, [value]);

  function leaveHistory() {
    browsing.current = null;
    skill.placeCaret(null);
    setHistoryBusy(false);
    setHistoryError(null);
  }

  async function browse(direction: -1 | 1) {
    const current = browsing.current;
    const entries = current?.entries ?? history;
    const index = Math.max(-1, Math.min(entries.length - 1, (current?.index ?? -1) + direction));
    if (current && index === current.index) return;
    skill.dismiss();
    setHistoryError(null);
    if (index === -1) {
      leaveHistory();
      onChange("");
      return;
    }
    const next = { entries, index, text: value };
    browsing.current = next;
    setHistoryBusy(true);
    try {
      const text = await recallPrompt(entries[index]!, () => browsing.current === next);
      if (browsing.current !== next) return;
      next.text = text;
      if (text !== value) skill.placeCaret(text.length);
      else {
        localRef.current?.setSelectionRange(text.length, text.length);
        skill.setCaret(text.length);
      }
      onChange(text);
    } catch (e) {
      if (browsing.current !== next) return;
      browsing.current = null;
      setHistoryError(e instanceof Error ? e.message : String(e));
    } finally {
      if (browsing.current === next || !browsing.current) setHistoryBusy(false);
    }
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
        {...skill.props}
        aria-busy={historyBusy}
        onChange={(e) => {
          leaveHistory();
          onChange(e.target.value);
          skill.onEdit(e.target);
        }}
        onKeyDown={(e) => {
          const historyArrow = e.key === "ArrowUp" || e.key === "ArrowDown";
          const inHistory = browsing.current && value === browsing.current.text;
          if (historyArrow && !e.nativeEvent.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey &&
              (inHistory || (!value && history.length > 0 && e.key === "ArrowUp"))) {
            e.preventDefault();
            void browse(e.key === "ArrowUp" ? 1 : -1);
            return;
          }
          if (skill.onKeyDown(e) || attachments.onKeyDown(e)) return;
          // Ctrl+Enter is the form's, so it does not submit twice.
          if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {historyBusy ? <span className="field-hint" role="status">Reading the earlier prompt…</span> : null}
      {historyError ? <span className="field-hint" role="alert">Could not read prompt history: {historyError}</span> : null}
      {skill.list}
    </AttachFrame>
  );
}
