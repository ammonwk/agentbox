import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { Icon, Spinner } from "../../components";

GlobalWorkerOptions.workerSrc = workerUrl;

/** A desktop browser's own PDF viewer has search and selection; a phone's
 *  draws nothing in a frame (Android) or one page (iOS), so pages are drawn
 *  here. This module is its own chunk: pdf.js loads with the first PDF. */
const native = typeof navigator !== "undefined" && navigator.pdfViewerEnabled && matchMedia("(pointer: fine)").matches;

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export default function PdfView({ url }: { url: string }) {
  if (native) return <iframe className="fv-frame" src={url} title="PDF" />;
  return <Pages url={url} />;
}

function Pages({ url }: { url: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratios, setRatios] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const task = getDocument({ url });
    let live = true;
    task.promise.then(
      async (d) => {
        const pages = await Promise.all(Array.from({ length: d.numPages }, (_, i) => d.getPage(i + 1)));
        if (!live) return;
        setRatios(pages.map((p) => {
          const v = p.getViewport({ scale: 1 });
          return v.height / v.width;
        }));
        setDoc(d);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
      void task.destroy();
    };
  }, [url]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit to the width, up to a page a reader can take in on a wide screen.
  const pageW = Math.round(Math.min(Math.max(width - 24, 120), 920) * ZOOMS[zoom]!);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 3;
    const kids = el.querySelectorAll<HTMLElement>(".fv-page");
    let n = 1;
    for (const k of kids) {
      if (k.offsetTop > mid) break;
      n = Number(k.dataset.n);
    }
    setPage(n);
  };

  // Zooming keeps the same place in the document in view.
  const rezoom = (to: number) => {
    const el = scroller.current;
    const frac = el && el.scrollHeight ? el.scrollTop / el.scrollHeight : 0;
    setZoom(to);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = frac * el.scrollHeight;
    });
  };

  if (error) {
    return (
      <div className="fv-empty">
        <Icon.alert size={28} />
        <p className="fv-empty-title">Can't draw this PDF</p>
        <p className="fv-empty-detail">{error}</p>
      </div>
    );
  }
  return (
    <div className="fv-pdf">
      <div className="fv-scroll fv-pages" ref={scroller} onScroll={onScroll}>
        {!doc ? (
          <div className="fv-empty"><Spinner size={18} /></div>
        ) : width > 0 ? (
          ratios.map((r, i) => <Page key={i} doc={doc} n={i + 1} width={pageW} ratio={r} root={scroller} />)
        ) : null}
      </div>
      {doc ? (
        <div className="fv-pdfbar" role="toolbar" aria-label="PDF">
          <span className="fv-pdfpage">{page} / {doc.numPages}</span>
          <button type="button" className="fv-btn" disabled={zoom === 0} onClick={() => rezoom(zoom - 1)} aria-label="Zoom out" title="Zoom out">
            <Icon.zoomOut size={17} />
          </button>
          <button type="button" className="fv-pdfzoom" onClick={() => rezoom(2)} title="Fit to width">
            {Math.round(ZOOMS[zoom]! * 100)}%
          </button>
          <button type="button" className="fv-btn" disabled={zoom === ZOOMS.length - 1} onClick={() => rezoom(zoom + 1)} aria-label="Zoom in" title="Zoom in">
            <Icon.zoomIn size={17} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A page is drawn when it comes near the screen and let go when it leaves,
 *  so a long document holds a few canvases, not a phone's memory. */
function Page({ doc, n, width, ratio, root }: { doc: PDFDocumentProxy; n: number; width: number; ratio: number; root: React.RefObject<HTMLDivElement | null> }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e!.isIntersecting), { root: root.current, rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current;
    if (!near || !c) return;
    let task: RenderTask | null = null;
    let live = true;
    void doc.getPage(n).then((p) => {
      if (!live) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const vp = p.getViewport({ scale: (width / p.getViewport({ scale: 1 }).width) * dpr });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = p.render({ canvas: c, viewport: vp });
      task.promise.catch(() => undefined);
    });
    return () => {
      live = false;
      task?.cancel();
      c.width = 0;
      c.height = 0;
    };
  }, [near, doc, n, width]);

  return (
    <div className="fv-page" data-n={n} ref={holder} style={{ width, height: Math.round(width * ratio) }}>
      <canvas ref={canvas} aria-label={`Page ${n}`} />
    </div>
  );
}
