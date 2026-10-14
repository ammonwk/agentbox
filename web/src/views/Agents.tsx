import { useEffect, useMemo, useState, type FormEvent } from "react";
import { HumanAgents } from "../../../src/cloud/agent-client";
import {
  AGENT_TEMPLATES,
  AgentDefinition,
  WorkStage,
  type AgentBoard,
  type SharedAgent,
  type WorkItem,
  type AgentAction,
} from "../../../src/cloud/agents";
import type { HumanCloud } from "../../../src/cloud/client";
import type { Installation, Member } from "../../../src/cloud/protocol";
import type { CloudStatus } from "../../../src/core/cloud/bridge";
import type { AgentsRuntime } from "../../../src/core/agents/runtime";
import type { ExpertSuggestion } from "../../../src/core/agents/expertise";
import type { AppState } from "../../../src/core/types";
import { parseWhen } from "../../../src/core/schedule";
import { Button, Empty, Field } from "../components";
import { request } from "../api";
import {
  humanCloud,
  signInRedirect,
  useCloudStatus,
  useCloudUser,
  useLoad,
} from "../lib/cloud";
import { go, selectScope } from "../route";
import { useScope } from "../lib/projects";
import "./agents.css";
import { LocalAgentSpace, SharedAgentSpace } from "./AgentSpace";

const when = (s?: string | null) =>
  s
    ? new Date(s).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Never";
const active = (s: string) =>
  ["queued", "starting", "running", "waiting", "uncertain"].includes(s);
const words = (s: string) =>
  s
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
type Task = (work: () => Promise<unknown>) => Promise<void>;
type Local = ReturnType<AgentsRuntime["status"]>;
async function hostRequest(
  api: HumanAgents,
  path: string,
  body: Record<string, unknown>,
) {
  const session = await api.human.sb.auth.getSession();
  if (!session.data.session)
    throw new Error("Sign in to change execution settings");
  return request("POST", path, {
    ...body,
    humanToken: session.data.session.access_token,
  });
}

