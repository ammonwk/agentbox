/** The shell: routing, theme, global keys, and the two things that must always
 *  be true — you can link to what you are looking at, and you can tell when
 *  the data on screen is stale. */

import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, clockNow, MOCK, subscribeToClock, useAppState, useConnection } from "./api";
import type { AgentSettings, AppState } from "../../src/core/types";
import { Button, Empty, ErrorBoundary, Icon, type IconComponent } from "./components";
import { needsYou, titleOf } from "./lib/board";
import { go, hrefOf, navOf, onGo, parseHash, type NavId, type Route } from "./route";
import { isInstalledApp, isPhone, openingTab } from "./lib/phone";
import { useUpdateReady } from "./lib/update";
import { useKeyboardNavigation } from "./lib/keyboard";
import { SystemBar } from "./SystemBar";
import { SysbarSlot } from "./sysbarslot";
import { SessionView } from "./views/session/SessionView";
import { isRecurring } from "../../src/core/schedule";
import { NewSession } from "./views/NewSession";
import { Settings } from "./views/Settings";
import { Skills } from "./views/Skills";
import { Mcps } from "./views/Mcps";
import { InboxBell } from "./Inbox";
import { Review } from "./views/Review";

// Accounts and Calibration are visited, not lived in; keep them out of the
// first paint. (The terminal is lazy too, inside SessionView — xterm is the
// heaviest thing in the bundle.)
const Accounts = lazy(() => import("./views/Accounts").then((m) => ({ default: m.Accounts })));
const Voice = lazy(() => import("./views/Voice").then((m) => ({ default: m.Voice })));

// ----------------------------------------------------------------- routing

function useRoute(): [Route, (to: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onChange);
    const off = onGo(onChange);
    // Normalise "" and anything unrecognised without adding a history entry.
    if (hrefOf(parseHash(location.hash)) !== location.hash) {
      history.replaceState(history.state, "", hrefOf(parseHash(location.hash)));
    }
    return () => {
      removeEventListener("hashchange", onChange);
      off();
    };
  }, []);

  return [route, go];
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
  { id: "review", label: "Review", icon: Icon.cards, to: { page: "review" } },
  { id: "voice", label: "Voice", icon: Icon.mic, to: { page: "voice" } },
  { id: "accounts", label: "Accounts", icon: Icon.users, to: { page: "accounts", sub: "accounts" } },
  { id: "skills", label: "Skills", icon: Icon.folder, to: { page: "skills" } },
  { id: "mcps", label: "MCPs", icon: Icon.plugs, to: { page: "mcps" } },
  { id: "settings", label: "Settings", icon: Icon.settings, to: { page: "settings" } },
];

const PAGE_TITLE: Record<NavId, string> = {
  sessions: "Sessions",
  review: "Review",
  voice: "Voice",
  accounts: "Accounts",
  skills: "Skills",
  mcps: "MCPs",
  settings: "Settings",
};

