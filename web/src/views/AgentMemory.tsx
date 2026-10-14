import { useState } from "react";
import type { Handoff, MemoryPolicy, MemoryRecord, Note } from "../../../src/core/agents/memory";
import type { Checkpoint, LocalAgent } from "../../../src/core/agents/conversation";
import { request } from "../api";
import { Button } from "../components";
import { useLoad } from "../lib/cloud";
import { hrefOf } from "../route";

type View = {
  policy: MemoryPolicy;
  checkpoint: Checkpoint | null;
  preferences: MemoryRecord[];
  handoffs: MemoryRecord[];
  notes: MemoryRecord[];
  results: { id: string; kind: string; at: number; session: string; summary: string }[];
};
const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const checkpointWords: Record<Checkpoint["state"], string> = {
  requested: "Handoff requested",
  saved: "Handoff saved",
  failed: "Handoff not saved",
};

/** About → Memory for a local agent: what a fresh conversation starts from.
 *  The handoffs are summaries; each links its source conversation. */
export function AgentMemory({ agent }: { agent: LocalAgent }) {
  const [query, setQuery] = useState(""),
    [searched, setSearched] = useState(""),
    [error, setError] = useState<string | null>(null);
  const memory = useLoad(
    () => request<View>("GET", `/api/agents/${encodeURIComponent(agent.id)}/memory?q=${encodeURIComponent(searched)}`),
    [agent.id, searched],
  );
  const prefer = (key: string, text: string) =>
    request("POST", `/api/agents/${encodeURIComponent(agent.id)}/memory/prefer`, { body: { key, text } })
      .then(() => { setError(null); return memory.reload(); })
      .catch((e) => setError((e as Error).message));
  const thread = (session: string) => hrefOf({ page: "agents", id: agent.id, view: "chat", thread: session });
  const m = memory.data, c = m?.checkpoint;
  const rolled = Object.keys(agent.rolled ?? {}).length;
  return (
    <section className="agent-memory" aria-labelledby="agent-memory-title">
      <h3 id="agent-memory-title">Memory</h3>
      <p className="hint">
        {m?.policy.rollover === false
          ? "Rollover is off: every message continues the current conversation."
          : `Continues the current conversation while its cache is warm. After ${m?.policy.idleMin ?? 10} idle minutes it saves a handoff of at most 500 words; a later message after the cache goes cold, or past ${m?.policy.contextPct ?? 60}% context, starts a fresh conversation from it.`}
        {rolled > 0 && ` ${rolled} earlier conversation${rolled === 1 ? "" : "s"} continued this way.`}
      </p>
      {c && (
        <p className="agent-memory-state" role="status">
          {checkpointWords[c.state]} · {when(c.at)} · {c.reason === "idle" ? "idle" : `${c.pct}% context`}
          {c.error ? ` · ${c.error}` : ""}
        </p>
      )}
      {(error || memory.error) && <p className="error" role="alert">{error ?? memory.error}</p>}
      <h4>Preferences</h4>
      {m?.preferences.length ? (
        <ul className="agent-memory-list">
          {m.preferences.map((p) => (
            <li key={p.id}>
              <span><b>{p.key}</b> {(p.body as { text: string }).text}</span>
              <Button variant="ghost" onClick={() => void prefer(p.key!, "")}>Forget</Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No durable preferences yet.</p>
      )}
      <form
        className="agent-memory-add"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget, data = new FormData(form);
          void prefer(String(data.get("key")), String(data.get("text"))).then(() => form.reset());
        }}
      >
        <input className="input" name="key" placeholder="key, e.g. review-style" aria-label="Preference key" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,59}" />
        <input className="input" name="text" placeholder="What the agent should remember" aria-label="Preference" required maxLength={400} />
        <Button type="submit">Add</Button>
      </form>
      <h4>Handoffs</h4>
      <form
        className="agent-memory-add"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearched(query);
        }}
      >
        <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search handoffs and decisions" aria-label="Search memory" />
        <Button type="submit">Search</Button>
      </form>
      {searched && (
        <ul className="agent-memory-list">
          {m?.results.length ? m.results.map((r) => (
            <li key={r.id}>
              <span>{r.kind} · {when(r.at)} · {r.summary}</span>
              <a href={thread(r.session)}>Conversation</a>
            </li>
          )) : <li className="hint">Nothing matches “{searched}”.</li>}
        </ul>
      )}
      {m?.handoffs.length ? (
        m.handoffs.map((h) => {
          const body = h.body as Handoff;
          return (
            <details key={h.id} className="agent-memory-handoff">
              <summary>
                <span>{when(h.at)}</span> {body.intent}
              </summary>
              {body.decisions.length > 0 && <><b>Decisions</b><ul>{body.decisions.map((d, i) => <li key={i}>{d.decision}{d.why && <em> — {d.why}</em>}</li>)}</ul></>}
              {body.open.length > 0 && <><b>Open questions</b><ul>{body.open.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
              {body.commitments.length > 0 && <><b>Commitments</b><ul>{body.commitments.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
              {body.refs.length > 0 && <><b>References</b><ul>{body.refs.map((r, i) => <li key={i}>{r.label}: {r.ref}</li>)}</ul></>}
              <p className="hint">
                From <a href={thread(h.session)}>its conversation</a>
                {h.usedBy && <> · continued in <a href={thread(h.usedBy)}>a fresh conversation</a></>}
              </p>
            </details>
          );
        })
      ) : (
        <p className="hint">No handoff yet. One is saved the first time the conversation goes idle.</p>
      )}
      {m?.notes.length ? (
        <>
          <h4>Recorded decisions</h4>
          <ul className="agent-memory-list">
            {m.notes.map((n) => (
              <li key={n.id}>
                <span>{when(n.at)} · {(n.body as Note).decision}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
