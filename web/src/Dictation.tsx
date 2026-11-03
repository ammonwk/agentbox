import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./components";
import { recordVoice } from "./lib/recording";
import { dictationTarget, type DictationInsertion } from "./lib/dictationTarget";
import "./dictation.css";

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type Phase = "arming" | "starting" | "recording" | "transcribing";
type Notice = { phase: Exclude<Phase, "arming"> | "error" | "hint"; text: string };

function fieldAt(target: EventTarget | null): Field | null {
  if (!(target instanceof HTMLElement) || target.closest('[inert], [aria-disabled="true"]')) return null;
  if (dictationTarget(target)) return target;
  if (target.closest('.xterm')) return null;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    if (target.disabled || target.readOnly || target.matches(":disabled")) return null;
    return target instanceof HTMLTextAreaElement || /^(text|search|url|tel|email)$/.test(target.type) ? target : null;
  }
  if (!target.isContentEditable) return null;
  let field = target;
  while (field.parentElement?.isContentEditable) field = field.parentElement;
  return field;
}

/** Keep the original selection, and never put a late result over a newer edit. */
function insertion(field: Field): DictationInsertion {
  const custom = dictationTarget(field);
  if (custom) return custom();
  const control = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
  const before = control ? control.value : field.innerHTML;
  const start = control?.selectionStart ?? null;
  const end = control?.selectionEnd ?? null;
  const selection = window.getSelection();
  const range = !control && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const unchanged = () => {
    if (!field.isConnected || fieldAt(document.activeElement) !== field) return false;
    if (control) return control.value === before && control.selectionStart === start && control.selectionEnd === end;
    const now = window.getSelection();
    if (field.innerHTML !== before || !range || !now?.rangeCount) return false;
    const current = now.getRangeAt(0);
    return current.startContainer === range.startContainer && current.startOffset === range.startOffset && current.endContainer === range.endContainer && current.endOffset === range.endOffset;
  };
  return {
    unchanged,
    insert(text: string, spoken = false) {
      if (!unchanged()) return;
      if (spoken && (!control || control instanceof HTMLTextAreaElement || /^(text|search)$/.test(control.type))) {
        let left = control && start !== null ? before.slice(0, start) : "";
        let right = control && end !== null ? before.slice(end) : "";
        if (range) {
          const prefix = range.cloneRange();
          prefix.selectNodeContents(field);
          prefix.setEnd(range.startContainer, range.startOffset);
          const suffix = range.cloneRange();
          suffix.selectNodeContents(field);
          suffix.setStart(range.endContainer, range.endOffset);
          left = prefix.toString();
          right = suffix.toString();
        }
        if (left && !/\s$/.test(left) && !/^[.,!?;:)}\]]/.test(text)) text = ` ${text}`;
        if (right && !/^[\s.,!?;:)}\]]/.test(right)) text += " ";
      }
      // The browser's editing command preserves undo and emits the input event
      // React uses for controlled fields, just like typing or pasting.
      if (document.execCommand("insertText", false, text)) return;
      if (control && start !== null && end !== null) {
        const room = control.maxLength < 0 ? text.length : Math.max(0, control.maxLength - before.length + end - start);
        const added = text.slice(0, room);
        const proto = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(control, before.slice(0, start) + added + before.slice(end));
        control.setSelectionRange(start + added.length, start + added.length);
        control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: added }));
      }
    },
  };
}

