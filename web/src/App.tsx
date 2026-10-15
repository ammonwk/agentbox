/** The shell: routing, theme, global keys, and the two things that must always
 *  be true — you can link to what you are looking at, and you can tell when
 *  the data on screen is stale. */

import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { api, clockNow, MOCK, subscribeToClock, useAppState, useConnection } from "./api";
import type { AgentSettings, AppState } from "../../src/core/types";
import { Button, Empty, ErrorBoundary, Icon, type IconComponent } from "./components";
import { needsYou, titleOf } from "./lib/board";
import { go, hrefOf, navOf, onGo, parseHash, restoreScope, scopeOf, selectScope, type NavId, type Route } from "./route";
import { isInstalledApp, isPhone, openingTab } from "./lib/phone";
import { useServerBehind, useUpdateReady } from "./lib/update";
import { useKeyboardNavigation } from "./lib/keyboard";
import { SystemBar } from "./SystemBar";
import { SessionView } from "./views/session/SessionView";
import { isRecurring } from "../../src/core/schedule";
import { NewSession } from "./views/NewSession";
import { Settings } from "./views/Settings";
import { SettingsNav } from "./SettingsNav";
import { Skills } from "./views/Skills";
import { Mcps } from "./views/Mcps";
import { InboxBell } from "./Inbox";
import { Review } from "./views/Review";
import { Dictation } from "./Dictation";
import { request } from "./api";
import { ProjectContext, scopedState, projectOfSession, useScope } from "./lib/projects";
import { ProjectTabs, useProjectTabs } from "./ProjectTabs";
import { Profile } from "./views/Profile";
import { ProjectSwitcher } from "./ProjectSwitcher";

// Accounts and Calibration are visited, not lived in; keep them out of the
// first paint. (The terminal is lazy too, inside SessionView — xterm is the
// heaviest thing in the bundle.)
const Team = lazy(() => import("./views/Team").then((m) => ({ default: m.Team })));
const Accounts = lazy(() => import("./views/Accounts").then((m) => ({ default: m.Accounts })));
const Voice = lazy(() => import("./views/Voice").then((m) => ({ default: m.Voice })));
const Agents = lazy(() => import("./views/Agents").then((m) => ({ default: m.Agents })));

// ----------------------------------------------------------------- routing

function useRoute(): [Route, (to: Route, replace?: boolean) => void] {
  const [route, setRoute] = useState<Route>(() => { restoreScope(); return parseHash(location.hash); });

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
  { id: "agents", label: "Agents", icon: Icon.brain, to: { page: "agents" } },
  { id: "sessions", label: "Sessions", icon: Icon.sessions, to: { page: "sessions" } },
  { id: "review", label: "Review", icon: Icon.cards, to: { page: "review" } },
  { id: "voice", label: "Voice", icon: Icon.mic, to: { page: "voice" } },
  { id: "team", label: "Team", icon: Icon.link, to: { page: "team" } },
];

const PAGE_TITLE: Record<NavId, string> = {
  agents: "Agents",
  sessions: "Sessions",
  review: "Review",
  voice: "Voice",
  accounts: "Accounts",
  skills: "Skills",
  mcps: "MCPs",
  team: "Team",
  settings: "Settings",
  profile: "Profile",
};

