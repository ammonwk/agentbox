import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AgentSettings, Repo, Session, SkillInfo } from "../../../../src/core/types";
import { api } from "../../api";
import { Button, Field, Icon, Modal, ModelPicker } from "../../components";
import { useAction } from "./useAction";

/** The `/token` under the caret, if the menu should be open for it. */
function slashToken(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|[\s(])\/([^\s]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
}

export function NewSession({
  repos,
  settings,
  skills,
  onClose,
  onCreated,
}: {
  repos: Repo[];
  settings: AgentSettings;
  skills: SkillInfo[];
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(settings.model);
  const [branch, setBranch] = useState("");
  const { run, busy, error } = useAction();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  /** Chosen index in the open menu; -1 means nothing highlighted yet. */
  const [picked, setPicked] = useState(-1);
  /** Set by Escape and held until the query changes again, so Esc really closes. */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const token = slashToken(prompt, caret);
  const matches =
    token === null
      ? []
      : skills.filter((s) => s.name.toLowerCase().startsWith(token.query.toLowerCase()));
  const menuOpen = token !== null && matches.length > 0 && dismissedAt !== caret;

  function syncCaret() {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart);
  }

  function accept(skill: SkillInfo) {
    if (token === null) return;
    const next = `${prompt.slice(0, token.start)}/${skill.name} ${prompt.slice(caret)}`;
    setPrompt(next);
    setDismissedAt(null);
    setPicked(-1);
    // React writes the value asynchronously; wait for the DOM to hold it.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const at = token.start + skill.name.length + 2;
      el.setSelectionRange(at, at);
      el.focus();
      setCaret(at);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (repoId && prompt.trim() && !busy) void submit();
      return;
    }
    if (!menuOpen) return;
    if (e.key === "ArrowDown") {
      // Nothing highlighted yet: ↓ takes the first row.
      e.preventDefault();
      setPicked(picked < 0 ? 0 : Math.min(picked + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      // …and ↑ takes the last one, where a keyboard user already is.
      e.preventDefault();
      setPicked(picked < 0 ? matches.length - 1 : Math.max(picked - 1, 0));
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      accept(matches[picked < 0 ? 0 : picked]);
    } else if (e.key === "Escape") {
      setDismissedAt(caret);
    }
  }

  async function submit() {
    const task = prompt.trim();
    if (!repoId || !task || busy) return;
    await run(async () => {
      const session = await api.spawnSession({
        repoId,
        prompt: task,
        model: model.trim() || undefined,
        branch: branch.trim() || undefined,
      });
      onCreated(session);
    });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await submit();
  }

  return (
    <Modal title="New session" onClose={onClose}>
      <form className="sx-form" onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <Field label="Repository">
          {repos.length === 0 ? (
            <p className="sx-scope-hint">
              No repos registered yet. Add one in Settings — a local path or an <code>owner/name</code>{" "}
              slug — and it will appear here.
            </p>
          ) : (
            <select value={repoId} onChange={(e) => setRepoId(e.target.value)} required>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.displayName}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Task">
          {/* The menu hangs below the textarea and floats over the fields
              beneath it, so the composer never reflows while it is open. */}
          <div className="sx-task-wrap">
            <textarea
              ref={textareaRef}
              autoFocus
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                syncCaret();
              }}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onSelect={syncCaret}
              placeholder={"Fix the 401 retry in src/api/client.ts: it retries on any error.\nRetry only 429 and 5xx, cap at 3 attempts, and add a test in src/api/client.test.ts.\n\nType / to insert a skill."}
              required
            />
            {menuOpen && (
              <ul className="sx-slash-menu" role="listbox" aria-label="Skills">
                {matches.map((s, i) => (
                  <li key={`${s.source}/${s.name}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === picked}
                      className={i === picked ? "picked" : ""}
                      onMouseEnter={() => setPicked(i)}
                      onClick={() => accept(s)}
                    >
                      <code>/{s.name}</code>
                      <span>{s.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Field>

        <Field label="Model" hint={`Starts on the default from Settings, ${settings.model}.`}>
          {(id) => <ModelPicker id={id} value={model} onChange={setModel} live />}
        </Field>

        <Field
          label="Existing branch (optional)"
          hint="Check this branch out instead of cutting a new one — how you point an agent at an open PR."
        >
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="leave blank for a fresh branch"
            spellCheck={false}
          />
        </Field>

        {error && <div className="sx-error">Could not spawn: {error}</div>}

        <div className="sx-form-actions">
          {/* Explicit: an untyped <button> inside a <form> submits it. */}
          <Button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            icon={Icon.play}
            loading={busy}
            disabled={busy || !repoId || prompt.trim() === ""}
          >
            Spawn
          </Button>
        </div>
      </form>
    </Modal>
  );
}
