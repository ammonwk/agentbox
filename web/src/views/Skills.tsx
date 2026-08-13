import { useState } from "react";
import type { AppState, SkillInfo } from "../api";
import { Empty, Modal } from "../components";

export function Skills({ state }: { state: AppState }) {
  const [open, setOpen] = useState<SkillInfo | null>(null);
  const skills = state.skills;

  return (
    <div>
      {skills.length === 0 && (
        <Empty title="No skills found">
          Skills are scanned from ~/.claude/skills, ~/.agents/skills and this
          project's .claude/skills.
        </Empty>
      )}
      <div className="grid">
        {skills.map((s) => (
          <div className="card card-hover skill-card" key={s.path} onClick={() => setOpen(s)} style={{ cursor: "pointer" }}>
            <div className="row">
              <span className="name">{s.name}</span>
              <span className={`src ${s.source}`}>{s.source}</span>
            </div>
            {s.description && <div className="desc">{s.description}</div>}
            <div className="path">{s.path}</div>
          </div>
        ))}
      </div>

      {open && (
        <Modal title={open.name} hint={open.description} onClose={() => setOpen(null)}>
          <pre style={{ whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 12.5, maxHeight: "55vh", overflow: "auto" }}>
            {open.body}
          </pre>
          <div className="actions">
            <button className="btn" onClick={() => setOpen(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
