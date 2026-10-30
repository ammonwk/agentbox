/** Editing one of your messages, and reading the conversation through another
 *  version of one (docs/v2.md "Editing a message").
 *
 * Edit goes back to the message in the CLI itself and carries on from there
 * with what you wrote instead (Claude's rewind, driven by the server). What
 * was said after it stays in the transcript, so the message then has
 * versions, "‹ 2/3 ›": the conversation as it stands is one; the others are
 * read here as they were, and can be carried on from.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ProviderId, Session, TimelineEvent } from "../../../../src/core/types";
import { api } from "../../api";
import { Button, Icon } from "../../components";
import { go } from "../../route";
import { useDismiss, useFloating } from "../newsession/popover";

type UserEvent = Extract<TimelineEvent, { kind: "user" }>;
export type EditMode = "send" | "code" | "fork";

/** What each CLI's own rewind can do from here (`ProviderAdapter.rewind`). */
const EDITS: Partial<Record<ProviderId, { code: boolean; fork: boolean; switch: boolean }>> = {
  claude: { code: true, fork: true, switch: true },
};

export const editsOf = (provider: ProviderId) => EDITS[provider] ?? null;

/** What a message bubble needs to offer Edit and its versions. */
export interface MessageEdits {
  session: Session;
  /** Edit is offered: the conversation as it stands, a CLI that can go back, a session typed into here. */
  canEdit: boolean;
  editing: string | null;
  setEditing(id: string | null): void;
  /** Show the conversation through version `to` of `ev`. */
  flip(ev: UserEvent, to: number): void;
}

export const EditsCtx = createContext<MessageEdits | null>(null);

/** An edit left open, kept per session in this browser so leaving the session
 *  (or reloading) brings it back as it was. Ended by Cancel, a send, or a flip. */
interface OpenEdit {
  ev: string;
  text: string;
  at: number;
}
const OPEN_EDITS = "agentbox.openEdits";
function openEdits(): Record<string, OpenEdit> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPEN_EDITS) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, OpenEdit>) : {};
  } catch {
    return {};
  }
}
export const openEdit = (sessionId: string): OpenEdit | null => openEdits()[sessionId] ?? null;
export function keepEdit(sessionId: string, edit: { ev: string; text: string } | null): void {
  const all = openEdits();
  if (edit) all[sessionId] = { ...edit, at: Date.now() };
  else delete all[sessionId];
  const kept = Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, 30);
  try {
    localStorage.setItem(OPEN_EDITS, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* private mode: the edit lasts while the session is open */
  }
}

/** `‹ 2/3 ›` under a message with versions. */
export function VersionNav({ ev }: { ev: UserEvent }) {
  const edits = useContext(EditsCtx);
  const v = ev.versions;
  if (!v || !edits) return null;
  return (
    <span className="tl-versions" aria-label={`Version ${v.index + 1} of ${v.of.length}`}>
      <button type="button" className="tl-me-act" disabled={v.index === 0} aria-label="Previous version" title="The version before" onClick={() => edits.flip(ev, v.index - 1)}>
        <Icon.chevronLeft size={13} />
      </button>
      <span>
        {v.index + 1}/{v.of.length}
      </span>
      <button type="button" className="tl-me-act" disabled={v.index === v.of.length - 1} aria-label="Next version" title="The version after" onClick={() => edits.flip(ev, v.index + 1)}>
        <Icon.chevronRight size={13} />
      </button>
    </span>
  );
}

/** The pencil beside Copy. */
export function EditButton({ ev }: { ev: UserEvent }) {
  const edits = useContext(EditsCtx);
  if (!edits?.canEdit) return null;
  return (
    <button type="button" className="tl-me-act tl-me-hover" aria-label="Edit the message" title="Edit: go back to here and send something else" onClick={() => edits.setEditing(ev.id)}>
      <Icon.edit size={14} />
    </button>
  );
}

const MODES: { mode: EditMode; label: string; detail: string }[] = [
  { mode: "send", label: "Send", detail: "Go back to before this message and carry on with this instead. What came after stays as the other version. From before the conversation was compacted, it carries on in a new session instead, as Fork here does." },
  { mode: "code", label: "Undo code changes and send", detail: "The same, and put the files back as they were before it (what the agent changed with its own edit tools)." },
  { mode: "fork", label: "Fork here", detail: "A new session with the conversation up to here, carrying on with this. This one stays as it is." },
];

