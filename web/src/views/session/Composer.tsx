import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject, type SetStateAction } from "react";
import type { AccountView, Placement, Session, SkillInfo } from "../../../../src/core/types";
import { ago, api, fmtRetryAt, fmtTokens, useNow } from "../../api";
import { AttachButton, AttachFrame, expandImages, tokensIn, useAttachments } from "../../attachments";
import { PROVIDER_LABEL } from "../../bits";
import { Button, Icon } from "../../components";
import { AccountPicker } from "../newsession/AccountPicker";
import { useSkillComplete } from "../newsession/skillcomplete";
import { hrefOf } from "../../route";
import { shownStatus } from "../../lib/board";
import { draftTaken, loadDraft, newRevision, onDraftWork, restorePending, saveDraft, submissionHash, type PendingSend } from "./drafts";
import { PendingSends, deliverPending } from "./submissions";
import "../newsession.css";
import { useAction } from "./useAction";
import { useVoiceNote, voiceNotes } from "./voicenote";
import { accountProvider } from "../../../../src/core/providers/account";

/** What the composer can do for a session, and the sentence that says so. */
export type ComposerMode =
  | { kind: "send" }
  | { kind: "resume" }
  | { kind: "adopt" }
  | { kind: "subagent" };

export function composerMode(s: Pick<Session, "host" | "status">): ComposerMode {
  if (s.host === "tmux") return { kind: "send" };
  if (s.host === "external") return { kind: "adopt" };
  if (s.host === "subagent") return { kind: "subagent" };
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
 * the box is replaced by the Adopt explanation. `/` completes the skills the
 * session can run, as in the new-session prompt.
 */
export function Composer({ session, accounts, skills, textareaRef }: {
  session: Session;
  accounts: readonly AccountView[];
  skills: readonly SkillInfo[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // The draft left here last time (the composer is keyed by session, so this
  // is read once per session). Sending clears it again.
  const draft = useMemo(() => loadDraft(session.id), [session.id]);
  const [text, setTextState] = useState(draft?.text ?? "");
  const revision = useRef(draft?.revision ?? newRevision());
  const setText = useCallback((next: SetStateAction<string>) => {
    revision.current = newRevision();
    setTextState(next);
  }, []);
  const submitting = useRef(false);
  const { run, busy, error, clear } = useAction();
  /** A voice message is on its way to words. */
  const [hearing, setHearing] = useState(false);
  /** The last failure was the recording's, not a send's. */
  const [spoke, setSpoke] = useState(false);
  const mode = composerMode(session);
  const ref = textareaRef;
  const provider = PROVIDER_LABEL[session.provider];
  const images = useAttachments({ text, setText, textareaRef: ref, initial: draft?.images, at: session.node ? session.id : undefined });
  const skill = useSkillComplete({ value: text, onChange: setText, skills, textareaRef: ref });
  /** Claude's side question: asked through the pane, answered in the Timeline, not sent as a message. */
  const btw = mode.kind === "send" && session.provider === "claude" ? BTW.exec(text) : null;
  /** Esc on the keyboard stops the turn: a session at its prompt has nothing to stop. */
  const interruptible = mode.kind === "send" && session.status === "running";
  // Esc from anywhere on the page that is not a field, the terminal (which
  // sends its own) or a dialog.
  useEffect(() => {
    if (!interruptible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || e.defaultPrevented) return;
      if (document.querySelector("[role=dialog]")) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest(".xterm") || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable)) return;
      e.preventDefault();
      void run(() => api.interrupt(session.id));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interruptible, session.id, run]);

  // Grow with the text up to a cap, then scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, el.scrollHeight + 2)}px`;
  }, [text]);

  // Remember the draft as it changes; sending empties the box, which deletes it.
  const savedImages = images.saved();
  const savedKey = JSON.stringify(savedImages);
  const editingRevision = revision.current;
  /** The revision this tab last saved, so emptying the box deletes our own
   *  draft and not a newer one written in another tab meanwhile. */
  const lastQueuedRevision = useRef(draft?.revision);
  useEffect(() => {
    const previous = lastQueuedRevision.current;
    lastQueuedRevision.current = editingRevision;
    void saveDraft(session.id, text, savedImages, editingRevision, previous);
  }, [session.id, text, savedKey, editingRevision]);
  // Taking a revision clears every tab holding that revision, before delivery.
  // A newer edit has its own revision, even if its text is identical.
  useEffect(
    () =>
      onDraftWork(() => {
        if (!draftTaken(session.id, revision.current)) return;
        revision.current = newRevision();
        setTextState("");
        images.clear();
      }),
    [session.id, images.clear],
  );

  async function submit() {
    if (busy || submitting.current || images.uploading) return;
    if (mode.kind === "send" && !text.trim()) return;
    setSpoke(false);
    submitting.current = true;
    // Snapshot uploaded paths before clearing attachments. Text typed while
    // storage or delivery is in flight belongs to a different revision.
    const sent = { text, images: images.saved(), at: Date.now(), revision: revision.current };
    try { await run(async () => {
      const paths = new Map(sent.images.map((i) => [i.n, i.path]));
      const missing = [...tokensIn(text)].filter((n) => !paths.has(n));
      if (missing.length) throw new Error(`image #${missing.join(", #")} did not upload — retry it or remove it`);
      const body = expandImages(text, paths).trim();
      const side = mode.kind === "send" && session.provider === "claude" ? BTW.exec(body) : null;
      const bodyHash = submissionHash(body);
      const pending: PendingSend = {
        id: newRevision(), sessionId: session.id, draft: sent,
        kind: side ? "btw" : mode.kind === "resume" ? "resume" : "send",
        body: side ? side[1]! : body, bodyHash, at: Date.now(), state: "pending", error: null,
      };
      // Taking the draft notifies any composer holding this revision. A
      // composer left meanwhile needs no cleanup: storage already took it.
      await deliverPending(pending);
    }); } finally { submitting.current = false; }
  }

  /** Put a voice message into words, after what is already in the box, to be read over before Send. */
  async function hear(audio: Blob) {
    if (busy) return;
    setSpoke(true);
    setHearing(true);
    try {
      await run(async () => {
        const heard = (await api.transcribe(audio)).trim();
        if (!heard) throw new Error("no speech was heard in the recording");
        setText((t) => [t.trimEnd(), heard].filter(Boolean).join(" "));
      });
    } finally {
      setHearing(false);
    }
  }

  const voice = useVoiceNote({
    onDone: (audio) => void hear(audio),
    onError: (why) => {
      setSpoke(true);
      void run(() => Promise.reject(new Error(why)));
    },
    working: hearing,
  });
  /** A phone: Send is also the microphone, held. */
  const talks = voiceNotes();
  const recording = voice.phase !== "idle";

  const placeholder =
    mode.kind === "send"
      ? session.status === "running"
        ? `Message ${provider} — it arrives when the current step yields`
        : `Message ${provider}`
      : "Stopped. Type a prompt to resume with it, or just press Resume.";
  const lastOn = accounts.find((a) => a.id === session.accountId)?.label ?? null;

  return (
    <div className="cmp" data-mode={mode.kind}>
      <PendingSends sessionId={session.id} onRestore={async (p) => {
        const previousRevision = revision.current;
        const restoredRevision = newRevision();
        let n = Math.max(0, ...images.atts.map((a) => a.n), ...tokensIn(text));
        const numbers = new Map(p.draft.images.map((a) => [a.n, ++n]));
        const restoredImages = p.draft.images.map((a) => ({ ...a, n: numbers.get(a.n)! }));
        const recovered = p.draft.text.replace(/\[Image #(\d+)\]/g, (token, old: string) => numbers.has(Number(old)) ? `[Image #${numbers.get(Number(old))}]` : token);
        const restored = [text.trimEnd(), recovered].filter(Boolean).join("\n\n");
        await restorePending(session.id, p.id, { text: restored, images: [...images.saved(), ...restoredImages], at: Date.now(), revision: restoredRevision }, previousRevision, () => revision.current === previousRevision);
        images.restore(restoredImages);
        revision.current = restoredRevision;
        setTextState(restored);
      }} />
      {error ? (
        <div className="cmp-error" role="alert">
          <Icon.alert size={13} /> {spoke ? "Not heard" : mode.kind === "resume" ? "Could not resume" : btw ? "Not asked" : "Not sent"}: {error}
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

      {mode.kind === "subagent" ? (
        <div className="cmp-note">
          <Icon.external size={14} />
          <span>
            {session.subagent?.answerWaiting
              ? session.status === "running"
                ? "An earlier answer is still waiting to be collected. "
                : "Finished, and its answer is waiting to be collected. "
              : null}
            A subagent its{" "}
            {session.parent ? <a href={hrefOf({ page: "session", id: session.parent, tab: "terminal" })}>parent session</a> : "parent session"} runs
            through its subagent MCP, so it is read-only here: steer or stop it through the parent. It stops when the parent does,
            and can be resumed here after that.
          </span>
        </div>
      ) : null}

      {/* An error screen agentbox retries is not a prompt for you: the session view says so. */}
      {session.question && mode.kind === "send" ? null : session.status === "blocked" && mode.kind === "send" && shownStatus(session) !== "retrying" ? (
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

      {session.limitHit ? <LimitBanner session={session} accounts={accounts} /> : null}

      {mode.kind === "send" || mode.kind === "resume" ? (
      <div className="cmp-row">
        <label className="sr-only" htmlFor={`cmp-${session.id}`}>
          {mode.kind === "resume" ? "Prompt to resume with" : "Message to the agent"}
        </label>
        {/* One box: the paperclip, the text, then the keys and Send. Pasted
            images go under the text, inside the box. */}
        <AttachFrame a={images} className="cmp-frame">
        <AttachButton a={images} className="cmp-attach" />
        <textarea
          id={`cmp-${session.id}`}
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          enterKeyHint="send"
          title="Enter sends · Shift+Enter for a new line · / for skills · Esc stops a running turn"
          {...skill.props}
          onChange={(e) => {
            setText(e.target.value);
            skill.onEdit(e.target);
          }}
          onKeyDown={(e) => {
            if (skill.onKeyDown(e) || images.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              // Mid-turn Esc stops the turn, as it does in the terminal; at rest it leaves the box.
              if (interruptible) {
                e.preventDefault();
                if (!e.repeat && !busy) void run(() => api.interrupt(session.id));
              } else (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        {skill.list}
        {voice.bar}
        <div className="cmp-tools">
          {mode.kind === "send" ? (
            <>
              {/* Esc and Interrupt only while there is a turn or a prompt to stop. */}
              {session.status === "running" || session.status === "blocked" ? (
                <button
                  type="button"
                  className="cmp-tool cmp-esc"
                  title="Press Escape in the session — cancels the current prompt or menu"
                  aria-label="Press Escape in the session"
                  disabled={busy}
                  onClick={() => void run(() => api.keys(session.id, ["Escape"]))}
                >
                  esc
                </button>
              ) : null}
              {session.status === "running" ? (
                <button
                  type="button"
                  className="cmp-tool cmp-stop"
                  title="Interrupt the current turn (Esc)"
                  aria-label="Interrupt the current turn"
                  disabled={busy}
                  onClick={() => void run(() => api.interrupt(session.id))}
                >
                  <Icon.stop size={14} />
                </button>
              ) : null}
              <span className="cmp-go-wrap">
                {voice.above}
                <Button
                  className="cmp-go"
                  variant="ghost"
                  icon={voice.phase === "locked" ? Icon.check : talks && (voice.phase === "held" || !text.trim()) ? Icon.mic : Icon.send}
                  loading={busy}
                  disabled={talks ? images.uploading : !text.trim() || images.uploading}
                  title="Send (Enter)"
                  aria-label={voice.phase === "locked" ? "Finish the recording" : talks && !text.trim() ? "Hold to record a voice message" : "Send"}
                  data-ready={text.trim() ? true : undefined}
                  data-rec={recording ? voice.phase : undefined}
                  onMouseDown={keepKeyboard}
                  {...(talks ? voice.button : {})}
                  onClick={() => {
                    if (voice.click()) return;
                    if (talks && !text.trim()) voice.hint();
                    else void submit();
                  }}
                />
              </span>
            </>
          ) : (
            <span className="cmp-go-wrap">
              {voice.above}
              <Button
                className="cmp-go"
                variant="ghost"
                icon={voice.phase === "locked" ? Icon.check : voice.phase === "held" ? Icon.mic : text.trim() ? Icon.send : Icon.play}
                loading={busy}
                aria-label={voice.phase === "locked" ? "Finish the recording" : text.trim() ? "Resume with prompt" : "Resume"}
                data-ready
                data-rec={recording ? voice.phase : undefined}
                onMouseDown={keepKeyboard}
                {...(talks ? voice.button : {})}
                onClick={() => {
                  if (!voice.click()) void submit();
                }}
              >
                <span className="cmp-go-label">{text.trim() ? "Resume with prompt" : "Resume"}</span>
              </Button>
            </span>
          )}
        </div>
        </AttachFrame>
        {mode.kind === "send" ? (
          // A phone has no Esc or arrow keys: these send them to the session.
          <div className="cmp-aux cmp-navigation">
            {(["Escape", "Up", "Down", "Enter"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className="keycap cmp-phone-key"
                title={`Press ${key} in the session`}
                aria-label={`Press ${key} in the session`}
                disabled={busy}
                onClick={() => void run(() => api.keys(session.id, [key]))}
              >
                {key === "Escape" ? "Esc" : key === "Up" ? "↑" : key === "Down" ? "↓" : "Enter"}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      ) : null}
      {/* Enter / Shift+Enter is what every chat box does; it lives in the
          textarea's tooltip rather than a permanent line under it. */}
      {btw ? (
        <div className="cmp-hint">A side question: Claude answers from what it already knows, without tools and without stopping its work. The answer shows in the Timeline.</div>
      ) : session.cold && mode.kind !== "adopt" ? (
        <div className="cmp-hint">
          Idle since {ago(session.lastActivityAt)}, so its cache is cold: {mode.kind === "send" ? "a message" : "resuming"} wakes it on whichever account has
          room{lastOn ? ` (last on ${lastOn})` : ""}{mode.kind === "send" ? ", restarting it there if that is another one" : ""}.
        </div>
      ) : mode.kind === "resume" ? (
        <div className="cmp-hint">Resumes on the same account{lastOn ? `, ${lastOn}` : ""}, in agentbox&apos;s tmux — its cache is still warm.</div>
      ) : null}
    </div>
  );
}

const BTW = /^\/btw\s+(\S[\s\S]*)$/;

/** Pressing Send leaves the box focused, so the keyboard stays up for the next
 *  message, as every phone chat does. */
const keepKeyboard = (e: ReactMouseEvent) => e.preventDefault();

const CONTINUE = "Usage limits have reset, continue";

/** Providers whose adapter can move a transcript between account homes
 *  (`moveSession`); the others can only continue where they are. */
const MOVABLE = new Set(["claude", "devin", "omp", "opencode"]);

/**
 * The session stopped at its account's limit. The fleet moves it to another
 * account once in its life (`Fleet.continueStalled`); this is what is left
 * when it has had that move or there was nowhere to go: continue on the
 * balancer's pick (shown before you click), or on whichever account you pick
 * instead, telling the agent to carry on.
 */
function LimitBanner({ session, accounts }: { session: Session; accounts: readonly AccountView[] }) {
  const { run, busy, error, clear } = useAction();
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [placeErr, setPlaceErr] = useState<string | null>(null);
  const [choice, setChoice] = useState("auto");
  /** Phones show one line and the button; the why and the picker are behind this. */
  const [more, setMore] = useState(false);
  const hit = session.limitHit!;
  const now = useNow(15_000);
  useEffect(() => {
    let cancelled = false;
    setChoice("auto");
    api
      .placement({ provider: session.provider, ...(session.model ? { model: session.model } : {}) })
      .then((p) => {
        if (cancelled) return;
        setPlacement(p);
        setPlaceErr(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPlacement(null);
        setPlaceErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [session.id, hit.at]);

  const mine = accounts.filter((a) => a.provider === accountProvider(session.provider));
  const canMove = MOVABLE.has(session.provider) && mine.length > 1;
  const here = accounts.find((a) => a.id === session.accountId) ?? null;
  const auto = placement?.accountId && placement.mode !== "none" ? accounts.find((a) => a.id === placement.accountId) ?? null : null;
  const target = choice !== "auto" ? mine.find((a) => a.id === choice) ?? null : canMove ? auto : null;
  const moves = !!target && target.id !== session.accountId;
  const label = moves ? `Continue on ${target!.label}` : "Continue here";
  // A move starts the conversation over on a cold cache: all of its context
  // is sent again, uncached.
  const resend = session.contextUsed ? `${fmtTokens(session.contextUsed)} tokens of context` : "the whole conversation";
  // "You've hit your weekly limit · resets Sep 30, 11am (America/Denver)" → "Weekly limit · resets Sep 30, 11am"
  const short = hit.detail.replace(/^you've hit your /i, "").replace(/\s*\([^)]*\)\s*$/, "");
  return (
    <div className="cmp-limit" role="status" data-more={more || undefined}>
      <Icon.gauge size={15} />
      <div className="cmp-limit-body">
        <strong className="cmp-limit-long">
          Stopped at {here ? `${here.label}'s` : "its account's"} limit {ago(hit.at)}
        </strong>
        <strong className="cmp-limit-short" title={`${hit.detail}, on ${here?.label ?? "its account"}`}>
          {short.charAt(0).toUpperCase() + short.slice(1)} · {ago(hit.at)}
        </strong>
        <span className="cmp-limit-detail">{hit.detail}</span>
        {hit.hopped ? (
          <span className="cmp-limit-auto">agentbox already moved it off one account at its limit, and does that once: from here a move is yours.</span>
        ) : null}
        {session.autoResume ? (
          <span className="cmp-limit-auto">
            agentbox tells it to carry on here {fmtRetryAt(session.autoResume.at, now)}, a minute after the window resets — or send it
            something yourself.
          </span>
        ) : null}
        {error ? (
          <span className="cmp-limit-err">
            {error}{" "}
            <button className="linkish" onClick={clear}>
              dismiss
            </button>
          </span>
        ) : (
          <span className="cmp-limit-why">
            {moves
              ? `${choice !== "auto" ? "" : placement?.mode === "overflow" ? `${target!.label} is the least claimed. ` : `${target!.label} has the most room. `}Moving re-sends ${resend} without the cache; the agent is told “${CONTINUE}”.`
              : choice !== "auto"
                ? `Stays here; the agent is told “${CONTINUE}”.`
                : !canMove
                  ? `It can only continue here, so this just tells it “${CONTINUE}”.`
                  : placement
                    ? `The balancer would keep it here, so this just tells it “${CONTINUE}”.`
                    : placeErr
                      ? `Could not ask the balancer (${placeErr}); pick an account below, or continue here.`
                      : "Asking the balancer where there is room…"}
          </span>
        )}
      </div>
      <Button
        size="sm"
        variant="primary"
        icon={Icon.play}
        loading={busy}
        disabled={choice === "auto" && !placement && !placeErr}
        title={choice === "auto" ? placement?.why : undefined}
        onClick={() => void run(() => api.move(session.id, { accountId: moves ? target!.id : session.accountId ?? "auto", prompt: CONTINUE }))}
      >
        <span className="cmp-limit-label">{label}</span>
      </Button>
      <button type="button" className="cmp-limit-more" aria-expanded={more} aria-label={more ? "Less" : "Why, and pick an account"} onClick={() => setMore(!more)}>
        <Icon.chevronDown size={14} className={more ? "rot" : undefined} />
      </button>
      {canMove ? (
        <div className="cmp-limit-pick">
          <AccountPicker
            accounts={mine}
            allAccounts={[...accounts]}
            value={choice}
            onChange={setChoice}
            placement={placement}
            placing={!placement && !placeErr}
            placeErr={placeErr}
          />
        </div>
      ) : null}
    </div>
  );
}
