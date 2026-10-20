/** Team › Members and Team › Nodes on a hub, and the hub link on a node
 *  (docs/hub.md). Nothing at all on a machine that is neither. Every member
 *  edits the members and approves nodes. */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { HubMember, HubNodeView, HubStatus, Lend } from "../../../src/core/types";
import { api } from "../api";
import { Button, Field, RelativeTime, Toggle } from "../components";

/** `fn`'s answer, loaded again when `deps` change or on `reload`. */
function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(fn);
  ref.current = fn;
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await ref.current();
      if (mine === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload };
}

const POLL_MS = 5_000;

function useRun(): [(fn: () => Promise<unknown>) => void, { busy: boolean; error: string | null }] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    fn().then(
      () => setBusy(false),
      (e: unknown) => {
        setError((e as Error).message);
        setBusy(false);
      },
    );
  };
  return [run, { busy, error }];
}

const Err = ({ error }: { error: string | null }) => (error ? <p className="error" role="alert">{error}</p> : null);

export function HubTeam() {
  const hub = useLoad(() => api.hub(), []);
  useEffect(() => {
    const t = setInterval(() => void hub.reload(), POLL_MS);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = hub.data;
  if (!s || s.role === "none") return null;
  return (
    <div className="team">
      {s.error ? <p className="error">{s.error}</p> : null}
      {s.role === "hub" ? (
        <>
          <Members status={s} reload={hub.reload} />
          <Nodes status={s} reload={hub.reload} />
        </>
      ) : (
        <Link status={s} reload={hub.reload} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- members

function Members({ status, reload }: { status: HubStatus; reload: () => Promise<void> }) {
  // Everyone admitted may do everything here (docs/hub.md, Trust model).
  const owner = status.person.role !== null;
  const members = status.members ?? [];
  const [login, setLogin] = useState("");
  const [run, r] = useRun();
  const save = (next: HubMember[]) => run(async () => (await api.hubMembers(next), await reload()));
  const add = (e: FormEvent) => {
    e.preventDefault();
    const l = login.trim().toLowerCase();
    if (!l) return;
    save([...members.filter((m) => m.login !== l), { login: l, role: "member" }]);
    setLogin("");
  };
  return (
    <section className="card">
      <h3>Members</h3>
      <p className="hint">
        The people who may open this hub: by their tailnet login from their own (untagged) devices, or by their email at its public address. Every member
        can do everything here, this list included, and runs commands as this machine&apos;s user through the sessions they start. You are {status.person.name}.
      </p>
      <table className="team-table">
        <tbody>
          {members.map((m) => (
            <tr key={m.login}>
              <td>{m.login}</td>
              <td className="faint">{m.name ?? ""}</td>
              <td>{m.role}</td>
              <td className="team-actions">
                {owner && m.role !== "owner" ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={r.busy}
                      onClick={() => save(members.map((x) => ({ ...x, role: x.login === m.login ? "owner" : "member" })))}
                    >
                      Make owner
                    </Button>
                    <Button size="sm" variant="ghost" disabled={r.busy} onClick={() => save(members.filter((x) => x.login !== m.login))}>
                      Remove
                    </Button>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {owner ? (
        <form className="input-row" onSubmit={add}>
          <input className="input" placeholder="teammate@example.com (what they sign in with)" value={login} onChange={(e) => setLogin(e.target.value)} />
          <Button type="submit" loading={r.busy}>
            Add member
          </Button>
        </form>
      ) : null}
      <Err error={r.error} />
    </section>
  );
}

// ------------------------------------------------------------------ nodes

function lendText(l: Lend | null): string {
  if (!l) return "not heard from yet";
  const accounts = l.accounts === "all" ? "every account" : l.accounts.length ? `${l.accounts.length} account${l.accounts.length === 1 ? "" : "s"}` : "no account";
  return `${accounts}; starts ${l.acceptStarts ? "on" : "off"}${l.maxSessions === null ? "" : `, at most ${l.maxSessions}`}`;
}

/** Each lent account's use, where the node has a reading of it. */
function headroomText(h: NonNullable<HubNodeView["headroom"]>): string {
  if (h.length === 0) return "no lent account";
  const known = h.filter((a) => a.short !== null || a.weekly !== null);
  if (known.length === 0) return `${h.length} lent account${h.length === 1 ? "" : "s"}, usage not read yet`;
  const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v)}%`);
  return known.map((a) => `${a.label}: ${pct(a.short)} short, ${pct(a.weekly)} week${a.eligible ? "" : " (full)"}`).join(" · ");
}

function Nodes({ status, reload }: { status: HubStatus; reload: () => Promise<void> }) {
  const owner = status.person.role !== null;
  const nodes = status.nodes ?? [];
  const [run, r] = useRun();
  return (
    <section className="card">
      <h3>Nodes</h3>
      <p className="hint">
        Machines that joined this hub with <code>agentbox hub join {status.self?.name ?? "<this hub>"}</code>. Their sessions show on the board with the node&apos;s
        name, and stay there, marked away, while a node cannot be reached. Each node&apos;s owner sets what it lends.
      </p>
      {nodes.length === 0 ? <p className="hint">No node has asked to join yet.</p> : null}
      <table className="team-table">
        <tbody>
          {nodes.map((n) => (
            <NodeRow key={n.id} n={n} owner={owner} busy={r.busy} act={(fn) => run(async () => (await fn(), await reload()))} />
          ))}
        </tbody>
      </table>
      <Err error={r.error} />
    </section>
  );
}

function NodeRow({ n, owner, busy, act }: { n: HubNodeView; owner: boolean; busy: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const who = n.login ?? (n.tags.join(", ") || "untagged");
  return (
    <tr>
      <td>
        <strong>{n.name}</strong>
        <div className="faint">
          {n.device ?? n.ip} · {who}
        </div>
      </td>
      <td>
        {n.approvedAt === null ? (
          <span className="team-state">waiting for approval</span>
        ) : n.reachable ? (
          <span className="team-state team-state-connected">reachable</span>
        ) : (
          <span className="team-state team-state-offline" title={n.error ?? undefined}>
            away{n.lastSeen ? <> · last seen <RelativeTime ts={n.lastSeen} short /></> : null}
          </span>
        )}
        {n.approvedAt !== null ? <div className="faint">{n.sessions} session{n.sessions === 1 ? "" : "s"}</div> : null}
      </td>
      <td>
        <div>{lendText(n.lend)}</div>
        {n.headroom ? (
          <div className="faint">{headroomText(n.headroom)}</div>
        ) : n.lend ? (
          <div className="faint">headroom not shared</div>
        ) : null}
      </td>
      <td className="team-actions">
        {owner && n.approvedAt === null ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => act(() => api.hubApprove(n.id))}>
            Approve
          </Button>
        ) : null}
        {owner ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api.hubRemove(n.id))}>
            {n.approvedAt === null ? "Decline" : "Remove"}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

// ------------------------------------------------------------------- node

function Link({ status, reload }: { status: HubStatus; reload: () => Promise<void> }) {
  const link = status.link!;
  const [max, setMax] = useState(link.lend.maxSessions === null ? "" : String(link.lend.maxSessions));
  const [accounts, setAccounts] = useState(link.lend.accounts === "all" ? "" : link.lend.accounts.join(", "));
  const [run, r] = useRun();
  const lend = (patch: Partial<Lend>) => run(async () => (await api.hubLend(patch), await reload()));
  return (
    <section className="card">
      <h3>Hub</h3>
      <p className="hint">
        This machine is <strong>{link.name}</strong>, a node of <strong>{link.hub.name}</strong> ({link.hub.url}). Its sessions stay here; the hub shows the ones on
        the accounts it lends and passes its members&apos; requests for them through to this machine.{" "}
        {link.lastHubAt ? (
          <>
            The hub last asked <RelativeTime ts={link.lastHubAt} short />.
          </>
        ) : (
          "The hub has not asked anything since this server started: its owner may not have approved this node yet."
        )}{" "}
        <code>agentbox hub leave</code> ends the link.
      </p>
      <div className="team-toggles">
        <Toggle checked={link.lend.shareHeadroom} onChange={(v) => lend({ shareHeadroom: v })} label="Show the lent accounts' usage on the hub" disabled={r.busy} />
        <Toggle checked={link.lend.acceptStarts} onChange={(v) => lend({ acceptStarts: v })} label="Let the hub start sessions here (from phase 2)" disabled={r.busy} />
      </div>
      <form
        className="team-grid"
        onSubmit={(e) => {
          e.preventDefault();
          const list = accounts.split(",").map((a) => a.trim()).filter(Boolean);
          lend({ maxSessions: max.trim() === "" ? null : Number(max), accounts: list.length ? list : "all" });
        }}
      >
        <Field label="Accounts it lends" hint="Account ids, comma-separated; empty for every account. Only sessions on these are shared.">
          <input className="input mono" value={accounts} onChange={(e) => setAccounts(e.target.value)} placeholder="all" />
        </Field>
        <Field label="Most sessions the hub may start" hint="Empty for no limit.">
          <input className="input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} placeholder="no limit" />
        </Field>
        <Button type="submit" loading={r.busy}>
          Save
        </Button>
      </form>
      <Err error={r.error} />
    </section>
  );
}
