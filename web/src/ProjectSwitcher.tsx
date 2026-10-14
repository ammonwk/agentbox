/** The switcher behind the sidebar's logo: one registered repository, or All
 *  projects. Picking one is navigation (route.ts `selectScope`): nothing
 *  running is touched. */

import { useState } from "react";
import type { Repo } from "../../src/core/types";
import { Button, Icon, Modal } from "./components";
import { go, selectScope } from "./route";

export function ProjectSwitcher({ repos, selected, onClose }: { repos: Repo[]; selected: string | null; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const visible = repos.filter((r) => `${r.displayName} ${r.fullName ?? ""} ${r.ref}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pick = (id: string | null) => {
    selectScope("project", id);
    onClose();
  };
  // Two repos may share a name (a fork, a second clone): then the path tells them apart.
  const ambiguous = (r: Repo) => !!r.fullName && repos.some((o) => o.id !== r.id && (o.fullName === r.fullName || o.displayName === r.displayName));
  return (
    <Modal title="Switch project" hint="One repository per project. Switching keeps all running work active." onClose={onClose}>
      <input
        className="input"
        autoFocus
        aria-label="Search projects"
        placeholder="Search repositories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".project-option")?.focus();
          }
          if (e.key === "Enter" && query && visible.length === 1) {
            e.preventDefault();
            pick(visible[0]!.id);
          }
        }}
      />
      <div
        className="project-options"
        role="group"
        aria-label="Projects"
        onKeyDown={(e) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
          const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          e.preventDefault();
          buttons[next]?.focus();
        }}
      >
        <button type="button" className="project-option" aria-pressed={!selected} onClick={() => pick(null)}>
          <span>
            <strong>All projects</strong>
            <small>Overview, general conversations and unassigned work</small>
          </span>
          {!selected && <Icon.check />}
        </button>
        {visible.map((r) => (
          <button type="button" className="project-option" key={r.id} aria-pressed={r.id === selected} onClick={() => pick(r.id)}>
            <span>
              <strong>{r.displayName}</strong>
              <small>{r.fullName ?? r.ref}</small>
              {ambiguous(r) && <small>{r.ref}</small>}
            </span>
            {r.id === selected && <Icon.check />}
          </button>
        ))}
        {!visible.length && <p className="hint">No matching repositories.</p>}
      </div>
      <Button
        onClick={() => {
          onClose();
          go({ page: "settings" });
        }}
      >
        Manage projects
      </Button>
    </Modal>
  );
}
