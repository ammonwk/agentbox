/** The Team page: you, your workspaces, this machine, and what the
 *  workspace shares (plans, skills, messages between machines), over the
 *  agentbox cloud (docs/cloud.md).
 *
 *  Two clients, one page. What is yours as a person (your profile, your
 *  workspaces, publishing a plan) goes from this browser to the cloud with
 *  your own session; what is this machine's (its credential, installing a
 *  skill here, sending as this machine) goes through the local server, which
 *  holds the machine's credential. Nothing here needs the cloud to run
 *  agentbox: without it the page says how to set one up. */

import { useScope } from "../lib/projects";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { HumanCloud } from "../../../src/cloud/client";
import {
  DEFAULT_SCOPES,
  SCOPES,
  WEB_NAMESPACE,
  type Installation,
  type Me,
  type Member,
  type Person,
  type Scope,
  type WorkspacePolicy,
} from "../../../src/cloud/protocol";
import type { CloudStatus } from "../../../src/core/cloud/bridge";
import type { AppState, ProviderId } from "../../../src/core/types";
import { api } from "../api";
import { CopyButton, PROVIDER_LABEL, PROVIDERS } from "../bits";
import { Button, Empty, Field, Icon, Toggle } from "../components";
import { humanCloud, rememberDefaults, signInRedirect, useCloudStatus, useCloudUser, useLoad } from "../lib/cloud";
import { Markdown } from "./session/Markdown";
import "./team.css";

type Tab = "you" | "workspace" | "machine" | "plans" | "skills" | "messages";
const TABS: { id: Tab; label: string }[] = [
  { id: "you", label: "You" },
  { id: "workspace", label: "Workspace" },
  { id: "machine", label: "This machine" },
  { id: "plans", label: "Plans" },
  { id: "skills", label: "Skills" },
  { id: "messages", label: "Messages" },
];

const when = (t: string | number | null | undefined): string =>
  t ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";
const personName = (p: Person | undefined): string => (p ? p.display_name || p.email || p.user_id.slice(0, 8) : "someone");

/** Runs an action, keeping its error and whether it is running. */
function useRun(): [(fn: () => Promise<unknown>) => Promise<void>, { busy: boolean; error: string | null; clear: () => void }] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return [run, { busy, error, clear: () => setError(null) }];
}

const Err = ({ error }: { error: string | null }) =>
  error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;

export function Team({ state }: { state: AppState }) {
  const { status, error, refresh } = useCloudStatus();
  if (error) return <Empty title="Could not ask this machine about the cloud">{error}</Empty>;
  if (!status) return <p className="hint">Loading…</p>;
  if (!status.configured) return <NotSetUp status={status} />;
  return <WithCloud status={status} refresh={refresh} state={state} />;
}

function NotSetUp({ status }: { status: CloudStatus }) {
  return (
    <div className="team">
      <section className="card">
        <h3>agentbox cloud is not set up here</h3>
        {status.configError ? <p className="error">{status.configError}</p> : null}
        <p className="hint">
          Everything on this machine works without it. The cloud is a small shared service (Supabase) for what a team shares: who you are, your workspaces, plans and
          skills with revisions, and messages between agents on different machines. Each machine keeps its own agents, transcripts and provider logins.
        </p>
        <p className="hint">
          To connect, put the project&apos;s URL and its <strong>publishable</strong> key in <code>~/.local/share/agentbox/cloud.env</code> and reload this page:
        </p>
        <pre className="team-pre">{`AGENTBOX_CLOUD_URL=https://<project>.supabase.co\nAGENTBOX_CLOUD_PUBLISHABLE_KEY=sb_publishable_…`}</pre>
        <p className="hint">Never a secret or service-role key: agentbox refuses one. docs/cloud.md has the setup, including a local Supabase for development.</p>
      </section>
    </div>
  );
}

function WithCloud({ status, refresh, state }: { status: CloudStatus; refresh: () => Promise<void>; state: AppState }) {
  const human = useMemo(() => humanCloud(status), [status.url, status.publishableKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const user = useCloudUser(human);
  if (!human || !user.ready) return <p className="hint">Loading…</p>;
  if (!user.userId) {
    return (
      <div className="team">
        <SignIn human={human} />
        <MachineSummary status={status} />
      </div>
    );
  }
  return <SignedIn key={user.userId} human={human} status={status} refresh={refresh} state={state} />;
}

function SignIn({ human }: { human: HumanCloud }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [run, r] = useRun();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!sent) {
        await human.sendCode(email.trim(), signInRedirect());
        setSent(true);
      } else {
        await human.verifyCode(email.trim(), code);
      }
    });
  };
  return (
    <section className="card">
      <h3>Sign in to the agentbox cloud</h3>
      <p className="hint">
        With your email: a six-digit code and a link arrive in one message. Use either. Your sign-in stays in this browser; this machine gets its own credential when you
        register it.
      </p>
      <form className="team-form" onSubmit={submit}>
        <Field label="Email">
          <input className="input" type="email" required value={email} disabled={sent} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        {sent ? (
          <Field label="Code" hint={`Sent to ${email}.`}>
            <input className="input mono" inputMode="numeric" required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoFocus />
          </Field>
        ) : null}
        <div className="input-row">
          <Button variant="primary" type="submit" loading={r.busy}>
            {sent ? "Sign in" : "Email me a code"}
          </Button>
          {sent ? (
            <Button variant="ghost" onClick={() => (setSent(false), setCode(""))}>
              Use another email
            </Button>
          ) : null}
        </div>
        <Err error={r.error} />
      </form>
    </section>
  );
}

