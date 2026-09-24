import { useEffect, useMemo, useState } from "react";
import type { SkillInfo } from "../../../src/core/types";
import { api } from "../api";
import { Button, Confirm, Empty, Icon } from "../components";
import { useIsNarrow } from "./session/useIsNarrow";
import "./skills.css";

/**
 * Every skill an agent can reach — global, agents and repo-local — in one list
 * you can read, edit, and promote from.
 *
 * Ported from Switchyard's skills page. The list itself arrives in cold state;
 * this view only reaches for the HTTP routes when the human acts.
 */
/** Every root a skill can come from, in the order they shadow each other. */
const SCOPES = ["all", "global", "agents", "codex", "omp", "project"] as const;

export function Skills({ skills }: { skills: SkillInfo[] }) {
  const [scope, setScope] = useState<"all" | SkillInfo["source"]>("all");
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const narrow = useIsNarrow();
  const selected = skills.find((s) => s.path === selectedPath) ?? null;

  // A selection whose skill vanished (demoted elsewhere, or on the next cold
  // refresh after a demote here) must not strand the detail pane on a ghost.
  useEffect(() => {
    if (selectedPath && !selected) setSelectedPath(null);
  }, [selectedPath, selected]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return skills.filter((s) => {
      if (scope !== "all" && s.source !== scope) return false;
      if (!q) return true;
      return [s.name, s.description, s.repo ?? ""].filter(Boolean).some((x) => x.toLowerCase().includes(q));
    });
  }, [skills, scope, filter]);

  const showList = !narrow || !selected;
  const showDetail = !narrow || selected != null;

  return (
    <div className="sk-wrap" data-panes={narrow ? "one" : "two"}>
      {showList && (
        <div className="sk-list">
          <div className="sk-list-head">
            <span className="sk-list-count">
              {skills.length} skill{skills.length === 1 ? "" : "s"}
            </span>
            <span className="sk-search">
              <Icon.search size={13} />
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="filter…"
                data-search
                aria-label="Filter skills"
              />
            </span>
          </div>

          <div className="sk-chips" role="group" aria-label="Filter by scope">
            {SCOPES.filter((s) => s === "all" || skills.some((k) => k.source === s)).map((s) => (
              <button
                key={s}
                className={`chip ${scope === s ? "on" : ""}`}
                onClick={() => setScope(s)}
                aria-pressed={scope === s}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="sk-list-scroll">
            {rows.length === 0 ? (
              <Empty title="No skills match.">
                Try a different filter, or the scope chips above.
              </Empty>
            ) : (
              <ul className="sk-rows">
                {rows.map((s) => (
                  <li key={`${s.source}:${s.path}`}>
                    <button
                      className="sk-row"
                      aria-current={selected?.path === s.path}
                      onClick={() => {
                        setSelectedPath(s.path);
                        setNote(null);
                      }}
                    >
                      <span className="sk-row-top">
                        <span className="sk-row-name">
                          /{s.name}
                          {!s.modelInvocable ? (
                            <span className="ghost" title="slash-command only — never fires on its own">
                              {" "}
                              ⌘
                            </span>
                          ) : null}
                        </span>
                        <span className={`src ${s.source}`} title={s.repo ? `${s.source} · ${s.repo}` : s.source}>
                          {s.repo ? `${s.repo}` : s.source}
                        </span>
                      </span>
                      <span className="sk-row-desc">
                        {s.description || <span className="ghost">no description</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {showDetail && selected ? (
        <SkillDetail
          key={selected.path}
          skill={selected}
          onBack={narrow ? () => setSelectedPath(null) : undefined}
          onNote={setNote}
          note={note}
        />
      ) : showDetail && (
        <div className="sk-detail">
          <Empty title="Select a skill to read it.">
            The list holds every SKILL.md an agent can reach. Pick one to read
            its body, edit it, promote a repo-local skill to your global set, or
            remove a global one.
          </Empty>
        </div>
      )}
    </div>
  );
}

function SkillDetail({
  skill,
  onBack,
  onNote,
  note,
}: {
  skill: SkillInfo;
  onBack?: () => void;
  onNote: (n: string | null) => void;
  note: string | null;
}) {
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmDemote, setConfirmDemote] = useState(false);

  // Read on selection; a skill switch must not keep the previous body.
  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setEditing(false);
    api
      .skillBody(skill.path)
      .then((r) => !cancelled && setBody(r.body))
      .catch((e: Error) => {
        if (cancelled) return;
        onNote(`Could not read this skill: ${e.message}`);
        setBody("");
      });
    return () => {
      cancelled = true;
    };
  }, [skill.path, onNote]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveSkillBody(skill.path, draft);
      if (!r.ok) throw new Error("save failed");
      setBody(draft);
      setEditing(false);
      onNote(`Saved /${skill.name}.`);
    } catch (e) {
      onNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const promote = async () => {
    setBusy(true);
    try {
      const r = await api.promoteSkill(skill.name);
      onNote(r.ok ? `Copied ${skill.name} to your global skills. The repo copy is untouched.` : r.error ?? "promote failed");
    } catch (e) {
      onNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const demote = async () => {
    setBusy(true);
    try {
      const r = await api.demoteSkill(skill.name);
      onNote(r.ok ? `Removed global /${skill.name}.` : r.error ?? "remove failed");
      if (r.ok) onBack?.();
    } catch (e) {
      onNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sk-detail">
      <div className="sk-header">
        <div className="sk-header-top">
          {onBack && (
            <Button variant="ghost" icon={Icon.chevronLeft} aria-label="Back to list" onClick={onBack} />
          )}
          <h2>/{skill.name}</h2>
          <div className="sk-header-actions">
            <Button variant="ghost" size="sm" icon={Icon.x} aria-label="Close" onClick={onBack} />
          </div>
        </div>

        <dl className="sk-facts">
          <div>
            <dt>scope</dt>
            <dd>
              {skill.source}
              {skill.repo ? ` · ${skill.repo}` : ""}
            </dd>
          </div>
          <div>
            <dt>size</dt>
            <dd>{skill.lines} lines</dd>
          </div>
          {skill.allowedTools ? (
            <div>
              <dt>tools</dt>
              <dd className="truncate" title={skill.allowedTools}>
                {skill.allowedTools}
              </dd>
            </div>
          ) : null}
          {!skill.modelInvocable ? (
            <div>
              <dt>invocation</dt>
              <dd>slash-command only</dd>
            </div>
          ) : null}
          <div className="sk-path">
            <dt>path</dt>
            <dd className="mono truncate" title={skill.path}>
              {skill.path}
            </dd>
          </div>
        </dl>

        {note ? (
          <p className="sk-note" onClick={() => onNote(null)} role="status">
            {note}
          </p>
        ) : null}
      </div>

      <div className="sk-body">
        {body === null ? (
          <Empty title="Reading…" />
        ) : editing ? (
          <textarea
            className="sk-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label={`Editing ${skill.name}`}
          />
        ) : (
          <pre>{body}</pre>
        )}
      </div>

      <div className="sk-foot">
        {editing ? (
          <>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              save
            </Button>
            <Button onClick={() => setEditing(false)}>cancel</Button>
            <span className="faint">edits the file on disk directly</span>
          </>
        ) : (
          <>
            <Button
              icon={Icon.edit}
              onClick={() => {
                setDraft(body ?? "");
                setEditing(true);
              }}
            >
              edit
            </Button>
            {skill.source === "project" ? (
              <Button
                icon={Icon.move}
                loading={busy}
                onClick={() => void promote()}
                title="copy to ~/.claude/skills — the repo copy stays put"
              >
                promote
              </Button>
            ) : null}
            {skill.source === "global" ? (
              <Button
                variant="danger"
                icon={Icon.trash}
                loading={busy}
                onClick={() => setConfirmDemote(true)}
              >
                remove from global
              </Button>
            ) : null}
          </>
        )}
      </div>

      {confirmDemote && (
        <Confirm
          title={`Remove the global skill “${skill.name}”?`}
          confirmLabel="Remove"
          danger
          body={
            <p>
              Deletes <span className="mono">~/.claude/skills/{skill.name}</span>.
              Any repo copy is untouched and the skill can be promoted again.
            </p>
          }
          onConfirm={() => {
            setConfirmDemote(false);
            void demote();
          }}
          onCancel={() => setConfirmDemote(false)}
        />
      )}
    </div>
  );
}
