/** Settings: what a superagent is, and how it runs. Its directory is the
 *  source of truth: the page changes only what agentbox keeps for it (on or
 *  off, its picture, preferences, a loop set by API). */

import { useEffect, useState } from "react";
import type { AppState, SuperagentInfo } from "../../../src/core/types";
import { api } from "../api";
import { PROVIDER_LABEL } from "../bits";
import { Button, Icon, RelativeTime, Toggle } from "../components";
import { hrefOf } from "../route";
import { AgentPictureEditor } from "./AgentAvatar";
import { AgentMemory } from "./AgentMemory";
import { Markdown } from "./session/Markdown";

export function AgentSettings({ info, state, reload }: { info: SuperagentInfo; state: AppState; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const main = info.main ? state.sessions.find((s) => s.id === info.main) : null;
  const where = info.projects === null ? "Every project" : info.projects.map((id) => state.repos.find((r) => r.id === id)?.displayName ?? id).join(", ") || "No project";
  return (
    <>
      <div className="agent-settings-controls">
        <span className="agent-enabled">
          <Toggle checked={info.enabled} disabled={busy} label="Enabled" onChange={(on) => void run(() => api.superagentPatch(info.name, { enabled: on }))} />
        </span>
        <span className="hint">
          {info.process
            ? info.enabled
              ? "Agentbox keeps its program running."
              : "Its program is stopped. Its sessions keep running."
            : info.enabled
              ? "It takes messages, and its loops and sweep run."
              : "It takes no messages, and its loops and sweep do not run. Its sessions keep running."}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {info.error && (
        <p className="error" role="alert">
          Its manifest cannot be read: {info.error}
        </p>
      )}

      <section className="agent-settings-section" aria-labelledby="agent-what">
        <h3 id="agent-what">{info.title}</h3>
        {info.description && (
          <div className="ag-md">
            <Markdown text={info.description} />
          </div>
        )}
        <dl className="ag-fields">
          <div>
            <dt>Name</dt>
            <dd className="mono">{info.name}</dd>
          </div>
          <div>
            <dt>Directory</dt>
            <dd className="mono">{info.dir}</dd>
          </div>
          <div>
            <dt>Manifest</dt>
            <dd className="mono">{info.dir.replace(/\/$/, "")}/superagent.json</dd>
          </div>
          <div>
            <dt>Shows in</dt>
            <dd>{where}</dd>
          </div>
          <div>
            <dt>Main conversation</dt>
            <dd>
              {info.main ? (
                <a href={hrefOf({ page: "session", id: info.main, tab: "timeline" })}>{info.main}</a>
              ) : info.canStart ? (
                "Your first message starts it"
              ) : (
                "None yet"
              )}
              {info.previous.length ? ` · ${info.previous.length} earlier` : ""}
            </dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>
              {info.selection
                ? `${PROVIDER_LABEL[info.selection.provider]}: ${info.selection.why}`
                : main
                  ? `${PROVIDER_LABEL[main.provider]}, as its manifest's main.start says`
                  : "No conversation yet: its manifest's main.start says where the first one runs"}
            </dd>
          </div>
        </dl>
        <p className="hint">
          To change it, change its directory (ask your coding agent), then run <code>agentbox superagent add {info.dir}</code> to read the manifest again.{" "}
          <code>agentbox superagent rm {info.name}</code> forgets it and keeps the directory.
        </p>
      </section>

      <Program info={info} busy={busy} restart={() => void run(() => api.superagentRestart(info.name))} />
      <Loops info={info} reload={reload} />

      <section className="agent-settings-section" aria-labelledby="agent-sweep">
        <h3 id="agent-sweep">Daily close</h3>
        <p className="hint">
          {info.sweep
            ? `Every day at ${info.sweep} it closes the work sessions it started that were idle for two hours. Its Feed shows each close.`
            : 'Off. "sweep": "23:00" in its manifest closes its idle work sessions each day at that time.'}
        </p>
      </section>

      <AgentPictureEditor agent={info} onChange={reload} />

      {info.memory ? (
        <AgentMemory info={info} />
      ) : (
        <section className="agent-memory" aria-labelledby="agent-memory-off">
          <h3 id="agent-memory-off">Memory</h3>
          <p className="hint">
            Off. Add <code>"memory": true</code> to its manifest for a memory journal and a read-only MEMORY.md. A fresh main conversation then starts from its
            last handoff and its preferences.
          </p>
        </section>
      )}
    </>
  );
}

/** Its program: the state agentbox keeps it in, Restart, and the end of its output. */
function Program({ info, busy, restart }: { info: SuperagentInfo; busy: boolean; restart: () => void }) {
  const [log, setLog] = useState<string | null>(null);
  const p = info.process;
  useEffect(() => {
    if (!p) return;
    let live = true;
    const load = () => api.superagentLog(info.name).then((l) => live && setLog(l.text), () => undefined);
    void load();
    const t = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [info.name, !!p]);
  return (
    <section className="agent-settings-section" aria-labelledby="agent-program">
      <h3 id="agent-program">Program</h3>
      <p className="hint">
        {p ? (
          <>
            {p.state === "running" ? "Running" : p.state === "backoff" ? "Restarting after it exited" : p.state === "starting" ? "Starting" : "Stopped"}
            {p.pid ? `, pid ${p.pid}` : ""}
            {p.restarts ? `, ${p.restarts} restart${p.restarts === 1 ? "" : "s"}` : ""}
            {p.lastExit ? `; last exit ${p.lastExit.code ?? "by a signal"}` : ""}
            {p.since ? (
              <>
                {" "}
                · since <RelativeTime ts={p.since} />
              </>
            ) : null}
          </>
        ) : info.hasPage ? (
          "Its program runs elsewhere (url): agentbox asks it for its page and does not run it."
        ) : (
          "None: it is a conversation with standing instructions."
        )}
      </p>
      {p && (
        <>
          <div className="ag-actions">
            <Button size="sm" icon={Icon.refresh} loading={busy} disabled={!info.enabled} onClick={restart}>
              Restart its program
            </Button>
          </div>
          <pre className="ag-log">{log === null ? "…" : log.slice(-20_000) || "(no output yet)"}</pre>
        </>
      )}
    </section>
  );
}

/** Its loops: prompts said to its main conversation on a schedule. A loop
 *  its manifest names changes with the manifest; one set by API can be removed here. */
function Loops({ info, reload }: { info: SuperagentInfo; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await api.superagentRemoveLoop(info.name, id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="agent-settings-section" aria-labelledby="agent-loops">
      <h3 id="agent-loops">Loops</h3>
      {info.loops.length ? (
        <ul className="agent-memory-list agent-loops">
          {info.loops.map((l) => (
            <li key={l.id}>
              <span>
                <b>{l.id}</b> {l.when}
                {l.check ? (
                  <>
                    {" "}
                    · only when <code>{l.check}</code> says so
                  </>
                ) : null}
                <br />
                <span className="hint">
                  {l.prompt.split("\n")[0]}
                  {l.nextAt ? (
                    <>
                      {" "}
                      · next <RelativeTime ts={l.nextAt} />
                    </>
                  ) : null}
                  {l.due ? " · due when the current turn ends" : ""}
                  {l.last ? ` · last ${l.last.result}${l.last.detail ? `: ${l.last.detail}` : ""}` : ""}
                  {l.source === "manifest" ? " · from its manifest" : " · set by API"}
                </span>
              </span>
              {l.source === "set" && (
                <Button variant="ghost" loading={busy === l.id} onClick={() => void remove(l.id)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">None. Its manifest's main.loops, or PUT /api/superagents/{info.name}/loops/:id, adds one.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
