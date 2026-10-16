import { useEffect, useState } from "react";
import type { AppState } from "../../src/core/types";
import { Icon } from "./components";
import { scopedState, projectOfSession } from "./lib/projects";
import { needsYou } from "./lib/board";
import { selectScope } from "./route";

const KEY = "agentbox.projectTabs";
function storedTabs(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  } catch { return []; }
}

export function useProjectTabs(state: AppState | null, selected: string | null) {
  const [saved, setSaved] = useState(storedTabs);
  const repos = state?.repos ?? [];
  const valid = saved.filter((id) => repos.some((r) => r.id === id));
  // Start with the two projects used most on this machine; no repository names
  // or personal paths belong in the application source.
  const counts = new Map<string, number>();
  if (state && !valid.length) for (const s of state.sessions) {
    const id = projectOfSession(repos, s);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = valid.length ? valid : [...repos].sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0)).slice(0, 2).map((r) => r.id);
  if (selected && repos.some((r) => r.id === selected) && !ids.includes(selected)) ids.push(selected);
  const stamp = JSON.stringify(ids);
  useEffect(() => {
    if (!state) return;
    setSaved(ids);
    try { localStorage.setItem(KEY, stamp); } catch { /* this tab still remembers */ }
  }, [stamp, !!state]);
  const close = (id: string) => {
    const next = ids.filter((v) => v !== id);
    if (!next.length) return;
    setSaved(next);
    if (selected === id) selectScope("project", next[Math.min(ids.indexOf(id), next.length - 1)]!);
  };
  const tabs = ids.map((id) => repos.find((r) => r.id === id)!);
  const attention = new Map<string, string>();
  if (state) for (const project of tabs) {
    const scoped = scopedState(state, project.id);
    const sessions = needsYou(scoped.sessions);
    const cards = scoped.cards.filter((c) => c.state === "open").length;
    const notice = [
      sessions ? `${sessions} session${sessions === 1 ? "" : "s"} waiting on you` : "",
      cards ? `${cards} card${cards === 1 ? "" : "s"} to review` : "",
    ].filter(Boolean).join("; ");
    if (notice) attention.set(project.id, notice);
  }
  return { tabs, attention, close };
}

export function ProjectTabs({ tabs, attention, selected, onAdd, onClose }: {
  tabs: AppState["repos"];
  attention: ReadonlyMap<string, string>;
  selected: string | null;
  onAdd: () => void;
  onClose: (id: string) => void;
}) {
  return <nav className="project-bar" aria-label="Projects">
    <div className="project-tabs" role="tablist" aria-label="Open projects" onKeyDown={(e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || (e.target as HTMLElement).getAttribute("role") !== "tab") return;
      const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const index = buttons.indexOf(e.target as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      e.preventDefault(); buttons[next]?.focus(); buttons[next]?.click();
    }}>
      {tabs.map((r) => <div className="project-tab" key={r.id} data-active={selected === r.id || undefined}>
        <button type="button" role="tab" aria-selected={selected === r.id} aria-controls="content" aria-describedby={attention.has(r.id) ? `project-attention-${r.id}` : undefined} tabIndex={selected === r.id || !selected && r === tabs[0] ? 0 : -1} onClick={() => selectScope("project", r.id)} title={[r.fullName ?? r.ref, attention.get(r.id)].filter(Boolean).join(" — ")}>
          {r.displayName}
          {attention.has(r.id) && <>
            <span className="project-tab-dot" aria-hidden="true" />
            <span className="sr-only" id={`project-attention-${r.id}`}>{attention.get(r.id)}</span>
          </>}
        </button>
        {tabs.length > 1 && <button type="button" className="project-tab-close" aria-label={`Close ${r.displayName} tab`} onClick={() => onClose(r.id)}><Icon.x size={12} /></button>}
      </div>)}
    </div>
    <button type="button" className="project-tab-add" onClick={onAdd} aria-label="Add project tab" title="Add project tab" aria-haspopup="dialog"><Icon.plus size={16} /></button>
  </nav>;
}
