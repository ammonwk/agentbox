/** The shell: routing, theme, global keys, and the two things that must always
 *  be true — you can link to what you are looking at, and you can tell when
 *  the data on screen is stale. */

import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, clockNow, MOCK, subscribeToClock, useAppState, useConnection } from "./api";
import type { AgentSettings, AppState } from "../../src/core/types";
import { Button, Empty, ErrorBoundary, Icon, type IconComponent } from "./components";
import { needsYou, titleOf } from "./lib/board";
import { go, hrefOf, navOf, onGo, parseHash, restoreScope, scopeOf, selectScope, type NavId, type Route } from "./route";
import { isInstalledApp, isPhone, openingTab, pickedTab } from "./lib/phone";
import { useServerBehind, useUpdateReady } from "./lib/update";
import { useKeyboardNavigation } from "./lib/keyboard";
import { SystemBar } from "./SystemBar";
import { SysbarSlot } from "./sysbarslot";
import { SessionView } from "./views/session/SessionView";
import { FileViewerHost } from "./views/session/FileViewer";
import { isRecurring } from "../../src/core/schedule";
import { NewSession } from "./views/NewSession";
import { Settings } from "./views/Settings";
import { Shortcuts } from "./views/Shortcuts";
import { Context } from "./views/Context";
import { Mcps } from "./views/Mcps";
import { InboxBell } from "./Inbox";
import { ProjectContext, scopedState, sessionProject, useScope } from "./lib/projects";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { ProjectTabs } from "./ProjectTabs";
import { Fenced, loadPlugins, pagesOf, runCommand, SAFE, SeenContext, usePlugins } from "./plugin/registry";

// Accounts and Calibration are visited, not lived in; keep them out of the
// first paint. (The terminal is lazy too, inside SessionView — xterm is the
// heaviest thing in the bundle.)
const Accounts = lazy(() => import("./views/Accounts").then((m) => ({ default: m.Accounts })));
const Voice = lazy(() => import("./views/Voice").then((m) => ({ default: m.Voice })));
const Extensions = lazy(() => import("./views/Extensions").then((m) => ({ default: m.Extensions })));

// ----------------------------------------------------------------- routing

