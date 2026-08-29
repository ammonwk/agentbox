/** The shell: routing, theme, and the two things that must always be true —
 *  you can link to what you are looking at, and you can tell when the data on
 *  screen is stale. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  api,
  clockNow,
  subscribeToClock,
  useAppState,
  useConnection,
  type AgentSettings,
  type AppState,
} from "./api";
// Pure module — it imports only `./types`, type-only, so pulling it into the
// browser bundle costs one small function and no server code.
import { inboxItems } from "../../src/core/conductor";
import { Button, Empty, Icon, type IconComponent } from "./components";
import { hrefOf, parseHash, type PageId, type Route } from "./route";
import { SystemBar } from "./SystemBar";
import { Inbox } from "./views/Inbox";
import { Sessions } from "./views/Sessions";
import { Skills } from "./views/Skills";
import { Settings } from "./views/Settings";

// ----------------------------------------------------------------- routing

/** The URL is the only place selection lives, so every view is linkable and
 *  the back button does what a browser's back button does. */
function useRoute(): [Route, (to: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  // Stable: views put it in effect dependency arrays.
  const navigate = useCallback((to: Route, replace = false) => {
    const href = hrefOf(to);
    if (href === location.hash) return; // no-op, and no re-render to loop on
    if (replace) history.replaceState(null, "", href);
    else location.hash = href;
    setRoute(to);
  }, []);

  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onChange);
    // Normalise "" and anything unrecognised to a real route, without adding a
    // history entry the back button would have to walk through.
    if (hrefOf(parseHash(location.hash)) !== location.hash) {
      history.replaceState(null, "", hrefOf(parseHash(location.hash)));
    }
    return () => removeEventListener("hashchange", onChange);
  }, []);

  return [route, navigate];
}

// -------------------------------------------------------------------- app

const NAV: { id: PageId; label: string; icon: IconComponent }[] = [
  { id: "inbox", label: "Inbox", icon: Icon.inbox },
  { id: "sessions", label: "Sessions", icon: Icon.sessions },
  { id: "skills", label: "Skills", icon: Icon.folder },
  { id: "settings", label: "Settings", icon: Icon.settings },
];

