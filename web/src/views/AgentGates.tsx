/** Settings → On or off, and Layers: a generic agent's gates and the layers
 *  over its directory (docs/superagents.md, Overrides and gates). The page
 *  writes only the person's own gates; every other change is in the files. */

import { useState } from "react";
import type { AppState, SuperagentGateSource, SuperagentInfo, SuperagentLayer } from "../../../src/core/types";
import { api } from "../api";
import { Button, Confirm } from "../components";
import { hrefOf } from "../route";

type Gate = boolean | null;

/** Who decided, as a sentence ends. */
export const DECIDED_BY: Record<SuperagentGateSource, string> = {
  local: "your setting in this project",
  project: "the project's shared file",
  user: "your setting for every project",
  manifest: "its manifest (off when it says nothing)",
};

const LAYER_TITLE: Record<SuperagentLayer["kind"], string> = {
  user: "Yours, every project",
  project: "The project's, shared by git",
  local: "Yours, in this project",
};

function GateSelect({ id, label, value, busy, onChange }: { id: string; label: string; value: Gate; busy: boolean; onChange: (v: Gate) => void }) {
  return (
    <label className="agent-gate" htmlFor={id}>
      <span>{label}</span>
      <select id={id} className="input" value={value === null ? "" : value ? "on" : "off"} disabled={busy} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "on")}>
        <option value="on">On</option>
        <option value="off">Off</option>
        <option value="">Not set</option>
      </select>
    </label>
  );
}

