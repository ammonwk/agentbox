import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AccountView, Placement, Session } from "../../../../src/core/types";
import { ago, api, fmtTokens } from "../../api";
import { AttachButton, AttachFrame, useAttachments } from "../../attachments";
import { PROVIDER_LABEL } from "../../bits";
import { Button, Icon } from "../../components";
import { AccountPicker } from "../newsession/AccountPicker";
import "../newsession.css";
import { useAction } from "./useAction";
import { echoSent } from "./echo";
import { QuestionCard } from "./Question";

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
export function Composer({ session, accounts, claimIdleMin }: { session: Session; accounts: readonly AccountView[]; claimIdleMin: number }) {
  const [text, setText] = useState("");
  const { run, busy, error, clear } = useAction();
  const mode = composerMode(session);
  const ref = useRef<HTMLTextAreaElement>(null);
  const provider = PROVIDER_LABEL[session.provider];
  const images = useAttachments({ text, setText, textareaRef: ref });

  // Grow with the text up to a cap, then scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, el.scrollHeight + 2)}px`;
  }, [text]);

  async function submit() {
    if (busy) return;
    if (mode.kind === "send" && !text.trim()) return;
    const ok = await run(async () => {
      const body = (await images.resolve(text)).trim();
      if (mode.kind === "send") {
        await api.send(session.id, body);
        echoSent(session.id, body);
      }
      else if (mode.kind === "resume") await api.resume(session.id, body || undefined);
    });
    if (ok) {
      setText("");
      images.clear();
    }
  }

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

      {session.question && mode.kind === "send" ? (
        <QuestionCard key={session.question.id} sessionId={session.id} ask={session.question} />
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

      {mode.kind !== "adopt" ? (
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
          title="Enter sends · Shift+Enter for a new line"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (images.onKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              (e.target as HTMLTextAreaElement).blur();
            }
          }}
        />
        </AttachFrame>
        <AttachButton a={images} className="cmp-attach" />
        {mode.kind === "send" ? (
          <>
            <Button
              className="cmp-go"
              variant="primary"
              icon={Icon.arrowUp}
              loading={busy}
              disabled={!text.trim() || images.uploading}
              aria-label="Send"
              onMouseDown={keepKeyboard}
              onClick={() => void submit()}
            >
              <span className="cmp-go-label">Send</span>
            </Button>
            <Button
              className="cmp-aux"
              title="Press Escape in the session — cancels the current prompt or menu"
              disabled={busy}
              onClick={() => void run(() => api.keys(session.id, ["Escape"]))}
            >
              Esc
            </Button>
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
          <Button
            className="cmp-go"
            variant="primary"
            icon={text.trim() ? Icon.arrowUp : Icon.play}
            loading={busy}
            aria-label={text.trim() ? "Resume with prompt" : "Resume"}
            onMouseDown={keepKeyboard}
            onClick={() => void submit()}
          >
            <span className="cmp-go-label">{text.trim() ? "Resume with prompt" : "Resume"}</span>
          </Button>
        ) : null}
      </div>
      ) : null}
      {/* Enter / Shift+Enter is what every chat box does; it lives in the
          textarea's tooltip rather than a permanent line under it. */}
      {session.cold && mode.kind !== "adopt" ? (
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
  return (
    <div className="cmp-limit" role="status">
      <Icon.gauge size={15} />
      <div className="cmp-limit-body">
        <strong>
          Stopped at {here ? `${here.label}'s` : "its account's"} limit {ago(hit.at)}
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
        {label}
      </Button>
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
