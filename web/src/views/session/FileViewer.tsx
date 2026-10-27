import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, fmtBytes, rawFileUrl } from "../../api";
import { Icon, RelativeTime, Spinner, type IconComponent } from "../../components";
import { copyText } from "../../bits";
import type { FileView } from "../../../../src/core/files";
import { Markdown } from "./Markdown";
import { SessionLinks } from "./sessionlinks";
import { useAction } from "./useAction";
import "./fileviewer.css";
import { closeViewer, FileBase, openInViewer, useOnThisMachine, useViewerStack, viewerBack, type ViewerEntry } from "./viewerstore";

const PdfView = lazy(() => import("./PdfView"));

/** The viewer, over whatever page is open: one per app (App.tsx). */
export function FileViewerHost() {
  const stack = useViewerStack();
  const top = stack.at(-1);
  if (!top) return null;
  return createPortal(<FileViewer key={`${stack.length}:${top.path}`} entry={top} depth={stack.length} />, document.body);
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ok"; file: FileView };

/** The lines a reference points at: `a.ts:12`, `a.ts:12-20`, `a.ts:12:5`, `#L12-L20`. */
function linesOf(ref: string): [number, number] | null {
  const m = ref.match(/:(\d+)(?:-(\d+))?(?::\d+)?$/) ?? ref.match(/#L(\d+)(?:-L?(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]);
  return [a, Math.max(a, Number(m[2] ?? a))];
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const WRAP_KEY = "agentbox.viewer.wrap";
function initialWrap(): boolean {
  try {
    const v = localStorage.getItem(WRAP_KEY);
    if (v !== null) return v === "1";
  } catch {
    /* private mode */
  }
  return matchMedia("(max-width: 900px)").matches;
}

function iconOf(file: FileView | null): IconComponent {
  switch (file?.kind) {
    case "directory": return Icon.folder;
    case "markdown": return Icon.fileText;
    case "pdf": return Icon.filePdf;
    case "image": return Icon.image;
    case "html": return Icon.fileCode;
    case "text": return Icon.fileText;
    default: return Icon.file;
  }
}

function FileViewer({ entry, depth }: { entry: ViewerEntry; depth: number }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useState(initialWrap);
  const [copied, setCopied] = useState(false);
  const here = useOnThisMachine();
  const desktop = useAction();
  const box = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => linesOf(entry.path), [entry.path]);

  useEffect(() => {
    let live = true;
    api.viewFile(entry.session, entry.path).then(
      (file) => live && setLoaded({ state: "ok", file }),
      (e: Error) => live && setLoaded({ state: "error", message: e.message }),
    );
    return () => {
      live = false;
    };
  }, [entry.session, entry.path]);

  // Escape closes the viewer and nothing under it; the page under it stays put.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    box.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      closeViewer();
    };
    window.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
      if (restore?.isConnected) restore.focus({ preventScroll: true });
    };
  }, []);

  const file = loaded.state === "ok" ? loaded.file : null;
  const name = file?.name ?? entry.path.replace(/[?#].*$/, "").replace(/(?::\d+(?:-\d+)?){1,2}$/, "").split("/").filter(Boolean).pop() ?? entry.path;
  const dir = file ? parentOf(file.path) : null;
  const FileIcon = iconOf(file);
  const textual = file?.kind === "text" || (file?.kind === "markdown" && source);
  const lineCount = file?.text ? file.text.split("\n").length - (file.text.endsWith("\n") ? 1 : 0) : 0;
  const open = (path: string) => openInViewer({ session: entry.session, path });

  const copy = () => {
    if (!file) return;
    void copyText(file.path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }, () => undefined);
  };
  const toggleWrap = () => {
    setWrap((w) => {
      try {
        localStorage.setItem(WRAP_KEY, w ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !w;
    });
  };
  const desktopLabel = file?.kind === "pdf" || file?.kind === "html" ? "Open in desktop browser" : file?.kind === "directory" ? "Open in file explorer" : "Show in file explorer";

  return (
    <div className="fv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeViewer()}>
      <div className="fv" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} ref={box} data-kind={file?.kind ?? "loading"}>
        <header className="fv-head">
          {depth > 1 ? (
            <button type="button" className="fv-btn" onClick={viewerBack} aria-label="Back" title="Back">
              <Icon.chevronLeft size={18} />
            </button>
          ) : null}
          <span className="fv-icon" aria-hidden="true">
            <FileIcon size={18} weight="duotone" />
          </span>
          <div className="fv-title">
            <h2 title={file?.path ?? entry.path}>{name}</h2>
            <div className="fv-sub">
              {dir ? (
                <button type="button" className="fv-dir" title={`Open ${dir}`} onClick={() => open(dir)}>
                  <bdi>{dir}</bdi>
                </button>
              ) : null}
              {file ? (
                <span className="fv-meta">
                  {file.kind === "directory" ? `${file.entries?.length ?? 0} item${file.entries?.length === 1 ? "" : "s"}` : fmtBytes(file.size)}
                  {lineCount ? ` · ${lineCount.toLocaleString()} lines` : null} · <RelativeTime ts={file.mtimeMs} short />
                </span>
              ) : null}
            </div>
          </div>
          <div className="fv-actions">
            {file?.kind === "markdown" ? (
              <div className="seg fv-seg" role="group" aria-label="Show as">
                <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>Rendered</button>
                <button type="button" aria-pressed={source} onClick={() => setSource(true)}>Source</button>
              </div>
            ) : null}
            {textual ? (
              <button type="button" className="fv-btn" aria-pressed={wrap} onClick={toggleWrap} title={wrap ? "Don't wrap lines" : "Wrap lines"} aria-label="Wrap lines">
                <Icon.wrap size={17} />
              </button>
            ) : null}
            {file ? (
              <button type="button" className="fv-btn fv-wide-only" onClick={copy} title="Copy path" aria-label="Copy path">
                {copied ? <Icon.check size={17} /> : <Icon.copy size={17} />}
              </button>
            ) : null}
            {file && file.kind !== "directory" ? (
              <a className="fv-btn" href={rawFileUrl(file.path, true)} download={file.name} title="Download" aria-label="Download">
                <Icon.download size={17} />
              </a>
            ) : null}
            {file && here ? (
              <button
                type="button"
                className="fv-btn fv-wide-only"
                disabled={desktop.busy}
                onClick={() => void desktop.run(() => api.openFile(entry.session, file.path))}
                title={desktop.error ?? desktopLabel}
                aria-label={desktopLabel}
                data-error={desktop.error ? "" : undefined}
              >
                {file.kind === "pdf" || file.kind === "html" ? <Icon.external size={17} /> : <Icon.folder size={17} />}
              </button>
            ) : null}
            <button type="button" className="fv-btn fv-close" onClick={closeViewer} title="Close (Esc)" aria-label="Close">
              <Icon.x size={18} />
            </button>
          </div>
        </header>
        <div className="fv-body">
          {loaded.state === "loading" ? (
            <div className="fv-empty">
              <Spinner size={18} />
            </div>
          ) : loaded.state === "error" ? (
            <div className="fv-empty">
              <Icon.alert size={28} />
              <p className="fv-empty-title">Can't open this file</p>
              <p className="fv-empty-detail">{loaded.message}</p>
            </div>
          ) : (
            <Body file={loaded.file} session={entry.session} source={source} wrap={wrap} lines={lines} open={open} here={here} />
          )}
        </div>
      </div>
    </div>
  );
}

function Body({ file, session, source, wrap, lines, open, here }: {
  file: FileView;
  session: string;
  source: boolean;
  wrap: boolean;
  lines: [number, number] | null;
  open: (path: string) => void;
  here: boolean;
}) {
  const raw = rawFileUrl(file.path);
  const cut = file.truncated && file.kind !== "directory" ? (
    <div className="fv-cut">
      Showing the first {fmtBytes(new TextEncoder().encode(file.text ?? "").length)} of {fmtBytes(file.size)}.{" "}
      <a href={rawFileUrl(file.path, true)} download={file.name}>Download the whole file</a>
    </div>
  ) : null;
  switch (file.kind) {
    case "markdown":
      if (source) return <TextView text={file.text ?? ""} wrap={wrap} lines={lines} footer={cut} />;
      return (
        <div className="fv-scroll">
          <article className="fv-doc">
            <SessionLinks.Provider value={{ index: EMPTY_INDEX, self: session }}>
              <FileBase.Provider value={parentOf(file.path)}>
                <Markdown text={file.text ?? ""} />
              </FileBase.Provider>
            </SessionLinks.Provider>
          </article>
          {cut}
        </div>
      );
    case "text":
      return <TextView text={file.text ?? ""} wrap={wrap} lines={lines} footer={cut} />;
    case "pdf":
      return (
        <Suspense fallback={<div className="fv-empty"><Spinner size={18} /></div>}>
          <PdfView url={raw} />
        </Suspense>
      );
    case "html":
      // Sandboxed twice: here, and by the server's CSP should it be opened bare.
      return <iframe className="fv-frame" src={raw} title={file.name} sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads" />;
    case "image":
      return (
        <div className="fv-scroll fv-image">
          <img src={raw} alt={file.name} />
        </div>
      );
    case "directory":
      return (
        <div className="fv-scroll">
          <ul className="fv-list">
            {file.path !== "/" ? (
              <li>
                <button type="button" onClick={() => open(parentOf(file.path))}>
                  <Icon.arrowUp size={16} />
                  <span className="fv-list-name">..</span>
                </button>
              </li>
            ) : null}
            {file.entries?.map((e) => (
              <li key={e.name}>
                <button type="button" onClick={() => open(`${file.path === "/" ? "" : file.path}/${e.name}`)}>
                  {e.dir ? <Icon.folder size={16} weight="duotone" /> : <Icon.file size={16} />}
                  <span className="fv-list-name">{e.name}</span>
                  {e.dir ? null : <span className="fv-list-size">{fmtBytes(e.size)}</span>}
                </button>
              </li>
            ))}
          </ul>
          {file.entries?.length === 0 ? <p className="fv-empty-detail fv-pad">This folder is empty.</p> : null}
          {file.truncated ? <div className="fv-cut">Showing the first {file.entries?.length} entries.</div> : null}
        </div>
      );
    default:
      return (
        <div className="fv-empty">
          <Icon.file size={32} />
          <p className="fv-empty-title">No preview for this file</p>
          <p className="fv-empty-detail">
            {fmtBytes(file.size)} of binary data{here ? "; your desktop can open it" : ""}.
          </p>
          <a className="btn btn-default btn-md" href={rawFileUrl(file.path, true)} download={file.name}>
            <Icon.download size={15} /> Download
          </a>
        </div>
      );
  }
}

const EMPTY_INDEX = { ids: new Set<string>(), provider: new Map() };

/** Lines in chunks the browser lays out only near the screen, so a long log
 *  costs what is in view. Numbers are not selectable: a copy is the text. */
const CHUNK = 400;
function TextView({ text, wrap, lines, footer }: { text: string; wrap: boolean; lines: [number, number] | null; footer: React.ReactNode }) {
  const all = useMemo(() => {
    if (text === "") return [];
    const ls = text.split("\n");
    if (ls.length > 1 && ls.at(-1) === "") ls.pop();
    return ls;
  }, [text]);
  const scroller = useRef<HTMLDivElement>(null);
  const width = String(all.length).length;

  // To the referenced line, a third of the way down, and again once the
  // chunks above it have been laid out at their real height.
  useLayoutEffect(() => {
    if (!lines) return;
    const go = () => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-ln="${lines[0]}"]`);
      const box = scroller.current;
      if (!el || !box) return;
      box.scrollTop = el.offsetTop - box.clientHeight / 3;
    };
    go();
    const raf = requestAnimationFrame(() => requestAnimationFrame(go));
    return () => cancelAnimationFrame(raf);
  }, [lines, wrap]);

  const chunks: React.ReactNode[] = [];
  for (let at = 0; at < all.length; at += CHUNK) {
    const slice = all.slice(at, at + CHUNK);
    const near = lines !== null && lines[0] > at && lines[0] <= at + CHUNK + 1;
    chunks.push(
      <div key={at} className={near ? "fv-chunk" : "fv-chunk fv-lazy"} style={{ containIntrinsicHeight: `auto ${slice.length * 20}px` }}>
        {slice.map((l, i) => {
          const n = at + i + 1;
          const hl = lines !== null && n >= lines[0] && n <= lines[1];
          return (
            <div key={n} className="fv-line" data-ln={n} data-hl={hl ? "" : undefined}>
              <span className="fv-ln">{n}</span>
              <span className="fv-lc">{l || "​"}</span>
            </div>
          );
        })}
      </div>,
    );
  }
  return (
    <div className="fv-scroll fv-code-scroll" ref={scroller}>
      <div className={`fv-code${wrap ? " fv-wrap" : ""}`} style={{ "--ln-w": `${Math.max(2, width)}ch` } as React.CSSProperties}>
        {chunks}
      </div>
      {text === "" ? <p className="fv-empty-detail fv-pad">This file is empty.</p> : null}
      {footer}
    </div>
  );
}