export function AgentGates({ info, state, reload }: { info: SuperagentInfo; state: AppState; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [add, setAdd] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (layer: "user" | "local", enabled: Gate, project?: string) => void run(() => api.superagentGate(info.name, { layer, enabled, ...(project ? { project } : {}) }));
  const layer = (k: SuperagentLayer["kind"]) => info.layers.find((l) => l.kind === k);
  const projectName = (id: string | null) => (id ? (state.repos.find((r) => r.id === id)?.displayName ?? id) : "");
  const on = new Set(info.instances.filter((i) => i.enabled).map((i) => i.project));
  const addable = state.repos.filter((r) => !on.has(r.id));
  return (
    <section className="agent-settings-section" aria-labelledby="agent-gates">
      <h3 id="agent-gates">On or off</h3>
      <p className="hint">
        {info.base ? (
          <>
            This is {info.base}'s instance in <b>{projectName(info.project)}</b>. It is <b>{info.enabled ? "on" : "off"}</b>, by {DECIDED_BY[info.gate.by]}. The project's gate wins when one is set (yours
            first), then yours for every project, then the manifest.
          </>
        ) : (
          <>
            For you, with no project, it is <b>{info.enabled ? "on" : "off"}</b>, by {DECIDED_BY[info.gate.by]}. In a project, it runs as an instance of its own when a gate there turns it
            on, or when a file there names it and your setting for every project is on.
          </>
        )}
      </p>
      {info.gate.error && (
        <p className="error" role="alert">
          It is off because a layer cannot be read: {info.gate.error}
        </p>
      )}
      <div className="agent-gates">
        {info.base && <GateSelect id="gate-local" label={`You, in ${projectName(info.project)}`} value={layer("local")?.enabled ?? null} busy={busy} onChange={(v) => set("local", v)} />}
        {info.base && (
          <span className="agent-gate">
            <span>The project's shared file</span>
            <span className="mono">{layer("project")?.enabled === undefined || layer("project")?.enabled === null ? "Not set" : layer("project")!.enabled ? "On" : "Off"}</span>
          </span>
        )}
        <GateSelect id="gate-user" label={info.base ? `You, in every project (all of ${info.base})` : "You, in every project"} value={layer("user")?.enabled ?? null} busy={busy} onChange={(v) => set("user", v)} />
      </div>
      {!info.base && (
        <>
          <h4 className="agent-gates-head">In projects</h4>
          {info.instances.length ? (
            <ul className="agent-memory-list">
              {info.instances.map((i) => (
                <li key={i.project}>
                  <span>
                    <b>{projectName(i.project)}</b> {i.enabled ? "On" : "Off"}, by {DECIDED_BY[i.by]}
                    {i.name ? (
                      <>
                        {" · "}
                        <a href={hrefOf({ page: "agents", id: i.name })}>{i.name}</a>
                      </>
                    ) : null}
                  </span>
                  <Button variant="ghost" loading={busy} onClick={() => set("local", !i.enabled, i.project)}>
                    {i.enabled ? "Turn off" : "Turn on"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">No project has turned it on, and no project's files name it.</p>
          )}
          {addable.length > 0 && (
            <div className="agent-memory-add">
              <select className="input" aria-label="Project" value={add} onChange={(e) => setAdd(e.target.value)} disabled={busy}>
                <option value="">Choose a project…</option>
                {addable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                  </option>
                ))}
              </select>
              <Button disabled={!add} loading={busy} onClick={() => (set("local", true, add), setAdd(""))}>
                Turn on in this project
              </Button>
            </div>
          )}
          <p className="hint">Your setting in a project is kept in its checkout, in .agentbox/superagents/{info.name}.local.json, which git ignores on this machine.</p>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** The layers over its directory: what each sets, and what a project's asks that needs you. */
export function AgentLayers({ info, reload }: { info: SuperagentInfo; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<SuperagentLayer | null>(null);
  const approve = async (l: SuperagentLayer, digest: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.superagentApprove(info.name, l.kind as "project" | "local", digest);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="agent-settings-section" aria-labelledby="agent-layers">
      <h3 id="agent-layers">Layers</h3>
      <p className="hint">
        Its directory is the base. Each layer is a JSON merge patch over its superagent.json, the most specific last, with <code>enabled</code>, <code>instructions</code> (said after
        MAIN.md) and <code>soul</code> of its own.
      </p>
      <ul className="agent-memory-list agent-loops">
        <li>
          <span>
            <b>Base</b> <span className="mono">{info.dir.replace(/\/$/, "")}/superagent.json</span>
          </span>
        </li>
        {info.layers.map((l) => (
          <li key={l.kind}>
            <span>
              <b>{LAYER_TITLE[l.kind]}</b> <span className="mono">{l.path}</span>
              <br />
              <span className="hint">
                {!l.exists
                  ? "No file."
                  : [
                      l.enabled === null ? null : `enabled: ${l.enabled}`,
                      l.fields.length ? `sets ${l.fields.join(", ")}` : null,
                      l.instructions ? "adds instructions" : null,
                      l.soul ? "gives a SOUL.md" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Empty."}
              </span>
              {l.error && (
                <span className="error" role="alert">
                  <br />
                  {l.error}
                </span>
              )}
              {l.restricted && (
                <span className={l.restricted.approved ? "hint" : "error"}>
                  <br />
                  {l.restricted.approved
                    ? `You approved its ${l.restricted.fields.join(", ")}.`
                    : `It asks to change ${l.restricted.fields.join(", ")}. A project's file cannot change what runs, where, or on which credentials without you, so these are left out.`}
                </span>
              )}
            </span>
            {l.restricted &&
              (l.restricted.approved ? (
                <Button variant="ghost" loading={busy} onClick={() => void approve(l, null)}>
                  Take back
                </Button>
              ) : (
                <Button loading={busy} onClick={() => setAsking(l)}>
                  Review
                </Button>
              ))}
          </li>
        ))}
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {asking?.restricted && (
        <Confirm
          title={`Let ${asking.kind === "local" ? "your file in this project" : "the project's file"} change ${asking.restricted.fields.join(", ")}?`}
          confirmLabel="Approve"
          danger
          body={
            <>
              <p>
                Anyone who can push to this project's repository can write this file. Approve only what you read here, from <span className="mono">{asking.path}</span>. A later change to
                these fields needs your approval again.
              </p>
              <pre className="ag-log" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {JSON.stringify(asking.restricted.values, null, 2)}
              </pre>
            </>
          }
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const l = asking;
            setAsking(null);
            void approve(l, l.restricted!.digest);
          }}
        />
      )}
    </section>
  );
}
