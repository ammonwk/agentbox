/**
 * A block page: one way for an extension to draw its page without writing
 * HTML (docs/extensions.md). It is a page of the app's own build, not part
 * of the app: an extension's program points its frame here with
 * `/blocks.html?src=/x/<name>`, answers `GET <src>/view?tab=` with blocks
 * and `POST <src>/action` with what an action did, and this draws them in the
 * app's look, on a phone too. Agentbox itself knows nothing of blocks.
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Empty, Icon } from "../components";
import { copyText } from "../bits";
import { useIsNarrow } from "../views/session/useIsNarrow";
import type { Action, ActionReply, Block, Field, View } from "./types";
import "../styles.css";
import "./blocks.css";

/** Where the program answers: an extension's prefix, never another site. */
const SRC = (() => {
  const s = new URLSearchParams(location.search).get("src") ?? "";
  return /^\/x\/[a-z][a-z0-9-]*$/.test(s) ? s : null;
})();

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SRC}${path}`, {
    method,
    headers: body === undefined ? { "x-agentbox": "1" } : { "content-type": "application/json", "x-agentbox": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let out: unknown = null;
  try {
    out = text.trim() ? JSON.parse(text) : null;
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const o = out as { error?: string; message?: string } | null;
    throw new Error(o?.error ?? o?.message ?? `HTTP ${res.status}`);
  }
  // agentbox's own refusals (the extension is not running) come wrapped.
  const env = out as { ok?: boolean; data?: unknown } | null;
  return (env && typeof env === "object" && "ok" in env && "data" in env ? env.data : out) as T;
}

/** An app link (`#/session/<id>`) opens in the app around this frame. */
function openInApp(hash: string) {
  const to = hash.replace(/^#?/, "#");
  if (window.top && window.top !== window) window.top.location.hash = to;
  else location.href = `/${to}`;
}

const tabOfHash = () => new URLSearchParams(location.hash.slice(1)).get("tab");

function Page() {
  const [tab, setTab] = useState<string | null>(tabOfHash);
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setTab(tabOfHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      call<View | null>("GET", `/view${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`).then(
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
  }, [tab, n]);
  const act: Act = async (a, values) => {
    if (a.confirm && !confirm(a.confirm)) return;
    setMessage(null);
    try {
      const reply = (await call<ActionReply | null>("POST", "/action", { action: a.id, values: { ...a.values, ...values }, tab })) ?? {};
      if (reply.view) setView(reply.view);
      else setN((x) => x + 1);
      if (reply.message) setMessage({ text: reply.message, bad: false });
      if (reply.open) openInApp(reply.open);
    } catch (e) {
      setMessage({ text: (e as Error).message, bad: true });
    }
  };
  if (!SRC) return <Empty title="No page to show">This page draws an extension's blocks: open it as /blocks.html?src=/x/&lt;name&gt;.</Empty>;
  const tabs = view?.tabs ?? [];
  const here = tab ?? tabs[0]?.id ?? null;
  return (
    <div className="ag-page">
      {tabs.length ? (
        <nav className="ag-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === here}
              onClick={() => {
                location.hash = `tab=${encodeURIComponent(t.id)}`;
              }}
            >
              {t.title}
              {t.badge != null && t.badge !== "" ? <span className="ag-badge">{t.badge}</span> : null}
            </button>
          ))}
        </nav>
      ) : null}
      {error && !view ? (
        <p className="ag-note bad">The page did not load: {error}</p>
      ) : !view ? (
        <Empty title="Loading…" />
      ) : (
        <>
          {view.title ? <h3 className="ag-page-title">{view.title}</h3> : null}
          {message ? (
            <p className={`ag-note ${message.bad ? "bad" : "ok"}`} role={message.bad ? "alert" : "status"}>
              {message.text}
            </p>
          ) : null}
          {error ? <p className="ag-note bad">The last refresh failed: {error}</p> : null}
          <Blocks blocks={view.blocks} act={act} />
        </>
      )}
    </div>
  );
}

