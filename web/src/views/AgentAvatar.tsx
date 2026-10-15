import { useState } from "react";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import { Cloud } from "@phosphor-icons/react/dist/csr/Cloud";
import { Heartbeat } from "@phosphor-icons/react/dist/csr/Heartbeat";
import { Sparkle } from "@phosphor-icons/react/dist/csr/Sparkle";
import { Brain } from "@phosphor-icons/react/dist/csr/Brain";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import type { AgentIcon } from "../../../src/core/types";

/** A superagent's own icon: the one its manifest names (`icon`), else one
 *  from what its description says it does; anything else thinks. */
export function agentIcon(role: string, icon?: AgentIcon | null) {
  if (icon) return ICONS[icon];
  if (/deploy|release|ci\/cd/i.test(role)) return Cloud;
  if (/health|performance|monitor|observab/i.test(role)) return Heartbeat;
  if (/fix|triage|bug|repair/i.test(role)) return Wrench;
  return Brain;
}
const ICONS: Record<AgentIcon, typeof Brain> = { brain: Brain, sparkle: Sparkle, fix: Wrench, release: Cloud, health: Heartbeat };

/** An agent's picture, or its own icon when it has none or the picture
 *  fails to load. Decorative: the agent's name is always said beside it. */
export function AgentAvatar({ role, icon, src, size = 34, className }: { role: string; icon?: AgentIcon | null; src?: string | null; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const Glyph = agentIcon(role, icon);
  const style = { width: size, height: size };
  return src && failed !== src ? (
    <img className={`agent-avatar${className ? ` ${className}` : ""}`} style={style} src={src} alt="" onError={() => setFailed(src)} />
  ) : (
    <span className={`agent-avatar agent-avatar-icon${className ? ` ${className}` : ""}`} style={style} aria-hidden="true">
      <Glyph size={Math.round(size * 0.55)} weight="duotone" aria-hidden="true" focusable="false" />
    </span>
  );
}

/** How a name reads beside its picture: VULCAN and vulcan both as Vulcan. */
export const agentName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

/** An agent that is not a registered one, or not proven to be: never anyone's picture. */
export function NeutralAgent({ size = 12 }: { size?: number }) {
  return <Robot size={size} aria-hidden="true" focusable="false" />;
}

export const avatarUrl = (a: { name: string; avatar: { at: number } | null }) =>
  a.avatar ? `/api/superagents/${encodeURIComponent(a.name)}/avatar?v=${a.avatar.at}` : null;

/** Settings → Picture: preview, replace and remove. The picture belongs to
 *  the superagent, so every conversation it has shows it. */
export function AgentPictureEditor({ agent, onChange }: { agent: { name: string; title: string; description: string; icon: AgentIcon | null; avatar: { at: number } | null }; onChange: () => Promise<unknown> | void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const url = `/api/superagents/${encodeURIComponent(agent.name)}/avatar`;
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
    <section className="agent-picture" aria-labelledby={`picture-${agent.name}`}>
      <h3 id={`picture-${agent.name}`}>Picture</h3>
      <div className="agent-picture-row">
        <AgentAvatar role={agent.description} icon={agent.icon} src={avatarUrl(agent)} size={72} />
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
      <p className="hint">PNG, JPEG, GIF or WebP, up to 2 MB. Shown beside {agent.title}'s replies; without one, its own icon is used.</p>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
