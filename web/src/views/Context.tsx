import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppState, ContextDoc, ProviderId, Repo, SkillInfo } from "../../../src/core/types";
import { api } from "../api";
import { PROVIDER_LABEL } from "../bits";
import { Button, Confirm, Empty, Icon } from "../components";
import { fmtBytes, guessHome, tildify } from "../lib/format";
import "./skills.css";
import "./context.css";

/**
 * What an agent is told before it does anything: the rules agentbox appends to
 * its system prompt, the instruction files each CLI reads for itself, and the
 * skills it can open by name. One scope at a time — every session, or one
 * repo — and every file is read and written in place.
 *
 * Nothing here is guessed: the catalogue and the write targets are the
 * server's (`src/server/context.ts`), which names files by id so the browser
 * can never ask for a path.
 */
export function Context({ state }: { state: AppState }) {
  const [docs, setDocs] = useState<ContextDoc[] | null>(null);
  const [briefing, setBriefing] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState("global");
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());

  const load = useCallback(() => {
    api.context().then(
      (r) => {
        setDocs(r.docs);
        setBriefing(r.briefing);
        setError(null);
      },
      (e: Error) =>
        setError(
          /<!doctype|no route for/i.test(e.message)
            ? "The agentbox server that is running is older than this page. Restart it, then reload, to read your context."
            : e.message,
        ),
    );
  }, []);
  useEffect(load, [load]);

  const repos = state.repos;
  const repo = scope === "global" ? null : (repos.find((r) => r.id === scope) ?? null);
  useEffect(() => {
    if (scope !== "global" && !repo) setScope("global");
  }, [scope, repo]);
  const here = repo ? repo.id : "global";
  const home = useMemo(() => guessHome(state.accounts.map((a) => a.home)), [state.accounts]);

  const rules = useMemo(() => docs?.filter((d) => d.kind === "rules" && d.scope === here) ?? [], [docs, here]);
  // A repo's session is also given the rules for every session, so they are
  // shown with it when there are any.
  const inherited = useMemo(
    () => (repo ? (docs?.filter((d) => d.kind === "rules" && d.scope === "global" && d.exists) ?? []) : []),
    [docs, repo],
  );
  const instructions = useMemo(() => {
    if (!docs) return [];
    const own = docs.filter((d) => d.kind === "instructions" && d.scope === here);
    // The global ones still apply here; only the ones actually written are
    // worth the room, since a file that does not exist tells an agent nothing.
    const everywhere = repo ? docs.filter((d) => d.kind === "instructions" && d.scope === "global" && d.exists) : [];
    return [...own, ...everywhere];
  }, [docs, here, repo]);

  // Bodies are read once per doc, for the previews.
  useEffect(() => {
    for (const doc of [...rules, ...inherited, ...instructions]) {
      if (asked.current.has(doc.id)) continue;
      asked.current.add(doc.id);
      api.contextDoc(doc.id).then(
        (r) => setBodies((b) => ({ ...b, [doc.id]: r.body })),
        () => setBodies((b) => ({ ...b, [doc.id]: "" })),
      );
    }
  }, [docs]);

  const saved = (next: ContextDoc[], id: string, body: string): void => {
    setDocs(next);
    setBodies((b) => ({ ...b, [id]: body }));
  };

  if (!docs) {
    return (
      <div className="cx">
        {error ? (
          <p className="cx-error" role="alert">
            {error}
          </p>
        ) : (
          <Empty title="Reading your context…" />
        )}
      </div>
    );
  }

  return (
    <div className="cx">
      <p className="cx-lede">What an agent is told before it starts, and where each piece comes from.</p>

      <div className="cx-scopes" role="group" aria-label="Who the context is read for">
        <span className="cx-scopes-label">Reading for</span>
        <button type="button" className={`chip ${!repo ? "on" : ""}`} aria-pressed={!repo} onClick={() => setScope("global")}>
          Every session
        </button>
        {repos.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`chip ${repo?.id === r.id ? "on" : ""}`}
            aria-pressed={repo?.id === r.id}
            onClick={() => setScope(r.id)}
            title={r.ref}
          >
            {r.displayName}
          </button>
        ))}
      </div>

      {error ? (
        <p className="cx-error" role="alert">
          {error}
        </p>
      ) : null}

      <Block title="Rules" hint={repo ? `Appended to every session in ${repo.displayName}.` : "Appended to every session's system prompt."}>
        {rules.map((doc) => (
          <DocCard key={doc.id} doc={doc} body={bodies[doc.id]} home={home} onSaved={saved} />
        ))}
        {inherited.map((doc) => (
          <DocCard key={doc.id} doc={doc} body={bodies[doc.id]} home={home} onSaved={saved} inherited />
        ))}
      </Block>

      <Block title="Instructions" hint={repo ? `The files each CLI reads in ${repo.displayName}.` : "The files each CLI reads for itself."}>
        {instructions.map((doc) => (
          <DocCard
            key={doc.id}
            doc={doc}
            body={bodies[doc.id]}
            home={home}
            onSaved={saved}
            inherited={repo !== null && doc.scope === "global"}
          />
        ))}
      </Block>

      <SkillsBlock state={state} repo={repo} />

      <Block title="From agentbox" hint="The briefing agentbox adds itself: the same for every session, and not yours to edit here.">
        <details className="cx-fixed">
          <summary>The briefing, verbatim</summary>
          <pre>{briefing}</pre>
        </details>
        <p className="cx-hint">
          Everything else a session hears — wait results, retries, recoveries, peer messages — is typed into its conversation
          when it happens, and is in its transcript. MCP servers are on the MCPs page; accounts and their environments on
          Accounts.
        </p>
      </Block>
    </div>
  );
}