export function Agents({ state, id }: { state: AppState; id?: string }) {
  const { status, error } = useCloudStatus();
  if (error) return <Empty title="Cloud connection unavailable">{error}</Empty>;
  if (!status) return <Empty title="Loading Agents…" />;
  if (!status.configured || id?.startsWith("local-"))
    return <LocalAgentSpace state={state} id={id} />;
  return <Connected status={status} state={state} id={id} />;
}
function Connected({
  status,
  state,
  id,
}: {
  status: CloudStatus;
  state: AppState;
  id?: string;
}) {
  const human = useMemo(
    () => humanCloud(status),
    [status.url, status.publishableKey],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const user = useCloudUser(human);
  if (!human || !user.ready) return <Empty title="Loading your workspace…" />;
  if (!user.userId)
    return (
      <><Empty title="Sign in to see your shared agents">
        <p>
          Your workspace identity controls authoring, execution requests and
          outreach preferences.
        </p>
        <Button onClick={() => go({ page: "team" })}>Sign in on Team</Button>
      </Empty><LocalAgentSpace state={state} /></>
    );
  return (
    <Directory
      key={user.userId}
      human={human}
      user={user.userId}
      status={status}
      state={state}
      id={id}
    />
  );
}
function Directory({
  human,
  user,
  status,
  state,
  id,
}: {
  human: HumanCloud;
  user: string;
  status: CloudStatus;
  state: AppState;
  id?: string;
}) {
  const api = useMemo(() => new HumanAgents(human), [human]);
  const me = useLoad(() => human.me(), [human]);
  const scope = useScope();
  const project = state.repos.find((r) => r.id === scope.project);
  const workspace = scope.workspace || status.installation?.workspaceId || "";
  const setWorkspace = (id: string) => selectScope("workspace", id);
  const [filter, setFilter] = useState("team");
  const [editing, setEditing] = useState<SharedAgent | AgentDefinition | null>(
    null,
  );
  const [name, setName] = useState("New agent");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (
      me.data &&
      !me.data.memberships.some((m) => m.workspace.id === workspace)
    )
      setWorkspace(me.data.memberships[0]?.workspace.id ?? "");
  }, [me.data, workspace]);
  const data = useLoad(async () => {
    if (!workspace) return null;
    const [board, members, hosts, actions, preferences] = await Promise.all([
      api.board(workspace),
      human.members(workspace),
      human.installations(workspace),
      api.actions(workspace),
      api.preferences(workspace),
    ]);
    return { board, members, hosts, actions, preferences };
  }, [api, workspace]);
  const local = useLoad(() => request<Local>("GET", "/api/agents/runtime"), []);
  useEffect(() => {
    const t = setInterval(() => {
      void data.reload();
      void local.reload();
    }, 10000);
    return () => clearInterval(t);
  }, [data.reload, local.reload]);
  const run: Task = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await data.reload();
      await local.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const selected = data.data?.board.agents.find((a) => a.id === id);
  const inProject = (a: SharedAgent) => !scope.project || !!project && a.definition.repos.some((slug) => slug.toLowerCase() === (project.fullName ?? (project.kind === "github" ? project.ref : "")).toLowerCase());
  const person = (id: string | null) =>
    !id
      ? "Unassigned"
      : data.data?.members.find((m) => m.user_id === id)?.person
          ?.display_name ||
        data.data?.members.find((m) => m.user_id === id)?.person?.email ||
        id.slice(0, 8);
  if (me.error || data.error) return <Empty title="Workspace unavailable">{me.error ?? data.error}<Button onClick={() => { void me.reload(); void data.reload(); }}>Retry</Button></Empty>;
  if (!me.data) return <Empty title="Loading workspaces…" />;
  if (selected && !inProject(selected)) return <Empty title="This shared agent works in other projects"><Button onClick={() => selectScope("project", null, { page: "agents", id: selected.id })}>Open in All projects</Button></Empty>;
  if (!me.data.memberships.length)
    return (
      <Empty title="Create or join a workspace first">
        <Button onClick={() => go({ page: "team" })}>Open Team</Button>
      </Empty>
    );
  return (
    <div className="agents-page">
      {!selected && (
        <div className="agents-toolbar">
          <div className="agents-crumb">
            <a href="#/agents">Agents</a>
          </div>
          <label className="agents-workspace">
            Workspace{" "}
            <select
              className="input"
              aria-label="Workspace"
              value={workspace}
              onChange={(e) => {
                setWorkspace(e.target.value);
                go({ page: "agents" });
              }}
            >
              {me.data.memberships.map((m) => (
                <option key={m.workspace.id} value={m.workspace.id}>
                  {m.workspace.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {(error || data.error) && (
        <p role="alert" className="error">
          {error || data.error}
        </p>
      )}
      {data.error && data.data && (
        <p className="hint">
          Showing the last received workspace state. Changes are unavailable
          until the cloud reconnects.
        </p>
      )}
      {editing ? (
        <Editor
          key={"id" in editing ? editing.id : name}
          initial={editing}
          name={name}
          user={user}
          workspace={workspace}
          members={data.data?.members ?? []}
          hosts={data.data?.hosts ?? []}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(input) =>
            run(async () => {
              const a = await api.save(input);
              setEditing(null);
              go({ page: "agents", id: a.id });
            })
          }
        />
      ) : selected && data.data ? (
        <SharedAgentSpace
          key={selected.id}
          a={selected}
          board={data.data.board}
          api={api}
          user={user}
          actions={data.data.actions}
        >
          <div className="agents-detail-head">
            <div>
              <span className="agents-eyebrow">
                {selected.team
                  ? "SHARED TEAM AGENT"
                  : "PERSONAL AGENT · SHARED VISIBILITY"}
              </span>
              <h2>{selected.name}</h2>
              <p>{selected.definition.role}</p>
              <p className="hint">Repositories: {selected.definition.repos.join(", ") || "None configured"}. One shared conversation across this agent’s scope.</p>
            </div>
            <div className="agents-buttons">
              <span className={`agent-pill ${selected.enabled ? "on" : ""}`}>
                {selected.enabled ? "Enabled" : "Paused"}
              </span>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const copy = await api.clone(selected, user);
                    go({ page: "agents", id: copy.id });
                  })
                }
              >
                Clone for me
              </Button>
              {selected.maintainers.includes(user) && (
                <Button onClick={() => setEditing(selected)}>
                  Edit definition
                </Button>
              )}
            </div>
          </div>
          <div className="agent-summary">
            <div>
              <span>Maintainers</span>
              <strong>{selected.maintainers.map(person).join(", ")}</strong>
            </div>
            <div>
              <span>Execution host</span>
              <strong>
                {data.data.hosts.find(
                  (h) => h.id === selected.execution_installation_id,
                )?.name ?? "Not connected"}
              </strong>
              <small>
                Host seen{" "}
                {when(
                  data.data.hosts.find(
                    (h) => h.id === selected.execution_installation_id,
                  )?.last_seen_at,
                )}
              </small>
            </div>
            <div>
              <span>GitHub actor</span>
              <strong>
                {selected.definition.github.kind === "app"
                  ? selected.definition.github.login || "App not connected"
                  : "Local work · no managed publisher"}
              </strong>
            </div>
            <div>
              <span>Configuration</span>
              <strong>
                Revision {selected.revision} ·{" "}
                {selected.definition.approval === "prepare"
                  ? "Human approval"
                  : "Automatic within scope"}
              </strong>
            </div>
          </div>
          <AgentDetail
            a={selected}
            board={data.data.board}
            actions={data.data.actions}
            api={api}
            user={user}
            run={run}
            busy={busy}
            person={person}
            hosts={data.data.hosts}
            members={data.data.members}
            localHost={status.installation?.id ?? null}
          />
          <Execution
            a={selected}
            status={status}
            state={state}
            hosts={data.data.hosts}
            user={user}
            api={api}
            local={local.data}
            run={run}
            busy={busy}
          />
          <details className="card agent-section">
            <summary>Definition and revision history</summary>
            <DefinitionHistory a={selected} api={api} person={person} />
          </details>
        </SharedAgentSpace>
      ) : id && data.data ? (
        <Empty title="Agent not found in this workspace">
          <Button onClick={() => go({ page: "agents" })}>Back to Agents</Button>
        </Empty>
      ) : (
        <>
          <div className="agents-intro">
            <span className="agents-eyebrow">ONGOING RESPONSIBILITIES</span>
            <h2>A shared view of the work</h2>
            <p>
              Stable agents, accountable humans. Follow the work wherever its
              execution host runs.
            </p>
          </div>
          <div className="agents-toolbar">
            <div className="segmented" aria-label="Agent filter">
              <Button
                variant={filter === "team" ? "primary" : "ghost"}
                onClick={() => setFilter("team")}
              >
                Workspace
              </Button>
              <Button
                variant={filter === "mine" ? "primary" : "ghost"}
                onClick={() => setFilter("mine")}
              >
                Mine
              </Button>
            </div>
            <Button
              variant="primary"
              onClick={() => {
                setName("New agent");
                setEditing(
                  AgentDefinition.parse({
                    role: "Custom responsibility",
                    instructions: "",
                    repos: project?.fullName ? [project.fullName] : project?.kind === "github" ? [project.ref] : [],
                  }),
                );
              }}
            >
              Create agent
            </Button>
          </div>
          <div className="agent-directory">
            {data.data?.board.agents
              .filter((a) => inProject(a) && (filter !== "mine" || a.maintainers.includes(user)))
              .map((a) => {
                const runs = data.data!.board.runs.filter(
                    (r) => r.agent_id === a.id && active(r.state),
                  ),
                  items = data.data!.board.work.filter(
                    (w) =>
                      w.agent_id === a.id && w.stage !== "verified_resolved",
                  );
                return (
                  <a
                    key={a.id}
                    href={`#/agents/${a.id}`}
                    className="card agent-directory-card"
                  >
                    <div className="agents-toolbar">
                      <span className="agent-monogram">
                        {a.name.slice(0, 1)}
                      </span>
                      <span className={`agent-pill ${a.enabled ? "on" : ""}`}>
                        {a.enabled
                          ? runs.length
                            ? runs[0]!.state
                            : "Enabled"
                          : "Paused"}
                      </span>
                    </div>
                    <h3>{a.name}</h3>
                    <p>{a.definition.role}</p>
                    <small>{a.definition.repos.join(", ") || "No repositories configured"}</small>
                    <div className="agent-directory-meta">
                      <span>
                        {a.team
                          ? "Team instance"
                          : `Maintained by ${person(a.created_by)}`}
                      </span>
                      <span>
                        {items.length} open work · {runs.length} active runs
                      </span>
                      <span>
                        {data.data!.hosts.find(
                          (h) => h.id === a.execution_installation_id,
                        )?.name ?? "Choose an execution host"}
                      </span>
                    </div>
                  </a>
                );
              })}
          </div>
          {data.data && data.data.board.agents.length === 0 && (
            <p className="hint">
              No agents yet. Start with Vulcan, or define a role of your own.
            </p>
          )}
          <Templates
            onChoose={(template) => {
              setName(template.name);
              setEditing({ ...template.definition, repos: project?.fullName ? [project.fullName] : project?.kind === "github" ? [project.ref] : template.definition.repos });
            }}
          />
        </>
      )}
      {!id && !editing && <details className="card agent-section"><summary>Local agents on this machine</summary><LocalAgentSpace state={state} /></details>}
      {data.data && (
        <details className="card agent-section">
          <summary>My expertise and contact preferences</summary>
          <Preferences
            api={api}
            human={human}
            workspace={workspace}
            user={user}
            board={data.data.board}
            preferences={data.data.preferences}
            run={run}
            busy={busy}
          />
        </details>
      )}
    </div>
  );
}
function Templates({
  onChoose,
}: {
  onChoose: (t: (typeof AGENT_TEMPLATES)[number]) => void;
}) {
  return (
    <section className="agent-templates">
      <div className="agents-toolbar">
        <h3>Start with a responsibility</h3>
        <span className="hint">
          Created paused. Connect only what you intend to use.
        </span>
      </div>
      <div className="agent-template-grid">
        {AGENT_TEMPLATES.map((t) => (
          <div key={t.id} className="card">
            <span className="agents-eyebrow">
              {t.id === "vulcan"
                ? "ISSUES → VERIFIED FIXES"
                : t.id === "caelus"
                  ? "CHECKS → RELEASE HEALTH"
                  : "SIGNALS → RESOLUTION"}
            </span>
            <h3>{t.name}</h3>
            <p>{t.description}</p>
            <Button onClick={() => onChoose(t)}>Use {t.name}</Button>
          </div>
        ))}
      </div>
    </section>
  );
}
function ListInput({
  values,
  change,
}: {
  values: string[];
  change: (values: string[]) => void;
}) {
  const [value, setValue] = useState(values.join(", "));
  return (
    <input
      className="input"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        change(words(e.target.value));
      }}
    />
  );
}
type Save = Parameters<HumanAgents["save"]>[0];
function Editor({
  initial,
  name: initialName,
  user,
  workspace,
  members,
  hosts,
  busy,
  onSave,
  onCancel,
}: {
  initial: SharedAgent | AgentDefinition;
  name: string;
  user: string;
  workspace: string;
  members: Member[];
  hosts: Installation[];
  busy: boolean;
  onSave: (s: Save) => Promise<void>;
  onCancel: () => void;
}) {
  const existing = "id" in initial ? initial : null;
  const [d, setD] = useState(
    existing?.definition ?? (initial as AgentDefinition),
  );
  const [name, setName] = useState(existing?.name ?? initialName),
    [team, setTeam] = useState(existing?.team ?? true);
  const [maintainers, setMaintainers] = useState(
    existing?.maintainers ?? [user],
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? false),
    [executor, setExecutor] = useState(
      existing?.execution_installation_id ?? "",
    );
  const [advanced, setAdvanced] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const definition = AgentDefinition.parse(
        advanced === null ? d : JSON.parse(advanced),
      );
      if (definition.activation.mode === "schedule") {
        const p = parseWhen(definition.activation.when);
        if ("error" in p) throw new Error(p.error);
        if (["merge", "red"].includes(p.rule.kind))
          throw new Error(
            "Choose a timed source schedule here; merge/workflow event sessions remain in Sessions.",
          );
      }
      void onSave({
        workspace,
        ...(existing ? { id: existing.id, base: existing.revision } : {}),
        name,
        team,
        definition,
        maintainers,
        enabled,
        executor: executor || null,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form className="card agent-editor" onSubmit={submit}>
      <div className="agents-toolbar">
        <h2>{existing ? `Edit ${existing.name}` : "Create an agent"}</h2>
        <span className="hint">
          {existing
            ? `Editing revision ${existing.revision}`
            : "Starts paused with you as maintainer"}
        </span>
      </div>
      <div className="agent-fields">
        <Field label="Name">
          <input
            className="input"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Instance">
          <select
            className="input"
            value={team ? "team" : "personal"}
            onChange={(e) => {
              setTeam(e.target.value === "team");
              if (e.target.value === "personal") setMaintainers([user]);
            }}
          >
            <option value="team">Shared team agent</option>
            <option value="personal">
              Personal agent, visible to workspace
            </option>
          </select>
        </Field>
      </div>
      <Field label="Role">
        <input
          className="input"
          required
          value={d.role}
          onChange={(e) => setD({ ...d, role: e.target.value })}
        />
      </Field>
      <Field label="Instructions">
        {(id) => (
          <textarea
            id={id}
            className="input"
            rows={7}
            value={d.instructions}
            onChange={(e) => setD({ ...d, instructions: e.target.value })}
          />
        )}
      </Field>
      <div className="agent-fields">
        <Field
          label="Allowed repositories"
          hint="owner/repository, comma separated"
        >
          <ListInput
            values={d.repos}
            change={(repos) => setD({ ...d, repos })}
          />
        </Field>
        <Field label="Expertise areas">
          <ListInput
            values={d.expertise}
            change={(expertise) => setD({ ...d, expertise })}
          />
        </Field>
        <Field label="Activation">
          <select
            className="input"
            value={d.activation.mode}
            onChange={(e) =>
              setD({
                ...d,
                activation: {
                  ...d.activation,
                  mode: e.target.value as AgentDefinition["activation"]["mode"],
                },
              })
            }
          >
            <option value="manual">Manual work intake and run now</option>
            <option value="schedule">Scheduled source intake</option>
            <option value="event">
              Watch connected sources every 5 minutes
            </option>
          </select>
        </Field>
        <Field
          label="Schedule"
          hint="Execution host's local time; e.g. every 15 minutes"
        >
          <input
            className="input"
            disabled={d.activation.mode !== "schedule"}
            value={d.activation.when}
            onChange={(e) =>
              setD({
                ...d,
                activation: { ...d.activation, when: e.target.value },
              })
            }
          />
        </Field>
        <Field label="Approval policy">
          <select
            className="input"
            value={d.approval}
            onChange={(e) =>
              setD({
                ...d,
                approval: e.target.value as "prepare" | "automatic",
              })
            }
          >
            <option value="prepare">
              Prepare each outbound action for human approval
            </option>
            <option value="automatic">
              Automatic supported actions within allowed scope
            </option>
          </select>
        </Field>
        <Field label="Concurrent work limit">
          <input
            className="input"
            type="number"
            min={1}
            max={4}
            value={d.maxConcurrent}
            onChange={(e) =>
              setD({ ...d, maxConcurrent: Number(e.target.value) })
            }
          />
        </Field>
      </div>
      <fieldset className="agent-checks">
        <legend>Allowed work</legend>
        {(
          ["investigate", "edit", "open_pr", "merge", "close_issue"] as const
        ).map((action) => (
          <label key={action}>
            <input
              type="checkbox"
              checked={d.actions.includes(action)}
              onChange={(e) =>
                setD({
                  ...d,
                  actions: e.target.checked
                    ? [...d.actions, action]
                    : d.actions.filter((x) => x !== action),
                })
              }
            />
            {action.replaceAll("_", " ")}
          </label>
        ))}
      </fieldset>
      <p className="hint">
        Publication starts with a draft PR. Merges require current-head checks,
        human reviews and repository rules. Issue closure requires the
        configured resolution evidence. Deployment and rollback are unavailable
        until a repository-specific adapter is connected. Scheduled intake
        assigns new work to the creator until explicitly handed off.
      </p>
      <div className="agent-fields">
        <Field
          label="Required check names"
          hint="In addition to GitHub's branch and repository rules"
        >
          <ListInput
            values={d.mergePolicy.requiredChecks}
            change={(requiredChecks) =>
              setD({ ...d, mergePolicy: { ...d.mergePolicy, requiredChecks } })
            }
          />
        </Field>
        <Field label="Current-head human approvals">
          <input
            className="input"
            type="number"
            min={1}
            max={10}
            value={d.mergePolicy.minApprovals}
            onChange={(e) =>
              setD({
                ...d,
                mergePolicy: {
                  ...d.mergePolicy,
                  minApprovals: Number(e.target.value),
                },
              })
            }
          />
        </Field>
        <Field label="Evidence required before issue closure">
          <select
            className="input"
            value={d.mergePolicy.resolution}
            onChange={(e) =>
              setD({
                ...d,
                mergePolicy: {
                  ...d.mergePolicy,
                  resolution: e.target.value as typeof d.mergePolicy.resolution,
                },
              })
            }
          >
            <option value="verified_resolved">
              Original symptom verified resolved
            </option>
            <option value="deployed">Fix confirmed deployed</option>
            <option value="merged">Fix confirmed merged</option>
          </select>
        </Field>
      </div>
      <Field label="Escalation">
        {(id) => (
          <textarea
            id={id}
            className="input"
            rows={2}
            value={d.escalation}
            onChange={(e) => setD({ ...d, escalation: e.target.value })}
          />
        )}
      </Field>
      {existing && (
        <div className="agent-fields">
          <Field
            label="Maintainers"
            hint="Visibility does not grant edit or execution rights."
          >
            <select
              className="input"
              multiple
              disabled={!team}
              value={maintainers}
              onChange={(e) =>
                setMaintainers([
                  ...new Set([
                    user,
                    ...Array.from(e.target.selectedOptions, (o) => o.value),
                  ]),
                ])
              }
            >
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.person?.display_name || m.person?.email || m.user_id}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Execution host"
            hint="Its owner must first grant this agent access below."
          >
            <select
              className="input"
              value={executor}
              onChange={(e) => setExecutor(e.target.value)}
            >
              <option value="">Not connected</option>
              {hosts
                .filter((h) => !h.revoked_at)
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
            </select>
          </Field>
          <label className="agent-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled · may start assigned work
          </label>
        </div>
      )}
      <details className="agent-advanced">
        <summary>
          Sources, pinned skills, GitHub actor and release scope
        </summary>
        <p className="hint">
          Edit the full definition. GitHub sources use kind “github_issues”,
          repo and optional label. Each named bot needs its own GitHub App; put
          only public appId, installationId and login here. Keep the private key
          on its execution host. Release scope names the actual repository,
          environment and artifact.
        </p>
        <textarea
          className="input mono"
          rows={22}
          aria-label="Full agent definition JSON"
          value={advanced ?? JSON.stringify(d, null, 2)}
          onChange={(e) => setAdvanced(e.target.value)}
          onBlur={() => {
            if (advanced !== null) {
              try {
                setD(AgentDefinition.parse(JSON.parse(advanced)));
                setAdvanced(null);
                setError(null);
              } catch (e) {
                setError((e as Error).message);
              }
            }
          }}
        />
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="agents-buttons">
        <Button variant="primary" type="submit" loading={busy}>
          {existing ? "Save revision" : "Create paused agent"}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
function AgentDetail({
  a,
  board,
  actions,
  api,
  user,
  run,
  busy,
  person,
  hosts,
  members,
  localHost,
}: {
  a: SharedAgent;
  board: AgentBoard;
  actions: AgentAction[];
  api: HumanAgents;
  user: string;
  run: Task;
  busy: boolean;
  person: (id: string | null) => string;
  hosts: Installation[];
  members: Member[];
  localHost: string | null;
}) {
  const [source, setSource] = useState(""),
    [title, setTitle] = useState(""),
    [acceptance, setAcceptance] = useState("");
  const editable = a.maintainers.includes(user),
    work = board.work.filter((w) => w.agent_id === a.id);
  return (
    <div className="agent-detail-grid">
      <div className="agent-main">
        <section className="card agent-section">
          <div className="agents-toolbar">
            <h3>Work queue</h3>
            <span className="hint">
              {work.length} {work.length === 1 ? "item" : "items"}
            </span>
          </div>
          {editable && (
            <details>
              <summary>Add an issue or source</summary>
              <form
                className="agent-intake"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const item = await api.intake(a.id, {
                      source,
                      title,
                      acceptance,
                    });
                    if (item.agent_id !== a.id)
                      go({ page: "agents", id: item.agent_id });
                    setSource("");
                    setTitle("");
                    setAcceptance("");
                  });
                }}
              >
                <Field label="Source URL">
                  <input
                    className="input"
                    type="url"
                    required
                    placeholder="https://github.com/owner/repo/issues/123"
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                  />
                </Field>
                <Field label="Work item title">
                  <input
                    className="input"
                    required
                    maxLength={200}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
                <Field label="Acceptance criteria">
                  {(id) => (
                    <textarea
                      id={id}
                      className="input"
                      rows={2}
                      value={acceptance}
                      onChange={(e) => setAcceptance(e.target.value)}
                    />
                  )}
                </Field>
                <Button type="submit" loading={busy}>
                  Add to shared queue
                </Button>
              </form>
            </details>
          )}
          {!work.length && (
            <div className="agent-empty">
              <h4>Ready for its first work item</h4>
              <p>
                Add an issue, define what a successful fix looks like, then
                assign a human and run it.
              </p>
            </div>
          )}
          {work.map((w) => (
            <Work
              key={w.id}
              work={w}
              board={board}
              api={api}
              editable={editable}
              user={user}
              run={run}
              busy={busy}
              members={members}
              person={person}
              enabled={a.enabled}
              localHost={localHost}
            />
          ))}
        </section>
        <section className="card agent-section">
          <h3>Actions & decisions</h3>
          <p className="hint">
            Approval applies only to the exact action below. Opt-out overrides
            approval at dispatch. Open Review to find pending decisions.
          </p>
          {actions
            .filter((x) => x.agent_id === a.id)
            .map((x) => (
              <div key={x.id} className="agent-action">
                <div className="agents-toolbar">
                  <strong>
                    {String(x.specification.kind).replaceAll("_", " ")}
                  </strong>
                  <span className="agent-pill">{x.state}</span>
                </div>
                <p>{String(x.specification.repo ?? "")}</p>
                <details>
                  <summary>Inspect exact action {x.id.slice(0, 8)}</summary>
                  <pre>{JSON.stringify(x.specification, null, 2)}</pre>
                </details>
                {x.result && (
                  <p>
                    {x.result.startsWith("https://") ? (
                      <a href={x.result} target="_blank" rel="noreferrer">
                        External result
                      </a>
                    ) : (
                      x.result
                    )}
                  </p>
                )}
                {["prepared", "approved"].includes(x.state) &&
                  (editable ||
                    board.work.find(
                      (w) =>
                        w.id ===
                        board.runs.find((r) => r.id === x.run_id)?.work_id,
                    )?.assignee === user) && (
                    <div className="agents-buttons">
                      <Button
                        disabled={busy}
                        variant="primary"
                        onClick={() => void run(() => api.decide(x.id, true))}
                      >
                        Approve this action
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => void run(() => api.decide(x.id, false))}
                      >
                        Decline / revoke
                      </Button>
                    </div>
                  )}
              </div>
            ))}
          {!actions.some((x) => x.agent_id === a.id) && (
            <p className="hint">No proposed outbound actions.</p>
          )}
        </section>
      </div>
      <aside className="agent-aside">
        <section className="card agent-section">
          <h3>Execution & progress</h3>
          {board.runs
            .filter((r) => r.agent_id === a.id)
            .map((r) => {
              const stale =
                active(r.state) &&
                r.state !== "queued" &&
                Date.parse(r.lease_until ?? "") < Date.now();
              return (
                <div key={r.id} className="agent-run">
                  <div className="agents-toolbar">
                    <strong>
                      {stale ? "Uncertain · heartbeat expired" : r.state}
                    </strong>
                    <span className="mono">{r.id.slice(0, 8)}</span>
                  </div>
                  <p>
                    {hosts.find((h) => h.id === r.installation_id)?.name ??
                      "Execution host"}{" "}
                    ·{" "}
                    {person(
                      board.work.find((w) => w.id === r.work_id)?.assignee ??
                        null,
                    )}
                  </p>
                  <p>
                    {r.next_action ||
                      (r.state === "queued"
                        ? "Waiting for an authorized host and an available slot"
                        : "No next action reported")}
                  </p>
                  {r.pending_decision && (
                    <div className="agent-decision">
                      <strong>Needs human</strong>
                      <p>{r.pending_decision}</p>
                    </div>
                  )}
                  {r.error && <p className="error">{r.error}</p>}
                  <small>
                    Last heartbeat {when(r.heartbeat_at)} · definition r
                    {r.config_revision}
                  </small>
                  {r.session_id &&
                    (r.installation_id === localHost ? (
                      <a href={`#/s/${r.session_id}`}>
                        Open session {r.session_id}
                      </a>
                    ) : (
                      <span className="hint">
                        Session {r.session_id} on its execution host
                      </span>
                    ))}
                  {r.previous_session_id && (
                    <small>Replaced session {r.previous_session_id}</small>
                  )}
                  {r.installation_id === localHost &&
                    hosts.find((h) => h.id === localHost)?.owner_user_id ===
                      user &&
                    ["running", "waiting"].includes(r.state) && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            hostRequest(
                              api,
                              `/api/agents/runs/${r.id}/rotate`,
                              {},
                            ),
                          )
                        }
                      >
                        Start a fresh session
                      </Button>
                    )}
                </div>
              );
            })}
          {!board.runs.some((r) => r.agent_id === a.id) && (
            <p className="hint">
              No runs yet. Run now creates a durable request for the configured
              host.
            </p>
          )}
        </section>
        <section className="card agent-section">
          <h3>Activity</h3>
          {board.events
            .filter((e) => e.agent_id === a.id)
            .slice(0, 20)
            .map((e) => (
              <div key={e.id} className="agent-event">
                <strong>{e.kind.replaceAll("_", " ")}</strong>
                <p>{e.detail}</p>
                <small>
                  {person(e.actor)} · {when(e.at)}
                </small>
              </div>
            ))}
        </section>
      </aside>
    </div>
  );
}
function Work({
  work: w,
  board,
  api,
  editable,
  user,
  run,
  busy,
  members,
  person,
  enabled,
  localHost,
}: {
  work: WorkItem;
  board: AgentBoard;
  api: HumanAgents;
  editable: boolean;
  user: string;
  run: Task;
  busy: boolean;
  members: Member[];
  person: (id: string | null) => string;
  enabled: boolean;
  localHost: string | null;
}) {
  const writer = board.runs.find((r) => r.work_id === w.id && active(r.state));
  const canManage = editable || w.assignee === user;
  const [to, setTo] = useState(w.assignee ?? user),
    [target, setTarget] = useState(w.agent_id);
  const [stage, setStage] = useState(w.stage),
    [outcome, setOutcome] = useState(w.outcome),
    [evidence, setEvidence] = useState(w.evidence[0]?.url ?? "");
  const [draftRevision, setDraftRevision] = useState(w.revision);
  const staleDraft = draftRevision !== w.revision;
  return (
    <article className="agent-work">
      <div className="agents-toolbar">
        <a href={w.source_url} target="_blank" rel="noreferrer">
          <strong>{w.title}</strong>
        </a>
        <span className="agent-pill">{w.stage.replaceAll("_", " ")}</span>
      </div>
      <p>{w.acceptance || "Acceptance criteria not provided"}</p>
      <div className="agents-toolbar">
        <span className="hint">
          Accountable: {person(w.assignee)} · {w.control.replaceAll("_", " ")}
        </span>
        {writer?.session_id && writer.installation_id === localHost && (
          <a href={`#/s/${writer.session_id}`}>Session</a>
        )}
      </div>
      {w.next_action && <p>Next: {w.next_action}</p>}
      {w.outcome && <p>{w.outcome}</p>}
      <div className="agents-buttons">
        {w.evidence.map((e) => (
          <a key={e.url} href={e.url} target="_blank" rel="noreferrer">
            {e.label}
          </a>
        ))}
      </div>
      {canManage && (
        <div className="agents-buttons">
          {editable && (
            <Button
              disabled={
                busy ||
                !enabled ||
                !!writer ||
                w.control === "takeover_requested"
              }
              onClick={() => void run(() => api.run(w, crypto.randomUUID()))}
            >
              Run now
            </Button>
          )}
          <Button
            disabled={
              busy ||
              w.control === "human" ||
              w.control === "takeover_requested"
            }
            onClick={() => void run(() => api.takeover(w))}
          >
            {w.control === "takeover_requested"
              ? "Waiting for writer to stop…"
              : "Take over"}
          </Button>
        </div>
      )}
      {canManage && (
        <details>
          <summary>Assignment, handoff and outcome</summary>
          {staleDraft && (
            <p className="hint">
              This item changed while the form was open.{" "}
              <Button
                onClick={() => {
                  setTo(w.assignee ?? user);
                  setTarget(w.agent_id);
                  setStage(w.stage);
                  setOutcome(w.outcome);
                  setEvidence(w.evidence[0]?.url ?? "");
                  setDraftRevision(w.revision);
                }}
              >
                Load current values
              </Button>
            </p>
          )}
          <div className="agent-fields">
            <Field label="Accountable human">
              <select
                className="input"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              >
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {person(m.user_id)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Agent instance">
              <select
                className="input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {board.agents
                  .filter((a) => a.maintainers.includes(user))
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <Button
            disabled={busy || !!writer || staleDraft}
            onClick={() => void run(() => api.assign(w, to, target))}
          >
            Save handoff
          </Button>
          {writer && (
            <p className="hint">
              A human handoff waits for the current writer to stop and
              acknowledge.
            </p>
          )}
          {w.control === "human" && (
            <div className="agent-intake">
              <Field label="Stage">
                <select
                  className="input"
                  value={stage}
                  onChange={(e) =>
                    setStage(e.target.value as WorkItem["stage"])
                  }
                >
                  {WorkStage.options.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Outcome / verification">
                {(id) => (
                  <textarea
                    id={id}
                    className="input"
                    value={outcome}
                    onChange={(e) => setOutcome(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Evidence URL">
                <input
                  className="input"
                  type="url"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              </Field>
              <Button
                disabled={busy || staleDraft}
                onClick={() =>
                  void run(() =>
                    api.progress(w, {
                      stage,
                      outcome,
                      next: "",
                      evidence: evidence
                        ? [{ url: evidence, label: "Outcome evidence" }]
                        : [],
                    }),
                  )
                }
              >
                Record outcome
              </Button>
            </div>
          )}
        </details>
      )}
    </article>
  );
}
function Execution({
  a,
  status,
  state,
  hosts,
  user,
  api,
  local,
  run,
  busy,
}: {
  a: SharedAgent;
  status: CloudStatus;
  state: AppState;
  hosts: Installation[];
  user: string;
  api: HumanAgents;
  local: Local | null;
  run: Task;
  busy: boolean;
}) {
  const [host, setHost] = useState(status.installation?.id ?? ""),
    [provider, setProvider] = useState("codex"),
    [model, setModel] = useState("");
  const [repos, setRepos] = useState<Record<string, string>>({}),
    [keyPath, setKeyPath] = useState(""),
    [noteCmd, setNoteCmd] = useState("");
  const binding = local?.bindings.find((b) => b.agent === a.id);
  const ownHost =
    hosts.find((h) => h.id === status.installation?.id)?.owner_user_id === user;
  return (
    <details className="card agent-section">
      <summary>Execution host setup</summary>
      <p className="hint">
        An agent's identity stays with the workspace when its host changes. Host
        grants are separate from maintainer permissions. Register a server on
        Team with the agents:execute scope, then authorize this instance.
      </p>
      <div className="agents-buttons">
        <select
          aria-label="Host to authorize"
          className="input"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        >
          <option value="">Select your host</option>
          {hosts
            .filter((h) => h.owner_user_id === user && !h.revoked_at)
            .map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
        </select>
        <Button
          disabled={busy || !host}
          onClick={() => void run(() => api.authorize(a.id, host, true))}
        >
          Grant host access
        </Button>
        <Button
          disabled={busy || !host}
          onClick={() => void run(() => api.authorize(a.id, host, false))}
        >
          Revoke access
        </Button>
      </div>
      {a.execution_installation_id === status.installation?.id && ownHost ? (
        <form
          className="agent-intake"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              hostRequest(api, "/api/agents/binding", {
                binding: {
                  agent: a.id,
                  url: status.url,
                  workspace: a.workspace_id,
                  provider,
                  model,
                  repos,
                  appKeyPath: keyPath,
                  noteCmd,
                },
              }),
            );
          }}
        >
          <h4>Configure this execution host</h4>
          <p className="hint">
            {binding
              ? `Configured with ${binding.provider}${binding.appConnected ? " and a local App key" : " for local work"}. Saving replaces local settings.`
              : "Not configured yet."}{" "}
            Local paths, provider accounts and credentials stay on this host.
          </p>
          <div className="agent-fields">
            <Field label="Provider">
              <select
                className="input"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {["codex", "claude", "devin", "omp", "opencode", "muse"].map(
                  (p) => (
                    <option key={p}>{p}</option>
                  ),
                )}
              </select>
            </Field>
            <Field label="Model (optional)">
              <input
                className="input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </Field>
            {a.definition.repos.map((slug) => (
              <Field key={slug} label={`Checkout for ${slug}`}>
                <select
                  className="input"
                  required
                  value={repos[slug] ?? ""}
                  onChange={(e) =>
                    setRepos({ ...repos, [slug]: e.target.value })
                  }
                >
                  <option value="">Select registered repository</option>
                  {state.repos
                    .filter(
                      (r) => r.fullName?.toLowerCase() === slug.toLowerCase(),
                    )
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName}
                      </option>
                    ))}
                </select>
              </Field>
            ))}
            <Field
              label="GitHub App PEM path"
              hint="Absolute path to a private 0600 file on this host. Never paste a key."
            >
              <input
                className="input"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Optional local intake note command"
            hint="For connected observability/event adapters: outputs a JSON array of source, title and acceptance. Runs on this host at the configured schedule."
          >
            {(id) => (
              <textarea
                id={id}
                className="input mono"
                rows={2}
                value={noteCmd}
                onChange={(e) => setNoteCmd(e.target.value)}
              />
            )}
          </Field>
          <p className="hint">
            Shared policies guard managed actions. Provider shells run as the
            host's Unix user; use an isolated service account for server
            execution when you need operating-system credential isolation.
          </p>
          <Button type="submit" disabled={busy}>
            Save host settings
          </Button>
          {local?.lastError && <p className="error">{local.lastError}</p>}
        </form>
      ) : (
        <p className="hint">
          Choose the authorized installation in Edit definition, then open this
          page on that host as its owner to configure execution.
        </p>
      )}
    </details>
  );
}
function DefinitionHistory({
  a,
  api,
  person,
}: {
  a: SharedAgent;
  api: HumanAgents;
  person: (id: string | null) => string;
}) {
  const history = useLoad(() => api.revisions(a.id), [a.id, a.revision]);
  return (
    <>
      <pre>{JSON.stringify(a.definition, null, 2)}</pre>
      {history.data?.map((r) => (
        <p key={r.revision}>
          Revision {r.revision} · {person(r.changed_by)} · {when(r.created_at)}
        </p>
      ))}
    </>
  );
}
function Preferences({
  api,
  human,
  workspace,
  user,
  board,
  preferences,
  run,
  busy,
}: {
  api: HumanAgents;
  human: HumanCloud;
  workspace: string;
  user: string;
  board: AgentBoard;
  preferences: Awaited<ReturnType<HumanAgents["preferences"]>>;
  run: Task;
  busy: boolean;
}) {
  const own = board.expertise.find((e) => e.user_id === user);
  const [areas, setAreas] = useState(own?.areas.join(", ") ?? ""),
    [login, setLogin] = useState(own?.github_login ?? ""),
    [emails, setEmails] = useState(own?.git_emails.join(", ") ?? ""),
    [paths, setPaths] = useState(own?.paths.join(", ") ?? "");
  const [repo, setRepo] = useState("*"),
    [agent, setAgent] = useState("");
  const [suggestions, setSuggestions] = useState<{
    suggestions: ExpertSuggestion[];
    missing: string[];
  } | null>(null);
  return (
    <>
      <p className="hint">
        Expertise helps suggest the right person. It never grants contact
        permission or reassigns work.
      </p>
      <div className="agent-fields">
        <Field label="My expertise areas">
          <input
            className="input"
            value={areas}
            onChange={(e) => setAreas(e.target.value)}
          />
        </Field>
        <Field label="GitHub login for history matching">
          <input
            className="input"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </Field>
        <Field label="My commit emails">
          <input
            className="input"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
          />
        </Field>
        <Field label="My repository paths">
          <input
            className="input"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
          />
        </Field>
      </div>
      <Button
        disabled={busy}
        onClick={() =>
          void run(() =>
            api.expertise(workspace, {
              areas: words(areas),
              login,
              emails: words(emails),
              paths: words(paths),
            }),
          )
        }
      >
        Save my expertise
      </Button>
      <h4>Bot outreach · off unless you opt in</h4>
      <p className="hint">
        Only you can opt your verified GitHub identity in. A matching opt-out
        overrides opt-in, including already queued actions. This controls
        agent-initiated contact; GitHub controls its own subscriber
        notifications.
      </p>
      <Button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const r = await human.sb.auth.linkIdentity({
              provider: "github",
              options: { redirectTo: signInRedirect() },
            });
            if (r.error) throw r.error;
          })
        }
      >
        Link my GitHub identity
      </Button>
      <div className="agent-fields">
        <Field
          label="Contact repository scope"
          hint="owner/repo, or * for the workspace"
        >
          <input
            className="input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </Field>
        <Field label="Contact agent scope">
          <select
            className="input"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            <option value="">All agents in this workspace</option>
            {board.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="agents-buttons">
        <Button
          disabled={busy}
          onClick={() =>
            void run(() => api.consent(workspace, repo, agent || null, true))
          }
        >
          Allow contact in this scope
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            void run(() => api.consent(workspace, repo, agent || null, false))
          }
        >
          Opt out of this scope
        </Button>
      </div>
      {preferences
        .filter((p) => p.user_id === user)
        .map((p) => (
          <div key={p.id} className="agent-event">
            <strong>{p.allowed ? "Opted in" : "Opted out"}</strong> ·{" "}
            {p.github_login} · {p.repo} ·{" "}
            {board.agents.find((a) => a.id === p.agent_id)?.name ??
              "All agents"}
            {p.allowed && (
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    api.consent(workspace, p.repo, p.agent_id, false),
                  )
                }
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
      <details>
        <summary>Find expertise suggestions with evidence</summary>
        <p className="hint">
          Uses the areas and paths entered above, plus this host's available git
          history and CODEOWNERS. Explicit assignment still wins.
        </p>
        <Button
          disabled={busy || !agent}
          onClick={() =>
            void run(async () => {
              setSuggestions(
                await request("POST", `/api/agents/${agent}/experts`, {
                  areas: words(areas),
                  paths: words(paths),
                }),
              );
            })
          }
        >
          Find suggestions for selected agent
        </Button>
        {suggestions?.missing.map((s) => (
          <p key={s} className="hint">
            {s}
          </p>
        ))}
        {suggestions?.suggestions.map((s) => (
          <div className="agent-event" key={s.userId}>
            <strong>{s.login || s.userId.slice(0, 8)}</strong>
            <ul>
              {s.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <span className="hint">
              Contact requires a separate current verified opt-in at dispatch.
            </span>
            {s.contact?.map((c) => (
              <p key={c.repo} className="hint">
                {c.repo}: {c.allowed ? "Opted in" : "Skip outreach"} ·{" "}
                {c.reason}
              </p>
            ))}
          </div>
        ))}
      </details>
    </>
  );
}
