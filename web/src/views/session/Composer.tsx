import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import type { AccountView, Placement, Session, SkillInfo } from "../../../../src/core/types";
import { ago, api, fmtTokens, useBtw } from "../../api";
import { AttachButton, AttachFrame, useAttachments } from "../../attachments";
import { PROVIDER_LABEL } from "../../bits";
import { Button, Icon } from "../../components";
import { AccountPicker } from "../newsession/AccountPicker";
import { useSkillComplete } from "../newsession/skillcomplete";
import { hrefOf, type SessionTab } from "../../route";
import { loadDraft, saveDraft } from "./drafts";
import "../newsession.css";
import { useAction } from "./useAction";
import { echoSent } from "./echo";
import { QuestionCard } from "./Question";
import { useVoiceNote, voiceNotes } from "./voicenote";

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
export function Composer({ session, tab, accounts, claimIdleMin, skills, textareaRef }: {
  session: Session;
  /** The tab showing above: the terminal has the question's own dialog, so the card stays off it. */
  tab: SessionTab;
  accounts: readonly AccountView[];
  claimIdleMin: number;
  skills: readonly SkillInfo[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  // The draft left here last time (the composer is keyed by session, so this
  // is read once per session). Sending clears it again.
  const draft = useMemo(() => loadDraft(session.id), [session.id]);
  const [text, setText] = useState(draft?.text ?? "");
  const { run, busy, error, clear } = useAction();
  /** A voice message is on its way to words. */
  const [hearing, setHearing] = useState(false);
  const mode = composerMode(session);
  const ref = textareaRef;
  const provider = PROVIDER_LABEL[session.provider];
  const images = useAttachments({ text, setText, textareaRef: ref, initial: draft?.images });
  const skill = useSkillComplete({ value: text, onChange: setText, skills, textareaRef: ref });
  const btwCards = useBtw(session.id);
  /** Claude's side question: asked through the pane, answered in the Timeline, not sent as a message. */
  const btw = mode.kind === "send" && session.provider === "claude" ? BTW.exec(text) : null;
  // Side questions with a card up in the Timeline. Live only while the
  // timeline's watch is held (this box shows on every tab); elsewhere the
  // list is empty and Esc goes to the pane, which is what that tab wants.
  const openCards = useMemo(() => btwCards.filter((b) => b.status !== "dismissed"), [btwCards]);
  // A prompt showing takes precedence: Esc there cancels it, and the card can wait.
  const escTakesCard = openCards.length > 0 && session.status !== "blocked";

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
  useEffect(() => {
    saveDraft(session.id, text, savedImages);
  }, [session.id, text, savedKey]);

  /** Send what is in the box and, after it, what `spoken` says. */
  async function submit(spoken?: Blob) {
    if (busy) return;
    if (mode.kind === "send" && !spoken && !text.trim()) return;
    let heard = "";
    const ok = await run(async () => {
      if (spoken) {
        setHearing(true);
        try {
          heard = await api.transcribe(spoken);
        } finally {
          setHearing(false);
        }
        if (!heard) throw new Error("no speech was heard in the recording");
      }
      const body = [(await images.resolve(text)).trim(), heard].filter(Boolean).join("\n\n");
      const side = mode.kind === "send" && session.provider === "claude" ? BTW.exec(body) : null;
      if (side) await api.btw(session.id, side[1]!);
      else if (mode.kind === "send") {
        await api.send(session.id, body);
        echoSent(session.id, body);
      }
      else if (mode.kind === "resume") await api.resume(session.id, body || undefined);
    });
    if (ok) {
      setText("");
      images.clear();
    } else if (heard) {
      // Heard but not delivered: the words wait in the box rather than being said again.
      setText((t) => [t.trim(), heard].filter(Boolean).join("\n\n"));
    }
  }

  const voice = useVoiceNote({
    onDone: (audio) => void submit(audio),
    onError: (why) => void run(() => Promise.reject(new Error(why))),
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
      {error ? (
        <div className="cmp-error" role="alert">
          <Icon.alert size={13} /> {mode.kind === "resume" ? "Could not resume" : btw ? "Not asked" : "Not sent"}: {error}
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

      {session.question && mode.kind === "send" ? (
        tab === "terminal" && session.host === "tmux" ? null : (
          <QuestionCard key={session.question.id} sessionId={session.id} ask={session.question} />
        )
      ) : session.status === "blocked" && mode.kind === "send" ? (
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

      {session.limitHit ? <LimitBanner session={session} accounts={accounts} claimIdleMin={claimIdleMin} /> : null}

      {mode.kind === "send" || mode.kind === "resume" ? (
      <div className="cmp-row">
        <label className="sr-only" htmlFor={`cmp-${session.id}`}>
          {mode.kind === "resume" ? "Prompt to resume with" : "Message to the agent"}
        </label>
        <AttachFrame a={images} className="cmp-frame">
        <textarea
          id={`cmp-${session.id}`}
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder}
          enterKeyHint="send"
          title="Enter sends · Shift+Enter for a new line · / for skills"
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
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        {skill.list}
        {voice.bar}
        </AttachFrame>
        <AttachButton a={images} className="cmp-attach" />
        {mode.kind === "send" ? (
          <>
            <span className="cmp-go-wrap">
              {voice.above}
              <Button
                className="cmp-go"
                variant="primary"
                icon={talks && (voice.phase === "held" || (!recording && !text.trim())) ? Icon.mic : Icon.arrowUp}
                loading={busy}
                disabled={talks ? images.uploading : !text.trim() || images.uploading}
                aria-label={voice.phase === "locked" ? "Send the recording" : talks && !text.trim() ? "Hold to record a voice message" : "Send"}
                data-rec={recording ? voice.phase : undefined}
                onMouseDown={keepKeyboard}
                {...(talks ? voice.button : {})}
                onClick={() => {
                  if (voice.click()) return;
                  if (talks && !text.trim()) voice.hint();
                  else void submit();
                }}
              >
                <span className="cmp-go-label">Send</span>
              </Button>
            </span>
            <div className="cmp-aux cmp-navigation">
              <Button
                className="cmp-aux"
                title={
                  escTakesCard
                    ? "Puts the side question's card away; a panel still up in the pane closes with it"
                    : "Press Escape in the session — cancels the current prompt or menu"
                }
                disabled={busy}
                onClick={() => {
                  if (escTakesCard) for (const b of openCards) void api.btwDismiss(session.id, b.id).catch(() => {});
                  else void run(() => api.keys(session.id, ["Escape"]));
                }}
              >
                Esc
              </Button>
              {(["Up", "Down", "Enter"] as const).map((key) => (
                <Button
                  key={key}
                  className="cmp-phone-key"
                  title={`Press ${key} in the session`}
                  aria-label={`Press ${key} in the session`}
                  disabled={busy}
                  onClick={() => void run(() => api.keys(session.id, [key]))}
                >
                  {key === "Up" ? "↑" : key === "Down" ? "↓" : "Enter"}
                </Button>
              ))}
            </div>
            <Button
              className="cmp-aux"
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
          <span className="cmp-go-wrap">
            {voice.above}
            <Button
              className="cmp-go"
              variant="primary"
              icon={voice.phase === "held" ? Icon.mic : recording || text.trim() ? Icon.arrowUp : Icon.play}
              loading={busy}
              aria-label={voice.phase === "locked" ? "Resume with the recording" : text.trim() ? "Resume with prompt" : "Resume"}
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
const MOVABLE = new Set(["claude", "devin"]);

/**
 * The session stopped at its account's limit. Nothing moves it on its own —
 * a move is a cache miss you should choose — so this offers the one-click
 * version: continue on the account with the most room (the balancer's pick,
 * shown before you click), or on whichever account you pick instead, telling
 * the agent to carry on.
 */
function LimitBanner({ session, accounts, claimIdleMin }: { session: Session; accounts: readonly AccountView[]; claimIdleMin: number }) {
  const { run, busy, error, clear } = useAction();
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [placeErr, setPlaceErr] = useState<string | null>(null);
  const [choice, setChoice] = useState("auto");
  /** Phones show one line and the button; the why and the picker are behind this. */
  const [more, setMore] = useState(false);
  const hit = session.limitHit!;
  useEffect(() => {
    let cancelled = false;
    setChoice("auto");
    api
      .placement({ provider: session.provider, big: session.big, ...(session.model ? { model: session.model } : {}) })
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

  const mine = accounts.filter((a) => a.provider === session.provider);
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
            claimIdleMin={claimIdleMin}
          />
        </div>
      ) : null}
    </div>
  );
}
