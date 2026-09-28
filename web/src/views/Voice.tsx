/** Hands-free: talk to agentbox from your phone.
 *
 * The phone streams its mic to the server and plays back what the server
 * sends; everything else — hearing, deciding, speaking — happens there
 * (src/voice). The conversation lives on the server under an id kept here, so
 * a dropped connection or a reload comes back to the same one.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button, Icon } from "../components";
import { createVoiceContext, startMic, VoicePlayer, type Mic } from "../lib/voiceAudio";
import "./voice.css";

type ServerState = "connecting" | "listening" | "thinking" | "speaking";
type Line = { id: number; kind: "you" | "agent" | "note" | "error"; text: string };
type ServerMsg =
  | { type: "state"; state: ServerState; muted: boolean }
  | { type: "heard"; text: string; final: boolean }
  | { type: "said"; text: string }
  | { type: "note"; text: string }
  | { type: "duck"; on: boolean }
  | { type: "flush" }
  | { type: "error"; message: string };

const CONV_KEY = "agentbox.voice.conv";
const UPDATES_KEY = "agentbox.voice.updates";

function convId(fresh = false): string {
  let id = fresh ? null : localStorage.getItem(CONV_KEY);
  if (!id) {
    id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CONV_KEY, id);
  }
  return id;
}

const STATUS: Record<ServerState, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
};

export function Voice() {
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [state, setState] = useState<ServerState>("connecting");
  const [muted, setMuted] = useState(false);
  const [updates, setUpdates] = useState(() => localStorage.getItem(UPDATES_KEY) !== "0");
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [typed, setTyped] = useState("");

  const ctx = useRef<AudioContext | null>(null);
  const mic = useRef<Mic | null>(null);
  const player = useRef<VoicePlayer | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const live = useRef(false);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useRef<{ release(): Promise<void> } | null>(null);
  const micLevel = useRef(0);
  const orb = useRef<HTMLButtonElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const stateRef = useRef<ServerState>("connecting");
  stateRef.current = state;

  useEffect(() => {
    api.voiceStatus().then(
      (s) => setProblem(s.ready ? null : `Voice is not set up yet: ${s.missing}.`),
      () => undefined,
    );
    if (!window.isSecureContext) setProblem("The microphone only works over HTTPS. Open this page at its https:// address.");
    return () => end();
  }, []);

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" });
  }, [lines, interim]);

  // The orb breathes with whoever is talking; a CSS variable, not a render.
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const tick = () => {
      const lvl = stateRef.current === "speaking" ? (player.current?.level() ?? 0) : micLevel.current;
      orb.current?.style.setProperty("--lvl", lvl.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on]);

  // Locked or switched away, the phone suspends audio; coming back resumes it,
  // or asks for a tap when Safari insists on one.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || !live.current) return;
      void holdScreen();
      const c = ctx.current;
      if (c && c.state !== "running") c.resume().then(() => setSuspended(c.state !== "running"), () => setSuspended(true));
      if (!ws.current) connect();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const add = (kind: Line["kind"], text: string) =>
    setLines((ls) => [...ls.slice(-80), { id: nextId.current++, kind, text }]);

  const send = (msg: object) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  };

  async function holdScreen() {
    try {
      const nav = navigator as unknown as { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } };
      wake.current = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      /* not allowed now; the next visibility change tries again */
    }
  }

  function connect() {
    if (!live.current) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${location.host}/ws/voice?c=${convId()}`);
    sock.binaryType = "arraybuffer";
    ws.current = sock;
    setState("connecting");
    sock.onopen = () => {
      retries.current = 0;
      sock.send(JSON.stringify({ type: "updates", on: updates }));
      if (muted) sock.send(JSON.stringify({ type: "mute", on: true }));
    };
    sock.onmessage = (e) => {
      if (typeof e.data !== "string") {
        player.current?.push(e.data as ArrayBuffer);
        return;
      }
      const m = JSON.parse(e.data) as ServerMsg;
      switch (m.type) {
        case "state":
          setState(m.state);
          break;
        case "heard":
          if (m.final) {
            setInterim("");
            add("you", m.text);
          } else setInterim(m.text);
          break;
        case "said":
          add("agent", m.text);
          break;
        case "note":
          add("note", m.text);
          break;
        case "error":
          add("error", m.message);
          break;
        case "duck":
          player.current?.duck(m.on);
          break;
        case "flush":
          player.current?.flush();
          break;
      }
    };
    sock.onclose = () => {
      if (ws.current !== sock) return;
      ws.current = null;
      if (!live.current) return;
      setState("connecting");
      const delay = Math.min(8000, 500 * 2 ** retries.current++);
      retryTimer.current = setTimeout(connect, delay);
    };
  }

  async function start() {
    setStarting(true);
    setProblem(null);
    try {
      const c = createVoiceContext();
      await c.resume();
      ctx.current = c;
      player.current = new VoicePlayer(c, () => send({ type: "played" }));
      mic.current = await startMic(c, (pcm, level) => {
        micLevel.current = level;
        if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(pcm);
      });
      live.current = true;
      setOn(true);
      void holdScreen();
      connect();
    } catch (err) {
      end();
      setProblem((err as Error).name === "NotAllowedError" ? "Microphone access was refused. Allow it for this site in Settings and try again." : (err as Error).message);
    } finally {
      setStarting(false);
    }
  }

  function end() {
    live.current = false;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    ws.current?.close();
    ws.current = null;
    mic.current?.stop();
    mic.current = null;
    player.current?.flush();
    player.current = null;
    void ctx.current?.close().catch(() => undefined);
    ctx.current = null;
    void wake.current?.release().catch(() => undefined);
    wake.current = null;
    setOn(false);
    setInterim("");
  }

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    send({ type: "mute", on: next });
  };

  const toggleUpdates = () => {
    const next = !updates;
    setUpdates(next);
    localStorage.setItem(UPDATES_KEY, next ? "1" : "0");
    send({ type: "updates", on: next });
  };

  const status = !on ? "Tap to talk" : muted ? "Muted" : STATUS[state];

  return (
    <div className="vc" data-state={on ? (muted ? "muted" : state) : "off"}>
      <header className="vc-head">
        <div className="vc-title">
          <h1>Voice</h1>
          <span className="vc-status" role="status">
            {status}
          </span>
        </div>
        <button type="button" className={`chip ${updates ? "on" : ""}`} aria-pressed={updates} onClick={toggleUpdates} title="Tell me when sessions finish or need an answer">
          <Icon.bell size={12} /> Updates
        </button>
      </header>

      <div className="vc-log" ref={scroll}>
        {lines.length === 0 && !interim ? (
          <div className="vc-hint">
            <p>
              Talk to it like a colleague on a call: ask what needs you, what a session said, answer one, or hand it something to do.
              Ask it to tell you when something finishes and it will speak up when it does. Real work it starts as its own session, and
              the answer comes back here.
            </p>
            <p>It only answers when you are talking to it, so you can leave it on while you do other things. Keep the screen on: a locked phone stops the mic.</p>
          </div>
        ) : null}
        {lines.map((l) => (
          <div key={l.id} className={`vc-line vc-${l.kind}`}>
            {l.text}
          </div>
        ))}
        {interim ? <div className="vc-line vc-you vc-interim">{interim}</div> : null}
      </div>

      {problem ? (
        <div className="vc-problem" role="alert">
          <Icon.alert size={14} /> {problem}
        </div>
      ) : null}
      {suspended ? (
        <button type="button" className="vc-problem" onClick={() => ctx.current?.resume().then(() => setSuspended(false))}>
          Audio paused while the phone was away. Tap to resume.
        </button>
      ) : null}

      <div className="vc-dock">
        <button
          ref={orb}
          type="button"
          className="vc-orb"
          aria-label={on ? (muted ? "Unmute" : "Mute") : "Start talking"}
          disabled={starting}
          onClick={() => (on ? toggleMute() : void start())}
        >
          {on && muted ? <Icon.micOff size={34} /> : <Icon.mic size={34} />}
        </button>
        {on ? (
          <div className="vc-controls">
            <Button size="sm" variant="ghost" icon={muted ? Icon.mic : Icon.micOff} onClick={toggleMute}>
              {muted ? "Unmute" : "Mute"}
            </Button>
            <Button size="sm" variant="danger" icon={Icon.stop} onClick={end}>
              End
            </Button>
          </div>
        ) : lines.length ? (
          <button
            type="button"
            className="linkish vc-fresh"
            onClick={() => {
              convId(true);
              setLines([]);
            }}
          >
            Start a fresh conversation
          </button>
        ) : null}
        {on ? (
          <form
            className="vc-type"
            onSubmit={(e) => {
              e.preventDefault();
              if (!typed.trim()) return;
              send({ type: "say", text: typed.trim() });
              setTyped("");
            }}
          >
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type to it" enterKeyHint="send" />
          </form>
        ) : null}
      </div>
    </div>
  );
}
