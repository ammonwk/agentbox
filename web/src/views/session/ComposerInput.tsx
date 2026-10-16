import { useLayoutEffect, type ComponentProps, type RefObject } from "react";
import { Button, Icon } from "../../components";

/** The same input in Sessions and Agents; delivery and optional controls stay
 * with their composer so a shared chat never sends through the local Fleet. */
export function ComposerInput({ textareaRef, onSend, onKeyDown, ...props }: Omit<ComponentProps<"textarea">, "ref"> & {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSend: () => void;
}) {
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, el.scrollHeight + 2)}px`;
  }, [props.value, textareaRef]);
  return <textarea
    ref={textareaRef}
    rows={1}
    enterKeyHint="send"
    title="Enter sends · Shift+Enter for a new line"
    {...props}
    onKeyDown={(e) => {
      onKeyDown?.(e);
      if (!e.defaultPrevented && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onSend();
      }
    }}
  />;
}

export function ComposerSend(props: ComponentProps<typeof Button>) {
  return <Button
    className="cmp-go"
    variant="ghost"
    icon={Icon.send}
    title="Send (Enter)"
    aria-label="Send"
    onMouseDown={(e) => e.preventDefault()}
    {...props}
  />;
}