export function App() {
  const { state, warnings } = useAppState();
  const [route, navigate] = useRoute();
  const theme = useTheme(state?.settings.theme);

  const counts = useMemo(() => countsOf(state), [state]);
  const selectSession = useCallback(
    (id: string | null) => navigate({ page: "sessions", sessionId: id }),
    [navigate],
  );

  // A page change starts at the top of that page. Without this the scroller
  // keeps the offset from the page you left — scroll down Settings, click
  // Inbox, and you arrive 266px in with its heading above the fold. Keyed on
  // `page` and not the whole route, so picking another session on the board
  // (where `.content` does not scroll anyway) is not a scroll event.
  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [route.page]);

  useEffect(() => {
    document.title = counts.inbox > 0 ? `(${counts.inbox}) agentbox` : "agentbox";
  }, [counts.inbox]);

  return (
    <div className="app">
      <a className="skip" href="#content">
        Skip to content
      </a>

      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <span>agentbox</span>
        </div>

        <nav aria-label="Primary">
          {NAV.map(({ id, label, icon: IconCmp }) => {
            const count = counts[id];
            const active = route.page === id;
            return (
              <a
                key={id}
                className={`nav-item ${active ? "active" : ""}`}
                href={hrefOf(id === "sessions" ? { page: "sessions", sessionId: null } : { page: id })}
                aria-current={active ? "page" : undefined}
              >
                <IconCmp />
                <span className="nav-label">{label}</span>
                {count > 0 ? (
                  <span className="count" title={countTitle(id, count)}>
                    {count}
                  </span>
                ) : null}
              </a>
            );
          })}
        </nav>

        <div className="spacer" />
        <ConnectionChip />
        <ThemeControl value={theme.pref} onChange={theme.set} />
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>
            {route.page === "inbox"
              ? "Inbox"
              : route.page === "sessions"
                ? "Sessions"
                : route.page === "skills"
                  ? "Skills"
                  : "Settings"}
          </h1>
        </header>

        <StaleBanner />
        {theme.error ? (
          <Banner tone="warn" icon={Icon.alert}>
            Theme not saved: {theme.error}
          </Banner>
        ) : null}
        {warnings.map((w) => (
          <Banner key={w} tone="warn" icon={Icon.alert}>
            {w}
          </Banner>
        ))}

        {/* The Sessions board and the Skills page are their own height-constrained
            grids with internal scrollers, so the shell must not pad them or scroll
            around them. */}
        <main
          className={`content ${(route.page === "sessions" || route.page === "skills") && state ? "flush" : ""}`}
          id="content"
          ref={contentRef}
          tabIndex={-1}
        >
          {!state ? (
            <Bootstrapping />
          ) : route.page === "inbox" ? (
            <Inbox state={state} onOpenSession={selectSession} />
          ) : route.page === "sessions" ? (
            <Sessions
              state={state}
              selectedId={route.sessionId}
              onSelect={selectSession}
            />
          ) : route.page === "skills" ? (
            <Skills skills={state.skills} />
          ) : (
            <Settings state={state} />
          )}
        </main>

        {/* A sibling of `.content` inside the flex column, not `position:
            fixed`. A floating status bar's failure mode is covering the last
            row of whatever you are reading; this one takes its height out of
            the scroller instead, so it cannot. */}
        <SystemBar />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- counts

function countsOf(state: AppState | null): Record<PageId, number> {
  if (!state) return { inbox: 0, sessions: 0, skills: 0, settings: 0 };
  return {
    // The badge counts the rows the Inbox renders, by calling the function that
    // renders them. An earlier version reimplemented the filter here and the
    // two drifted to 72 against 67 on the same screen — a badge that is not
    // literally the page's own count is a second opinion, not a summary.
    inbox: inboxItems(state.sessions, state.prs).length,
    // No closed filter: `state.sessions` is `listSessions(false)`, which is
    // `WHERE archived_at IS NULL`. Filtering again would read as a guard and
    // hide that closed sessions never reach the client at all.
    sessions: state.sessions.filter((s) => s.status === "running" || s.status === "spawning").length,
    skills: 0,
    settings: 0,
  };
}

function countTitle(id: PageId, n: number): string {
  if (id === "inbox") return `${n} thing${n === 1 ? "" : "s"} waiting on you`;
  return `${n} session${n === 1 ? "" : "s"} working right now`;
}

// ------------------------------------------------------------- connection

/** Seconds until a value in the future, ticking once a second. */
function useCountdown(to: number | null): number | null {
  return useSyncExternalStore(
    subscribeToClock,
    () => (to === null ? null : Math.max(0, Math.ceil((to - clockNow()) / 1000))),
    () => null,
  );
}

function ConnectionChip() {
  const { connected, downSince } = useConnection();
  const label = connected ? "Live" : downSince ? "Offline" : "Connecting…";
  return (
    // `title` and the wrapped label so the narrow rail can drop the word and
    // keep the dot: whether the data is live is the one thing that must stay
    // legible at every width, and the rail used to hide the chip outright.
    <div className={`conn ${connected ? "on" : "off"}`} title={`Connection: ${label}`}>
      <span className="dot" aria-hidden="true" />
      <span className="conn-label">{label}</span>
    </div>
  );
}

/** The app keeps rendering the last state it had; this says so out loud. */
function StaleBanner() {
  const { connected, downSince, retryAt, attempts, lastError, retryNow } = useConnection();
  const secs = useCountdown(retryAt);
  if (connected || downSince === null) return null;

  const downFor = Math.round((Date.now() - downSince) / 1000);
  return (
    <Banner tone="danger" icon={Icon.wifiOff}>
      <span>
        <strong>Not connected.</strong> Everything below is a snapshot from{" "}
        {downFor < 60 ? `${downFor}s` : `${Math.round(downFor / 60)}m`} ago and is not updating.{" "}
        {lastError ? `Last error: ${lastError}. ` : ""}
        {secs === null ? "" : secs > 0 ? `Retrying in ${secs}s` : "Retrying…"}
        {attempts > 1 ? ` (attempt ${attempts})` : ""}
      </span>
      <Button size="sm" icon={Icon.refresh} onClick={retryNow}>
        Retry now
      </Button>
    </Banner>
  );
}

function Banner({
  tone,
  icon: IconCmp,
  children,
}: {
  tone: "warn" | "danger";
  icon: IconComponent;
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role="status">
      <IconCmp size={15} />
      {children}
    </div>
  );
}

/**
 * Before the first state arrives. A bare "Connecting…" that can hang forever
 * is the thing this replaces: probe /api/health and show what it says.
 */
function Bootstrapping() {
  const { connected } = useConnection();
  // Two different failures, deliberately not one string: "the server is not
  // there" and "the server answered and omp is unusable" need opposite advice,
  // and this screen used to give the first one's advice to both.
  const [probe, setProbe] = useState<{ kind: "unreachable" | "omp"; detail: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api.health().then(
        (h) => {
          if (cancelled || h.ompState === "ok") return;
          // `ompDetail` already separates "not installed" from "installed and
          // broken, here is why". Writing our own sentence here is how this
          // line came to claim `omp` was not on PATH for an `omp` that was.
          setProbe({ kind: "omp", detail: h.ompDetail ?? `omp is ${h.ompState}.` });
        },
        (err: Error) => !cancelled && setProbe({ kind: "unreachable", detail: err.message }),
      );
    }, 1500); // give the socket a fair chance before crying wolf
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  if (probe) {
    const reload = (
      <Button variant="primary" icon={Icon.refresh} onClick={() => location.reload()}>
        Reload
      </Button>
    );
    return probe.kind === "unreachable" ? (
      <Empty title="Can't reach the agentbox server" action={reload}>
        <p className="mono">{probe.detail}</p>
        <p>
          Start it with <code>bun run dev</code> in the agentbox checkout, then reload.
        </p>
      </Empty>
    ) : (
      <Empty title="agentbox is running, but omp is not usable" action={reload}>
        <p className="mono">{probe.detail}</p>
        <p>Nothing can be spawned until that is fixed. Everything else still works.</p>
      </Empty>
    );
  }

  return (
    <Empty title={connected ? "Loading your sessions…" : "Connecting to agentbox…"}>
      <p>This should take a moment. If it does not, the server is probably not running.</p>
    </Empty>
  );
}

