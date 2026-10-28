/** The projects you keep open, as tabs above the page, with a dot on one that
 *  has something waiting on you. Picking one is navigation (route.ts
 *  `selectScope`), as the switcher's pick is: nothing running is touched.
 *  Next and previous project tab are keybinds with no key until you give
 *  them one (Settings → Keybinds). */

import { useEffect, useState } from "react";
import type { AppState } from "../../src/core/types";
import { Icon } from "./components";
import { needsYou } from "./lib/board";
import { useKeybinds } from "./lib/keybinds";
import { scopedState, sessionProject } from "./lib/projects";
import { selectScope } from "./route";

const KEY = "agentbox.projectTabs";

function stored(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === "string"))] : [];
  } catch {
    return [];
  }
}

/** The open tabs: those you kept, else the two projects with the most sessions here; the selected one always among them. */
function useProjectTabs(state: AppState, selected: string | null) {
  const [saved, setSaved] = useState(stored);
  const repos = state.repos;
  let ids = saved.filter((id) => repos.some((r) => r.id === id));
  if (!ids.length) {
    const counts = new Map<string, number>();
    for (const s of state.sessions) {
      const id = sessionProject(repos, s);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    ids = [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)!).slice(0, 2);
  }
  if (selected && repos.some((r) => r.id === selected) && !ids.includes(selected)) ids = [...ids, selected];
  const stamp = JSON.stringify(ids);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, stamp);
    } catch {
      /* private mode: this tab still remembers */
    }
  }, [stamp]);
  const close = (id: string) => {
    const next = ids.filter((x) => x !== id);
    setSaved(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* as above */
    }
    if (selected === id) selectScope("project", next[Math.min(ids.indexOf(id), next.length - 1)] ?? null);
  };
  return { tabs: ids.map((id) => repos.find((r) => r.id === id)!), close };
}

/** What a project has waiting on you, said in the tab's title; empty when nothing. */
function attentionOf(state: AppState, project: string | null): string {
  const scoped = scopedState(state, project);
  const sessions = needsYou(scoped.sessions);
  const cards = scoped.cards.filter((c) => c.state === "open").length;
  return [sessions ? `${sessions} session${sessions === 1 ? "" : "s"} waiting on you` : "", cards ? `${cards} card${cards === 1 ? "" : "s"} to review` : ""]
    .filter(Boolean)
    .join("; ");
}

export function ProjectTabs({ state, selected, onOpen, hint }: { state: AppState; selected: string | null; onOpen: () => void; hint?: string }) {
  const { tabs, close } = useProjectTabs(state, selected);
  const all = [null, ...tabs.map((r) => r.id)];
  const step = (delta: 1 | -1) => () => {
    const at = all.indexOf(selected);
    selectScope("project", all[(at + delta + all.length) % all.length] ?? null);
  };
  useKeybinds({ "project.next": step(1), "project.prev": step(-1) });
  return (
    <nav className="project-bar" aria-label="Projects">
      <div className="project-tabs" role="tablist" aria-label="Open projects">
        {[null, ...tabs].map((r) => {
          const id = r?.id ?? null;
          const on = selected === id;
          const notice = attentionOf(state, id);
          return (
            <div className="project-tab" key={id ?? ""} data-active={on || undefined}>
              <button type="button" role="tab" aria-selected={on} onClick={() => selectScope("project", id)} title={[r ? (r.fullName ?? r.ref) : "Every project", notice].filter(Boolean).join(" — ")}>
                {r ? r.displayName : "All"}
                {notice && id ? <span className="project-tab-dot" aria-label={notice} /> : null}
              </button>
              {r ? (
                <button type="button" className="project-tab-close" aria-label={`Close the ${r.displayName} tab`} onClick={() => close(r.id)}>
                  <Icon.x size={11} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button type="button" className="project-tab-add" onClick={onOpen} aria-label="Open a project" title="Open a project" aria-haspopup="dialog">
        <Icon.plus size={14} />
      </button>
      {hint ? <span className="hint">{hint}</span> : null}
    </nav>
  );
}
