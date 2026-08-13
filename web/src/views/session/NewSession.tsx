import { useState, type FormEvent } from "react";
import type { AgentSettings, Repo, Session } from "../../../../src/core/types";
import { api } from "../../api";
import { Button, Field, Icon, Modal } from "../../components";
import { useAction } from "./useAction";

export function NewSession({
  repos,
  settings,
  onClose,
  onCreated,
}: {
  repos: Repo[];
  settings: AgentSettings;
  onClose: () => void;
  onCreated: (session: Session) => void;
}) {
  const [repoId, setRepoId] = useState(repos[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(settings.model);
  const [branch, setBranch] = useState("");
  const { run, busy, error } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
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

  return (
    <Modal
      title="New session"
      hint="agentbox cuts a worktree, runs omp on it, and streams everything it does back here."
      onClose={onClose}
    >
      <form className="sx-form" onSubmit={submit}>
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

        <Field
          label="Task"
          hint="This is where the run is won or lost — the model is capable but literal."
        >
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={"Fix the 401 retry in src/api/client.ts: it retries on any error.\nRetry only 429 and 5xx, cap at 3 attempts, and add a test in src/api/client.test.ts."}
            required
          />
        </Field>

        {/* Concrete, because a vague task is the single most common cause of a
            run going sideways with this class of model. */}
        <div className="sx-scope-hint">
          A task this model does well with:
          <ul>
            <li>names the files it should touch, or how to find them;</li>
            <li>states the finished condition — a test that passes, a command that exits 0;</li>
            <li>fits in one sitting. Two changes are two sessions.</li>
          </ul>
        </div>

        <Field label="Model" hint={`Blank uses the default, ${settings.model}.`}>
          <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} />
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