/** Space is held for one second to dictate into whichever editor has focus. */
export function Dictation() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const cancelRef = useRef(() => {});

  useEffect(() => {
    type Take = {
      edit: ReturnType<typeof insertion>;
      phase: Phase;
      timer?: ReturnType<typeof setTimeout>;
      audio?: ReturnType<typeof recordVoice>;
    };
    let take: Take | undefined;
    let spaceDown = false;
    const cancel = () => {
      const current = take;
      take = undefined;
      clearTimeout(current?.timer);
      current?.audio?.stop(false);
      setNotice(null);
    };
    cancelRef.current = cancel;
    const fail = (current: Take, text: string) => {
      if (take !== current) return;
      cancel();
      setNotice({ phase: "error", text });
    };
    const interrupted = () => {
      if (!take) return;
      const opening = take.phase === "starting";
      cancel();
      if (opening) setNotice({ phase: "hint", text: "Allow microphone access, then hold Space again to record." });
    };
    const tap = () => {
      if (take?.phase !== "arming") return;
      const edit = take.edit;
      cancel();
      edit.insert(" ");
    };
    const start = (current: Take) => {
      if (take !== current || !current.edit.unchanged()) { cancel(); return; }
      current.phase = "starting";
      setNotice({ phase: "starting", text: "Opening microphone… Keep holding Space" });
      current.audio = recordVoice({
        onStart: () => {
          if (take !== current) return;
          current.phase = "recording";
          setNotice({ phase: "recording", text: "Listening… Release Space to transcribe · Esc cancels" });
        },
        onDone: (audio) => {
          if (take !== current) return;
          void api.transcribe(audio).then((text) => {
            if (take !== current) return;
            if (!current.edit.unchanged()) { cancel(); return; }
            const heard = text.trim();
            if (!heard) { fail(current, "No speech was heard. Hold Space to try again."); return; }
            cancel();
            current.edit.insert(heard, true);
          }).catch((error: Error) => fail(current, error.message));
        },
        onError: (text) => fail(current, text),
      });
    };
    const swallow = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (take || noticeVisible())) {
        swallow(e);
        cancel();
        return;
      }
      if (isSpace(e) && spaceDown) { swallow(e); return; }
      if (take) {
        // Fast typing often presses the next key before releasing Space.
        // Commit a short press first so characters stay in the right order.
        if (take.phase === "arming") tap();
        else cancel();
      }
      if (!isSpace(e) || e.repeat || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const field = fieldAt(e.target);
      // A voice note from a mic or Send button has the microphone: Space types.
      if (!field || document.querySelector(".vn-rec, [data-rec]")) return;
      swallow(e);
      spaceDown = true;
      const current: Take = { edit: insertion(field), phase: "arming" };
      take = current;
      setNotice(null);
      current.timer = setTimeout(() => start(current), 1000);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isSpace(e) || !spaceDown) return;
      spaceDown = false;
      swallow(e);
      const current = take;
      if (!current) return;
      if (current.phase === "arming") tap();
      else if (current.phase === "recording") {
        current.phase = "transcribing";
        setNotice({ phase: "transcribing", text: "Transcribing…" });
        current.audio?.stop(true);
      } else if (current.phase === "starting") interrupted();
    };
    const onBlur = () => { spaceDown = false; interrupted(); };
    const onHidden = () => { if (document.hidden) onBlur(); };
    const onFocusOut = () => interrupted();
    const onInput = () => { if (take) cancel(); };
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".dictation")) return;
      if (take?.phase === "arming") tap();
      else if (take) cancel();
    };
    const onSelection = () => { if (take && !take.edit.unchanged()) cancel(); };
    // Window capture owns Escape before dialog/composer handlers can act on it.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onBlur);
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("input", onInput, true);
    document.addEventListener("compositionstart", onInput, true);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("selectionchange", onSelection);
    return () => {
      cancel();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("compositionstart", onInput, true);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("selectionchange", onSelection);
    };
  }, []);

  if (!notice) return null;
  return (
    <div className="dictation" data-phase={notice.phase}>
      <Icon.mic size={18} />
      <span role={notice.phase === "error" ? "alert" : "status"}>{notice.text}</span>
      <button type="button" aria-label={notice.phase === "error" || notice.phase === "hint" ? "Dismiss transcription notice" : "Cancel transcription"} onPointerDown={(e) => e.preventDefault()} onClick={() => cancelRef.current()}>
        <Icon.x size={16} />
      </button>
    </div>
  );
}

function noticeVisible() { return !!document.querySelector(".dictation"); }