function MachineSummary({ status }: { status: CloudStatus }) {
  return (
    <section className="card">
      <h3>This machine</h3>
      {status.installation ? (
        <p className="hint">
          Registered as <strong>{status.installation.name}</strong> in <strong>{status.installation.workspaceSlug}</strong>: <StateMark status={status} />
        </p>
      ) : (
        <p className="hint">Not registered. Sign in, then register it from This machine, or run <code>agentbox cloud login</code> in a terminal.</p>
      )}
    </section>
  );
}

function StateMark({ status }: { status: CloudStatus }) {
  const label: Record<CloudStatus["state"], string> = {
    local: "local only",
    unregistered: "not registered",
    connecting: "connecting",
    connected: "connected",
    offline: "cannot reach the cloud; retrying",
    revoked: "revoked",
  };
  return (
    <span className={`team-state team-state-${status.state}`} title={status.lastError ?? undefined}>
      {label[status.state]}
      {status.lastOkAt ? ` · last ok ${new Date(status.lastOkAt).toLocaleTimeString()}` : ""}
    </span>
  );
}

// -------------------------------------------------------------- signed in

function SignedIn({ human, status, refresh, state }: { human: HumanCloud; status: CloudStatus; refresh: () => Promise<void>; state: AppState }) {
  const me = useLoad(() => human.me(), []);
  const settings = useLoad(() => human.settings(), []);
  const web = (settings.data?.frontend[WEB_NAMESPACE] ?? {}) as { teamTab?: Tab; workspace?: string };
  const [tab, setTab] = useState<Tab | null>(null);
  const scope = useScope();
  const wsId = scope.workspace || null;
  const setWsId = (id: string) => scope.select("workspace", id);
  useEffect(() => {
    if (settings.data) rememberDefaults(settings.data.defaults);
  }, [settings.data]);
  const memberships = me.data?.memberships ?? [];
  const current = memberships.find((m) => m.workspace.id === (wsId ?? status.installation?.workspaceId)) ?? memberships[0] ?? null;
  useEffect(() => {
    if (me.data && current && scope.workspace !== current.workspace.id) setWsId(current.workspace.id);
  }, [me.data, current?.workspace.id, scope.workspace]);
  const shownTab = tab ?? web.teamTab ?? "you";
  // Where you were on this page is a frontend preference, kept under this
  // app's own namespace so another frontend's settings are left alone.
  const remember = (patch: { teamTab?: Tab; workspace?: string }) => void human.saveFrontend(WEB_NAMESPACE, { ...web, ...patch }).then(() => settings.reload(), () => undefined);

  if (me.error) return <Empty title="Could not load your account">{me.error}</Empty>;
  if (!me.data) return <p className="hint">Loading…</p>;
  return (
    <div className="team">
      <div className="team-head">
        <div className="seg" role="group" aria-label="Team sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={shownTab === t.id}
              onClick={() => {
                setTab(t.id);
                remember({ teamTab: t.id });
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {memberships.length > 0 ? (
          <label className="team-ws">
            <span className="faint">Workspace</span>
            <select
              className="input"
              value={current?.workspace.id ?? ""}
              onChange={(e) => {
                setWsId(e.target.value);
                remember({ workspace: e.target.value });
              }}
            >
              {memberships.map((m) => (
                <option key={m.workspace.id} value={m.workspace.id}>
                  {m.workspace.name} ({m.role})
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {shownTab === "you" ? (
        <YouTab human={human} me={me.data} settings={settings} reloadMe={me.reload} />
      ) : shownTab === "workspace" ? (
        <WorkspaceTab human={human} me={me.data} current={current} reloadMe={me.reload} onPick={setWsId} />
      ) : !current ? (
        <Empty title="No workspace yet">Create one, or join one with an invite, on the Workspace tab.</Empty>
      ) : shownTab === "machine" ? (
        <MachineTab human={human} me={me.data} ws={current.workspace.id} role={current.role} status={status} refresh={refresh} />
      ) : shownTab === "plans" ? (
        <PlansTab human={human} ws={current.workspace.id} />
      ) : shownTab === "skills" ? (
        <SkillsTab human={human} ws={current.workspace.id} status={status} state={state} />
      ) : (
        <MessagesTab human={human} me={me.data} ws={current.workspace.id} status={status} state={state} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- you

function YouTab({ human, me, settings, reloadMe }: { human: HumanCloud; me: Me; settings: ReturnType<typeof useLoad<import("../../../src/cloud/protocol").UserSettings>>; reloadMe: () => Promise<void> }) {
  const [name, setName] = useState(me.user.display_name);
  const d = settings.data?.defaults ?? {};
  const [provider, setProvider] = useState<string>(d.provider ?? "");
  const [model, setModel] = useState<string>(d.models?.[d.provider ?? ""] ?? "");
  useEffect(() => {
    setProvider(d.provider ?? "");
    setModel(d.models?.[d.provider ?? ""] ?? "");
  }, [settings.data?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [run, r] = useRun();
  const namespaces = Object.entries(settings.data?.frontend ?? {});
  return (
    <>
      <section className="card">
        <h3>You</h3>
        <p className="hint">
          Signed in as <strong>{me.user.email}</strong>. Co-members of your workspaces see this name and email.
        </p>
        <form
          className="input-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await human.setDisplayName(name.trim());
              await reloadMe();
            });
          }}
        >
          <input className="input" placeholder="Display name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Button type="submit" loading={r.busy}>
            Save name
          </Button>
          <Button variant="ghost" icon={Icon.x} onClick={() => void run(async () => (rememberDefaults(null), await human.signOut()))}>
            Sign out
          </Button>
        </form>
        <Err error={r.error} />
      </section>
      <section className="card">
        <h3>Personal defaults</h3>
        <p className="hint">
          Yours on every machine where you sign in. The new-session dialog starts from these in a browser that has not picked anything yet; what you pick there wins.
          A machine&apos;s own paths and accounts are never here.
        </p>
        <div className="team-grid">
          <Field label="Agent">
            <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">No default</option>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model for that agent" hint="Any id the agent takes; one an account does not offer runs as Default.">
            <input className="input mono" value={model} disabled={!provider} onChange={(e) => setModel(e.target.value)} placeholder="Default" />
          </Field>
        </div>
        <Button
          loading={r.busy}
          onClick={() =>
            void run(async () => {
              const models = { ...(d.models ?? {}) };
              if (provider) models[provider] = model.trim();
              const s = await human.saveDefaults({ ...d, provider: (provider || undefined) as ProviderId | undefined, models });
              rememberDefaults(s.defaults);
              await settings.reload();
            })
          }
        >
          Save defaults
        </Button>
      </section>
      <section className="card">
        <h3>Frontend preferences</h3>
        <p className="hint">
          Each frontend keeps its own settings under its own name, so a custom UI can sit beside this one without either changing the other&apos;s. This app uses{" "}
          <code>{WEB_NAMESPACE}</code> (it remembers the tab and workspace you had open here).
        </p>
        {namespaces.length === 0 ? (
          <p className="faint">Nothing saved yet.</p>
        ) : (
          <ul className="team-list">
            {namespaces.map(([ns, v]) => (
              <li key={ns}>
                <code>{ns}</code> <span className="faint mono">{JSON.stringify(v)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// -------------------------------------------------------------- workspace

function WorkspaceTab({
  human,
  me,
  current,
  reloadMe,
  onPick,
}: {
  human: HumanCloud;
  me: Me;
  current: Me["memberships"][number] | null;
  reloadMe: () => Promise<void>;
  onPick: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [token, setToken] = useState("");
  const [run, r] = useRun();
  return (
    <>
      {current ? <WorkspaceDetail key={current.workspace.id} human={human} me={me} ws={current.workspace.id} role={current.role} reloadMe={reloadMe} /> : null}
      <section className="card">
        <h3>New workspace, or join one</h3>
        <form
          className="team-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const ws = await human.createWorkspace(name.trim(), slug.trim() || name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
              await reloadMe();
              onPick(ws.id);
              setName("");
              setSlug("");
            });
          }}
        >
          <Field label="Name">
            <input className="input" required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Short name" hint="Lowercase letters, digits and dashes; unique across the service.">
            <input className="input mono" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="from the name" />
          </Field>
          <div>
            <Button type="submit" variant="primary" icon={Icon.plus} loading={r.busy}>
              Create
            </Button>
          </div>
        </form>
        <form
          className="input-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const j = await human.acceptInvite(token);
              await reloadMe();
              onPick(j.workspace_id);
              setToken("");
            });
          }}
        >
          <input className="input mono" placeholder="Invite token (abinv_…)" value={token} onChange={(e) => setToken(e.target.value)} />
          <Button type="submit" loading={r.busy} disabled={!token.trim()}>
            Join
          </Button>
        </form>
        <Err error={r.error} />
      </section>
    </>
  );
}

function WorkspaceDetail({ human, me, ws, role, reloadMe }: { human: HumanCloud; me: Me; ws: string; role: Member["role"]; reloadMe: () => Promise<void> }) {
  const admin = role === "owner" || role === "admin";
  const members = useLoad(() => human.members(ws), [ws]);
  const invites = useLoad(() => (admin ? human.invites(ws) : Promise.resolve([])), [ws, admin]);
  const policy = useLoad(() => human.policy(ws), [ws]);
  const [run, r] = useRun();
  const [made, setMade] = useState<string | null>(null);
  const [inv, setInv] = useState({ email: "", role: "member" as "member" | "admin", ttl: 72, uses: 1 });
  return (
    <>
      <section className="card">
        <h3>Members</h3>
        <Err error={members.error} />
        <table className="team-table">
          <tbody>
            {(members.data ?? []).map((m) => (
              <tr key={m.user_id}>
                <td>{personName(m.person)}</td>
                <td className="faint">{m.person.email}</td>
                <td>
                  {role === "owner" && m.user_id !== me.user.user_id ? (
                    <select className="input" value={m.role} onChange={(e) => void run(async () => (await human.setRole(ws, m.user_id, e.target.value as Member["role"]), await members.reload()))}>
                      <option value="owner">owner</option>
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td className="team-actions">
                  {m.user_id === me.user.user_id ? (
                    <Button size="sm" variant="ghost" onClick={() => void run(async () => (await human.removeMember(ws, m.user_id), await reloadMe()))}>
                      Leave
                    </Button>
                  ) : role === "owner" || (role === "admin" && m.role === "member") ? (
                    <Button size="sm" variant="ghost" icon={Icon.trash} onClick={() => void run(async () => (await human.removeMember(ws, m.user_id), await members.reload()))}>
                      Remove
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">Removing someone revokes their machines here at once, and the messages those machines had queued are not delivered.</p>
        <Err error={r.error} />
      </section>
      {admin ? (
        <section className="card">
          <h3>Invites</h3>
          <p className="hint">An invite is a token shown once. Bind it to an email to make it useless to anyone else; it expires, and runs out after its uses.</p>
          <form
            className="team-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const c = await human.createInvite(ws, { email: inv.email.trim() || null, role: inv.role, ttlHours: inv.ttl, maxUses: inv.uses });
                setMade(c.token);
                await invites.reload();
              });
            }}
          >
            <Field label="Email (optional)">
              <input className="input" type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            </Field>
            <Field label="Role">
              <select className="input" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value as "member" | "admin" })}>
                <option value="member">member</option>
                {role === "owner" ? <option value="admin">admin</option> : null}
              </select>
            </Field>
            <Field label="Hours">
              <input className="input" type="number" min={1} value={inv.ttl} onChange={(e) => setInv({ ...inv, ttl: Number(e.target.value) })} />
            </Field>
            <Field label="Uses">
              <input className="input" type="number" min={1} max={100} value={inv.uses} onChange={(e) => setInv({ ...inv, uses: Number(e.target.value) })} />
            </Field>
            <div>
              <Button type="submit" variant="primary" loading={r.busy}>
                Create invite
              </Button>
            </div>
          </form>
          {made ? (
            <div className="team-secret">
              <p className="hint">Send this to them now; it is not shown again. They paste it into Join here, or run:</p>
              <code className="mono">agentbox cloud login --invite {made}</code> <CopyButton text={made} label="Copy token" />
            </div>
          ) : null}
          <table className="team-table">
            <tbody>
              {(invites.data ?? []).map((i) => {
                const live = !i.revoked_at && new Date(i.expires_at) > new Date() && i.uses < i.max_uses;
                return (
                  <tr key={i.id} className={live ? "" : "faint"}>
                    <td>{i.email ?? "anyone with the token"}</td>
                    <td>{i.role}</td>
                    <td>
                      {i.uses}/{i.max_uses} used
                    </td>
                    <td>{i.revoked_at ? "revoked" : `expires ${when(i.expires_at)}`}</td>
                    <td className="team-actions">
                      {live ? (
                        <Button size="sm" variant="ghost" onClick={() => void run(async () => (await human.revokeInvite(i.id), await invites.reload()))}>
                          Revoke
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}
      {policy.data ? <PolicyCard human={human} ws={ws} admin={admin} policy={policy.data} onSaved={policy.reload} /> : <Err error={policy.error} />}
    </>
  );
}

function PolicyCard({ human, ws, admin, policy, onSaved }: { human: HumanCloud; ws: string; admin: boolean; policy: WorkspacePolicy; onSaved: () => Promise<void> }) {
  const [p, setP] = useState(policy);
  const [run, r] = useRun();
  const m = p.messaging;
  const num = (label: string, value: number, set: (n: number) => void, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input" type="number" disabled={!admin} value={value} onChange={(e) => set(Number(e.target.value))} />
    </Field>
  );
  return (
    <section className="card">
      <h3>Team policy</h3>
      <p className="hint">{admin ? "What this workspace's admins decide for everyone in it. The service enforces it." : "Set by this workspace's admins; the service enforces it."}</p>
      <div className="team-toggles">
        <Toggle checked={m.enabled} disabled={!admin} onChange={(v) => setP({ ...p, messaging: { ...m, enabled: v } })} label="Messages between machines" />
        <Toggle checked={m.allow_wake} disabled={!admin} onChange={(v) => setP({ ...p, messaging: { ...m, allow_wake: v } })} label="A message may ask to wake a session" />
      </div>
      <div className="team-grid">
        {num("Largest message (bytes)", m.max_body_bytes, (n) => setP({ ...p, messaging: { ...m, max_body_bytes: n } }))}
        {num("Keep undelivered text (hours)", m.body_retention_hours, (n) => setP({ ...p, messaging: { ...m, body_retention_hours: n } }), "Then it expires. Delivered text is dropped at once.")}
        {num("Messages per machine per hour", m.sender_hourly_limit, (n) => setP({ ...p, messaging: { ...m, sender_hourly_limit: n } }))}
        {num("Longest invite (hours)", p.invites.max_ttl_hours, (n) => setP({ ...p, invites: { max_ttl_hours: n } }))}
        <Field label="Who publishes plans and skills">
          <select className="input" disabled={!admin} value={p.artifacts.publish_role} onChange={(e) => setP({ ...p, artifacts: { publish_role: e.target.value as "member" | "admin" } })}>
            <option value="member">every member</option>
            <option value="admin">owners and admins</option>
          </select>
        </Field>
      </div>
      {admin ? (
        <Button loading={r.busy} onClick={() => void run(async () => (setP(await human.setPolicy(ws, p)), await onSaved()))}>
          Save policy
        </Button>
      ) : null}
      <Err error={r.error} />
    </section>
  );
}

// ---------------------------------------------------------------- machine

function MachineTab({ human, me, ws, role, status, refresh }: { human: HumanCloud; me: Me; ws: string; role: Member["role"]; status: CloudStatus; refresh: () => Promise<void> }) {
  const installations = useLoad(() => human.installations(ws), [ws]);
  const members = useLoad(() => human.members(ws), [ws]);
  const grants = useLoad(() => human.grants(ws), [ws]);
  const registered = status.installation && status.installation.workspaceId === ws ? (installations.data ?? []).find((i) => i.id === status.installation!.id) : undefined;
  // Only its owner manages a machine; anyone else signed in here is told whose it is.
  const here = registered?.owner_user_id === me.user.user_id ? registered : undefined;
  const providers = useLoad(() => (here ? human.providerConnections(here.id) : Promise.resolve([])), [here?.id, status.lastOkAt && Math.floor(status.lastOkAt / 60_000)]);
  const [name, setName] = useState(status.hostname);
  const [scopes, setScopes] = useState<Scope[]>(DEFAULT_SCOPES);
  const [run, r] = useRun();
  const people = new Map((members.data ?? []).map((m) => [m.user_id, m.person]));
  const mine = (installations.data ?? []).filter((i) => i.owner_user_id === me.user.user_id && !i.revoked_at);
  const [grantFor, setGrantFor] = useState("");
  const [grantTo, setGrantTo] = useState("");
  const admin = role === "owner" || role === "admin";

  const scopeBoxes = (value: Scope[], set: (s: Scope[]) => void) => (
    <div className="team-scopes">
      {SCOPES.map((s) => (
        <label key={s}>
          <input type="checkbox" checked={value.includes(s)} onChange={(e) => set(e.target.checked ? [...value, s] : value.filter((x) => x !== s))} /> <code>{s}</code>
        </label>
      ))}
    </div>
  );

  return (
    <>
      <section className="card">
        <h3>This machine</h3>
        {status.installation ? (
          <>
            <p className="hint">
              <strong>{status.installation.name}</strong> in <strong>{status.installation.workspaceSlug}</strong>: <StateMark status={status} />
            </p>
            {status.lastError ? <p className="error">{status.lastError}</p> : null}
            {status.installation.workspaceId !== ws ? <p className="hint">It is registered in another workspace; switch to it above to manage it.</p> : null}
            {registered && !here ? <p className="hint">It is registered to {status.hello ? personName(status.hello.owner) : "someone else"}, who manages it.</p> : null}
            {here ? (
              <>
                <p className="hint">What this machine may do with its credential (agents on it never get yours):</p>
                <ScopeEditor value={here.scopes} onSave={(s) => run(async () => (await human.updateInstallation(here.id, { scopes: s }), await installations.reload()))} render={scopeBoxes} />
                <div className="toggle-row">
                  <Toggle
                    checked={here.accept_own}
                    onChange={(v) => void run(async () => (await human.updateInstallation(here.id, { acceptOwn: v }), await installations.reload()))}
                    label="Take messages from my other machines without a grant"
                  />
                </div>
              </>
            ) : null}
            <div className="input-row">
              <Button icon={Icon.refresh} onClick={() => void run(async () => (await api.cloudSync(), await refresh()))}>
                Sync now
              </Button>
              {registered && !here ? null : here ? (
                <Button
                  variant="ghost"
                  icon={Icon.trash}
                  onClick={() => void run(async () => (await human.revokeInstallation(here.id), await api.cloudForget(false), await refresh(), await installations.reload()))}
                >
                  Revoke and forget
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => void run(async () => (await api.cloudForget(false), await refresh()))}>
                  Forget the credential here
                </Button>
              )}
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const reg = await human.registerInstallation(ws, name.trim(), { platform: navigator.platform, scopes });
                // Straight to the machine; this page keeps no copy. If the
                // machine does not take it, no installation is left without it.
                await api.cloudRegister(reg.secret).catch(async (e: unknown) => {
                  await human.revokeInstallation(reg.installation.id).catch(() => undefined);
                  throw e;
                });
                await refresh();
                await installations.reload();
              });
            }}
          >
            <p className="hint">
              Register this machine in this workspace. It gets a credential of its own with the scopes you pick: its agents can send and receive messages and
              read the workspace&apos;s plans and skills, never act as you.
            </p>
            <Field label="Name">
              <input className="input mono" required value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,47}" />
            </Field>
            {scopeBoxes(scopes, setScopes)}
            <Button type="submit" variant="primary" loading={r.busy}>
              Register this machine
            </Button>
          </form>
        )}
        <Err error={r.error} />
      </section>

      {status.installation ? <LocalSettings status={status} refresh={refresh} /> : null}

      {here ? (
        <section className="card">
          <h3>Provider logins on this machine</h3>
          <p className="hint">What the workspace&apos;s service knows: the provider and the account&apos;s label{status.settings.shareAccountEmails ? " and email" : ""}, visible only to you. Credentials stay on this machine.</p>
          <ul className="team-list">
            {(providers.data ?? []).map((p) => (
              <li key={`${p.provider}/${p.account_label}`}>
                <strong>{PROVIDER_LABEL[p.provider as ProviderId] ?? p.provider}</strong> {p.account_label} <span className="faint">{[p.account_email, p.plan].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card">
        <h3>Machines in this workspace</h3>
        <table className="team-table">
          <tbody>
            {(installations.data ?? []).map((i) => (
              <tr key={i.id} className={i.revoked_at ? "faint" : ""}>
                <td>
                  <strong>{i.name}</strong>
                  {i.id === status.installation?.id ? " (this one)" : ""}
                </td>
                <td>{personName(people.get(i.owner_user_id))}</td>
                <td className="faint">{i.scopes.join(", ")}</td>
                <td>{i.revoked_at ? `revoked ${when(i.revoked_at)}` : `seen ${when(i.last_seen_at)}`}</td>
                <td className="team-actions">
                  {!i.revoked_at && (i.owner_user_id === me.user.user_id || admin) && i.id !== status.installation?.id ? (
                    <Button size="sm" variant="ghost" onClick={() => void run(async () => (await human.revokeInstallation(i.id), await installations.reload()))}>
                      Revoke
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>Who may message your machines</h3>
        <p className="hint">
          Being in the workspace is not permission to type into your agents. Your own machines may (unless you turn that off above); anyone else needs a grant from
          you, for one of your machines. Taking one back stops what they have queued, too.
        </p>
        <ul className="team-list">
          {(grants.data ?? [])
            .filter((g) => !g.revoked_at)
            .map((g) => {
              const target = installations.data?.find((i) => i.id === g.target_installation_id);
              const to = g.grantee_user_id ? personName(people.get(g.grantee_user_id)) : `machine ${installations.data?.find((i) => i.id === g.grantee_installation_id)?.name ?? "?"}`;
              return (
                <li key={g.id}>
                  {to} → <strong>{target?.name ?? "?"}</strong>{" "}
                  <Button size="sm" variant="ghost" onClick={() => void run(async () => (await human.revokeDelivery(g.id), await grants.reload()))}>
                    Take back
                  </Button>
                </li>
              );
            })}
        </ul>
        {mine.length ? (
          <div className="input-row">
            <select className="input" value={grantFor} onChange={(e) => setGrantFor(e.target.value)}>
              <option value="">Into my machine…</option>
              {mine.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <select className="input" value={grantTo} onChange={(e) => setGrantTo(e.target.value)}>
              <option value="">from…</option>
              {(members.data ?? [])
                .filter((m) => m.user_id !== me.user.user_id)
                .map((m) => (
                  <option key={m.user_id} value={`user:${m.user_id}`}>
                    {personName(m.person)} (any of their machines)
                  </option>
                ))}
              {(installations.data ?? [])
                .filter((i) => !i.revoked_at && i.owner_user_id !== me.user.user_id)
                .map((i) => (
                  <option key={i.id} value={`inst:${i.id}`}>
                    machine {i.name}
                  </option>
                ))}
            </select>
            <Button
              disabled={!grantFor || !grantTo}
              onClick={() =>
                void run(async () => {
                  const [kind, id] = grantTo.split(":");
                  await human.grantDelivery(grantFor, kind === "user" ? { user: id } : { installation: id });
                  await grants.reload();
                })
              }
            >
              Allow
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function ScopeEditor({ value, onSave, render }: { value: Scope[]; onSave: (s: Scope[]) => Promise<void>; render: (v: Scope[], set: (s: Scope[]) => void) => ReactNode }) {
  const [v, setV] = useState(value);
  const dirty = [...v].sort().join() !== [...value].sort().join();
  return (
    <div>
      {render(v, setV)}
      {dirty ? (
        <Button size="sm" onClick={() => void onSave(v)}>
          Save scopes
        </Button>
      ) : null}
    </div>
  );
}

function LocalSettings({ status, refresh }: { status: CloudStatus; refresh: () => Promise<void> }) {
  const s = status.settings;
  const [run, r] = useRun();
  const set = (patch: Parameters<typeof api.cloudSettings>[0]) => void run(async () => (await api.cloudSettings(patch), await refresh()));
  return (
    <section className="card">
      <h3>This machine only</h3>
      <p className="hint">Kept on this machine and never sent to the cloud.</p>
      <div className="toggle-row">
        <Toggle checked={s.allowRemoteWake} onChange={(v) => set({ allowRemoteWake: v })} label="Let a message from another machine wake a stopped or cold session" />
        <p className="field-hint">Only when its sender asks and the team policy allows. Off, such a message is refused and the sender is told why.</p>
      </div>
      <div className="toggle-row">
        <Toggle checked={s.shareAccountEmails} onChange={(v) => set({ shareAccountEmails: v })} label="Include provider account emails in this machine's provider metadata" />
      </div>
      <div className="team-grid">
        <Field label="Install skills into">
          <select className="input" value={s.skillRoot} onChange={(e) => set({ skillRoot: e.target.value as "claude" | "agents" })}>
            <option value="claude">~/.claude/skills</option>
            <option value="agents">~/.agents/skills</option>
          </select>
        </Field>
        <Field label="Check for messages every (seconds)">
          <input className="input" type="number" min={2} max={300} defaultValue={s.pollSeconds} onBlur={(e) => set({ pollSeconds: Number(e.target.value) })} />
        </Field>
      </div>
      <Err error={r.error} />
    </section>
  );
}

// ------------------------------------------------------------------ plans

function PlansTab({ human, ws }: { human: HumanCloud; ws: string }) {
  const plans = useLoad(() => human.plans(ws), [ws]);
  const [slug, setSlug] = useState<string | null>(null);
  const [rev, setRev] = useState<number | null>(null);
  const plan = useLoad(() => (slug ? human.plan(ws, slug, rev ?? undefined) : Promise.resolve(null)), [ws, slug, rev]);
  const [editing, setEditing] = useState<{ slug: string; title: string; body: string; base: number | null; summary: string } | null>(null);
  const [run, r] = useRun();
  return (
    <div className="team-split">
      <section className="card team-index">
        <h3>Plans</h3>
        <ul className="team-list">
          {(plans.data ?? []).map((p) => (
            <li key={p.id}>
              <button type="button" className={`team-link ${p.slug === slug ? "on" : ""}`} onClick={() => (setSlug(p.slug), setRev(null), setEditing(null))}>
                {p.title}
              </button>{" "}
              <span className="faint">rev {p.latest_rev}</span>
            </li>
          ))}
        </ul>
        {plans.data?.length === 0 ? <p className="faint">No plans yet.</p> : null}
        <Button icon={Icon.plus} onClick={() => setEditing({ slug: "", title: "", body: "", base: null, summary: "" })}>
          New plan
        </Button>
        <Err error={plans.error} />
      </section>
      <section className="card team-detail">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const p = await human.publishPlan(ws, { slug: editing.slug, title: editing.title, body: editing.body, baseRev: editing.base, summary: editing.summary });
                setEditing(null);
                setSlug(p.plan.slug);
                setRev(null);
                await plans.reload();
                await plan.reload();
              });
            }}
          >
            <h3>{editing.base === null ? "New plan" : `Revision ${editing.base + 1} of ${editing.slug}`}</h3>
            <div className="team-grid">
              <Field label="Short name">
                <input className="input mono" required disabled={editing.base !== null} value={editing.slug} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} />
              </Field>
              <Field label="Title">
                <input className="input" required value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} />
              </Field>
            </div>
            <textarea className="input team-text" rows={16} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} placeholder="Markdown" />
            <div className="input-row">
              <input className="input" placeholder="What changed (optional)" value={editing.summary} onChange={(e) => setEditing({ ...editing, summary: e.target.value })} />
              <Button type="submit" variant="primary" loading={r.busy}>
                Publish
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
            <p className="hint">Published on top of the revision you started from; if someone published since, you are told rather than overwriting theirs.</p>
            <Err error={r.error} />
          </form>
        ) : plan.data ? (
          <>
            <div className="team-detail-head">
              <h3>{plan.data.revision.title}</h3>
              <select className="input" value={plan.data.revision.rev} onChange={(e) => setRev(Number(e.target.value))}>
                {plan.data.revisions.map((x) => (
                  <option key={x.rev} value={x.rev}>
                    rev {x.rev} · {when(x.created_at)}
                    {x.summary ? ` · ${x.summary}` : ""}
                  </option>
                ))}
              </select>
              <Button
                icon={Icon.edit}
                onClick={() =>
                  setEditing({ slug: plan.data!.plan.slug, title: plan.data!.plan.title, body: plan.data!.revision.body ?? "", base: plan.data!.plan.latest_rev, summary: "" })
                }
              >
                New revision
              </Button>
            </div>
            <p className="faint">
              <code>agentbox cloud plan show {plan.data.plan.slug} --rev {plan.data.revision.rev}</code>
            </p>
            <div className="team-md">
              <Markdown text={plan.data.revision.body ?? ""} />
            </div>
          </>
        ) : (
          <Empty title="Pick a plan">A plan is a Markdown document with every revision kept. Agents read it with `agentbox cloud plan show`.</Empty>
        )}
      </section>
    </div>
  );
}

// ----------------------------------------------------------------- skills

function SkillsTab({ human, ws, status, state }: { human: HumanCloud; ws: string; status: CloudStatus; state: AppState }) {
  const skills = useLoad(() => human.skills(ws), [ws]);
  const installed = useLoad(() => (status.installation ? api.cloudInstalledSkills() : Promise.resolve([])), [status.installation?.id]);
  const [name, setName] = useState<string | null>(null);
  const [rev, setRev] = useState<number | null>(null);
  const skill = useLoad(() => (name ? human.skill(ws, name, rev ?? undefined) : Promise.resolve(null)), [ws, name, rev]);
  const [force, setForce] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [publish, setPublish] = useState("");
  const [run, r] = useRun();
  const here = status.installation?.workspaceId === ws;
  const canPublish = status.hello?.installation.scopes.includes("artifacts:publish");
  const local = state.skills.filter((s) => s.source !== "project");
  const installedHere = new Map((installed.data ?? []).map((s) => [s.manifest.name, s.manifest]));
  return (
    <div className="team-split">
      <section className="card team-index">
        <h3>Skills</h3>
        <ul className="team-list">
          {(skills.data ?? []).map((s) => {
            const m = installedHere.get(s.name);
            return (
              <li key={s.id}>
                <button type="button" className={`team-link ${s.name === name ? "on" : ""}`} onClick={() => (setName(s.name), setRev(null), setResult(null))}>
                  {s.name}
                </button>{" "}
                <span className="faint">
                  rev {s.latest_rev}
                  {m ? ` · here: rev ${m.rev}${m.rev < s.latest_rev ? " (newer available)" : ""}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
        {skills.data?.length === 0 ? <p className="faint">No skills yet.</p> : null}
        <h4>Publish one of this machine&apos;s skills</h4>
        {here && canPublish ? (
          <div className="input-row">
            <select className="input" value={publish} onChange={(e) => setPublish(e.target.value)}>
              <option value="">Pick a skill…</option>
              {local.map((s) => (
                <option key={s.path} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
            <Button disabled={!publish} loading={r.busy} onClick={() => void run(async () => {
              const p = await api.cloudPublishSkill(publish);
              setResult(p.unchanged ? `${p.skill.name} is already rev ${p.revision.rev}.` : `Published ${p.skill.name} rev ${p.revision.rev}.`);
              await skills.reload();
              await installed.reload();
            })}>
              Publish
            </Button>
          </div>
        ) : (
          <p className="hint">{here ? "This machine needs the artifacts:publish scope (This machine tab)." : "Register this machine in this workspace first."}</p>
        )}
        <Err error={skills.error} />
      </section>
      <section className="card team-detail">
        {skill.data ? (
          <>
            <div className="team-detail-head">
              <h3>{skill.data.skill.name}</h3>
              <select className="input" value={skill.data.revision.rev} onChange={(e) => setRev(Number(e.target.value))}>
                {skill.data.revisions.map((x) => (
                  <option key={x.rev} value={x.rev}>
                    rev {x.rev} · {when(x.created_at)}
                    {x.summary ? ` · ${x.summary}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <p className="hint">{skill.data.revision.description}</p>
            {here ? (
              <div className="input-row">
                <Button
                  variant="primary"
                  icon={Icon.arrowDown}
                  loading={r.busy}
                  onClick={() =>
                    void run(async () => {
                      const out = await api.cloudInstallSkill(skill.data!.skill.name, skill.data!.revision.rev, force);
                      const parts = [`Installed rev ${out.rev} into ${out.dir}: ${out.written.length} written, ${out.same.length} unchanged, ${out.removed.length} removed.`];
                      for (const k of out.kept) parts.push(`Kept your ${k.path}; this revision's copy is at ${k.incoming}.`);
                      for (const k of out.replaced) parts.push(`Replaced your ${k.path}; your copy is at ${k.backup}.`);
                      setResult(parts.join(" "));
                      await installed.reload();
                    })
                  }
                >
                  Install rev {skill.data.revision.rev} here
                </Button>
                <Toggle checked={force} onChange={setForce} label="Replace files I edited (backed up first)" />
              </div>
            ) : (
              <p className="hint">Register this machine in this workspace to install skills on it.</p>
            )}
            {result ? <p className="hint">{result}</p> : null}
            <Err error={r.error} />
            <ul className="team-list mono">
              {(skill.data.revision.files ?? []).map((f) => (
                <li key={f.path}>
                  {f.path} <span className="faint">{f.bytes} B</span>
                </li>
              ))}
            </ul>
            <div className="team-md">
              <Markdown text={skill.data.revision.files?.find((f) => f.path === "SKILL.md")?.content.replace(/^---[\s\S]*?---\n/, "") ?? ""} />
            </div>
          </>
        ) : (
          <Empty title="Pick a skill">
            A skill is a whole skill directory, with every revision kept. Installing pins one revision on this machine and keeps any file you have edited.
          </Empty>
        )}
      </section>
    </div>
  );
}

// --------------------------------------------------------------- messages

function MessagesTab({ human, me, ws, status, state }: { human: HumanCloud; me: Me; ws: string; status: CloudStatus; state: AppState }) {
  const messages = useLoad(() => human.messages(ws), [ws, status.lastOkAt && Math.floor(status.lastOkAt / 10_000)]);
  const installations = useLoad(() => human.installations(ws), [ws]);
  // What this machine sends goes as its owner, so only its owner sends from here.
  const here = status.installation?.workspaceId === ws && status.hello?.owner.user_id === me.user.user_id;
  const dir = useLoad(() => (here ? api.cloudDirectory(true) : Promise.resolve(null)), [here, ws]);
  const names = new Map((installations.data ?? []).map((i: Installation) => [i.id, i.name]));
  const [to, setTo] = useState("");
  const [session, setSession] = useState("");
  const [text, setText] = useState("");
  const [wake, setWake] = useState(false);
  const [share, setShare] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [run, r] = useRun();
  const target = dir.data?.installations.find((i) => i.id === to);
  const live = state.sessions.filter((s) => s.status !== "closed");
  return (
    <>
      <section className="card">
        <h3>Send a message to an agent on another machine</h3>
        {here ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const out = await api.cloudSend({ to: `${target!.name}/${session.trim()}`, text, wake });
                setNote(out.message ? `${out.to}: ${out.message.state}` : `${out.to}: ${out.state === "pending" ? "queued here until the cloud can be reached" : out.state}`);
                setText("");
                await messages.reload();
              });
            }}
          >
            <p className="hint">
              It goes from this machine, as you. The agent that reads it is told it is a message from a peer, not instructions from its human. Agents send their own with{" "}
              <code>agentbox cloud send</code>.
            </p>
            <div className="team-grid">
              <Field label="Machine">
                <select className="input" required value={to} onChange={(e) => setTo(e.target.value)}>
                  <option value="">Pick…</option>
                  {(dir.data?.installations ?? []).map((i) => (
                    <option key={i.id} value={i.id} disabled={!i.accepts_from_me}>
                      {i.name} ({personName(i.owner)}){i.accepts_from_me ? "" : " — not allowed"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Session id" hint="Listed agents are below; any session id on that machine works.">
                <input className="input mono" required value={session} onChange={(e) => setSession(e.target.value)} list="team-agents" />
              </Field>
            </div>
            <datalist id="team-agents">
              {(dir.data?.agents ?? []).filter((a) => a.installation_id === to).map((a) => (
                <option key={a.id} value={a.local_session_id}>
                  {a.label ?? ""}
                </option>
              ))}
            </datalist>
            <textarea className="input team-text" rows={4} required value={text} onChange={(e) => setText(e.target.value)} />
            <div className="input-row">
              <Toggle checked={wake} onChange={setWake} label="Wake it if it is stopped or cold" />
              <Button type="submit" variant="primary" icon={Icon.send} loading={r.busy} disabled={!target || !session.trim() || !text.trim()}>
                Send
              </Button>
            </div>
            {note ? <p className="hint">{note}</p> : null}
          </form>
        ) : (
          <p className="hint">
            {status.installation?.workspaceId === ws
              ? `This machine is registered to ${status.hello ? personName(status.hello.owner) : "someone else"}; what it sends goes as them, so only they send from here.`
              : "Register this machine in this workspace to send from it."}
          </p>
        )}
        <Err error={r.error ?? dir.error} />
      </section>
      {here ? (
        <section className="card">
          <h3>Agents others can address</h3>
          <p className="hint">Listing a session puts its id and title in the workspace directory. Whether anyone may message it is still up to your grants.</p>
          <ul className="team-list">
            {(dir.data?.agents ?? []).map((a) => (
              <li key={a.id}>
                <code>
                  {names.get(a.installation_id) ?? "?"}/{a.local_session_id}
                </code>{" "}
                {a.label}
                {a.installation_id === status.installation?.id ? (
                  <Button size="sm" variant="ghost" onClick={() => void run(async () => (await api.cloudShare(a.local_session_id, false), await dir.reload()))}>
                    Unlist
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="input-row">
            <select className="input" value={share} onChange={(e) => setShare(e.target.value)}>
              <option value="">List one of this machine&apos;s sessions…</option>
              {live.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} · {s.label ?? s.title}
                </option>
              ))}
            </select>
            <Button disabled={!share} onClick={() => void run(async () => (await api.cloudShare(share, true), setShare(""), await dir.reload()))}>
              List it
            </Button>
          </div>
        </section>
      ) : null}
      <section className="card">
        <h3>Receipts</h3>
        <p className="hint">What your machines sent and got. The text is kept only until it is delivered (or the team policy&apos;s hours run out); the receipt for 30 days.</p>
        <Err error={messages.error} />
        <table className="team-table">
          <tbody>
            {(messages.data ?? []).map((m) => (
              <tr key={m.id}>
                <td className="faint">{when(m.created_at)}</td>
                <td>{m.sender_user_id === me.user.user_id ? <span>you via {names.get(m.sender_installation_id) ?? "?"}{m.sender_agent ? `/${m.sender_agent}` : ""}</span> : m.sender_label}</td>
                <td>
                  → {names.get(m.target_installation_id) ?? "?"}/{m.target_agent}
                </td>
                <td>
                  <span className={`team-msg team-msg-${m.state}`}>{m.state}</span>
                  {m.reason ? <span className="faint"> {m.reason}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {messages.data?.length === 0 ? <p className="faint">No messages yet.</p> : null}
      </section>
    </>
  );
}
