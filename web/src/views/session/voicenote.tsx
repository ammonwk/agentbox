import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../../components";
import { isPhone } from "../../lib/phone";
import "../voicenote.css";

/**
 * A voice message from the Send button, the way WhatsApp's works: hold it to
 * record and let go to finish; slide up while holding to lock the recording,
 * so it carries on without a finger until the button is tapped; slide left,
 * or the bin once locked, to throw it away. The recording goes to the caller
 * whole, which has it put into words (`api.transcribe`) and puts those in the
 * text box, to be read over and corrected before they are sent.
 */

/** A press shorter than this is a tap: Send, as before. */
const HOLD_MS = 250;
/** How far up locks, and how far left cancels. */
const LOCK_PX = 64;
const CANCEL_PX = 90;
/** Shorter than this was a slip of the thumb, not a message. */
const MIN_MS = 600;
/** The server's cap (MAX_AUDIO_BYTES). */
const MAX_BYTES = 40 * 1024 * 1024;

/** Chrome and Firefox record webm/opus, Safari mp4; Deepgram reads either. */
const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

/** Phones and tablets: where there is a thumb to hold a button with. */
export function voiceNotes(): boolean {
  return typeof window !== "undefined" && (isPhone() || window.matchMedia("(pointer: coarse)").matches);
}

type Phase = "idle" | "held" | "locked";

export interface VoiceNote {
  phase: Phase;
  /** Spread on the Send button. */
  button: {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLButtonElement>) => void;
    onContextMenu: (e: ReactMouseEvent) => void;
  };
  /** The button's click: true when the click was the recording's (the end of
   *  a hold, or the tap that finishes a locked one) and the caller should do nothing. */
  click: () => boolean;
  /** Say how it works, after a tap with nothing to send. */
  hint: () => void;
  /** Over the text box while recording. */
  bar: React.ReactNode;
  /** Above the button: the lock to slide up to, or the hint. */
  above: React.ReactNode;
}

