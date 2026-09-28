import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { hrefOf } from "../../route";
import { prRefs, prUrl } from "../../lib/prlinks";
import { sessionRefs, type SessionIndex } from "../../lib/sessionrefs";
import { backoffMs, openTerm, type TermChannel } from "../../api";
import { Button, Icon } from "../../components";

/**
 * The session's real TUI: an xterm.js view onto the same tmux session a
 * terminal gets with `agentbox attach`. Closing this (switching tab, leaving
 * the page) only detaches — the agent keeps running.
 *
 * Its own module so xterm (the heaviest thing the UI ships) is only fetched
 * when a terminal is actually opened.
 */

/** Always dark. The CLIs pick their own palette for a dark terminal far more
 *  often than a light one, and a black pane on a light page reads as "this is
 *  a terminal" rather than as a rendering bug. */
const THEME: ITheme = {
  background: "#0e0e11",
  foreground: "#e6e6e9",
  cursor: "#f97316",
  cursorAccent: "#0e0e11",
  selectionBackground: "#f9731655",
  black: "#1b1b1f",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#e879f9",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#f0abfc",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};

type Phase = { kind: "connecting" } | { kind: "live" } | { kind: "down"; retryAt: number; reason: string | null };

export default function Terminal({
  sessionId,
  index,
  prBase,
  flashRef,
  onScrolled,
}: {
  sessionId: string;
  /** The board, for the other sessions this one names on screen. */
  index: SessionIndex;
  /** `https://github.com/owner/repo` for PR numbers on screen, or null. */
  prBase: string | null;
  /** Set to a function that lights up one screen row: where a jump landed. */
  flashRef?: MutableRefObject<((row: number) => void) | null>;
  /** You scrolled the TUI yourself (wheel or PageUp/PageDown), settled. */
  onScrolled?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const [flash, setFlash] = useState<{ top: number; height: number; key: number } | null>(null);
  const scrolled = useRef(onScrolled);
  scrolled.current = onScrolled;
  // Read by the link provider on hover; a ref so the board changing does not
  // tear the terminal down.
  const idx = useRef(index);
  idx.current = index;
  const pr = useRef(prBase);
  pr.current = prBase;
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [kick, setKick] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
      allowProposedApi: false,
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box);
    termRef.current = term;

    // The TUI scrolls itself; say so once it has stopped moving.
    let settle: ReturnType<typeof setTimeout> | null = null;
    const moved = () => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => scrolled.current?.(), 350);
    };
    // Capture: xterm stops the wheel it turns into mouse reports for tmux.
    box.addEventListener("wheel", moved, { passive: true, capture: true });

    let alive = true;
    let chan: TermChannel | null = null;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;

    const safeFit = () => {
      // fit() throws on a zero-size container (a hidden tab); skip until visible.
      if (box.clientWidth < 20 || box.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    };

    // `quiet`: the first retry after a drop keeps the screen as it was, and
    // only says so if it has not reattached within a few seconds. Opening the
    // PWA from the background always finds the socket closed.
    const connect = (quiet = false) => {
      retry = null;
      if (quiet) grace = setTimeout(() => setPhase({ kind: "connecting" }), 3_000);
      else setPhase({ kind: "connecting" });
      chan = openTerm(sessionId, {
        onOpen: () => {
          if (!alive) return;
          if (grace) clearTimeout(grace);
          grace = null;
          attempts = 0;
          setPhase({ kind: "live" });
          safeFit();
          chan?.resize(term.cols, term.rows);
          term.focus();
        },
        onOutput: (bytes) => alive && term.write(bytes),
        onClose: (reason) => {
          if (!alive) return;
          attempts += 1;
          if (attempts === 1) {
            retry = setTimeout(() => connect(true), 0);
            return;
          }
          if (grace) clearTimeout(grace);
          grace = null;
          const delay = backoffMs(attempts - 1);
          setPhase({ kind: "down", retryAt: Date.now() + delay, reason });
          retry = setTimeout(connect, delay);
        },
      });
    };

    // Another session named on screen — its id, tmux name, provider id or
    // worktree path, which the Project session and the fleet's own agents
    // print all the time — is a link to it. Only names that are on the board,
    // so an ordinary eight-letter word never lights up.
    const links = term.registerLinkProvider({
      provideLinks(y, callback) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const found = sessionRefs(text, idx.current)
          .filter((r) => r.id !== sessionId)
          .map((r) => ({
            range: { start: { x: r.start + 1, y }, end: { x: r.end, y } },
            text: text.slice(r.start, r.end),
            decorations: { pointerCursor: true, underline: true },
            activate: () => {
              location.hash = hrefOf({ page: "session", id: r.id, tab: "terminal" });
            },
          }));
        callback(found.length ? found : undefined);
      },
    });
    // PR numbers — `#6307`, `PR 6644`, a bare `6644` — open the PR on GitHub.
    const prLinks = term.registerLinkProvider({
      provideLinks(y, callback) {
        const base = pr.current;
        if (!base) return callback(undefined);
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const found = prRefs(text).map((r) => ({
          range: { start: { x: r.start + 1, y }, end: { x: r.end, y } },
          text: text.slice(r.start, r.end),
          decorations: { pointerCursor: true, underline: true },
          activate: (e: MouseEvent) => {
            e.preventDefault();
            window.open(prUrl(base, r.number), "_blank", "noopener");
          },
        }));
        callback(found.length ? found : undefined);
      },
    });
    // The keys a desktop terminal set up by `/terminal-setup` would send, which
    // xterm.js does not: Shift+Enter a newline (ESC Enter, which Claude Code
    // reads as a newline, not a submit) and Ctrl+Backspace a word (Ctrl+W;
    // xterm.js sends a plain ^H, one character). The keypress and keyup of the
    // same combination are swallowed too, or the Enter would still submit.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.key === "PageUp" || e.key === "PageDown")) moved();
      if (e.altKey || e.metaKey) return true;
      const seq =
        e.key === "Enter" && e.shiftKey && !e.ctrlKey ? "\x1b\r" : e.key === "Backspace" && e.ctrlKey && !e.shiftKey ? "\x17" : null;
      if (seq === null) return true;
      e.preventDefault();
      if (e.type === "keydown") chan?.send(seq);
      return false;
    });
    const input = term.onData((d) => chan?.send(d));
    const sized = term.onResize(({ cols, rows }) => chan?.resize(cols, rows));

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(safeFit);
    });
    ro.observe(box);
    safeFit();
    connect();
    // Back in the foreground: skip whatever backoff is left.
    const wake = () => {
      if (document.visibilityState !== "visible" || !retry) return;
      clearTimeout(retry);
      connect(attempts === 1);
    };
    document.addEventListener("visibilitychange", wake);

    return () => {
      alive = false;
      termRef.current = null;
      if (settle) clearTimeout(settle);
      box.removeEventListener("wheel", moved, { capture: true });
      if (retry) clearTimeout(retry);
      if (grace) clearTimeout(grace);
      document.removeEventListener("visibilitychange", wake);
      cancelAnimationFrame(raf);
      ro.disconnect();
      input.dispose();
      sized.dispose();
      links.dispose();
      prLinks.dispose();
      chan?.close();
      term.dispose();
    };
  }, [sessionId, kick]);

  useEffect(() => {
    if (!flashRef) return;
    flashRef.current = (row) => {
      const term = termRef.current;
      const screen = boxRef.current?.querySelector<HTMLElement>(".xterm-screen");
      const wrap = wrapRef.current;
      if (!term || !screen || !wrap || term.rows === 0) return;
      const height = screen.clientHeight / term.rows;
      const top = screen.getBoundingClientRect().top - wrap.getBoundingClientRect().top + row * height;
      setFlash({ top, height, key: Date.now() });
    };
    return () => {
      flashRef.current = null;
    };
  }, [flashRef]);

  return (
    <div className="term-wrap" ref={wrapRef}>
      <div className="term-box" ref={boxRef} aria-label="Session terminal" />
      {flash ? (
        <div key={flash.key} className="term-flash" style={{ top: flash.top, height: flash.height }} onAnimationEnd={() => setFlash(null)} />
      ) : null}
      {phase.kind !== "live" ? (
        <div className="term-overlay" role="status">
          {phase.kind === "connecting" ? (
            <span>Attaching to tmux…</span>
          ) : (
            <>
              <span>
                Detached{phase.reason ? `: ${phase.reason}` : ""}. Reconnecting — the agent keeps running either way.
              </span>
              <Button size="sm" icon={Icon.refresh} onClick={() => setKick((k) => k + 1)}>
                Reconnect now
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