/** The message being edited, in place of its bubble. */
export function EditBox({ ev, text }: { ev: UserEvent; text: string }) {
  const edits = useContext(EditsCtx)!;
  const { session } = edits;
  const can = editsOf(session.provider);
  const [draft, setDraft] = useState(() => {
    const kept = openEdit(session.id);
    return kept?.ev === ev.id ? kept.text : text;
  });
  const [busy, setBusy] = useState<EditMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const style = useFloating(caret, menu, 300, 300, "end");
  useDismiss(menu, () => setMenu(false), [caret, list]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    // It is in view when opened; on coming back, the timeline puts you where you were.
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => keepEdit(session.id, { ev: ev.id, text: draft }), [session.id, ev.id, draft]);
  // Grow with what is typed, up to most of the view.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, window.innerHeight * 0.6)}px`;
  }, [draft]);

  const modes = MODES.filter((m) => m.mode === "send" || (m.mode === "code" ? can?.code : can?.fork));
  const submit = async (mode: EditMode) => {
    setMenu(false);
    if (!draft.trim() || busy) return;
    setBusy(mode);
    setError(null);
    try {
      const sent = mode === "fork" ? await api.fork(session.id, ev.id, draft) : await api.edit(session.id, ev.id, draft, mode, crypto.randomUUID());
      // A message from before the conversation was compacted is edited in a fork.
      if ("session" in sent) {
        edits.setEditing(null);
        go({ page: "session", id: sent.session.id, tab: "timeline" });
        return;
      }
      const { receipt } = sent;
      if (receipt.state === "sent") edits.setEditing(null);
      else setError(receipt.error ?? `not confirmed (${receipt.state}); the Terminal tab shows where it is`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tl-edit" data-ev={ev.id}>
      <textarea
        ref={area}
        className="tl-edit-input"
        value={draft}
        disabled={!!busy}
        aria-label="The message, edited"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.preventDefault();
            edits.setEditing(null);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit("send");
          }
        }}
      />
      {error ? (
        <div className="tl-edit-error" role="alert">
          <Icon.alert size={12} /> {error}
        </div>
      ) : null}
      <div className="tl-edit-foot">
        <span className="tl-edit-note">
          {ev.images ? `Its ${ev.images === 1 ? "image is" : "images are"} not sent again. ` : ""}
          {session.status === "running" ? "It is working: this stops it first." : ""}
        </span>
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => edits.setEditing(null)}>
          Cancel
        </Button>
        <span className="tl-split">
          <Button size="sm" variant="primary" loading={busy === "send" || busy === "code"} disabled={!!busy || !draft.trim()} onClick={() => void submit("send")} title="Go back to before this message and carry on with this (Ctrl+Enter)">
            {busy === "fork" ? "Forking…" : "Save & Send"}
          </Button>
          {modes.length > 1 ? (
            <Button
              ref={caret}
              size="sm"
              variant="primary"
              className="tl-split-caret"
              icon={Icon.chevronDown}
              aria-label="More ways to send it"
              aria-haspopup="menu"
              aria-expanded={menu}
              disabled={!!busy || !draft.trim()}
              onClick={() => setMenu(!menu)}
            />
          ) : null}
        </span>
      </div>
      {menu ? (
        <div ref={list} className="tl-split-menu" role="menu" style={style}>
          {modes.map((m) => (
            <button key={m.mode} type="button" role="menuitem" className="tl-split-item" onClick={() => void submit(m.mode)}>
              <span className="tl-split-label">{m.label}</span>
              <span className="tl-split-detail">{m.detail}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Said while reading another version: which, and the ways back. */
export function VersionBar({ session, via, version, onBack }: { session: Session; via: string; version: { index: number; of: number } | null; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = editsOf(session.provider)?.switch && session.host !== "external" && session.host !== "subagent";
  const working = session.status === "running";
  const carryOn = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.continueFrom(session.id, via);
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tl-version-bar" role="status">
      <Icon.branch size={14} />
      <span className="tl-version-text">
        {error ?? (
          <>
            Reading {version ? `version ${version.index + 1} of ${version.of}` : "another version"} of a message. The session carries on from another.
          </>
        )}
      </span>
      {can ? (
        <Button size="sm" loading={busy} disabled={working} title={working ? "It is mid-turn: wait for it, or stop it" : "Carry on from this version: your next message follows it"} onClick={() => void carryOn()}>
          Continue from here
        </Button>
      ) : null}
      <Button size="sm" variant="primary" onClick={onBack}>
        Back to current
      </Button>
    </div>
  );
}