function Block({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="cx-block" aria-label={title}>
      <header className="cx-block-head">
        <h2>{title}</h2>
        <p>{hint}</p>
      </header>
      <div className="cx-block-body">{children}</div>
    </section>
  );
}

/**
 * One context file: what it is, who reads it, what it says, and the editor.
 * Saving writes the file on disk; the next session started or resumed picks
 * it up, because the rules are read at launch.
 */
function DocCard({
  doc,
  body,
  home,
  onSaved,
  inherited,
}: {
  doc: ContextDoc;
  body: string | undefined;
  home: string | null;
  onSaved: (docs: ContextDoc[], id: string, body: string) => void;
  /** Shown under a repo, but read everywhere. */
  inherited?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const cap = doc.cap;
  const overCap = cap !== undefined && doc.bytes > cap;

  async function start(): Promise<void> {
    setEditing(true);
    setDraft(body ?? "");
    setNote(null);
    if (body !== undefined) return;
    try {
      const r = await api.contextDoc(doc.id);
      setDraft(r.body);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  }

  async function save(): Promise<void> {
    setBusy(true);
    try {
      const r = await api.saveContextDoc(doc.id, draft);
      onSaved(r.docs, doc.id, draft);
      setEditing(false);
      setNote(cap !== undefined && draft.length > cap ? `Saved. A session is given the first ${cap / 1024} KB.` : "Saved. The next session here reads it.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`cx-doc ${inherited ? "cx-doc-inherited" : ""}`} data-open={editing || undefined}>
      <header className="cx-doc-head">
        <span className="cx-doc-name">{doc.label}</span>
        {inherited ? <span className="cx-tag">every session</span> : null}
        <span className="cx-doc-who">
          {doc.providers.map((p) => (
            <ProviderName key={p} provider={p} />
          ))}
        </span>
        <span className="cx-doc-size">{doc.exists ? fmtBytes(doc.bytes) : "not written"}</span>
        <Button size="sm" variant="ghost" icon={Icon.edit} onClick={() => void start()}>
          {doc.exists ? "Edit" : "Write"}
        </Button>
      </header>
      <p className="cx-doc-meta">
        <span className="mono" title={doc.path}>
          {tildify(doc.path, home)}
        </span>
        <span>{doc.read}</span>
      </p>
      {overCap && cap !== undefined ? (
        <p className="cx-warn">
          Over {cap / 1024} KB: a session is given the first {cap / 1024} KB only.
        </p>
      ) : null}

      {editing ? (
        <div className="cx-edit-wrap">
          <textarea
            className="cx-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={12}
            aria-label={`${doc.label} for ${doc.scopeLabel}`}
            placeholder={doc.kind === "rules" ? "Type rules the way you would say them to an agent…" : "# Instructions\n"}
          />
          <div className="cx-actions">
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <span className="cx-hint">{doc.kind === "rules" ? "Markdown, as it will read in the system prompt." : "The CLI's own file, edited in place."}</span>
          </div>
        </div>
      ) : body === undefined ? (
        <p className="cx-hint">Reading…</p>
      ) : body.trim() === "" ? (
        <p className="cx-empty">{doc.kind === "rules" ? "No rules here yet." : "No such file yet."}</p>
      ) : (
        <pre className="cx-preview">{body}</pre>
      )}

      {note ? (
        <p className="cx-note" role="status" onClick={() => setNote(null)}>
          {note}
        </p>
      ) : null}
    </article>
  );
}

function ProviderName({ provider }: { provider: ProviderId }) {
  return <span className={`prov prov-${provider}`}>{PROVIDER_LABEL[provider]}</span>;
}

/** Every root a skill can come from, in the order they shadow each other. */
const SCOPES = ["all", "global", "agents", "codex", "omp", "project"] as const;

/** Every skill an agent can reach here, with the body in place when one is opened. */
function SkillsBlock({ state, repo }: { state: AppState; repo: Repo | null }) {
  const [source, setSource] = useState<"all" | SkillInfo["source"]>("all");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const skills = useMemo(
    () => (repo ? state.skills.filter((s) => s.source !== "project" || s.repo === repo.ref) : state.skills),
    [state.skills, repo],
  );
  const names = useMemo(() => {
    const at = new Map<string, string>();
    for (const r of state.repos) at.set(r.ref, r.displayName);
    return at;
  }, [state.repos]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return skills.filter((s) => {
      if (source !== "all" && s.source !== source) return false;
      if (!q) return true;
      return [s.name, s.description, names.get(s.repo ?? "") ?? s.repo ?? ""].some((x) => x.toLowerCase().includes(q));
    });
  }, [skills, source, filter, names]);

  const chips = SCOPES.filter((s) => s === "all" || skills.some((k) => k.source === s));

  return (
    <Block
      title="Skills"
      hint={repo ? `Skills an agent can open in ${repo.displayName}: its own, then yours.` : "Skills an agent can open by name: yours, and each repo's own."}
    >
      <div className="cx-skill-bar">
        <span className="sk-search">
          <Icon.search size={13} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter…" data-search aria-label="Filter skills" />
        </span>
        <div className="sk-chips" role="group" aria-label="Filter by scope">
          {chips.map((s) => (
            <button key={s} className={`chip ${source === s ? "on" : ""}`} aria-pressed={source === s} onClick={() => setSource(s)}>
              {s}
            </button>
          ))}
        </div>
        <span className="cx-count">
          {rows.length} of {skills.length}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="cx-empty">{skills.length === 0 ? "No skills here yet." : "None match."}</p>
      ) : (
        <ul className="sk-rows cx-skills">
          {rows.map((s) => (
            <li key={`${s.source}:${s.path}`}>
              <button
                className="sk-row"
                data-nav-item
                data-nav-id={`skill:${s.path}`}
                aria-expanded={open === s.path}
                onClick={() => setOpen(open === s.path ? null : s.path)}
              >
                <span className="sk-row-top">
                  <span className="sk-row-name">
                    /{s.name}
                    {!s.modelInvocable ? (
                      <span className="ghost" title="slash-command only — never fires on its own">
                        {" "}
                        ⌘
                      </span>
                    ) : null}
                  </span>
                  <span className={`src ${s.source}`} title={s.path}>
                    {names.get(s.repo ?? "") ?? s.source}
                  </span>
                </span>
                <span className="sk-row-desc">{s.description || <span className="ghost">no description</span>}</span>
              </button>
              {open === s.path ? <SkillPanel key={s.path} skill={s} onClose={() => setOpen(null)} /> : null}
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function SkillPanel({ skill, onClose }: { skill: SkillInfo; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [confirmDemote, setConfirmDemote] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.skillBody(skill.path).then(
      (r) => !cancelled && setBody(r.body),
      (e: Error) => {
        if (cancelled) return;
        setNote(`Could not read this skill: ${e.message}`);
        setBody("");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [skill.path]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.saveSkillBody(skill.path, draft);
      if (!r.ok) throw new Error("save failed");
      setBody(draft);
      setEditing(false);
      setNote(`Saved /${skill.name}.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const promote = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.promoteSkill(skill.name);
      setNote(r.ok ? "Copied to your global skills. The repo copy is untouched." : (r.error ?? "promote failed"));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const demote = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.demoteSkill(skill.name);
      if (!r.ok) throw new Error(r.error ?? "remove failed");
      onClose();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cx-skill-panel">
      <dl className="cx-facts">
        <div>
          <dt>scope</dt>
          <dd>{skill.source}</dd>
        </div>
        <div>
          <dt>size</dt>
          <dd>{skill.lines} lines</dd>
        </div>
        {skill.allowedTools ? (
          <div>
            <dt>tools</dt>
            <dd className="truncate" title={skill.allowedTools}>
              {skill.allowedTools}
            </dd>
          </div>
        ) : null}
        {!skill.modelInvocable ? (
          <div>
            <dt>invocation</dt>
            <dd>slash-command only</dd>
          </div>
        ) : null}
        <div className="cx-facts-path">
          <dt>path</dt>
          <dd className="mono truncate" title={skill.path}>
            {skill.path}
          </dd>
        </div>
      </dl>

      {editing ? (
        <textarea className="cx-edit" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label={`Editing ${skill.name}`} />
      ) : (
        <pre className="cx-skill-body">{body ?? "Reading…"}</pre>
      )}

      <div className="cx-actions">
        {editing ? (
          <>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
              save
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              cancel
            </Button>
            <span className="cx-hint">edits SKILL.md on disk</span>
          </>
        ) : (
          <>
            <Button
              size="sm"
              icon={Icon.edit}
              onClick={() => {
                setDraft(body ?? "");
                setEditing(true);
              }}
            >
              edit
            </Button>
            {skill.source === "project" ? (
              <Button size="sm" icon={Icon.move} loading={busy} onClick={() => void promote()} title="copy to ~/.claude/skills — the repo copy stays put">
                promote
              </Button>
            ) : null}
            {skill.source === "global" ? (
              <Button size="sm" variant="danger" icon={Icon.trash} loading={busy} onClick={() => setConfirmDemote(true)}>
                remove from global
              </Button>
            ) : null}
          </>
        )}
        {note ? (
          <span className="cx-note" role="status" onClick={() => setNote(null)}>
            {note}
          </span>
        ) : null}
      </div>

      {confirmDemote ? (
        <Confirm
          title={`Remove the global skill “${skill.name}”?`}
          confirmLabel="Remove"
          danger
          body={
            <p>
              Deletes <span className="mono">~/.claude/skills/{skill.name}</span>. Any repo copy is untouched and the skill can be promoted again.
            </p>
          }
          onConfirm={() => {
            setConfirmDemote(false);
            void demote();
          }}
          onCancel={() => setConfirmDemote(false)}
        />
      ) : null}
    </div>
  );
}
