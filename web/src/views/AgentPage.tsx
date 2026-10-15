/** A superagent's own page in its Feed: the blocks its program answers
 *  `GET /agentbox/view` with, and the buttons that post its actions
 *  (docs/superagents.md, Its page). Agentbox draws them; the program decides them. */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, type SuperagentActionReply } from "../api";
import type { SuperagentAction, SuperagentBlock, SuperagentField, SuperagentInfo, SuperagentView } from "../../../src/core/types";
import { Button, Empty, Icon } from "../components";
import { hrefOf } from "../route";
import { Markdown } from "./session/Markdown";

/** One tab of its page (`null`: the first), asked again as often as the page says. */
export function usePage(info: SuperagentInfo, tab: string | null) {
  const [view, setView] = useState<SuperagentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const running = info.hasPage && info.enabled && (!info.process || info.process.state === "running");
  useEffect(() => {
    if (!running) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api.superagentView(info.name, tab).then(
        (v) => {
          if (!live) return;
          setView(v);
          setError(null);
          timer = setTimeout(load, Math.max(2, v?.refresh ?? 15) * 1000);
        },
        (e: Error) => {
          if (!live) return;
          setError(e.message);
          timer = setTimeout(load, 15_000);
        },
      );
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [info.name, tab, running, n]);
  return { view, setView, error, running, reload: () => setN((x) => x + 1) };
}

export type Page = ReturnType<typeof usePage>;

/** The sum of its page's numeric tab badges: the Feed tab's own badge. */
export function feedBadge(view: SuperagentView | null): number {
  return (view?.tabs ?? []).reduce((n, t) => n + (typeof t.badge === "number" ? t.badge : /^\d+$/.test(String(t.badge ?? "")) ? Number(t.badge) : 0), 0);
}

export function PagePanel({ info, page, tab, onCompose }: { info: SuperagentInfo; page: Page; tab: string | null; onCompose: (text: string) => void }) {
  const { view, setView, error, running, reload } = page;
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const act = async (a: SuperagentAction, values: Record<string, unknown>) => {
    if (a.confirm && !confirm(a.confirm)) return;
    setMessage(null);
    try {
      const reply: SuperagentActionReply = (await api.superagentAction(info.name, { action: a.id, values: { ...a.values, ...values }, tab })) ?? {};
      if (reply.view) setView(reply.view);
      else reload();
      if (reply.message) setMessage({ text: reply.message, bad: false });
      if (reply.compose) onCompose(reply.compose);
      if (reply.open) location.hash = reply.open.replace(/^#?/, "#");
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  };
  if (!running)
    return (
      <Empty title={info.enabled ? "Its program is not running" : `${info.title} is disabled`}>
        <p>Settings shows its program's state and the end of its output.</p>
      </Empty>
    );
  if (error && !view) return <p className="ag-note bad">Its page did not load: {error}</p>;
  if (!view) return <Empty title="Loading…" />;
  return (
    <div className="ag-page">
      {view.title ? <h3 className="ag-page-title">{view.title}</h3> : null}
      {message ? (
        <p className={`ag-note ${message.bad ? "bad" : "ok"}`} role={message.bad ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      {error ? <p className="ag-note bad">The last refresh failed: {error}</p> : null}
      <Blocks blocks={view.blocks} act={act} />
    </div>
  );
}

export type Act = (a: SuperagentAction, values: Record<string, unknown>) => Promise<void>;

/** False on a teammate's page of a shared superagent: its sessions and its
 *  `#…` links belong to its host, so they show as text, not as links. */
export const LocalLinks = createContext(true);

export function Blocks({ blocks, act }: { blocks: SuperagentBlock[]; act: Act }) {
  return (
    <>
      {(blocks ?? []).map((b, i) => (
        <BlockView key={("id" in b && b.id) || i} block={b} act={act} />
      ))}
    </>
  );
}

function BlockView({ block: b, act }: { block: SuperagentBlock; act: Act }) {
  const local = useContext(LocalLinks);
  switch (b.type) {
    case "heading":
      return <h4 className="ag-h">{b.text}</h4>;
    case "markdown":
      return (
        <div className="ag-md">
          <Markdown text={b.text} />
        </div>
      );
    case "divider":
      return <hr className="ag-hr" />;
    case "fields":
      return (
        <dl className="ag-fields">
          {b.items.map((f, i) => (
            <div key={i}>
              <dt>{f.label}</dt>
              <dd>
                <Markdown text={f.value} inline />
              </dd>
            </div>
          ))}
        </dl>
      );
    case "actions":
      return <Actions actions={b.actions} act={act} values={() => ({})} />;
    case "form":
      return <FormBlock form={b} act={act} />;
    case "item":
      return (
        <article className={`ag-item ${b.status ?? ""}`}>
          <header>
            {b.status ? <span className={`ag-dot ${b.status}`} aria-label={b.status} /> : null}
            <span className="ag-item-title">{b.title}</span>
            {b.subtitle ? <span className="ag-item-sub">{b.subtitle}</span> : null}
          </header>
          {b.body ? (
            <div className="ag-md">
              <Markdown text={b.body} />
            </div>
          ) : null}
          {b.sessions?.length || b.links?.length ? (
            <div className="ag-item-links">
              {b.sessions?.map((id) =>
                local ? (
                  <a key={id} href={hrefOf({ page: "session", id, tab: "timeline" })}>
                    <Icon.terminal size={12} /> {id}
                  </a>
                ) : (
                  <span key={id} className="hint" title="A session on its host. A teammate cannot open it.">
                    <Icon.terminal size={12} /> {id}
                  </span>
                ),
              )}
              {b.links?.map((l, i) =>
                /^https?:/.test(l.url) || (local && l.url.startsWith("#")) ? (
                  <a key={i} href={l.url} target={l.url.startsWith("#") ? undefined : "_blank"} rel="noreferrer">
                    {l.url.startsWith("#") ? null : <Icon.external size={12} />} {l.label}
                  </a>
                ) : null,
              )}
            </div>
          ) : null}
          {b.children?.length ? (
            <div className="ag-item-children">
              <Blocks blocks={b.children} act={act} />
            </div>
          ) : null}
          {b.actions?.length ? <Actions actions={b.actions} act={act} values={() => ({})} /> : null}
        </article>
      );
    default:
      return null;
  }
}

function Actions({ actions, act, values }: { actions: SuperagentAction[]; act: Act; values: () => Record<string, unknown> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="ag-actions">
      {actions.map((a) => (
        <Button
          key={a.id}
          size="sm"
          type="button"
          variant={a.style === "primary" ? "primary" : a.style === "danger" ? "danger" : "default"}
          loading={busy === a.id}
          disabled={!!busy}
          onClick={async () => {
            setBusy(a.id);
            try {
              await act(a, values());
            } finally {
              setBusy(null);
            }
          }}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}

function FormBlock({ form, act }: { form: Extract<SuperagentBlock, { type: "form" }>; act: Act }) {
  const initial = () => Object.fromEntries(form.fields.map((f) => [f.name, f.value ?? (f.kind === "checkbox" ? false : "")]));
  const [values, setValues] = useState<Record<string, unknown>>(initial);
  // A page that changed what the form holds (after an action) shows it; what you are typing is kept otherwise.
  const shape = JSON.stringify(form.fields.map((f) => [f.name, f.value]));
  const last = useRef(shape);
  useEffect(() => {
    if (last.current !== shape) {
      last.current = shape;
      setValues(initial());
    }
  }, [shape]);
  const set = (name: string, v: unknown) => setValues((x) => ({ ...x, [name]: v }));
  return (
    <form className="ag-form" onSubmit={(e) => e.preventDefault()}>
      {form.fields.map((f) => (
        <FieldView key={f.name} form={form.id} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
      ))}
      <Actions actions={form.actions} act={act} values={() => values} />
    </form>
  );
}

function FieldView({ form, field: f, value, onChange }: { form: string; field: SuperagentField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `ag-f-${form}-${f.name}`;
  if (f.kind === "checkbox")
    return (
      <label className="ag-check">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {f.label}
      </label>
    );
  return (
    <label className="ag-field" htmlFor={id}>
      <span>{f.label}</span>
      {f.kind === "textarea" ? (
        <textarea id={id} rows={f.rows ?? 5} value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : f.kind === "select" ? (
        <select id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} value={String(value ?? "")} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
