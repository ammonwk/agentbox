import { useState } from "react";
import type { CreationDraft, CreationSpec } from "../../../src/cloud/agent-creation";
import { Button } from "../components";
import { hrefOf } from "../route";
export function AgentCreationCard({ draft, edit, reload, scope }: { draft: CreationDraft; scope: string; edit: (draft: CreationDraft, spec: CreationSpec, create: boolean) => Promise<CreationDraft>; reload: () => Promise<unknown> }) {
  const [spec, setSpec] = useState(draft.spec), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // Automatic is a local agent policy; a shared agent runs on its host's configured provider.
  const local = draft.creator.startsWith("local-");
  async function submit(create: boolean) {
    setBusy(true); setError("");
    try {
      let current = draft;
      if (JSON.stringify(spec) !== JSON.stringify(draft.spec)) current = await edit(draft, spec, false);
      if (create) await edit(current, spec, true);
      await reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (draft.created) return <article className="agent-proposal card"><h3>{draft.spec.name} created</h3><p>Ready for manual chat. No background work was started.</p><a href={hrefOf({ page: "agents", id: draft.created, view: "chat", thread: "new" })}>Open {draft.spec.name} →</a></article>;
  return <form className="agent-proposal agent-creation card" onSubmit={(e) => { e.preventDefault(); void submit(true); }}>
    <h3>Create an agent</h3><p className="hint">{scope} · You remain accountable · Manual activation</p>
    <label>Name<input className="input" value={spec.name} required maxLength={80} onChange={(e) => setSpec({ ...spec, name: e.target.value })} /></label>
    <label>Purpose<input className="input" value={spec.role} required maxLength={120} onChange={(e) => setSpec({ ...spec, role: e.target.value })} /></label>
    <label>Instructions<textarea className="input" value={spec.instructions} required maxLength={20000} rows={4} onChange={(e) => setSpec({ ...spec, instructions: e.target.value })} /></label>
    <label>Provider<select className="input" value={spec.provider} onChange={(e) => setSpec({ ...spec, provider: e.target.value as CreationSpec["provider"] })}>{local && <option value="auto">Automatic</option>}<option value="codex">Codex</option><option value="claude">Claude</option><option value="muse">Muse</option></select></label>
    {local && spec.provider === "auto" && <p className="hint">Each fresh conversation starts on whichever logged-in provider has room; memory carries across.</p>}
    <label>Limits<textarea className="input" value={spec.limits} maxLength={2000} rows={2} onChange={(e) => setSpec({ ...spec, limits: e.target.value })} /></label>
    <label>Requested automation<input className="input" value={spec.automation} maxLength={1000} placeholder="None — manual chat" onChange={(e) => setSpec({ ...spec, automation: e.target.value })} /></label>
    {spec.automation && <p className="hint">Recorded for later setup. This will not configure a schedule, monitoring or an integration.</p>}
    <p className="hint">No publisher credentials are inherited. External actions and outreach retain their authorization and opt-in requirements. A shared execution host requires its owner’s grant.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="agents-buttons"><Button type="submit" variant="primary" disabled={busy}>Create agent</Button><Button disabled={busy} onClick={() => void submit(false)}>Save draft</Button></div>
  </form>;
}
