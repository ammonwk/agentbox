import { useEffect, useMemo, useState } from "react";
import { useAppState, api, type AgentSettings } from "./api";
import { Icon } from "./components";
import { Conductor } from "./views/Conductor";
import { Agents } from "./views/Agents";
import { Prs } from "./views/Prs";
import { Skills } from "./views/Skills";
import { Settings } from "./views/Settings";

type Page = "conductor" | "agents" | "prs" | "skills" | "settings";

const NAV: { id: Page; label: string; icon: (p: { size?: number }) => React.ReactElement }[] = [
  { id: "conductor", label: "Conductor", icon: Icon.conductor },
  { id: "agents", label: "Agents", icon: Icon.board },
  { id: "prs", label: "Pull Requests", icon: Icon.prs },
  { id: "skills", label: "Skills", icon: Icon.skills },
  { id: "settings", label: "Settings", icon: Icon.settings },
];

const PAGE_TITLE: Record<Page, string> = {
  conductor: "Conductor",
  agents: "Agents",
  prs: "Pull Requests",
  skills: "Skills",
  settings: "Settings",
};

export function App() {
  const { state, connected } = useAppState();
  const [page, setPage] = useState<Page>("conductor");
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);

  const { theme, setTheme } = useTheme(state?.settings.theme ?? "system");

  useEffect(() => {
    if (focusSessionId) {
      setPage("agents");
      const t = setTimeout(() => setFocusSessionId(null), 1200);
      return () => clearTimeout(t);
    }
  }, [focusSessionId]);

  const counts = useMemo(() => {
    if (!state) return { conductor: 0, agents: 0, prs: 0 };
    return {
      conductor: state.conductor.length,
      agents: state.sessions.filter((s) => ["running", "spawning", "waiting"].includes(s.status)).length,
      prs: state.prs.length,
    };
  }, [state]);

  function openSession(id: string) {
    setFocusSessionId(id);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <svg viewBox="0 0 32 32">
            <rect x="3" y="3" width="26" height="26" rx="6" fill="var(--accent)" opacity="0.15" />
            <rect x="8" y="8" width="16" height="4" rx="1.5" fill="var(--accent)" />
            <rect x="8" y="16" width="10" height="4" rx="1.5" fill="var(--text)" opacity="0.85" />
            <rect x="8" y="23" width="13" height="3" rx="1.5" fill="var(--faint)" />
          </svg>
          agentbox
        </div>

        {NAV.map(({ id, label, icon: IconCmp }) => (
          <button key={id} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => setPage(id)}>
            <IconCmp />
            {label}
            {counts[id as "conductor"] > 0 && (
              <span className="count">{counts[id as keyof typeof counts]}</span>
            )}
          </button>
        ))}

        <div className="spacer" />
        <button
          className="theme-toggle"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Icon.sun size={15} /> : <Icon.moon size={15} />}
          {theme === "dark" ? "Light mode" : "Dark mode"}
        </button>
      </aside>

      <div className="main">
        <div className="topbar">
          <h1>{PAGE_TITLE[page]}</h1>
          <span className={`conn ${connected ? "on" : ""}`}>
            <span className="dot" />
            {connected ? "live" : "reconnecting"}
          </span>
        </div>
        <div className="content">
          {!state ? (
            <div className="empty"><h3>Connecting…</h3></div>
          ) : page === "conductor" ? (
            <Conductor state={state} onOpenSession={openSession} />
          ) : page === "agents" ? (
            <Agents state={state} focusSessionId={focusSessionId} />
          ) : page === "prs" ? (
            <Prs state={state} onOpenSession={openSession} />
          ) : page === "skills" ? (
            <Skills state={state} />
          ) : (
            <Settings state={state} onSettingsChange={persistLocalTheme} />
          )}
        </div>
      </div>
    </div>
  );

  function persistLocalTheme(s: AgentSettings) {
    setTheme(s.theme);
  }
}

function useTheme(pref: AgentSettings["theme"]) {
  const [resolved, setResolved] = useState<"light" | "dark">(resolve(pref));

  useEffect(() => {
    function update() {
      setResolved(resolve(pref));
    }
    update();
    if (pref === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
  }, [pref]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  return {
    theme: resolved,
    setTheme: (t: AgentSettings["theme"]) => {
      void api.saveSettings({ theme: t });
      setResolved(resolve(t));
    },
  };
}

function resolve(pref: AgentSettings["theme"]): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}