export function useVoiceNote({ onDone, onError, working, tapStarts = false }: {
  onDone: (audio: Blob) => void;
  onError: (why: string) => void;
  /** The last recording is being put into words. */
  working: boolean;
  /** A tap with no hold starts a recording, and locks it until the next tap,
   *  rather than saying how the button works. A Send button cannot: its tap
   *  sends. */
  tapStarts?: boolean;
}): VoiceNote {
  const [phase, setPhase] = useState<Phase>("idle");
  const [ms, setMs] = useState(0);
  /** 0–1: how far toward the lock, and toward cancel, the thumb has slid. */
  const [pull, setPull] = useState({ up: 0, left: 0 });
  const [hinting, setHinting] = useState(false);

  // The gesture and the recorder live in refs: pointer events arrive faster
  // than renders, and the recorder's callbacks outlive the render that made them.
  const g = useRef({
    phase: "idle" as Phase,
    timer: null as ReturnType<typeof setTimeout> | null,
    x: 0,
    y: 0,
    /** The click that ends this press belongs to the recording. */
    swallow: false,
    /** Counts recordings, so a microphone that arrives late knows it was let go of. */
    take: 0,
    stream: null as MediaStream | null,
    rec: null as MediaRecorder | null,
    chunks: [] as Blob[],
    startedAt: 0,
    keep: false,
  });
  const cb = useRef({ onDone, onError });
  cb.current = { onDone, onError };

  const go = (p: Phase) => {
    g.current.phase = p;
    setPhase(p);
    if (p !== "held") setPull({ up: 0, left: 0 });
  };

  useEffect(() => {
    if (phase === "idle") return;
    const t = setInterval(() => setMs(g.current.startedAt ? Date.now() - g.current.startedAt : 0), 200);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (!hinting) return;
    const t = setTimeout(() => setHinting(false), 2200);
    return () => clearTimeout(t);
  }, [hinting]);

  /** Stop recording; `keep` says whether what was said is kept or dropped. */
  const end = (keep: boolean) => {
    const s = g.current;
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.take++;
    s.keep = keep;
    if (s.rec && s.rec.state !== "inactive") s.rec.stop();
    else s.stream?.getTracks().forEach((t) => t.stop());
    s.rec = null;
    s.stream = null;
    if (s.phase !== "idle") go("idle");
  };
  // Leaving the session mid-recording lets go of the microphone.
  useEffect(() => () => end(false), []);

  const begin = async (locked = false) => {
    const s = g.current;
    s.timer = null;
    s.swallow = true;
    s.startedAt = 0;
    setMs(0);
    go(locked ? "locked" : "held");
    setHinting(false);
    navigator.vibrate?.(12);
    const take = ++s.take;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error(window.isSecureContext ? "this browser cannot record" : "the microphone needs HTTPS — open the https:// address");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      // Let go of (or cancelled by the permission prompt) before the microphone came.
      if (s.take !== take) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mimeType = MIMES.find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      const startedAt = Date.now();
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (!s.keep) return;
        if (Date.now() - startedAt < MIN_MS) return setHinting(true);
        const audio = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
        if (audio.size === 0) cb.current.onError("nothing was recorded");
        else if (audio.size > MAX_BYTES) cb.current.onError("the recording is too long to send");
        else cb.current.onDone(audio);
      };
      rec.onerror = () => {
        cb.current.onError("the recording failed");
        end(false);
      };
      s.stream = stream;
      s.rec = rec;
      s.startedAt = startedAt;
      rec.start(1000);
    } catch (e) {
      if (s.take !== take) return;
      const err = e as Error;
      cb.current.onError(err.name === "NotAllowedError" ? "the microphone is blocked for this page — allow it in the browser's site settings" : `no microphone: ${err.message}`);
      end(false);
    }
  };

  const button: VoiceNote["button"] = {
    onPointerDown: (e) => {
      const s = g.current;
      s.swallow = false;
      if (s.phase !== "idle" || working || e.button !== 0) return;
      s.x = e.clientX;
      s.y = e.clientY;
      // The slide is followed past the button's edge.
      e.currentTarget.setPointerCapture(e.pointerId);
      s.timer = setTimeout(() => void begin(), HOLD_MS);
    },
    onPointerMove: (e) => {
      const s = g.current;
      if (s.phase !== "held") return;
      const up = s.y - e.clientY;
      const left = s.x - e.clientX;
      if (up >= LOCK_PX) {
        navigator.vibrate?.(12);
        go("locked");
      } else if (left >= CANCEL_PX) end(false);
      else setPull({ up: Math.max(0, up / LOCK_PX), left: Math.max(0, left / CANCEL_PX) });
    },
    onPointerUp: () => {
      const s = g.current;
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
        // A tap: a Send button says how to hold, a mic button starts listening.
        if (tapStarts && !working) void begin(true);
      } else if (s.phase === "held") end(true);
    },
    onPointerCancel: () => {
      const s = g.current;
      if (s.timer) {
        clearTimeout(s.timer);
        s.timer = null;
      } else if (s.phase === "held") {
        // The system took the touch (a notification shade, the permission
        // prompt). What was said so far is kept for a tap on the button; with no
        // microphone yet there is nothing to keep.
        if (s.rec) go("locked");
        else end(false);
      }
    },
    // A long press is ours, not the browser's menu.
    onContextMenu: (e) => e.preventDefault(),
  };

  const click = () => {
    const s = g.current;
    if (s.swallow) {
      s.swallow = false;
      return true;
    }
    if (s.phase === "locked") {
      end(true);
      return true;
    }
    return false;
  };

  const clock = `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  const bar =
    phase !== "idle" ? (
      <div className="vn-rec" data-phase={phase} role="status" aria-live="off">
        {phase === "locked" ? (
          <button type="button" className="vn-rec-bin" aria-label="Discard the recording" onClick={() => end(false)}>
            <Icon.trash size={17} />
          </button>
        ) : null}
        <span className="vn-rec-dot" aria-hidden />
        <span className="vn-rec-clock">{clock}</span>
        {phase === "held" ? (
          <span className="vn-rec-slide" style={{ transform: `translateX(${-pull.left * 28}px)`, opacity: 1 - pull.left * 0.7 }}>
            <Icon.chevronLeft size={14} /> Slide to cancel
          </span>
        ) : (
          <span className="vn-rec-slide">Tap ✓ when done</span>
        )}
      </div>
    ) : working ? (
      <div className="vn-rec" data-phase="working" role="status">
        <span className="vn-rec-slide">Transcribing…</span>
      </div>
    ) : null;

  const above =
    phase === "held" ? (
      <span className="vn-rec-lock" aria-hidden style={{ transform: `translateY(${-pull.up * 14}px)` }} data-near={pull.up > 0.6 || undefined}>
        <Icon.lock size={15} />
        <Icon.chevronUp size={13} />
      </span>
    ) : hinting ? (
      <span className="vn-rec-hint" role="status">
        Hold to record, release to type it out
      </span>
    ) : null;

  return { phase, button, click, hint: () => setHinting(true), bar, above };
}

/**
 * A microphone for a prompt box that has no Send button to hold: tap it and
 * speak (tap again, or ✓, when done), or hold it and let go. The words land
 * in the box for reading over before anything is started.
 */
export function VoiceButton({ voice, disabled }: {
  voice: VoiceNote;
  disabled?: boolean;
}) {
  const live = voice.phase !== "idle";
  return (
    <span className="vn-mic-wrap">
      {voice.above}
      <button
        type="button"
        className="vn-mic"
        aria-label={
          voice.phase === "idle" ? "Record a voice prompt" : voice.phase === "locked" ? "Finish the recording" : "Release to finish the recording"
        }
        title="Tap to dictate, or hold while you speak"
        disabled={disabled}
        data-rec={live ? voice.phase : undefined}
        {...voice.button}
        onClick={() => {
          if (voice.click()) return;
          voice.hint();
        }}
      >
        {voice.phase === "locked" ? <Icon.check size={16} /> : <Icon.mic size={17} />}
      </button>
    </span>
  );
}
