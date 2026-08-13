import type { ReactNode } from "react";
import type { SessionStatus } from "./api";

// ---- icons (inline, minimal set) ----

type IconProps = { size?: number };

const I = (d: string) =>
  ({ size = 16 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );

export const Icon = {
  board: I("M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 9h18M9 9v12"),
  conductor: I("M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7zM12 8v4M12 15h.01"),
  prs: I("M7 21a4 4 0 0 0 4-4v-5m4 0a4 4 0 0 0 4 4h2v-4a4 4 0 0 0-4-4h-2M7 5a4 4 0 0 1 4 4"),
  skills: I("M4 7V5a1 1 0 0 1 1-1h5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-5a1 1 0 0 1-1-1v-2M9 6h10a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9M5 12h4"),
  settings: I("M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"),
  plus: I("M12 5v14M5 12h14"),
  play: I("M8 5v14l11-7z"),
  stop: I("M7 6h10v12H7z"),
  archive: I("M4 5h16M4 5l1 15h14l1-15M10 12h4"),
  trash: I("M4 7h16M9 7V5h6v2M6 7l1 14h10l1-14M10 11v6M14 11v6"),
  sun: I("M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"),
  moon: I("M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"),
  alert: I("M12 8v5M12 16.5v.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"),
  git: I("M9 6a3 3 0 1 0-6 0 3 3 0 0 0 4 2.8V15.2A3 3 0 1 0 10 15V8.8A3 3 0 0 0 12 6zM9 6a3 3 0 0 0 6 0M9 6a3 3 0 0 1 6 0"),
  chat: I("M4 5h16v12H8l-4 4z"),
  check: I("M5 13l4 4L19 7"),
  refresh: I("M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"),
};

// ---- status ----

const STATUS_LABEL: Record<SessionStatus, string> = {
  spawning: "Spawning",
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  dead: "Lost",
};

export function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`pill ${status}`}>{STATUS_LABEL[status]}</span>;
}

// ---- layout bits ----

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Modal({
  title, hint, children, onClose,
}: { title: string; hint?: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {hint && <p className="hint">{hint}</p>}
        {children}
      </div>
    </div>
  );
}