function useRoute(): [Route, (to: Route, replace?: boolean) => void] {
  // An unscoped link to a list opens in the project this browser last looked at.
  const [route, setRoute] = useState<Route>(() => {
    restoreScope();
    return parseHash(location.hash);
  });

  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", onChange);
    addEventListener("popstate", onChange);
    const off = onGo(onChange);
    // Normalise "" and anything unrecognised without adding a history entry.
    if (hrefOf(parseHash(location.hash)) !== location.hash) {
      history.replaceState(history.state, "", hrefOf(parseHash(location.hash)));
    }
    return () => {
      removeEventListener("hashchange", onChange);
      removeEventListener("popstate", onChange);
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
  { id: "voice", label: "Voice", icon: Icon.mic, to: { page: "voice" } },
  { id: "accounts", label: "Accounts", icon: Icon.users, to: { page: "accounts", sub: "accounts" } },
  { id: "context", label: "Context", icon: Icon.context, to: { page: "context" } },
  { id: "mcps", label: "MCPs", icon: Icon.plugs, to: { page: "mcps" } },
  { id: "settings", label: "Settings", icon: Icon.settings, to: { page: "settings" } },
];

/** Pages a project filters (and extensions' pages that say `scoped`); the rest are the machine's, whatever is selected. */
const SCOPED_PAGES = new Set<Route["page"]>(["session", "sessions"]);
const GLOBAL_PAGES = new Set<Route["page"]>(["accounts", "settings", "extensions", "context", "mcps", "voice"]);

const PAGE_TITLE: Record<string, string> = {
  sessions: "Sessions",
  voice: "Voice",
  accounts: "Accounts",
  context: "Context",
  mcps: "MCPs",
  settings: "Settings",
};

export function App() {
  useKeyboardNavigation();
  const { state } = useAppState();
  useEffect(() => void loadPlugins(), []);
  const plugins = usePlugins();
  const extPages = useMemo(() => pagesOf(plugins.loaded), [plugins.loaded]);
  const [route, navigate] = useRoute();
  useTheme(state?.settings.theme);
  const [newOpen, setNewOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The selected project (lib/projects.tsx): the lists, badges and the
  // new-session dialog see the board through it. Accounts, MCPs, settings
  // and the system bar are global.
  const scope = useScope();
  const project = state?.repos.find((r) => r.id === scope.project) ?? null;
  const scoped = useMemo(() => (state ? scopedState(state, scope.project) : null), [state, scope.project]);
  // A scope naming a repo that is registered no more (or on another machine).
  const staleProject = !!state && !!scope.project && !project;
  const selectedSession = route.page === "session" ? state?.sessions.find((s) => s.id === route.id) : null;
  // An unscoped link straight to a session lands in that session's project.
  useEffect(() => {
    if (selectedSession && !scopeOf().has("project")) selectScope("project", sessionProject(state!.repos, selectedSession), route, true);
  }, [selectedSession?.id]);
  const wrongSession = !!scope.project && !!selectedSession && !scoped!.sessions.some((s) => s.id === selectedSession.id);
  const projectName = project?.displayName ?? (staleProject ? "Unavailable project" : "All projects");
  const nav = navOf(route);
  // The start of the system bar, where an open session puts its facts.
  const [sysbarSlot, setSysbarSlot] = useState<HTMLElement | null>(null);

  const extPage = route.page === "ext" ? (extPages.find((p) => p.id === route.id) ?? null) : null;
  const scopedPage = SCOPED_PAGES.has(route.page) || !!extPage?.scoped;
  // The rail: Sessions, then what extensions added, then the app's own tools.
  const rail = useMemo(
    () => [
      NAV[0]!,
      ...extPages.map((p) => ({ id: p.id, label: p.label, icon: p.icon, to: { page: "ext", id: p.id, rest: "" } as Route })),
      ...NAV.slice(1),
    ],
    [extPages],
  );
  const counts = useMemo(() => {
    const out: Record<string, number> = countsOf(scoped);
    for (const p of extPages) {
      if (!p.badge || !state || !scoped) continue;
      try {
        out[p.id] = p.badge(p.scoped ? scoped : state);
      } catch (e) {
        console.error(`agentbox: extension ${p.ext}, the count on ${p.id}`, e);
      }
    }
    return out;
  }, [scoped, state, extPages]);

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
      if (document.querySelector(".modal-backdrop, .fv-backdrop")) return;
      if (e.key === "n") {
        e.preventDefault();
        setNewOpen(true);
      } else if (e.key === "?") {
        e.preventDefault();
        setKeysOpen(true);
      } else if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>("[data-search]");
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
      } else if (runCommand(e.key)) {
        e.preventDefault();
      }
    };
    // Ctrl+T is `n` in the installed app, from anywhere, the terminal
    // included: captured before xterm can send it as a key.
    const onCtrlT = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.key.toLowerCase() !== "t" || !isInstalledApp()) return;
      e.preventDefault();
      e.stopPropagation();
      if (!document.querySelector(".modal-backdrop, .fv-backdrop")) setNewOpen(true);
    };
    addEventListener("keydown", onKey);
    addEventListener("keydown", onCtrlT, true);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keydown", onCtrlT, true);
    };
  }, []);

  const flush = route.page === "sessions" || route.page === "session" || route.page === "voice" || !!extPage?.flush;
  const focusAccount = route.page === "session" ? state?.sessions.find((x) => x.id === route.id)?.accountId ?? null : null;

  return (
    <ProjectContext.Provider value={{ repos: state?.repos ?? [] }}>
    <SeenContext.Provider value={state && scoped ? { state, scoped, project: scope.project } : null}>
    <div className="app" data-page={route.page === "ext" ? route.id : route.page}>
      <a className="skip" href="#content">
        Skip to content
      </a>

      {/* The slot holds the icon rail's width in the layout; the sidebar
          itself widens over the page on hover, so nothing beside it reflows. */}
      <div className="sidebar-slot">
        <aside className="sidebar" data-nav-region="navigation" aria-label="Application navigation">
          {/* The logo is the project: it names the selected one and opens the switcher. */}
          <button
            type="button"
            className="brand project-brand"
            aria-label={`Switch project: ${projectName}`}
            title={`Switch project · ${projectName}`}
            aria-haspopup="dialog"
            onClick={() => setSwitcherOpen(true)}
          >
            <BrandMark />
            <span className="nav-label">{projectName}</span>
            {MOCK ? (
              <span className="mock-tag" title="Opened with ?mock=1 — nothing here is real and nothing is sent anywhere">
                mock
              </span>
            ) : null}
          </button>

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
            {rail.map(({ id, label, icon: IconCmp, to }) => {
              const count = counts[id] ?? 0;
              const active = nav === id;
              return (
                <a
                  key={id}
                  data-nav-item
                  data-nav-id={id}
                  data-nav-ext={extPages.some((p) => p.id === id) || undefined}
                  aria-keyshortcuts="ArrowUp ArrowDown ArrowRight"
                  className={`nav-item ${active ? "active" : ""}`}
                  href={hrefOf(to)}
                  aria-current={active ? "page" : undefined}
                  title={label}
                >
                  <IconCmp size={20} weight="duotone" />
                  <span className="nav-label">{label}</span>
                  {count > 0 ? (
                    <span className={`count${id === "accounts" ? " count-warn" : ""}`} title={extPages.find((p) => p.id === id)?.badgeTitle?.(count) ?? countTitle(id, count)}>
                      {count}
                    </span>
                  ) : null}
                </a>
              );
            })}
          </nav>

          <div className="spacer" />
          <button type="button" className="nav-item nav-keys" title="Keyboard shortcuts (?)" onClick={() => setKeysOpen(true)}>
            <Icon.keyboard size={20} />
            <span className="nav-label">Shortcuts</span>
            <kbd className="nav-label">?</kbd>
          </button>
          <UpdateReady />
          <InboxBell state={state} />
          <ConnectionChip />
        </aside>
      </div>

      <div className="main">
        {/* The projects you keep open (ProjectTabs.tsx); + opens any other. */}
        {state ? (
          <ProjectTabs
            state={state}
            selected={scope.project}
            onOpen={() => setSwitcherOpen(true)}
            hint={GLOBAL_PAGES.has(route.page) ? (route.page === "context" ? "What agents are told" : "Global settings and tools") : undefined}
          />
        ) : null}
        {/* The sessions pages carry their own header — the board's filter bar,
            the session's title — so a page title above them is a second one. */}
        {flush ? null : (
          <header className="topbar">
            <h1>{extPage?.label ?? PAGE_TITLE[nav] ?? ""}</h1>
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
            ) : route.page === "settings" || route.page === "extensions" ? (
              <div className="seg topbar-seg" role="group" aria-label="Settings view">
                <button type="button" aria-pressed={route.page === "settings"} onClick={() => navigate({ page: "settings" })}>
                  <Icon.settings size={14} />
                  General
                </button>
                <button type="button" aria-pressed={route.page === "extensions"} onClick={() => navigate({ page: "extensions", name: null })}>
                  <Icon.extension size={14} />
                  Extensions
                </button>
              </div>
            ) : null}
          </header>
        )}

        {/* The one banner left: the rest are in the inbox (Inbox.tsx). */}
        <StaleBanner />

        <SysbarSlot.Provider value={sysbarSlot}>
        <main className={`content ${(flush || route.page === "mcps" || route.page === "extensions") && state ? "flush" : ""}`} id="content" ref={contentRef} tabIndex={-1} data-nav-region="page" data-nav-route={hrefOf(route)}>
          <ErrorBoundary resetKey={hrefOf(route)} label="This page">
            {!state ? (
              <Bootstrapping />
            ) : staleProject && scopedPage ? (
              <Empty title="This project is no longer registered" action={<Button onClick={() => selectScope("project", null)}>All projects</Button>}>
                <p>Your conversations and work remain in All projects.</p>
              </Empty>
            ) : wrongSession ? (
              <Empty
                title="This session belongs to another project"
                action={<Button onClick={() => selectScope("project", sessionProject(state.repos, selectedSession), route)}>Open in its project</Button>}
              />
            ) : route.page === "sessions" || route.page === "session" ? (
              <SessionView
                key={scope.project ?? "all"}
                state={state}
                visible={scoped!}
                id={route.page === "session" ? route.id : null}
                tab={route.page === "session" ? route.tab : "timeline"}
                onTab={(tab) => {
                  pickedTab(tab);
                  if (route.page === "session") navigate({ page: "session", id: route.id, tab }, true);
                }}
                onOpen={(id) => navigate({ page: "session", id, tab: openingTab(state.sessions.find((s) => s.id === id)) })}
                onNew={() => setNewOpen(true)}
              />
            ) : route.page === "extensions" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Extensions name={route.name} />
              </Suspense>
            ) : route.page === "accounts" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Accounts state={state} route={route} />
              </Suspense>
            ) : route.page === "voice" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Voice />
              </Suspense>
            ) : route.page === "ext" ? (
              extPage ? (
                <Fenced ext={extPage.ext} what="This page" reset={hrefOf(route)}>
                  {extPage.render({ state: extPage.scoped ? scoped! : state, rest: route.rest })}
                </Fenced>
              ) : !plugins.ready ? (
                <Empty title="Loading…" />
              ) : SAFE ? (
                <Empty title="Extensions are not loaded" action={<a className="btn" href={location.pathname + location.hash}>Load them</a>}>
                  <p>
                    This page was opened with <code>?safe=1</code>, so no extension's part in the app is here.
                  </p>
                </Empty>
              ) : (
                <Empty title="No such page" action={<a className="btn" href={hrefOf({ page: "extensions", name: null })}>Extensions</a>}>
                  <p>
                    No extension adds a page called <code>{route.id}</code>.
                  </p>
                </Empty>
              )
            ) : route.page === "context" ? (
              <Context state={state} />
            ) : route.page === "mcps" ? (
              <Mcps />
            ) : (
              <Settings state={state} />
            )}
          </ErrorBoundary>
        </main>
        </SysbarSlot.Provider>

        <ErrorBoundary label="The system bar">
          <SystemBar
            accounts={state?.accounts ?? []}
            sessions={state?.sessions ?? []}
            focusAccount={focusAccount}
            slotRef={setSysbarSlot}
            tail={plugins.loaded.flatMap((l) => l.status.map((render, i) => <Fenced key={`${l.name}:${i}`} ext={l.name} what="A status item" small>{render()}</Fenced>))}
          />
        </ErrorBoundary>
      </div>

      <ErrorBoundary label="The file viewer">
        <FileViewerHost />
      </ErrorBoundary>
      {keysOpen ? <Shortcuts onClose={() => setKeysOpen(false)} /> : null}
      {switcherOpen && state ? <ProjectSwitcher repos={state.repos} selected={scope.project} onClose={() => setSwitcherOpen(false)} /> : null}
      {newOpen && state ? (
        <ErrorBoundary label="The new-session dialog">
          <NewSession
            key={scope.project ?? "all"}
            project={project?.id ?? null}
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
    </SeenContext.Provider>
    </ProjectContext.Provider>
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

function countsOf(state: AppState | null): Record<string, number> {
  if (!state) return {};
  const loginsOpen = state.logins.filter((l) => l.state !== "done" && l.state !== "failed").length;
  const authBad = state.accounts.filter((a) => a.enabled && (a.auth.state === "expired" || a.auth.state === "missing")).length;
  return {
    sessions: needsYou(state.sessions),
    accounts: Math.max(loginsOpen, authBad),
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

/** A rebuild this page is not running yet, which reloads by itself when that
 *  is safe, or newer commits the server is not running, which wait for a
 *  click to restart it on them (lib/update.ts). */
function UpdateReady() {
  const ready = useUpdateReady();
  const behind = useServerBehind();
  const [restarting, setRestarting] = useState(false);
  useEffect(() => setRestarting(false), [behind?.running]);
  if (!ready && !behind) return null;
  const n = behind?.commits ?? 0;
  return (
    <button
      type="button"
      className="nav-item nav-update"
      disabled={restarting}
      title={behind
        ? `${n} newer commit${n === 1 ? "" : "s"} in the checkout than the server runs. Click to restart the server on ${n === 1 ? "it" : "them"}; sessions keep running.`
        : "agentbox was rebuilt. Reload to run the new version (it reloads by itself next time you leave the page)"}
      onClick={() => {
        if (!behind) return location.reload();
        setRestarting(true);
        api.restartServer().catch(() => setRestarting(false));
      }}
    >
      <Icon.refresh />
      <span className="nav-label">{restarting ? "Restarting…" : "Update"}</span>
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

/** The theme Settings saved, applied: `system` follows the system's. Cached
 *  so a load paints in it before the state arrives. */
function useTheme(serverPref: AgentSettings["theme"] | undefined) {
  const pref = serverPref ?? readCachedTheme();

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

function BrandMark() {
  return (
    <img src="/icon.svg" width="20" height="20" alt="" />
  );
}