/** Markdown, with app links (`#/…`) opening in the app and the rest in a new tab. */
function Markdown({ text, inline }: { text: string; inline?: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) =>
          href?.startsWith("#") ? (
            <a href={href} onClick={(e) => (e.preventDefault(), openInApp(href))}>
              {children}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        ...(inline ? { p: ({ children }) => <>{children}</> } : {}),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

type Act = (a: Action, values: Record<string, unknown>) => Promise<void>;

function Blocks({ blocks, act }: { blocks: Block[]; act: Act }) {
  return (
    <>
      {(blocks ?? []).map((b, i) => (
        <BlockView key={("id" in b && b.id) || i} block={b} act={act} />
      ))}
    </>
  );
}

function BlockView({ block: b, act }: { block: Block; act: Act }) {
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
    case "text":
      return <TextBlock block={b} />;
    case "split":
      return <SplitBlock block={b} act={act} />;
    case "switch":
      return <SwitchBlock block={b} act={act} />;
    case "item":
      return <ItemBlock block={b} act={act} />;
    default:
      return null;
  }
}

/** A choice the browser keeps for a block across refreshes and tab changes: by the block's id, for this tab's life. */
function useKept<T extends string | boolean>(id: string | undefined, initial: T): [T, (v: T) => void] {
  const key = id ? `agentbox.block.${SRC}.${id}` : null;
  const [v, setV] = useState<T>(() => {
    const got = key ? sessionStorage.getItem(key) : null;
    return got === null ? initial : ((typeof initial === "boolean" ? got === "true" : got) as T);
  });
  return [
    v,
    (next: T) => {
      setV(next);
      if (key) sessionStorage.setItem(key, String(next));
    },
  ];
}

function TextBlock({ block: b }: { block: Extract<Block, { type: "text" }> }) {
  const [wrap, setWrap] = useState(b.wrap ?? true);
  const [copied, setCopied] = useState(false);
  const lines = b.text ? b.text.split("\n").length : 0;
  return (
    <figure className="ag-text">
      <figcaption>
        <span className="ag-text-title">{b.title ?? ""}</span>
        <span className="ag-text-size">
          {lines.toLocaleString()} line{lines === 1 ? "" : "s"} · {b.text.length.toLocaleString()} chars
        </span>
        <button type="button" className="ag-text-btn" aria-pressed={wrap} onClick={() => setWrap(!wrap)} title="Wrap long lines">
          wrap
        </button>
        <button
          type="button"
          className="ag-text-btn"
          onClick={() => void copyText(b.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
          title="Copy all of it"
        >
          {copied ? <Icon.check size={12} /> : <Icon.copy size={12} />}
        </button>
      </figcaption>
      <pre className={wrap ? "wrap" : undefined} style={{ maxHeight: b.maxHeight ?? 480 }} tabIndex={0}>
        {b.text}
      </pre>
    </figure>
  );
}

function SplitBlock({ block: b, act }: { block: Extract<Block, { type: "split" }>; act: Act }) {
  const narrow = useIsNarrow();
  const [chosen, choose] = useKept<string>(b.id, b.selected ?? b.items[0]?.id ?? "");
  // On a phone the list comes first; choosing opens the pane, and back returns to the list.
  const [open, setOpen] = useState(false);
  const item = b.items.find((x) => x.id === chosen) ?? b.items[0];
  if (!item) return null;
  const showList = !narrow || !open;
  const showPane = !narrow || open;
  return (
    <section className="ag-split" data-panes={narrow ? "one" : "two"}>
      {showList ? (
        <nav className="ag-split-list" aria-label={b.title ?? "Entries"}>
          {b.title ? <h4 className="ag-split-head">{b.title}</h4> : null}
          <ul>
            {b.items.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  className="ag-split-row"
                  aria-current={x.id === item.id}
                  onClick={() => {
                    choose(x.id);
                    setOpen(true);
                  }}
                >
                  <span className="ag-split-top">
                    {x.status ? <span className={`ag-dot ${x.status}`} aria-label={x.status} /> : null}
                    <span className="ag-split-name">{x.title}</span>
                    {x.badge != null && x.badge !== "" ? <span className="ag-split-badge">{x.badge}</span> : null}
                  </span>
                  {x.subtitle ? <span className="ag-split-sub">{x.subtitle}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {showPane ? (
        <div className="ag-split-pane" aria-label={item.title}>
          {narrow ? (
            <button type="button" className="ag-split-back" onClick={() => setOpen(false)}>
              <Icon.chevronLeft size={14} /> {b.title ?? "All"}
            </button>
          ) : null}
          <h3 className="ag-split-title">{item.title}</h3>
          <Blocks key={item.id} blocks={item.blocks} act={act} />
        </div>
      ) : null}
    </section>
  );
}

function SwitchBlock({ block: b, act }: { block: Extract<Block, { type: "switch" }>; act: Act }) {
  const [chosen, choose] = useKept<string>(b.id, b.selected ?? b.options[0]?.id ?? "");
  const opt = b.options.find((o) => o.id === chosen) ?? b.options[0];
  if (!opt) return null;
  return (
    <div className="ag-switch">
      <div className="ag-switch-bar" role="tablist">
        {b.options.map((o) => (
          <button key={o.id} type="button" role="tab" aria-selected={o.id === opt.id} onClick={() => choose(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <Blocks key={opt.id} blocks={opt.blocks} act={act} />
    </div>
  );
}

function ItemBlock({ block: b, act }: { block: Extract<Block, { type: "item" }>; act: Act }) {
  const folds = b.collapsed !== undefined;
  const [folded, setFolded] = useKept<boolean>(folds ? b.id : undefined, b.collapsed ?? false);
  const head = (
    <>
      {folds ? <Icon.chevronRight size={13} className={`ag-fold${folded ? "" : " open"}`} /> : null}
      {b.status ? <span className={`ag-dot ${b.status}`} aria-label={b.status} /> : null}
      <span className="ag-item-title">{b.title}</span>
      {b.subtitle ? <span className="ag-item-sub">{b.subtitle}</span> : null}
    </>
  );
  return (
    <article className={`ag-item ${b.status ?? ""}${folds ? " folds" : ""}`}>
      {folds ? (
        <header>
          <button type="button" className="ag-item-toggle" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
            {head}
          </button>
        </header>
      ) : (
        <header>{head}</header>
      )}
      {folded ? null : (
        <>
          {b.body ? (
            <div className="ag-md">
              <Markdown text={b.body} />
            </div>
          ) : null}
          {b.sessions?.length || b.links?.length ? (
            <div className="ag-item-links">
              {b.sessions?.map((id) => (
                <a key={id} href={`/#/session/${id}`} onClick={(e) => (e.preventDefault(), openInApp(`#/session/${id}`))}>
                  <Icon.terminal size={12} /> {id}
                </a>
              ))}
              {b.links?.map((l, i) =>
                l.url.startsWith("#") ? (
                  <a key={i} href={l.url} onClick={(e) => (e.preventDefault(), openInApp(l.url))}>
                    {l.label}
                  </a>
                ) : /^https?:/.test(l.url) ? (
                  <a key={i} href={l.url} target="_blank" rel="noreferrer">
                    <Icon.external size={12} /> {l.label}
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
        </>
      )}
    </article>
  );
}

function Actions({ actions, act, values }: { actions: Action[]; act: Act; values: () => Record<string, unknown> }) {
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

function FormBlock({ form, act }: { form: Extract<Block, { type: "form" }>; act: Act }) {
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
        <FieldView key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
      ))}
      <Actions actions={form.actions} act={act} values={() => values} />
    </form>
  );
}

function FieldView({ field: f, value, onChange }: { field: Field; value: unknown; onChange: (v: unknown) => void }) {
  const id = `ag-f-${f.name}`;
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
