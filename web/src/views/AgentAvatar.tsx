import { useState } from "react";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { Heartbeat } from "@phosphor-icons/react/dist/csr/Heartbeat";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";

/** Each agent's own icon, from what it does: Jupiter creates, Caelus
 *  releases, Salus watches health, Vulcan fixes; anything else thinks.
 *  The Agents rail draws the same mapping. */
export function agentIcon(role: string, creator?: boolean) {
  if (creator) return Sparkle;
  if (/deploy|release|ci\/cd/i.test(role)) return Cloud;
  if (/health|performance|monitor|observab/i.test(role)) return Heartbeat;
  if (/fix|triage|bug|repair/i.test(role)) return Wrench;
  return Brain;
}

/** An agent's picture, or its own icon when it has none or the picture
 *  fails to load. Decorative: the agent's name is always said beside it. */
export function AgentAvatar({ role, creator, src, size = 34, className }: { role: string; creator?: boolean; src?: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const Glyph = agentIcon(role, creator);
  const style = { width: size, height: size };
  return src && failed !== src ? (
    <img className={`agent-avatar${className ? ` ${className}` : ""}`} style={style} src={src} alt="" onError={() => setFailed(src)} />
  ) : (
    <span className={`agent-avatar agent-avatar-icon${className ? ` ${className}` : ""}`} style={style} aria-hidden="true">
      <Glyph size={Math.round(size * 0.55)} weight="duotone" aria-hidden="true" focusable="false" />
    </span>
  );
}

export const localAvatarUrl = (agent: { id: string; avatar?: { at: number } }) =>
  agent.avatar ? `/api/agents/local/${encodeURIComponent(agent.id)}/avatar?v=${agent.avatar.at}` : null;

/** About → Picture for a local agent: preview, replace and remove. The
 *  picture belongs to the agent, so every conversation it has shows it. */
export function AgentPictureEditor({ agent, onChange }: { agent: { id: string; name: string; role: string; capability?: string; avatar?: { at: number } }; onChange: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const url = `/api/agents/local/${encodeURIComponent(agent.id)}/avatar`;
  const change = async (init: RequestInit) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { ...init, headers: { "x-agentbox": "1", ...(init.headers as Record<string, string>) } });
      const env = (await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }))) as { ok?: boolean; error?: string };
      if (!env.ok) throw new Error(env.error || `failed: ${res.status}`);
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="agent-picture" aria-labelledby={`picture-${agent.id}`}>
      <h3 id={`picture-${agent.id}`}>Picture</h3>
      <div className="agent-picture-row">
        <AgentAvatar role={agent.role} creator={agent.capability === "creator"} src={localAvatarUrl(agent)} size={72} />
        <div className="agent-picture-actions">
          <label className="btn btn-default btn-md">
            {agent.avatar ? "Replace picture" : "Upload picture"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              disabled={busy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (!file) return;
                if (file.size > 2 * 1024 * 1024) return setError("Choose an image of at most 2 MB");
                void change({ method: "PUT", headers: { "content-type": file.type }, body: file });
              }}
            />
          </label>
          {agent.avatar && (
            <button type="button" className="btn btn-default btn-md" disabled={busy} onClick={() => void change({ method: "DELETE" })}>
              Remove
            </button>
          )}
        </div>
      </div>
      <p className="hint">PNG, JPEG, GIF or WebP, up to 2 MB. Shown beside {agent.name}'s replies; without one, its own icon is used.</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
