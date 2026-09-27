/** The shell: routing, theme, global keys, and the two things that must always
 *  be true — you can link to what you are looking at, and you can tell when
 *  the data on screen is stale. */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, clockNow, MOCK, subscribeToClock, useAppState, useConnection } from "./api";
import type { AgentSettings, AppState } from "../../src/core/types";
import { Button, Empty, ErrorBoundary, Icon, type IconComponent } from "./components";
import { needsYou, titleOf } from "./lib/board";
import { hrefOf, navOf, parseHash, type NavId, type Route } from "./route";
import { openingTab } from "./lib/phone";
import { useUpdateReady } from "./lib/update";
import { SystemBar } from "./SystemBar";
import { SessionView } from "./views/session/SessionView";
import { isRecurring } from "../../src/core/schedule";
import { NewSession } from "./views/NewSession";
import { Settings } from "./views/Settings";
import { Skills } from "./views/Skills";

// Accounts and Calibration are visited, not lived in; keep them out of the
// first paint. (The terminal is lazy too, inside SessionView — xterm is the
// heaviest thing in the bundle.)
const Accounts = lazy(() => import("./views/Accounts").then((m) => ({ default: m.Accounts })));
const Voice = lazy(() => import("./views/Voice").then((m) => ({ default: m.Voice })));

// ----------------------------------------------------------------- routing

function useRoute(): [Route, (to: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  const navigate = useCallback((to: Route, replace = false) => {
    const href = hrefOf(to);
    if (href === location.hash) return;
    if (replace) history.replaceState(null, "", href);
    else location.hash = href;
    setRoute(to);
  }, []);

  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onChange);
    // Normalise "" and anything unrecognised without adding a history entry.
    if (hrefOf(parseHash(location.hash)) !== location.hash) {
      history.replaceState(null, "", hrefOf(parseHash(location.hash)));
    }
    return () => removeEventListener("hashchange", onChange);
  }, []);

  return [route, navigate];
}

/** Keys that work anywhere except while typing: `n` new session, `/` search. */
function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  if (t.closest(".xterm")) return true; // the terminal owns every key it gets
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

// -------------------------------------------------------------------- app

const NAV: { id: NavId; label: string; icon: IconComponent; to: Route }[] = [
  { id: "sessions", label: "Sessions", icon: Icon.sessions, to: { page: "sessions" } },
  { id: "voice", label: "Voice", icon: Icon.mic, to: { page: "voice" } },
  { id: "accounts", label: "Accounts", icon: Icon.users, to: { page: "accounts", sub: "accounts" } },
  { id: "skills", label: "Skills", icon: Icon.folder, to: { page: "skills" } },
  { id: "settings", label: "Settings", icon: Icon.settings, to: { page: "settings" } },
];

const PAGE_TITLE: Record<NavId, string> = {
  sessions: "Sessions",
  voice: "Voice",
  accounts: "Accounts",
  skills: "Skills",
  settings: "Settings",
};

