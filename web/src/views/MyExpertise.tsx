import { useMemo, useState } from "react";
import { HumanAgents } from "../../../src/cloud/agent-client";
import type { AgentBoard } from "../../../src/cloud/agents";
import type { HumanCloud } from "../../../src/cloud/client";
import type { CloudStatus } from "../../../src/core/cloud/bridge";
import type { ExpertSuggestion } from "../../../src/core/agents/expertise";
import { Button, Field } from "../components";
import { request } from "../api";
import { humanCloud, signInRedirect, useCloudStatus, useCloudUser, useLoad } from "../lib/cloud";
import { useScope } from "../lib/projects";
import "./agents.css";

const words = (s: string) =>
  s
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
type Task = (work: () => Promise<unknown>) => Promise<void>;

/** The Settings section for the signed-in person's expertise and contact
 *  preferences in the current workspace. Nothing without a cloud sign-in. */
export function MyExpertise() {
  const { status } = useCloudStatus(60_000);
  const human = useMemo(
    () => (status ? humanCloud(status) : null),
    [status?.url, status?.publishableKey],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const user = useCloudUser(human);
  if (!status?.configured || !human || !user.userId) return null;
  return <Section key={user.userId} human={human} user={user.userId} status={status} />;
}

function Section({ human, user, status }: { human: HumanCloud; user: string; status: CloudStatus }) {
  const api = useMemo(() => new HumanAgents(human), [human]);
  const scope = useScope();
  const me = useLoad(() => human.me(), [human]);
  const memberships = me.data?.memberships ?? [];
  const wanted = scope.workspace || status.installation?.workspaceId || "";
  const workspace = memberships.some((m) => m.workspace.id === wanted) ? wanted : memberships[0]?.workspace.id ?? "";
  const data = useLoad(async () => {
    if (!workspace) return null;
    const [board, preferences] = await Promise.all([api.board(workspace), api.preferences(workspace)]);
    return { board, preferences };
  }, [api, workspace]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const run: Task = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await data.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const name = memberships.find((m) => m.workspace.id === workspace)?.workspace.name;
  return (
    <section className="card" data-nav-item data-nav-id="settings:expertise" tabIndex={0} aria-label="My expertise">
      <h3>My expertise and contact{name ? ` · ${name}` : ""}</h3>
      {(error || data.error) && (
        <p role="alert" className="error">
          {error || data.error}
        </p>
      )}
      {data.data && (
        <Preferences
          key={workspace}
          api={api}
          human={human}
          workspace={workspace}
          user={user}
          board={data.data.board}
          preferences={data.data.preferences}
          run={run}
          busy={busy}
        />
      )}
    </section>
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
