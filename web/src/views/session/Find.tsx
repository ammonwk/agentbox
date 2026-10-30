/** Finding words in a conversation: every message they were said in, loaded
 *  or not (the server's index of what you and the agents said, not tool
 *  output), stepped through one at a time, and the words marked where they
 *  show. Ctrl+F opens it over the timeline; a second Ctrl+F is the browser's. */

import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../../api";
import { Icon } from "../../components";

export function FindBar({
  sessionId,
  initial,
  start,
  onGo,
  onClose,
}: {
  sessionId: string;
  initial: string;
  /** The hit already shown (the search that led here opened it). */
  start?: string;
  onGo: (event: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState(initial);
  const [hits, setHits] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const first = useRef(start);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    setHits(null);
    const needle = q.trim();
    if (needle.length < 3) return;
    let live = true;
    const t = setTimeout(() => {
      api.saidIn(sessionId, needle).then(
        (found) => {
          if (!live) return;
          const ids = found.map((h) => h.event);
          // At the hit already open, else the newest: you read from the end.
          const k = first.current ? ids.indexOf(first.current) : -1;
          first.current = undefined;
          const at = k >= 0 ? k : ids.length - 1;
          setHits(ids);
          setI(at);
          if (k < 0 && ids.length) onGo(ids[at]!);
        },
        () => live && setHits([]),
      );
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sessionId]);

  const step = (d: -1 | 1) => {
    if (!hits?.length) return;
    const n = (i + d + hits.length) % hits.length;
    setI(n);
    onGo(hits[n]!);
  };
  const short = q.trim().length < 3;
  return (
    <div className="tl-find" role="search">
      <Icon.search size={13} />
      <input
        ref={input}
        value={q}
        placeholder="Find in this conversation"
        aria-label="Find in this conversation"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="tl-find-n" aria-live="polite">
        {short ? (q.trim() ? "3 letters or more" : "") : hits === null ? "…" : hits.length ? `${i + 1} of ${hits.length}` : "Not said here"}
      </span>
      <button type="button" className="tl-find-btn" title="Earlier (Shift+Enter)" aria-label="Earlier" disabled={!hits?.length} onClick={() => step(-1)}>
        <Icon.chevronUp size={14} />
      </button>
      <button type="button" className="tl-find-btn" title="Later (Enter)" aria-label="Later" disabled={!hits?.length} onClick={() => step(1)}>
        <Icon.chevronDown size={14} />
      </button>
      <button type="button" className="tl-find-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
        <Icon.x size={14} />
      </button>
    </div>
  );
}

/** Mark `q` wherever it shows in `root`, and brighter in the row `now` names
 *  (`data-ev`): the CSS Custom Highlight API, so the rendered rows are not
 *  touched. Words split across formatting are not found. */
export function useMarks(root: RefObject<HTMLElement | null>, q: string | null, now: string | null, deps: unknown[]): void {
  useEffect(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const Hl = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!reg || !Hl) return;
    const needle = q?.trim().toLowerCase() ?? "";
    const el = root.current;
    if (!el || needle.length < 3) {
      reg.delete("tl-find");
      reg.delete("tl-find-now");
      return;
    }
    const all: Range[] = [];
    const mine: Range[] = [];
    const current = now ? el.querySelector(`[data-ev="${CSS.escape(now)}"]`) : null;
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = n.nodeValue?.toLowerCase() ?? "";
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + needle.length)) {
        const r = new Range();
        r.setStart(n, k);
        r.setEnd(n, k + needle.length);
        (current?.contains(n) ? mine : all).push(r);
      }
    }
    reg.set("tl-find", new Hl(...all));
    reg.set("tl-find-now", new Hl(...mine));
    return () => {
      reg.delete("tl-find");
      reg.delete("tl-find-now");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, now, ...deps]);
}