// ------------------------------------------------------------------ theme

const THEME_CACHE_KEY = "agentbox.theme";

const THEMES: { id: AgentSettings["theme"]; label: string; icon: IconComponent }[] = [
  { id: "light", label: "Light", icon: Icon.sun },
  { id: "system", label: "System", icon: Icon.monitor },
  { id: "dark", label: "Dark", icon: Icon.moon },
];

/**
 * Three states, honestly. `system` is a real preference, not a thing that
 * collapses into light the first time you press the button.
 */
function useTheme(serverPref: AgentSettings["theme"] | undefined) {
  // Held locally only while the PUT is in flight, so the control responds
  // immediately without pretending to be the source of truth.
  const [pending, setPending] = useState<AgentSettings["theme"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pref = pending ?? serverPref ?? readCachedTheme();

  useEffect(() => {
    if (pending && serverPref === pending) setPending(null);
  }, [pending, serverPref]);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(pref);
      document.documentElement.style.colorScheme = resolveTheme(pref);
    };
    apply();
    localStorage.setItem(THEME_CACHE_KEY, pref); // so a reload does not flash
    if (pref !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [pref]);

  return {
    pref,
    error,
    set: (next: AgentSettings["theme"]) => {
      setPending(next);
      setError(null);
      api.saveSettings({ theme: next }).catch((e: Error) => {
        // Revert AND say why. Reverting alone is what this used to do, and a
        // theme that silently snaps back reads as a UI glitch rather than as a
        // server that refused the write — the reader has no way to tell the
        // difference, so they retry the same click instead of reading the log.
        setPending(null);
        setError(e.message);
      });
    },
  };
}

function readCachedTheme(): AgentSettings["theme"] {
  const v = localStorage.getItem(THEME_CACHE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function resolveTheme(pref: AgentSettings["theme"]): "light" | "dark" {
  if (pref !== "system") return pref;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeControl({
  value,
  onChange,
}: {
  value: AgentSettings["theme"];
  onChange: (t: AgentSettings["theme"]) => void;
}) {
  return (
    <div className="theme-control" role="group" aria-label="Colour theme">
      {THEMES.map(({ id, label, icon: IconCmp }) => (
        <button
          key={id}
          type="button"
          className={`theme-opt ${value === id ? "on" : ""}`}
          aria-pressed={value === id}
          title={`${label} theme`}
          onClick={() => onChange(id)}
        >
          <IconCmp size={14} />
          <span className="sr-only">{label} theme</span>
        </button>
      ))}
    </div>
  );
}

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" rx="6" fill="var(--accent)" opacity="0.15" />
      <rect x="8" y="8" width="16" height="4" rx="1.5" fill="var(--accent)" />
      <rect x="8" y="16" width="10" height="4" rx="1.5" fill="currentColor" opacity="0.85" />
      <rect x="8" y="23" width="13" height="3" rx="1.5" fill="var(--faint)" />
    </svg>
  );
}
