import { useEffect, useRef, useState } from "react";
import type { Session } from "../../../../src/core/types";
import { api } from "../../api";
import { PROVIDER_LABEL } from "../../bits";
import { Button, Icon } from "../../components";
import { useAction } from "./useAction";

/** What the composer can do for a session, and the sentence that says so. */
export type ComposerMode =
  | { kind: "send" }
  | { kind: "resume" }
  | { kind: "adopt" };

export function composerMode(s: Pick<Session, "host" | "status">): ComposerMode {
  if (s.host === "tmux") return { kind: "send" };
  if (s.host === "external") return { kind: "adopt" };
  return { kind: "resume" };
}

/** Keys worth a button when the agent is showing a prompt. tmux key names. */
const PROMPT_KEYS: { keys: string[]; label: string; title: string }[] = [
  { keys: ["Enter"], label: "Enter", title: "Accept the highlighted option" },
  { keys: ["1"], label: "1", title: "Pick option 1" },
  { keys: ["2"], label: "2", title: "Pick option 2" },
  { keys: ["3"], label: "3", title: "Pick option 3" },
  { keys: ["Up"], label: "↑", title: "Move up" },
  { keys: ["Down"], label: "↓", title: "Move down" },
];

/**
 * Type into the session. For a session in agentbox's tmux, Enter pastes the
 * text into the TUI (bracketed, so newlines stay one prompt) and presses
 * Enter. For a stopped one, the text becomes the prompt it resumes with. A
 * session in someone else's terminal cannot be typed into until adopted, so
 * the box is replaced by the Adopt explanation.
 */
export function Composer({ session }: { session: Session }) {
  const [text, setText] = useState("");
  const { run, busy, error, clear } = useAction();
  const mode = composerMode(session);
  const ref = useRef<HTMLTextAreaElement>(null);
  const provider = PROVIDER_LABEL[session.provider];

  // Grow with the text up to a cap, then scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, el.scrollHeight + 2)}px`;
  }, [text]);

  async function submit() {
    const body = text.trim();
    if (busy) return;
    if (mode.kind === "send") {
      if (!body) return;
      if (await run(() => api.send(session.id, body))) setText("");
    } else if (mode.kind === "resume") {
      if (await run(() => api.resume(session.id, body || undefined))) setText("");
    }
  }

  const placeholder =
    mode.kind === "send"
      ? session.status === "running"
        ? `Message ${provider} — it arrives when the current step yields`
        : `Message ${provider}`
      : "Stopped. Type a prompt to resume with it, or just press Resume.";

  return (
    <div className="cmp" data-mode={mode.kind}>
      {error ? (
        <div className="cmp-error" role="alert">
          <Icon.alert size={13} /> {mode.kind === "resume" ? "Could not resume" : "Not sent"}: {error}
          <button className="linkish" onClick={clear}>
            dismiss
          </button>
        </div>
      ) : null}

      {mode.kind === "adopt" ? (
        <div className="cmp-note">
          <Icon.external size={14} />
          <span>
            Running in a terminal agentbox did not start{session.pid ? ` (pid ${session.pid})` : ""}, so it is read-only here.{" "}
            <strong>Adopt</strong> stops that process only after proving the conversation resumes, then continues it in agentbox&apos;s
            tmux on the same account.
          </span>
          <Button size="sm" variant="primary" icon={Icon.link} loading={busy} onClick={() => void run(() => api.adopt(session.id))}>
            Adopt
          </Button>
        </div>
      ) : null}

      {session.status === "blocked" && mode.kind === "send" ? (
        <div className="cmp-keys" role="group" aria-label="Answer the prompt">
          <span className="cmp-keys-label">
            <Icon.alert size={13} /> The agent is showing a prompt — answer it in the terminal, or send a key:
          </span>
          {PROMPT_KEYS.map((k) => (
            <button
              key={k.label}
              className="keycap"
              title={k.title}
              disabled={busy}
              onClick={() => void run(() => api.keys(session.id, k.keys))}
            >
              {k.label}
            </button>
          ))}
        </div>
      ) : null}

      {mode.kind !== "adopt" ? (
      <div className="cmp-row">
        <label className="sr-only" htmlFor={`cmp-${session.id}`}>
          {mode.kind === "resume" ? "Prompt to resume with" : "Message to the agent"}
        </label>
        <textarea
          id={`cmp-${session.id}`}
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          title="Enter sends · Shift+Enter for a new line"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        {mode.kind === "send" ? (
          <>
            <Button
              variant="primary"
              icon={Icon.send}
              loading={busy}
              disabled={!text.trim()}
              onClick={() => void submit()}
            >
              Send
            </Button>
            <Button
              title="Press Escape in the session — cancels the current prompt or menu"
              disabled={busy}
              onClick={() => void run(() => api.keys(session.id, ["Escape"]))}
            >
              Esc
            </Button>
            <Button
              variant="danger"
              icon={Icon.stop}
              title="Interrupt the current turn"
              disabled={busy || session.status !== "running"}
              onClick={() => void run(() => api.interrupt(session.id))}
            >
              Interrupt
            </Button>
          </>
        ) : mode.kind === "resume" ? (
          <Button variant="primary" icon={Icon.play} loading={busy} onClick={() => void submit()}>
            {text.trim() ? "Resume with prompt" : "Resume"}
          </Button>
        ) : null}
      </div>
      ) : null}
      {/* Enter / Shift+Enter is what every chat box does; it lives in the
          textarea's tooltip rather than a permanent line under it. */}
      {mode.kind === "resume" ? <div className="cmp-hint">Resumes on the same account it started on, in agentbox&apos;s tmux.</div> : null}
    </div>
  );
}