export function App() {
  const { state } = useAppState();
  const [route, navigate] = useRoute();
  const theme = useTheme(state?.settings.theme);
  const [newOpen, setNewOpen] = useState(false);
  const nav = navOf(route);

  const counts = useMemo(() => countsOf(state), [state]);

  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [route.page]);

  // With the breadcrumb gone, the tab title is where the session's name lives.
  const here = route.page === "session" && state ? `${titleOfId(state, route.id)} — agentbox` : "agentbox";
  useEffect(() => {
    document.title = counts.sessions > 0 ? `(${counts.sessions}) ${here}` : here;
  }, [counts.sessions, here]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (e.key === "n") {
        e.preventDefault();
        setNewOpen(true);
      } else if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-search]");
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const flush = route.page === "sessions" || route.page === "session" || route.page === "voice";
  const focusAccount = route.page === "session" ? state?.sessions.find((x) => x.id === route.id)?.accountId ?? null : null;

  return (
    <div className="app" data-page={route.page}>
      <a className="skip" href="#content">
        Skip to content
      </a>

      {/* The slot holds the icon rail's width in the layout; the sidebar
          itself widens over the page on hover, so nothing beside it reflows. */}
      <div className="sidebar-slot">
        <aside className="sidebar">
          <div className="brand">
            <BrandMark />
            <span className="nav-label">agentbox</span>
            {MOCK ? (
              <span className="mock-tag" title="Opened with ?mock=1 — nothing here is real and nothing is sent anywhere">
                mock
              </span>
            ) : null}
          </div>

          <button type="button" className="nav-item nav-new" title="New session (n)" onClick={() => setNewOpen(true)}>
            <Icon.plus />
            <span className="nav-label">New session</span>
            <kbd className="nav-label">n</kbd>
          </button>

          <nav aria-label="Primary">
            {NAV.map(({ id, label, icon: IconCmp, to }) => {
              const count = counts[id];
              const active = nav === id;
              return (
                <a
                  key={id}
                  className={`nav-item ${active ? "active" : ""}`}
                  href={hrefOf(to)}
                  aria-current={active ? "page" : undefined}
                  title={label}
                >
                  <IconCmp />
                  <span className="nav-label">{label}</span>
                  {count > 0 ? (
                    <span className={`count${id === "accounts" ? " count-warn" : ""}`} title={countTitle(id, count)}>
                      {count}
                    </span>
                  ) : null}
                </a>
              );
            })}
          </nav>

          <div className="spacer" />
          <div className="sidebar-keys nav-label" aria-hidden="true">
            <span><kbd>/</kbd> search</span>
            <span><kbd>j</kbd><kbd>k</kbd> move</span>
          </div>
          <UpdateReady />
          <ConnectionChip />
          <ThemeControl value={theme.pref} onChange={theme.set} />
        </aside>
      </div>

      <div className="main">
        {/* The sessions pages carry their own header — the board's filter bar,
            the session's title — so a page title above them is a second one. */}
        {flush ? null : (
          <header className="topbar">
            <h1>{PAGE_TITLE[nav]}</h1>
            {route.page === "accounts" ? (
              <div className="seg topbar-seg" role="group" aria-label="Accounts view">
                <button
                  type="button"
                  aria-pressed={route.sub === "accounts"}
                  onClick={() => navigate({ page: "accounts", sub: "accounts" })}
                >
                  Accounts
                </button>
                <button
                  type="button"
                  aria-pressed={route.sub === "calibration"}
                  onClick={() => navigate({ page: "accounts", sub: "calibration" })}
                >
                  Calibration
                </button>
              </div>
            ) : null}
          </header>
        )}

        <StaleBanner />
        {theme.error ? (
          <Banner tone="warn" icon={Icon.alert}>
            Theme not saved: {theme.error}
          </Banner>
        ) : null}
        {state?.warnings.map((w) => (
          <Banner key={w} tone="warn" icon={Icon.alert}>
            {w}
          </Banner>
        ))}

        <main className={`content ${(flush || route.page === "skills") && state ? "flush" : ""}`} id="content" ref={contentRef} tabIndex={-1}>
          <ErrorBoundary resetKey={hrefOf(route)} label="This page">
            {!state ? (
              <Bootstrapping />
            ) : route.page === "sessions" || route.page === "session" ? (
              <SessionView
                state={state}
                id={route.page === "session" ? route.id : null}
                tab={route.page === "session" ? route.tab : "terminal"}
                onTab={(tab) => route.page === "session" && navigate({ page: "session", id: route.id, tab }, true)}
                onOpen={(id) =>
                  navigate({
                    page: "session",
                    id,
                    tab: route.page === "session" ? route.tab : openingTab(state.sessions.find((s) => s.id === id)?.status),
                  })
                }
                onNew={() => setNewOpen(true)}
              />
            ) : route.page === "accounts" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Accounts state={state} sub={route.sub} />
              </Suspense>
            ) : route.page === "voice" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Voice />
              </Suspense>
            ) : route.page === "skills" ? (
              <Skills skills={state.skills} />
            ) : (
              <Settings state={state} />
            )}
          </ErrorBoundary>
        </main>

        <ErrorBoundary label="The system bar">
          <SystemBar accounts={state?.accounts ?? []} focusAccount={focusAccount} />
        </ErrorBoundary>
      </div>

      {newOpen && state ? (
        <ErrorBoundary label="The new-session dialog">
          <NewSession
            state={state}
            onClose={() => setNewOpen(false)}
            onCreated={(id) => {
              setNewOpen(false);
              navigate({ page: "session", id, tab: openingTab() });
            }}
            onScheduled={(sc) => {
              setNewOpen(false);
              // A one-time one waits in the list like a session; a recurring one lives in Settings.
              navigate(!isRecurring(sc.rule) ? { page: "session", id: sc.id, tab: openingTab() } : { page: "settings" });
            }}
          />
        </ErrorBoundary>
      ) : null}
    </div>
  );
}

