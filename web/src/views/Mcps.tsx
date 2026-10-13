import { useCallback, useEffect, useMemo, useState } from "react";
import type { McpCheck, McpFound, McpReach, McpServerInput, McpServerView, McpState, McpTransport } from "../../../src/core/types";
import { api } from "../api";
import { PROVIDER_LABEL } from "../bits";
import { Button, Confirm, Empty, Icon, Spinner, Toggle } from "../components";
import { useIsNarrow } from "./session/useIsNarrow";
import "./skills.css";
import "./mcps.css";

/**
 * The global MCP servers: one list agentbox gives every agent it starts
 * (src/core/mcp.ts), and the servers the agents' own configs already define,
 * which can be added to it. Values of environment variables and headers never
 * come back from the server; an edit keeps the saved ones it is not given.
 */

type Selection = { kind: "server"; name: string } | { kind: "found"; id: string } | { kind: "new" } | null;

const REACH_WORD: Record<McpReach["state"], string> = {
  on: "Gets it",
  own: "Has its own",
  conflict: "Keeps its own",
  off: "Off",
  unsupported: "Not passed",
  error: "Problem",
};

export function Mcps() {
  const [data, setData] = useState<McpState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection>(null);
  const [filter, setFilter] = useState("");
  const narrow = useIsNarrow();

  const load = useCallback(() => {
    api.mcp().then(setData, (e: Error) =>
      // A server from before this page answers with the app's own HTML, or no route.
      setError(/<!doctype|no route for/i.test(e.message) ? "The agentbox server that is running is older than this page. Restart it, then reload, to manage MCP servers." : e.message),
    );
  }, []);
  useEffect(load, [load]);

  const server = sel?.kind === "server" ? (data?.servers.find((s) => s.name === sel.name) ?? null) : null;
  const found = sel?.kind === "found" ? (data?.found.find((f) => f.id === sel.id) ?? null) : null;
  // A selection whose entry went away (deleted, imported) must not strand the pane.
  useEffect(() => {
    if (data && ((sel?.kind === "server" && !server) || (sel?.kind === "found" && !found))) setSel(null);
  }, [data, sel, server, found]);

  const q = filter.trim().toLowerCase();
  const match = (...xs: (string | null)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q));
  const servers = useMemo(() => (data?.servers ?? []).filter((s) => match(s.name, s.command, s.url)), [data, q]);
  const founds = useMemo(() => (data?.found ?? []).filter((f) => f.global !== "same" && match(f.name, f.command, f.url, PROVIDER_LABEL[f.provider])), [data, q]);

  const showList = !narrow || sel === null;
  const showDetail = !narrow || sel !== null;
  const back = narrow ? () => setSel(null) : undefined;
  const done = (next: McpState, select: Selection) => {
    setData(next);
    setSel(select);
  };

  // Nothing to focus until the list is read: the keyboard waits for its first row.
  if (!data) {
    return (
      <div className="sk-wrap mc-wrap">
        {error ? (
          <p className="sk-note mc-error" role="alert">
            {error}
          </p>
        ) : (
          <Empty title="Reading…" />
        )}
      </div>
    );
  }

  return (
    <div className="sk-wrap mc-wrap" data-panes={narrow ? "one" : "two"}>
      {showList && (
        <div className="sk-list" data-nav-region="list" tabIndex={-1} aria-label="MCP servers">
          <div className="sk-list-head">
            <span className="sk-list-count">
              {data.servers.length} global
            </span>
            <span className="sk-search">
              <Icon.search size={13} />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…" data-search aria-label="Filter MCP servers" />
            </span>
            <Button size="sm" icon={Icon.plus} onClick={() => setSel({ kind: "new" })} aria-current={sel?.kind === "new"}>
              Add
            </Button>
          </div>

          <div className="sk-list-scroll">
            {error ? <p className="sk-note mc-error" role="alert">{error}</p> : null}
            <>
                <h3 className="mc-group">Global</h3>
                {servers.length === 0 ? (
                  <p className="mc-hint">{data.servers.length === 0 ? "None yet. Add one, or add one your agents already have below." : "None match."}</p>
                ) : (
                  <ul className="sk-rows">
                    {servers.map((s) => (
                      <li key={s.name}>
                        <button className="sk-row" data-nav-item data-nav-id={`mcp:${s.name}`} aria-current={server?.name === s.name} onClick={() => setSel({ kind: "server", name: s.name })}>
                          <span className="sk-row-top">
                            <span className="sk-row-name">{s.name}</span>
                            {s.problem || s.reach.some((r) => r.state === "conflict" || r.state === "error") ? (
                              <span className="mc-warn" title={s.problem ?? "An agent keeps its own server of this name, or a file could not be written"}>
                                <Icon.alert size={13} />
                              </span>
                            ) : null}
                            <span className={`mc-badge ${s.enabled ? "on" : ""}`}>{s.enabled ? "On" : "Off"}</span>
                          </span>
                          <span className="sk-row-desc">{s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <h3 className="mc-group">In your agents' own settings</h3>
                {founds.length === 0 ? (
                  <p className="mc-hint">{q ? "None match." : "Nothing else found."}</p>
                ) : (
                  <ul className="sk-rows">
                    {founds.map((f) => (
                      <li key={f.id}>
                        <button className="sk-row" data-nav-item data-nav-id={`found:${f.id}`} aria-current={found?.id === f.id} onClick={() => setSel({ kind: "found", id: f.id })}>
                          <span className="sk-row-top">
                            <span className="sk-row-name">{f.name}</span>
                            <span className={`mc-badge src-${f.provider}`}>{PROVIDER_LABEL[f.provider]}</span>
                          </span>
                          <span className="sk-row-desc">
                            {f.scope === "project" ? `One project: ${f.project}` : "Every session of it"}
                            {f.unsupported ? " · cannot be made global" : f.global === "different" ? " · differs from the global one" : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </>
          </div>
        </div>
      )}

      {showDetail ? (
        <div className="sk-detail" data-nav-region="detail" tabIndex={-1} aria-label="MCP server details">
          {sel?.kind === "new" ? (
            <ServerForm key="new" saved={null} onCancel={() => setSel(null)} onSaved={(next, name) => done(next, { kind: "server", name })} onBack={back} />
          ) : server ? (
            <ServerDetail key={server.name} server={server} data={data} onChange={setData} onSelect={setSel} onBack={back} />
          ) : found ? (
            <FoundDetail key={found.id} found={found} data={data} onImported={(next, name) => done(next, { kind: "server", name })} onBack={back} />
          ) : (
            <Overview data={data} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** What the page is for, and how each agent gets the list. */
function Overview({ data }: { data: McpState }) {
  return (
    <div className="sk-body mc-overview">
      <h2>MCP servers for every agent</h2>
      <p>
        A global server is given to every session agentbox starts or resumes, on every account. Each agent keeps its own settings; when it already
        has a server of the same name, it keeps that one.
      </p>
      <p className="faint">Sessions you start outside agentbox do not get them until agentbox adopts them.</p>
      <table className="mc-agents">
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.provider}>
                <th scope="row">{PROVIDER_LABEL[a.provider]}</th>
                <td>
                  <span className={`mc-badge ${a.supported && a.installed ? "on" : ""}`}>{!a.installed ? "Not installed" : a.supported ? "Gets them" : "Not passed"}</span>
                </td>
                <td className="faint">{a.how}</td>
              </tr>
            ))}
          </tbody>
      </table>
    </div>
  );
}

function Header({ title, onBack, children }: { title: string; onBack?: () => void; children?: React.ReactNode }) {
  return (
    <div className="sk-header-top">
      {onBack ? <Button variant="ghost" icon={Icon.chevronLeft} aria-label="Back to list" data-nav-back onClick={onBack} /> : null}
      <h2>{title}</h2>
      <div className="sk-header-actions">{children}</div>
    </div>
  );
}

function ServerDetail({
  server,
  data,
  onChange,
  onSelect,
  onBack,
}: {
  server: McpServerView;
  data: McpState;
  onChange: (s: McpState) => void;
  onSelect: (s: Selection) => void;
  onBack?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [check, setCheck] = useState<McpCheck | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (editing) {
    return (
      <ServerForm
        saved={server}
        onCancel={() => setEditing(false)}
        onSaved={(next, name) => {
          onChange(next);
          setEditing(false);
          if (name !== server.name) onSelect({ kind: "server", name });
        }}
        onBack={onBack}
      />
    );
  }

  return (
    <>
      <div className="sk-header">
        <Header title={server.name} onBack={onBack}>
          <Toggle
            checked={server.enabled}
            label={server.enabled ? "On" : "Off"}
            // Not disabled while it saves: a disabled switch loses the keyboard's focus.
            onChange={(on) => busy === null && void run("toggle", async () => onChange(await api.setMcpEnabled(server.name, on)))}
          />
        </Header>
        <dl className="sk-facts">
          <div>
            <dt>{server.transport === "stdio" ? "command" : "address"}</dt>
            <dd className="mono mc-wrap-text">{server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}</dd>
          </div>
          {server.envKeys.length ? (
            <div>
              <dt>environment</dt>
              <dd className="mono">{server.envKeys.map((k) => `${k}=••••`).join("  ")}</dd>
            </div>
          ) : null}
          {server.headerKeys.length ? (
            <div>
              <dt>headers</dt>
              <dd className="mono">{server.headerKeys.map((k) => `${k}: ••••`).join("  ")}</dd>
            </div>
          ) : null}
          {server.from ? (
            <div>
              <dt>added from</dt>
              <dd className="mc-wrap-text">{server.from}</dd>
            </div>
          ) : null}
        </dl>
        {server.problem ? (
          <p className="sk-note mc-error" role="alert">
            {server.problem}
          </p>
        ) : null}
        {note ? (
          <p className="sk-note" role="status" onClick={() => setNote(null)}>
            {note}
          </p>
        ) : null}
      </div>

      <div className="sk-body mc-body">
        <h3 className="mc-sub">Agents</h3>
        <table className="mc-agents">
          <tbody>
            {server.reach.map((r) => (
              <tr key={r.provider}>
                <th scope="row">{PROVIDER_LABEL[r.provider]}</th>
                <td>
                  <span className={`mc-badge mc-${r.state}`}>{REACH_WORD[r.state]}</span>
                </td>
                <td className="faint">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {data.stale.length ? (
          <div className="mc-stale" role="status">
            <h3 className="mc-sub">Running sessions</h3>
            <p>
              {data.stale.length} running session{data.stale.length === 1 ? "" : "s"} started before the last change to this list. They get it when
              they next start or resume; agentbox does not restart them.
            </p>
            <ul>
              {data.stale.slice(0, 8).map((s) => (
                <li key={s.id}>
                  <a href={`#/s/${encodeURIComponent(s.id)}`}>{s.title}</a> <span className="faint">{PROVIDER_LABEL[s.provider]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="faint mc-saved">Every running session agentbox started already has this list.</p>
        )}

        <h3 className="mc-sub">Check</h3>
        {busy === "check" ? (
          <p className="faint">
            <Spinner size={12} /> Starting it and asking for its tools…
          </p>
        ) : check ? (
          check.ok ? (
            <p className="mc-ok" role="status">
              It answered in {(check.ms / 1000).toFixed(1)}s with {check.tools.length} tool{check.tools.length === 1 ? "" : "s"}
              {check.tools.length ? `: ${check.tools.join(", ")}` : ""}.
            </p>
          ) : (
            <p className="sk-note mc-error" role="alert">
              It did not answer: {check.error}
            </p>
          )
        ) : (
          <p className="faint">Starts the server here, asks for its tools, and stops it.</p>
        )}
      </div>

      <div className="sk-foot">
        <Button icon={Icon.edit} onClick={() => setEditing(true)} disabled={busy !== null}>
          Edit
        </Button>
        <Button icon={Icon.plugsOn} loading={busy === "check"} onClick={() => void run("check", async () => setCheck(await api.checkMcp(server.name)))}>
          Check
        </Button>
        <Button variant="danger" icon={Icon.trash} disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
      </div>

      {confirmDelete ? (
        <Confirm
          title={`Delete the global server “${server.name}”?`}
          confirmLabel="Delete"
          danger
          body={<p>New and resumed sessions stop getting it. The agents' own settings are not changed.</p>}
          onConfirm={() => {
            setConfirmDelete(false);
            void run("delete", async () => onChange(await api.removeMcp(server.name)));
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </>
  );
}

/** One environment variable or header row. `kept`: a saved value the page was never shown. */
type Pair = { key: string; value: string; kept: boolean };

function ServerForm({
  saved,
  onSaved,
  onCancel,
  onBack,
}: {
  saved: McpServerView | null;
  onSaved: (next: McpState, name: string) => void;
  onCancel: () => void;
  onBack?: () => void;
}) {
  const [name, setName] = useState(saved?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(saved?.transport ?? "stdio");
  const [command, setCommand] = useState(saved?.command ?? "");
  const [args, setArgs] = useState((saved?.args ?? []).join("\n"));
  const [url, setUrl] = useState(saved?.url ?? "");
  const [env, setEnv] = useState<Pair[]>((saved?.envKeys ?? []).map((key) => ({ key, value: "", kept: true })));
  const [headers, setHeaders] = useState<Pair[]>((saved?.headerKeys ?? []).map((key) => ({ key, value: "", kept: true })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const out = (ps: Pair[]) => ps.filter((p) => p.key.trim() || p.value).map((p) => (p.kept && p.value === "" ? { key: p.key.trim() } : { key: p.key.trim(), value: p.value }));
  const save = async () => {
    const body: McpServerInput =
      transport === "stdio"
        ? { name, transport, command, args: args.split("\n").map((a) => a.trim()).filter(Boolean), env: out(env) }
        : { name, transport, url, headers: out(headers) };
    setBusy(true);
    setError(null);
    try {
      onSaved(saved ? await api.updateMcp(saved.name, body) : await api.addMcp(body), name.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="mc-form-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="sk-header">
        <Header title={saved ? `Edit ${saved.name}` : "Add a global server"} onBack={onBack} />
        <p className="faint mc-form-lead">Every session agentbox starts or resumes gets it. Running sessions keep what they started with.</p>
        {error ? (
          <p className="sk-note mc-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="sk-body mc-form">
        <label className="mc-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" autoComplete="off" spellCheck={false} required />
          <small className="faint">Letters, digits, - and _. Agents show its tools under this name.</small>
        </label>

        <fieldset className="mc-field">
          <legend>How it runs</legend>
          <div className="mc-seg" role="radiogroup" aria-label="How it runs">
            {(
              [
                ["stdio", "A command on this computer"],
                ["http", "An address (URL)"],
              ] as const
            ).map(([t, label]) => (
              <label key={t} className={`mc-seg-opt ${transport === t ? "on" : ""}`}>
                <input type="radio" name="transport" value={t} checked={transport === t} onChange={() => setTransport(t)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>

        {transport === "stdio" ? (
          <>
            <label className="mc-field">
              <span>Command</span>
              <input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" autoComplete="off" spellCheck={false} />
              <small className="faint">Started directly, not through a shell.</small>
            </label>
            <label className="mc-field">
              <span>Arguments</span>
              <textarea className="mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-github"} spellCheck={false} />
              <small className="faint">One per line.</small>
            </label>
            <Pairs title="Environment variables" what="variable" pairs={env} onChange={setEnv} />
          </>
        ) : (
          <>
            <label className="mc-field">
              <span>Address</span>
              <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" autoComplete="off" spellCheck={false} />
              <small className="faint">A Streamable HTTP server.</small>
            </label>
            <Pairs title="Headers" what="header" pairs={headers} onChange={setHeaders} />
          </>
        )}
      </div>
      <div className="sk-foot">
        <Button type="submit" variant="primary" loading={busy}>
          {saved ? "Save" : "Add"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function Pairs({ title, what, pairs, onChange }: { title: string; what: string; pairs: Pair[]; onChange: (p: Pair[]) => void }) {
  const set = (i: number, p: Partial<Pair>) => onChange(pairs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <fieldset className="mc-field">
      <legend>{title}</legend>
      {pairs.map((p, i) => (
        <div key={i} className="mc-pair">
          <input
            className="mono"
            value={p.key}
            onChange={(e) => set(i, { key: e.target.value, kept: false })}
            placeholder="NAME"
            aria-label={`${what} ${i + 1} name`}
            autoComplete="off"
            spellCheck={false}
          />
          <input
            className="mono"
            type="password"
            value={p.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={p.kept ? "saved — leave empty to keep" : "value"}
            aria-label={`${what} ${i + 1} value`}
            autoComplete="new-password"
          />
          <Button variant="ghost" size="sm" icon={Icon.x} aria-label={`Remove ${what} ${p.key || i + 1}`} onClick={() => onChange(pairs.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" icon={Icon.plus} onClick={() => onChange([...pairs, { key: "", value: "", kept: false }])}>
        Add a {what}
      </Button>
      <small className="faint">Values are kept private and are never shown again.</small>
    </fieldset>
  );
}

function FoundDetail({ found, data, onImported, onBack }: { found: McpFound; data: McpState; onImported: (next: McpState, name: string) => void; onBack?: () => void }) {
  const taken = data.servers.some((s) => s.name === found.name);
  const [name, setName] = useState(taken ? `${found.name}-${found.provider}` : found.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      onImported(await api.importMcp(found.id, { name: name.trim(), promote: found.scope === "project" }), name.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="sk-header">
        <Header title={found.name} onBack={onBack} />
        <dl className="sk-facts">
          <div>
            <dt>agent</dt>
            <dd>{PROVIDER_LABEL[found.provider]}</dd>
          </div>
          <div>
            <dt>reaches</dt>
            <dd>{found.scope === "project" ? `Sessions in ${found.project}` : `Every ${PROVIDER_LABEL[found.provider]} session that reads this file`}</dd>
          </div>
          <div>
            <dt>{found.transport === "http" ? "address" : "command"}</dt>
            <dd className="mono mc-wrap-text">{found.transport === "http" ? found.url : [found.command, ...found.args].filter(Boolean).join(" ") || "—"}</dd>
          </div>
          {found.envKeys.length ? (
            <div>
              <dt>environment</dt>
              <dd className="mono">{found.envKeys.map((k) => `${k}=••••`).join("  ")}</dd>
            </div>
          ) : null}
          {found.headerKeys.length ? (
            <div>
              <dt>headers</dt>
              <dd className="mono">{found.headerKeys.map((k) => `${k}: ••••`).join("  ")}</dd>
            </div>
          ) : null}
          <div className="sk-path">
            <dt>{found.sources.length === 1 ? "file" : "files"}</dt>
            <dd className="mono mc-wrap-text">{found.sources.join(", ")}</dd>
          </div>
        </dl>
        {error ? (
          <p className="sk-note mc-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="sk-body mc-body">
        {found.unsupported ? (
          <p>agentbox cannot make this one global: {found.unsupported}.</p>
        ) : (
          <>
            <p>
              {found.scope === "project"
                ? "Only sessions in this project get it now. Making it global gives it to every agent's sessions, in every project."
                : `Only ${PROVIDER_LABEL[found.provider]} gets it now. Making it global gives it to every agent agentbox starts.`}{" "}
              Its values are copied into agentbox's private list; the agent's own file is not changed.
            </p>
            {found.global === "different" || taken ? (
              <label className="mc-field">
                <span>Name for the global server</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} />
                <small className="faint">A global server named {found.name} already exists with another definition.</small>
              </label>
            ) : null}
          </>
        )}
      </div>
      {!found.unsupported ? (
        <div className="sk-foot">
          <Button variant="primary" icon={Icon.plus} loading={busy} onClick={() => (found.scope === "project" ? setConfirm(true) : void add())}>
            {found.scope === "project" ? "Make global" : "Add to global"}
          </Button>
        </div>
      ) : null}
      {confirm ? (
        <Confirm
          title={`Give “${found.name}” to every session?`}
          confirmLabel="Make global"
          body={<p>It is defined for {found.project} only. Every agent agentbox starts or resumes, in every project, will get it.</p>}
          onConfirm={() => {
            setConfirm(false);
            void add();
          }}
          onCancel={() => setConfirm(false)}
        />
      ) : null}
    </>
  );
}
