import { useEffect, useState } from "react";
import { Button, Icon } from "../components";
import {
  ACTIONS,
  comboOf,
  conflicts,
  FIXED,
  isAppOnly,
  isChord,
  isDefault,
  keysOf,
  refusal,
  resetKeys,
  setKeys,
  setRecording,
  showCombo,
  useKeybindings,
  type ActionId,
} from "../lib/keybinds";
import { isInstalledApp } from "../lib/phone";

const ORDER = ["Anywhere", "Sessions", "Review", "Composer", "New session"];

/** Settings → Keybinds: every action with a key, to record another key for,
 *  take one off, or put back as it was (lib/keybinds.ts). */
export function Keybinds() {
  const overrides = useKeybindings();
  const [recording, setRecordingId] = useState<ActionId | null>(null);
  const [refused, setRefused] = useState<{ id: ActionId; why: string } | null>(null);
  const app = isInstalledApp();
  const clash = conflicts(overrides);
  const changed = Object.keys(overrides).length > 0;

  // While one records, every key is for it and no shortcut runs. Esc stops.
  useEffect(() => {
    if (!recording) return;
    setRecording(true);
    const onKey = (e: KeyboardEvent) => {
      const combo = comboOf(e);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      if (combo === "Escape") return setRecordingId(null);
      const why = refusal(combo);
      if (why) return setRefused({ id: recording, why });
      const keys = keysOf(recording);
      if (!keys.includes(combo)) setKeys(recording, [...keys, combo]);
      setRefused(null);
      setRecordingId(null);
    };
    addEventListener("keydown", onKey, true);
    return () => {
      removeEventListener("keydown", onKey, true);
      setRecording(false);
    };
  }, [recording]);

  return (
    <section className="card" id="keybinds" data-nav-item data-nav-id="settings:keybinds" tabIndex={0} aria-label="Keybinds">
      <h3>Keybinds</h3>
      <p className="hint">
        Press <strong>Add key</strong>, then the key. A key with Ctrl, {showCombo("Alt")} or {showCombo("Meta")} works from the terminal and text fields
        too; one without them works only outside them. This browser keeps your keys; other devices keep their own.
      </p>
      {app ? null : (
        <p className="warn">
          <Icon.alert size={14} />
          This is a browser tab, and a browser keeps keys such as Ctrl+W, Ctrl+T and Ctrl+Tab for itself. Those keys are marked <strong>App only</strong>: they work in
          the installed app and do nothing here. Pressing one to record it does what the browser does with it.
        </p>
      )}
      {clash.size > 0 ? (
        <p className="warn">
          <Icon.alert size={14} />
          {clash.size === 1 ? "A key does" : "Keys do"} more than one thing:{" "}
          {[...clash].map(([k, ids]) => `${showCombo(k)} (${ids.map((id) => ACTIONS.find((a) => a.id === id)!.label).join("; ")})`).join(", ")}. Where both can run, the
          first in this list wins.
        </p>
      ) : null}

      {ORDER.map((group) => {
        const actions = ACTIONS.filter((a) => a.group === group);
        const fixed = FIXED.filter((f) => f.group === group);
        return (
          <div className="kb-group" key={group}>
            <h4>{group}</h4>
            <ul className="kb-list">
              {actions.map((a) => {
                const keys = keysOf(a.id, overrides);
                const on = recording === a.id;
                return (
                  <li key={a.id} className="kb-row" data-recording={on || undefined}>
                    <span className="kb-label">{a.label}</span>
                    <span className="kb-keys">
                      {keys.length === 0 && !on ? <span className="kb-none">No key</span> : null}
                      {keys.map((k) => {
                        const others = (clash.get(k) ?? []).filter((x) => x !== a.id);
                        const title = [
                          isAppOnly(k) ? "Works only in the installed app: a browser tab keeps this key." : "",
                          isChord(k) ? "Works from the terminal and text fields too." : "Works outside the terminal and text fields.",
                          others.length ? `Also: ${others.map((x) => ACTIONS.find((y) => y.id === x)!.label).join("; ")}.` : "",
                        ].filter(Boolean).join(" ");
                        return (
                          <span className="kb-key" key={k} data-conflict={others.length > 0 || undefined} data-off={(!app && isAppOnly(k)) || undefined} title={title}>
                            <kbd>{showCombo(k)}</kbd>
                            {isAppOnly(k) ? <span className="kb-tag">App only</span> : null}
                            {others.length ? <Icon.alert size={12} aria-label={`Also ${others.length === 1 ? "bound to another action" : "bound to other actions"}`} /> : null}
                            <button type="button" className="kb-remove" aria-label={`Remove ${showCombo(k)} from ${a.label}`} onClick={() => setKeys(a.id, keys.filter((x) => x !== k))}>
                              <Icon.x size={11} />
                            </button>
                          </span>
                        );
                      })}
                      {on ? <span className="kb-listening">Press a key… (Esc stops)</span> : null}
                    </span>
                    <span className="kb-actions">
                      <Button
                        size="sm"
                        icon={on ? Icon.x : Icon.plus}
                        aria-pressed={on}
                        onClick={() => {
                          setRefused(null);
                          setRecordingId(on ? null : a.id);
                        }}
                        onBlur={() => on && setRecordingId(null)}
                      >
                        {on ? "Stop" : "Add key"}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={keys.length === 0} onClick={() => setKeys(a.id, [])}>
                        Clear
                      </Button>
                      <Button size="sm" variant="ghost" icon={Icon.undo} disabled={isDefault(a.id)} title={`Default: ${a.defaults.map(showCombo).join(", ") || "no key"}`} onClick={() => resetKeys(a.id)}>
                        Reset
                      </Button>
                    </span>
                    {refused?.id === a.id ? <p className="kb-why">{refused.why}</p> : null}
                  </li>
                );
              })}
              {fixed.map((f) => (
                <li key={f.label} className="kb-row kb-fixed">
                  <span className="kb-label">{f.label}</span>
                  <span className="kb-keys">
                    {f.keys.map((k) => (
                      <span className="kb-key" key={k}>
                        <kbd>{showCombo(k)}</kbd>
                      </span>
                    ))}
                  </span>
                  <span className="kb-actions kb-fixed-note">Fixed</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      <div className="kb-foot">
        <Button size="sm" icon={Icon.undo} disabled={!changed} onClick={() => resetKeys()}>
          Reset every key
        </Button>
      </div>
    </section>
  );
}