function titleOfId(state: AppState, id: string): string {
  const s = state.sessions.find((x) => x.id === id);
  return s ? titleOf(s) : id;
}

// ----------------------------------------------------------------- counts

function countsOf(state: AppState | null): Record<NavId, number> {
  if (!state) return { sessions: 0, voice: 0, accounts: 0, skills: 0, settings: 0 };
  const loginsOpen = state.logins.filter((l) => l.state !== "done" && l.state !== "failed").length;
  const authBad = state.accounts.filter((a) => a.enabled && (a.auth.state === "expired" || a.auth.state === "missing")).length;
  return {
    sessions: needsYou(state.sessions),
    voice: 0,
    accounts: Math.max(loginsOpen, authBad),
    skills: 0,
    settings: 0,
  };
}

function countTitle(id: NavId, n: number): string {
  if (id === "accounts") return `${n} account${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a login`;
  return `${n} session${n === 1 ? "" : "s"} waiting on you`;
}

// ------------------------------------------------------------- connection

function useCountdown(to: number | null): number | null {
  return useSyncExternalStore(
    subscribeToClock,
    () => (to === null ? null : Math.max(0, Math.ceil((to - clockNow()) / 1000))),
    () => null,
  );
}

/** A rebuild this page is not running yet; it reloads by itself when that is safe (lib/update.ts). */
function UpdateReady() {
  const ready = useUpdateReady();
  if (!ready) return null;
  return (
    <button
      type="button"
      className="nav-item nav-update"
      title="agentbox was rebuilt. Reload to run the new version (it reloads by itself next time you leave the page)"
      onClick={() => location.reload()}
    >
      <Icon.refresh />
      <span className="nav-label">Update</span>
    </button>
  );
}

function ConnectionChip() {
  const { connected, downSince } = useConnection();
  const label = connected ? (MOCK ? "Mock data" : "Live") : downSince ? "Offline" : "Connecting…";
  return (
    <div className={`conn ${connected ? "on" : "off"}`} title={`Connection: ${label}`} role="status">
      <span className="dot" aria-hidden="true" />
      <span className="conn-label nav-label">{label}</span>
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

function Banner({ tone, icon: IconCmp, children }: { tone: "warn" | "danger"; icon: IconComponent; children: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role="status">
      <IconCmp size={15} />
      {children}
    </div>
  );
}

/** Before the first state arrives: probe /api/health rather than hang on "Connecting…". */
function Bootstrapping() {
  const { connected } = useConnection();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      api.health().then(
        () => undefined,
        (err: Error) => !cancelled && setProblem(err.message),
      );
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  if (problem) {
    return (
      <Empty
        title="Can't reach the agentbox server"
        action={
          <Button variant="primary" icon={Icon.refresh} onClick={() => location.reload()}>
            Reload
          </Button>
        }
      >
        <p className="mono">{problem}</p>
        <p>
          Start it with <code>bun run dev</code> in the agentbox checkout, then reload. To look around
          without one, open this page with <code>?mock=1</code>.
        </p>
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

/** Three states, honestly: `system` is a real preference. */
function useTheme(serverPref: AgentSettings["theme"] | undefined) {
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
    try {
      localStorage.setItem(THEME_CACHE_KEY, pref);
    } catch {
      /* private mode: the system default on next load is fine */
    }
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
        // Revert AND say why: a theme that silently snaps back reads as a glitch.
        setPending(null);
        setError(e.message);
      });
    },
  };
}

function readCachedTheme(): AgentSettings["theme"] {
  try {
    const v = localStorage.getItem(THEME_CACHE_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function resolveTheme(pref: AgentSettings["theme"]): "light" | "dark" {
  if (pref !== "system") return pref;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeControl({ value, onChange }: { value: AgentSettings["theme"]; onChange: (t: AgentSettings["theme"]) => void }) {
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