export function App() {
  useKeyboardNavigation();
  const { state } = useAppState();
  const [route, navigate] = useRoute();
  const theme = useTheme(state?.settings.theme);
  const [newOpen, setNewOpen] = useState(false);
  const nav = navOf(route);
  // The start of the system bar, where an open session puts its facts.
  const [sysbarSlot, setSysbarSlot] = useState<HTMLElement | null>(null);

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
    // Ctrl+T is `n` in the installed app, from anywhere, the terminal
    // included: captured before xterm can send it as a key.
    const onCtrlT = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== "t" || !isInstalledApp()) return;
      e.preventDefault();
      e.stopPropagation();
      if (!document.querySelector(".modal-backdrop")) setNewOpen(true);
    };
    addEventListener("keydown", onKey);
    addEventListener("keydown", onCtrlT, true);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keydown", onCtrlT, true);
    };
  }, []);

  const flush = route.page === "sessions" || route.page === "session" || route.page === "voice" || route.page === "review";
  const focusAccount = route.page === "session" ? state?.sessions.find((x) => x.id === route.id)?.accountId ?? null : null;

  return (
    <div className="app" data-page={route.page}>
      <a className="skip" href="#content">
        Skip to content
      </a>

      {/* The slot holds the icon rail's width in the layout; the sidebar
          itself widens over the page on hover, so nothing beside it reflows. */}
      <div className="sidebar-slot">
        <aside className="sidebar" data-nav-region="navigation" aria-label="Application navigation">
          <div className="brand">
            <BrandMark />
            <span className="nav-label">agentbox</span>
            {MOCK ? (
              <span className="mock-tag" title="Opened with ?mock=1 — nothing here is real and nothing is sent anywhere">
                mock
              </span>
            ) : null}
          </div>

          {/* Blurring on a mouse click (e.detail > 0) keeps the Modal from
              handing focus back here on close: a script refocus outside the
              gesture reads as keyboard focus, and :focus-visible on this
              button held the sidebar open after sending. Keyboard activation
              (Enter) keeps the restore. */}
          <button
            type="button"
            className="nav-item nav-new"
            data-nav-item
            title="New session (n)"
            onClick={(e) => {
              if (e.detail > 0) e.currentTarget.blur();
              setNewOpen(true);
            }}
          >
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
                  data-nav-item
                  aria-keyshortcuts="ArrowUp ArrowDown ArrowRight"
                  className={`nav-item ${active ? "active" : ""}`}
                  href={hrefOf(to)}
                  aria-current={active ? "page" : undefined}
                  title={label}
                >
                  <IconCmp size={20} weight="duotone" />
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
          <UpdateReady />
          <InboxBell state={state} themeError={theme.error} />
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
                  aria-pressed={route.sub !== "calibration"}
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

        {/* The one banner left: the rest are in the inbox (Inbox.tsx). */}
        <StaleBanner />

        <SysbarSlot.Provider value={sysbarSlot}>
        <main className={`content ${(flush || route.page === "skills" || route.page === "mcps") && state ? "flush" : ""}`} id="content" ref={contentRef} tabIndex={-1} data-nav-region="page" data-nav-route={hrefOf(route)}>
          <ErrorBoundary resetKey={hrefOf(route)} label="This page">
            {!state ? (
              <Bootstrapping />
            ) : route.page === "sessions" || route.page === "session" ? (
              <SessionView
                state={state}
                id={route.page === "session" ? route.id : null}
                tab={route.page === "session" ? route.tab : "timeline"}
                onTab={(tab) => route.page === "session" && navigate({ page: "session", id: route.id, tab }, true)}
                onOpen={(id) =>
                  navigate({
                    page: "session",
                    id,
                    tab: route.page === "session" ? route.tab : openingTab(state.sessions.find((s) => s.id === id)),
                  })
                }
                onNew={() => setNewOpen(true)}
              />
            ) : route.page === "accounts" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Accounts state={state} route={route} />
              </Suspense>
            ) : route.page === "voice" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Voice />
              </Suspense>
            ) : route.page === "review" ? (
              <Review state={state} />
            ) : route.page === "skills" ? (
              <Skills skills={state.skills} />
            ) : route.page === "mcps" ? (
              <Mcps />
            ) : (
              <Settings state={state} />
            )}
          </ErrorBoundary>
        </main>
        </SysbarSlot.Provider>

        <ErrorBoundary label="The system bar">
          <SystemBar accounts={state?.accounts ?? []} sessions={state?.sessions ?? []} focusAccount={focusAccount} slotRef={setSysbarSlot} />
        </ErrorBoundary>
      </div>

      {newOpen && state ? (
        <ErrorBoundary label="The new-session dialog">
          <NewSession
            state={state}
            onClose={() => setNewOpen(false)}
            onCreated={(id) => {
              setNewOpen(false);
              afterDialog(() => navigate({ page: "session", id, tab: openingTab() }));
            }}
            onScheduled={(sc) => {
              setNewOpen(false);
              // A one-time one waits in the list like a session; a recurring one lives in Settings.
              afterDialog(() => navigate(!isRecurring(sc.rule) ? { page: "session", id: sc.id, tab: openingTab() } : { page: "settings" }));
            }}
          />
        </ErrorBoundary>
      ) : null}
    </div>
  );
}

/** A phone's back gesture shows the page as it looked when it was left: leave
 *  once the dialog is off the screen, or going back shows it for a moment. */
function afterDialog(fn: () => void): void {
  if (isPhone()) requestAnimationFrame(() => requestAnimationFrame(fn));
  else fn();
}

function titleOfId(state: AppState, id: string): string {
  const s = state.sessions.find((x) => x.id === id);
  return s ? titleOf(s) : id;
}

// ----------------------------------------------------------------- counts

function countsOf(state: AppState | null): Record<NavId, number> {
  if (!state) return { sessions: 0, review: 0, voice: 0, accounts: 0, skills: 0, mcps: 0, settings: 0 };
  const loginsOpen = state.logins.filter((l) => l.state !== "done" && l.state !== "failed").length;
  const authBad = state.accounts.filter((a) => a.enabled && (a.auth.state === "expired" || a.auth.state === "missing")).length;
  return {
    sessions: needsYou(state.sessions),
    // Kept for later is still yours, but you have seen it: it does not nag.
    review: state.cards.filter((c) => c.state === "open").length,
    voice: 0,
    accounts: Math.max(loginsOpen, authBad),
    skills: 0,
    mcps: 0,
    settings: 0,
  };
}

function countTitle(id: NavId, n: number): string {
  if (id === "review") return `${n} card${n === 1 ? "" : "s"} to review`;
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
  const { connected, downSince, failing, restarting, starting } = useConnection();
  const label = connected
    ? starting
      ? "Starting…"
      : MOCK
        ? "Mock data"
        : "Live"
    : restarting
      ? "Restarting…"
      : failing
        ? "Offline"
        : downSince
          ? "Reconnecting…"
          : "Connecting…";
  return (
    <div className={`conn ${connected ? "on" : failing ? "off" : ""}`} title={`Connection: ${label}`} role="status">
      <span className="dot" aria-hidden="true" />
      <span className="conn-label nav-label">{label}</span>
    </div>
  );
}

/**
 * The app keeps rendering the last state it had; this says so out loud. Only
 * a failed connection is a banner: then the whole page is out of date. A
 * restart the server announced, and its first read of the transcripts, are
 * expected and over in seconds, so they go in the inbox (Inbox.tsx).
 */
function StaleBanner() {
  const { connected, downSince, retryAt, attempts, lastError, failing, restarting, retryNow } = useConnection();
  const secs = useCountdown(retryAt);
  if (connected || restarting || downSince === null || !failing) return null;
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
  const { connected, starting } = useConnection();
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
  if (connected && starting) {
    return (
      <Empty title="agentbox is starting…">
        <p>
          Reading transcripts{starting.of > 0 ? ` (${starting.read} of ${starting.of})` : ""}. Your sessions appear when it is done.
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
    <img src="/icon.svg" width="20" height="20" alt="" />
  );
}