export function App() {
  useKeyboardNavigation();
  const { state } = useAppState();
  const [route, navigate] = useRoute();
  useEffect(() => {
    if (new URLSearchParams(location.search).has("cloud") && route.page !== "team") navigate({ page: "team" }, true);
  }, []);
  useTheme(state?.settings.theme);
  const [newOpen, setNewOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const scope = useScope();
  const project = state?.repos.find((r) => r.id === scope.project) ?? null;
  const scoped = useMemo(() => (state ? scopedState(state, scope.project) : null), [state, scope.project]);
  const staleProject = !!state && !!scope.project && !project;
  const selectedSession = route.page === "session" ? state?.sessions.find((s) => s.id === route.id) : null;
  useEffect(() => {
    if (selectedSession && !scopeOf().has("project")) selectScope("project", projectOfSession(state!.repos, selectedSession), route, true);
  }, [selectedSession?.id]);
  const wrongSession = scope.project && selectedSession && projectOfSession(state!.repos, selectedSession) !== scope.project;
  const projectTabs = useProjectTabs(state, scope.project);
  // For the key handler below, which is added once.
  const tabOrder = useRef<{ ids: string[]; selected: string | null }>({ ids: [], selected: null });
  tabOrder.current = { ids: projectTabs.tabs.map((t) => t.id), selected: scope.project };
  // A link to one agent with no project waits: the Agents page selects the
  // agent's first project. For an agent that names none, the first tab opens.
  const agentLink = route.page === "agents" && !!route.id && !scopeOf().has("project");
  useEffect(() => {
    if (!state || scope.project || !projectTabs.tabs.length || route.page === "session" || agentLink) return;
    selectScope("project", projectTabs.tabs[0]!.id, route, true);
  }, [!!state, scope.project, route.page, projectTabs.tabs[0]?.id, agentLink]);
  const nav = navOf(route);
  // The start of the system bar, where an open session puts its facts.

  const counts = useMemo(() => countsOf(scoped), [scoped]);

  const contentRef = useRef<HTMLElement>(null);
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [route.page, route.page === "agents" ? route.id : null]);

  // With the breadcrumb gone, the tab title is where the session's name lives.
  const here = route.page === "session" && state ? `${titleOfId(state, route.id)} — agentbox` : "agentbox";
  useEffect(() => {
    document.title = counts.sessions > 0 ? `(${counts.sessions}) ${here}` : here;
  }, [counts.sessions, here]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (e.key === "Tab" && e.shiftKey) {
        // Shift+Tab steps to the next project tab, and from the last to the
        // first. Not in a text field or the terminal (isTyping), where it is
        // the field's or the agent's own (Claude Code's mode switch), and not
        // in a dialog; elsewhere it no longer moves focus back.
        const { ids, selected } = tabOrder.current;
        if (ids.length < 2) return;
        e.preventDefault();
        selectScope("project", ids[(ids.indexOf(selected ?? "") + 1) % ids.length]!);
      } else if (e.key === "n") {
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
    // Ctrl+Tab steps to the next project tab and Ctrl+Shift+Tab to the one
    // before, from anywhere, as a browser's tabs do. A browser keeps the key
    // for its own tabs; the installed app and the desktop app give it here.
    const onCtrlTab = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.key !== "Tab") return;
      const { ids, selected } = tabOrder.current;
      if (ids.length < 2 || document.querySelector(".modal-backdrop")) return;
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? ids.length - 1 : 1;
      selectScope("project", ids[(ids.indexOf(selected ?? "") + step) % ids.length]!);
    };
    addEventListener("keydown", onKey);
    addEventListener("keydown", onCtrlT, true);
    addEventListener("keydown", onCtrlTab, true);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keydown", onCtrlT, true);
      removeEventListener("keydown", onCtrlTab, true);
    };
  }, []);

  const flush = route.page === "sessions" || route.page === "session" || route.page === "voice" || route.page === "review";
  const focusAccount = route.page === "session" ? state?.sessions.find((x) => x.id === route.id)?.accountId ?? null : null;

  return (
    <ProjectContext.Provider value={{ repos: state?.repos ?? [] }}><div className="app" data-page={route.page}>
      <Dictation />
      <a className="skip" href="#content">
        Skip to content
      </a>

      {/* The slot holds the icon rail's width in the layout; the sidebar
          itself widens over the page on hover, so nothing beside it reflows. */}
      <div className="sidebar-slot">
        <aside className="sidebar" data-nav-region="navigation" aria-label="Application navigation">
          <a className="brand project-brand" href={hrefOf({ page: "agents" })} aria-label="agentbox home" title="agentbox">
            <BrandMark />
            <span className="nav-label">agentbox</span>
            {MOCK ? (
              <span className="mock-tag" title="Opened with ?mock=1 — nothing here is real and nothing is sent anywhere">
                mock
              </span>
            ) : null}
          </a>

          <nav aria-label="Primary">
            {NAV.map(({ id, label, icon: IconCmp, to }) => {
              const count = counts[id];
              const active = nav === id;
              return (
                <a
                  key={id}
                  data-nav-item
                  data-nav-id={id}
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

          <div className="sidebar-footer">
            <UpdateReady />
            <a className={`nav-item ${nav === "settings" ? "active" : ""}`} data-nav-item data-nav-id="settings" href={hrefOf({ page: "settings" })} aria-current={nav === "settings" ? "page" : undefined} title="Settings">
              <Icon.settings size={20} weight="duotone" />
              <span className="nav-label">Settings</span>
              {counts.accounts > 0 ? <span className="count count-warn" title={countTitle("accounts", counts.accounts)}>{counts.accounts}</span> : null}
            </a>
            <InboxBell state={state} />
            <ProfileLink identity={state?.onboarding.identity} active={route.page === "profile"} />
          </div>
        </aside>
      </div>

      <div className="main">
        <ProjectTabs tabs={projectTabs.tabs} attention={projectTabs.attention} selected={scope.project} onAdd={() => setSwitcherOpen(true)} onClose={projectTabs.close} />
        {/* The sessions pages carry their own header — the board's filter bar,
            the session's title — so a page title above them is a second one. */}
        {flush || route.page === "agents" || route.page === "profile" ? null : (
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

        {nav === "settings" ? <SettingsNav route={route} accountAlerts={counts.accounts} /> : null}

        {/* The one banner left: the rest are in the inbox (Inbox.tsx). */}
        <StaleBanner />

        <main className={`content ${(flush || route.page === "skills" || route.page === "mcps") && state ? "flush" : ""}`} id="content" ref={contentRef} tabIndex={-1} data-nav-region="page" data-nav-route={hrefOf(route)}>
          <ErrorBoundary resetKey={hrefOf(route)} label="This page">
            {!state ? (
              <Bootstrapping />
            ) : staleProject && ["agents", "session", "sessions", "review"].includes(route.page) ? (
              <Empty title="This project is no longer registered"><Button onClick={() => setSwitcherOpen(true)}>Choose a project</Button></Empty>
            ) : wrongSession ? (
              <Empty title="This session belongs to another project"><Button onClick={() => selectScope("project", projectOfSession(state.repos, selectedSession!), route)}>Open in its project</Button></Empty>
            ) : route.page === "sessions" || route.page === "session" ? (
              <SessionView
                key={scope.project ?? "all"}
                state={state}
                visible={scoped!}
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
            ) : route.page === "agents" ? (
              <Suspense fallback={<Empty title="Loading…" />}><Agents key={`${scope.workspace}:${scope.project ?? "all"}`} state={state} route={route} /></Suspense>
            ) : route.page === "accounts" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Accounts state={state} route={route} />
              </Suspense>
            ) : route.page === "voice" ? (
              <Suspense fallback={<Empty title="Loading…" />}>
                <Voice />
              </Suspense>
            ) : route.page === "review" ? (
              <Review key={scope.project ?? "all"} state={scoped!} />
            ) : route.page === "skills" ? (
              <Skills skills={state.skills} />
            ) : route.page === "team" ? (
              <Suspense fallback={<Empty title="Loading…" />}><Team state={state} /></Suspense>
            ) : route.page === "profile" ? (
              <Profile identity={state.onboarding.identity} />
            ) : route.page === "mcps" ? (
              <Mcps />
            ) : (
              <Settings state={state} />
            )}
          </ErrorBoundary>
        </main>

        <ErrorBoundary label="The system bar">
          <SystemBar accounts={state?.accounts ?? []} sessions={state?.sessions ?? []} cleanup={state?.cleanup ?? null} focusAccount={focusAccount} />
        </ErrorBoundary>
      </div>

      {switcherOpen && state && <ProjectSwitcher repos={state.repos} selected={scope.project} onClose={() => setSwitcherOpen(false)} />}
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
    </div></ProjectContext.Provider>
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
  if (!state) return { agents: 0, sessions: 0, review: 0, voice: 0, accounts: 0, skills: 0, mcps: 0, team: 0, settings: 0, profile: 0 };
  const loginsOpen = state.logins.filter((l) => l.state !== "done" && l.state !== "failed").length;
  const authBad = state.accounts.filter((a) => a.enabled && (a.auth.state === "expired" || a.auth.state === "missing")).length;
  return {
    agents: 0,
    sessions: needsYou(state.sessions.filter((s) => !s.agentOwner)),
    // Kept for later is still yours, but you have seen it: it does not nag.
    review: state.cards.filter((c) => c.state === "open").length,
    voice: 0,
    accounts: Math.max(loginsOpen, authBad),
    skills: 0,
    mcps: 0,
    team: 0,
    settings: 0,
    profile: 0,
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
        : "Update ready. It loads automatically when editing, sending or recording is finished. Click to reload now."}
      onClick={() => {
        if (!behind) return location.reload();
        setRestarting(true);
        request("POST", "/api/server/restart").catch(() => setRestarting(false));
      }}
    >
      <Icon.refresh />
      <span className="nav-label">{restarting ? "Restarting…" : "Update"}</span>
    </button>
  );
}

function ProfileLink({ identity, active }: { identity: AppState["onboarding"]["identity"] | undefined; active: boolean }) {
  const name = identity?.name || "Your profile";
  const github = identity?.github;
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return (
    <a className={`nav-item nav-profile ${active ? "active" : ""}`} data-nav-item data-nav-id="profile" aria-current={active ? "page" : undefined} href={hrefOf({ page: "profile" })} aria-label={`${name} · Profile`} title={`${name} · Profile`}>
      <span className="nav-avatar" aria-hidden="true">
        {github && failedImage !== github ? <img src={`https://github.com/${encodeURIComponent(github)}.png?size=64`} alt="" referrerPolicy="no-referrer" onError={() => setFailedImage(github)} /> : initials}
      </span>
      <span className="nav-label">{name}</span>
    </a>
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
