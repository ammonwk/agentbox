/** `agentbox wait 22849` in agent prose, drawn as the wait itself: what it
 *  watches, how long it has, and while a job runs the last line of its log —
 *  live, read every few seconds until it ends. A click opens the end of the
 *  log, or how it ended. One the server does not know stays as it was written. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, useNow } from "../../api";
import { Icon } from "../../components";
import { fmtDur } from "../../lib/format";
import { useDismiss, useFloating } from "../newsession/popover";
import type { WaitEnd, WaitView } from "../../../../src/core/types";

const POLL_MS = 3_000;

/** Reads shared by every mention of one wait; an ended one is read once. */
const reads = new Map<number, { at: number; read: Promise<WaitView | null>; view?: WaitView | null }>();

function readWait(id: number): Promise<WaitView | null> {
  const had = reads.get(id);
  if (had && (had.view?.ended || Date.now() - had.at < POLL_MS - 500)) return had.read;
  const entry: { at: number; read: Promise<WaitView | null>; view?: WaitView | null } = { at: Date.now(), read: Promise.resolve(null) };
  entry.read = api.wait(id).then(
    (v) => (entry.view = v),
    () => (entry.view = had?.view ?? null),
  );
  reads.set(id, entry);
  return entry.read;
}

function useWait(id: number): WaitView | null | undefined {
  const [view, setView] = useState<WaitView | null | undefined>(() => reads.get(id)?.view);
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      if (document.visibilityState === "visible") {
        const v = await readWait(id);
        if (stop) return;
        setView(v);
        if (!v || v.ended) return;
      }
      t = setTimeout(look, POLL_MS);
    };
    void look();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [id]);
  return view;
}

const ENDED: Record<WaitEnd, string> = { happened: "done", stuck: "stuck", timeout: "timed out", broken: "broke", cancelled: "cancelled" };

export function WaitRef({ id, children }: { id: number; children: ReactNode }) {
  const w = useWait(id);
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), [chip, pop]);
  const style = useFloating(chip, open, 320, 420);
  if (!w) return <>{children}</>;

  const going = !w.ended;
  const label = w.spec.kind === "job" ? jobLabel(w.spec.command) : w.what;
  const time = going
    ? w.spec.kind === "time"
      ? `in ${fmtDur(w.deadline - now)}`
      : fmtDur(now - w.createdAt)
    : `${ENDED[w.ended!]} after ${fmtDur((w.endedAt ?? now) - w.createdAt)}`;
  const peek = going ? (w.tail ? lastLine(w.tail) : w.seen) : null;
  const mark = going ? <span className="wk-pulse" /> : w.ended === "happened" ? <Icon.check size={11} weight="bold" /> : w.ended === "cancelled" ? <Icon.x size={11} /> : <Icon.alert size={11} />;
  const detail = going ? w.tail ?? w.seen : w.outcome;

  return (
    <>
      <button
        ref={chip}
        type="button"
        className="sx-wait"
        data-ended={w.ended ?? undefined}
        title={`agentbox wait ${w.id}: ${w.what}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {mark}
        <span className="sx-wait-what">{label}</span>
        <span className="sx-wait-time">{time}</span>
        {peek ? <code className="sx-wait-peek">{peek}</code> : null}
      </button>
      {open ? (
        <div ref={pop} className="sx-wait-pop" style={style} onClick={(e) => e.stopPropagation()}>
          <div className="sx-wait-pop-head">
            wait {w.id} · {w.spec.kind === "job" ? `job ${plainCommand(w.spec.command)}` : w.what}
          </div>
          {detail ? <pre>{detail}</pre> : <div className="faint">{going ? "Nothing to show yet." : "Ended with nothing to say."}</div>}
        </div>
      ) : null}
    </>
  );
}

/** A job's command as a person would name it: its `--name`, the script it
 *  runs, or the command without the shell quoting `agentbox wait job` adds. */
function jobLabel(command: string): string {
  const named = /^([\w.-]+): /.exec(command);
  if (named) return named[1]!;
  const plain = plainCommand(command);
  const script = /[^\s<>|;&]+\.(?:sh|py|[cm]?[jt]s|rb|pl)\b/.exec(plain);
  if (script) return script[0].split("/").pop()!;
  return plain.replace(/^(?:ba)?sh -c /, "").replace(/^cd \S+ && /, "");
}

/** Without the quoting `agentbox wait job` wraps each word in. */
const plainCommand = (command: string): string => command.replaceAll(`'\\''`, "").replaceAll("'", "").replace(/\s+/g, " ").trim();

const lastLine = (text: string): string => text.trimEnd().split("\n").at(-1)!.trim();
