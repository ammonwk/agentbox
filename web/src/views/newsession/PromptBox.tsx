import { useRef, type Ref } from "react";
import type { SkillInfo } from "../../../../src/core/types";
import { AttachFrame, type Attachments } from "../../attachments";
import { useSkillComplete } from "./skillcomplete";

/**
 * The prompt, with `/skill` completion (skillcomplete.tsx). Enter submits,
 * Shift+Enter is a new line. Images pasted or dropped in attach to it.
 */
export function PromptBox({
  value,
  onChange,
  skills,
  textareaRef,
  attachments,
  onSubmit,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  skills: SkillInfo[];
  textareaRef: Ref<HTMLTextAreaElement>;
  attachments: Attachments;
  onSubmit: () => void;
  id?: string;
}) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const skill = useSkillComplete({ value, onChange, skills, textareaRef: localRef });

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
        onChange={(e) => {
          onChange(e.target.value);
          skill.onEdit(e.target);
        }}
        onKeyDown={(e) => {
          if (skill.onKeyDown(e) || attachments.onKeyDown(e)) return;
          // Ctrl+Enter is the form's, so it does not submit twice.
          if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      {skill.list}
    </AttachFrame>
  );
}
