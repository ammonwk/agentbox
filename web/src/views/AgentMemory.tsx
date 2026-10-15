import { useEffect, useState } from "react";
import type { SuperagentInfo } from "../../../src/core/types";
import type { MemoryView } from "../../../src/core/superagent/memory-view";
import type { Handoff, Note } from "../../../src/core/superagent/memory";
import type { Checkpoint } from "../../../src/core/superagent/state";
import { api } from "../api";
import { Button } from "../components";
import { useLoad } from "../lib/cloud";
import { hrefOf } from "../route";

const when = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const checkpointWords: Record<Checkpoint["state"], string> = {
  requested: "Handoff requested",
  saved: "Handoff saved",
  failed: "Handoff not saved",
};

/** Settings → Memory for a superagent whose manifest says `"memory": true`:
 *  what a fresh main conversation starts from (`MemoryView`,
 *  src/core/superagent/memory-view.ts). The handoffs are summaries; each
 *  links its source conversation. A person sets and forgets preferences;
 *  its main conversation and its program write the rest. */
export function AgentMemory({ info }: { info: SuperagentInfo }) {
  const [query, setQuery] = useState(""),
    [searched, setSearched] = useState(""),
    [error, setError] = useState<string | null>(null);
  const memory = useLoad(() => api.superagentMemory(info.name, searched), [info.name, searched]);
  // The main writes handoffs and notes while you look.
  useEffect(() => {
    const t = setInterval(() => void memory.reload(), 15_000);
    return () => clearInterval(t);
  }, [memory.reload]);
  const prefer = (key: string, text: string) =>
    api
      .superagentPrefer(info.name, key, text)
      .then(() => {
        setError(null);
        return memory.reload();
      })
      .catch((e) => setError((e as Error).message));
  const thread = (session: string) => hrefOf({ page: "agents", id: info.name, view: "chat", thread: session });
  const m: MemoryView | null = memory.data, c = m?.checkpoint;
  const rollover = info.rollover;
  return (
    <section className="agent-memory" aria-labelledby="agent-memory-title">
      <h3 id="agent-memory-title">Memory</h3>
      <p className="hint">
        {rollover
          ? `Continues the current conversation while its cache is warm. After ${rollover.idleMin} idle minutes it saves a handoff of at most 500 words; a later message after the cache goes cold, or past ${rollover.contextPct}% context, starts a fresh conversation from it.`
          : "Rollover is off: every message continues the current conversation. Its manifest's main.rollover turns it on."}
      </p>
      {c && (
        <p className="agent-memory-state" role="status">
          {checkpointWords[c.state]} · {when(c.at)} · {c.reason === "idle" ? "idle" : `${c.pct}% context`}
          {c.error ? ` · ${c.error}` : ""}
        </p>
      )}
      {m?.supplied.length ? (
        <p className="hint">
          The current conversation started from {m.supplied.length === 1 ? "the handoff" : `${m.supplied.length} handoffs`} of{" "}
          {m.supplied.map((s, i) => (
            <span key={s.handoff}>
              {i ? ", " : null}
              <a href={thread(s.session)}>{when(s.at)}</a>
            </span>
          ))}
          .
        </p>
      ) : null}
      {(error || memory.error) && (
        <p className="error" role="alert">
          {error ?? memory.error}
        </p>
      )}
      {m && <AgentFilesPanel files={m.files} />}
      <h4>Preferences</h4>
      {m?.preferences.length ? (
        <ul className="agent-memory-list">
          {m.preferences.map((p) => (
            <li key={p.id}>
              <span>
                <b>{p.key}</b> {(p.body as { text: string }).text}
              </span>
              <Button variant="ghost" onClick={() => void prefer(p.key!, "")}>
                Forget
              </Button>
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
          const form = e.currentTarget,
            data = new FormData(form);
          void prefer(String(data.get("key")), String(data.get("text"))).then(() => form.reset());
        }}
      >
        <input className="input" name="key" placeholder="key, e.g. review-style" aria-label="Preference key" required pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,59}" />
        <input className="input" name="text" placeholder="What the agent must remember" aria-label="Preference" required maxLength={1500} />
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
          {m?.results?.length ? (
            m.results.map((r) => (
              <li key={r.id}>
                <span>
                  {r.kind} · {when(r.at)} · {r.summary}
                </span>
                <a href={thread(r.session)}>Conversation</a>
              </li>
            ))
          ) : (
            <li className="hint">Nothing matches “{searched}”.</li>
          )}
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
              {body.decisions.length > 0 && (
                <>
                  <b>Decisions</b>
                  <ul>
                    {body.decisions.map((d, i) => (
                      <li key={i}>
                        {d.decision}
                        {d.why && <em> — {d.why}</em>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {body.open.length > 0 && (
                <>
                  <b>Open questions</b>
                  <ul>
                    {body.open.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
              {body.commitments.length > 0 && (
                <>
                  <b>Commitments</b>
                  <ul>
                    {body.commitments.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </>
              )}
              {body.refs.length > 0 && (
                <>
                  <b>References</b>
                  <ul>
                    {body.refs.map((r, i) => (
                      <li key={i}>
                        {r.label}: {r.ref}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="hint">
                From <a href={thread(h.session)}>its conversation</a>
                {h.usedBy && (
                  <>
                    {" "}
                    · continued in <a href={thread(h.usedBy)}>a fresh conversation</a>
                  </>
                )}
              </p>
            </details>
          );
        })
      ) : (
        <p className="hint">No handoff yet. {rollover ? "One is saved the first time the conversation goes idle." : "Its main conversation or its program writes one."}</p>
      )}
      {m?.notes.length ? (
        <>
          <h4>Recorded decisions</h4>
          <ul className="agent-memory-list">
            {m.notes.map((n) => (
              <li key={n.id}>
                <span>
                  {when(n.at)} · {(n.body as Note).decision}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** SOUL.md (yours to edit; agentbox never writes it) and MEMORY.md (rebuilt
 *  from the journal), with anything a fresh conversation does not use. */
function AgentFilesPanel({ files: f }: { files: MemoryView["files"] }) {
  return (
    <>
      <h4>Files</h4>
      <ul className="agent-memory-list">
        <li>
          <span>
            <b>SOUL.md</b> Persona, voice and boundaries. You edit it; a fresh conversation reads it after MAIN.md. It gives no authority.
            <br />
            <code>{f.soul.path}</code>
            {f.soul.hash ? ` · ${f.soul.chars.toLocaleString()} characters` : " · not there"}
            {f.soul.notes.map((n) => (
              <span key={n} className="error">
                <br />
                {n}
              </span>
            ))}
          </span>
        </li>
        <li>
          <span>
            <b>MEMORY.md</b> A read-only view of this memory, rebuilt after each change. Change memory here, not in the file.
            <br />
            <code>{f.memory.path}</code>
            {f.memory.setAside && (
              <span className="error">
                <br />
                An edit was set aside, unused, on {when(f.memory.setAside.at)}: <code>{f.memory.setAside.path}</code>
              </span>
            )}
          </span>
        </li>
      </ul>
    </>
  );
}
