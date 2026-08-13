import { useState } from "react";
import type { AppState, AgentSettings } from "../api";
import { api } from "../api";
import { Icon } from "../components";

export function Settings({
  state, onSettingsChange,
}: { state: AppState; onSettingsChange: (s: AgentSettings) => void }) {
  const [newRepo, setNewRepo] = useState("");
  const [repoErr, setRepoErr] = useState<string | null>(null);
  const [repoBusy, setRepoBusy] = useState(false);
  const settings = state.settings;

  async function addRepo() {
    if (!newRepo.trim() || repoBusy) return;
    setRepoBusy(true);
    setRepoErr(null);
    try {
      await api.addRepo(newRepo.trim());
      setNewRepo("");
    } catch (e) {
      setRepoErr((e as Error).message);
    } finally {
      setRepoBusy(false);
    }
  }

  function save(patch: Partial<AgentSettings>) {
    void api.saveSettings(patch).then(onSettingsChange).catch(() => {});
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <div className="card settings-block">
        <h3>Appearance</h3>
        <p className="hint">agentbox follows your system theme by default.</p>
        <div className="setting-row">
          <div className="lbl">Theme</div>
          <div style={{ display: "flex", gap: 6 }}>
            {(["light", "dark", "system"] as const).map((t) => (
              <button
                key={t}
                className={`btn ${settings.theme === t ? "btn-primary" : ""}`}
                onClick={() => save({ theme: t })}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card settings-block">
        <h3>Agent runs</h3>
        <p className="hint">Defaults for new sessions.</p>
        <div className="setting-row">
          <div className="lbl">
            Model
            <small>The omp model selector (e.g. opencode-go/deepseek-v4-flash)</small>
          </div>
          <input
            className="input"
            style={{ maxWidth: 280 }}
            value={settings.model}
            onChange={(e) => save({ model: e.target.value })}
          />
        </div>
        <div className="setting-row">
          <div className="lbl">
            Auto-approve tool calls
            <small>Let omp run without asking for permission</small>
          </div>
          <button
            className={`toggle ${settings.autoApprove ? "on" : ""}`}
            onClick={() => save({ autoApprove: !settings.autoApprove })}
            aria-label="toggle auto-approve"
          />
        </div>
        <div className="setting-row">
          <div className="lbl">
            Max run time
            <small>A session is stopped after this many minutes</small>
          </div>
          <input
            className="input"
            type="number"
            style={{ maxWidth: 90 }}
            min={1}
            value={settings.maxMinutes}
            onChange={(e) => save({ maxMinutes: Math.max(1, Number(e.target.value) || 60) })}
          />
        </div>
      </div>

      <div className="card settings-block">
        <h3>Repositories</h3>
        <p className="hint">Where sessions spawn from. Add a local git path or an owner/repo slug.</p>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            className="input"
            placeholder="/path/to/repo or owner/repo"
            value={newRepo}
            onChange={(e) => setNewRepo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addRepo()}
          />
          <button className="btn btn-primary" onClick={addRepo} disabled={repoBusy}>
            <Icon.plus size={13} /> Add
          </button>
        </div>
        {repoErr && <p style={{ color: "var(--danger)", fontSize: 12.5, marginBottom: 8 }}>{repoErr}</p>}
        {state.repos.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>No repositories registered yet.</p>
        )}
        {state.repos.map((r) => (
          <div className="repo-row" key={r.id}>
            <span className={`src ${r.kind === "github" ? "agents" : "project"}`} style={{ fontSize: 10, fontWeight: 650, textTransform: "uppercase", padding: "2px 7px", borderRadius: 999 }}>
              {r.kind}
            </span>
            <span className="name">{r.displayName}</span>
            <span style={{ color: "var(--faint)", fontFamily: "var(--mono)", fontSize: 11 }}>{r.ref}</span>
            <button
              className="btn btn-ghost"
              style={{ color: "var(--danger)" }}
              onClick={() => api.deleteRepo(r.id)}
              title="Remove repo"
            >
              <Icon.trash size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
