/** The primitive set. Everything else in web/ is built out of these.
 *
 * Two rules hold this file together: an interactive thing is a real element
 * with a real accessible name, and nothing here knows what page it is on.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { ago, clockNow, subscribeToClock } from "./api";

// ------------------------------------------------------------------ icons

export type IconProps = { size?: number; className?: string };
export type IconComponent = (props: IconProps) => ReactElement;

const I =
  (...d: string[]): IconComponent =>
  ({ size = 16, className }: IconProps) => (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d.map((path, i) => (
        <path key={i} d={path} />
      ))}
    </svg>
  );

/** Not annotated as `Record<string, ...>` on purpose: the exact key set means a
 *  typo at a callsite is a compile error rather than a silently missing glyph. */
export const Icon = {
  inbox: I("M3 13h5l1 3h6l1-3h5", "M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"),
  sessions: I("M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M3 9h18M9 9v12"),
  settings: I("M4 7h8M16 7h4M4 17h4M12 17h8", "M14 4v6M8 14v6"),

  plus: I("M12 5v14M5 12h14"),
  play: I("M7 4.5v15l12-7.5z"),
  stop: I("M7 6h10v12H7z"),
  pause: I("M9 5v14M15 5v14"),
  refresh: I("M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 3.5v6h-6"),
  archive: I("M4 5h16M4 5l1 15h14l1-15", "M10 12h4"),
  trash: I("M4 7h16M9 7V5h6v2", "M6 7l1 14h10l1-14M10 11v6M14 11v6"),
  send: I("M4 12l16-8-6 16-2.5-6.5z"),
  check: I("M5 13l4 4L19 7"),
  x: I("M6 6l12 12M18 6L6 18"),
  chevronRight: I("M9 5l7 7-7 7"),
  chevronLeft: I("M15 5l-7 7 7 7"),
  chevronDown: I("M5 9l7 7 7-7"),
  arrowDown: I("M12 4v15M6 13l6 6 6-6"),
  external: I("M14 4h6v6", "M20 4L11 13M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"),

  sun: I("M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12 1v2M12 21v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"),
  moon: I("M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"),
  monitor: I("M3 5h18v11H3z", "M9 20h6M12 16v4"),

  alert: I("M12 8v5M12 16.5v.01", "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"),
  flag: I("M5 21V4M5 4h12l-2 4 2 4H5"),
  clock: I("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"),
  shield: I("M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z", "M9 12l2 2 4-4"),
  eye: I("M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"),

  branch: I("M6 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 9v11", "M18 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM18 9v2a4 4 0 0 1-4 4h-4"),
  prs: I("M6 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM6 9v11", "M18 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18 15V9l-4-4h-3M11 2l-3 3 3 3"),
  repo: I("M5 4h14v16H7a2 2 0 0 1-2-2z", "M5 17h14"),
  folder: I("M3 6h6l2 2h10v11H3z"),

  file: I("M6 3h8l4 4v14H6z", "M14 3v4h4"),
  edit: I("M4 20h4L20 8l-4-4L4 16z"),
  terminal: I("M4 5h16v14H4z", "M8 10l2.5 2L8 14M13 15h4"),
  search: I("M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M16.5 16.5L21 21"),
  brain: I("M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V17a3 3 0 0 0 4 2.8", "M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V17a3 3 0 0 1-4 2.8M12 4v16"),
  download: I("M12 4v10M8 11l4 4 4-4", "M4 19h16"),
  move: I("M9 6l-4 4 4 4", "M5 10h9a5 5 0 0 1 5 5v4"),

  chat: I("M4 5h16v11H9l-5 4z"),
  user: I("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"),
  robot: I("M6 9h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z", "M12 5v4M9 14v1M15 14v1"),
  dollar: I("M12 3v18", "M16 7.5A3.5 3.5 0 0 0 12.5 5h-1a3 3 0 0 0 0 6h1a3 3 0 0 1 0 6h-1A3.5 3.5 0 0 1 8 16.5"),
  wifiOff: I("M2 2l20 20", "M5 12.5a11 11 0 0 1 4-2.4M15 10.1a11 11 0 0 1 4 2.4M8.5 16a6 6 0 0 1 7 0M12 20h.01"),

  users: I("M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4.5-6.5"),
  sliders: I("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3", "M1 14h6M9 8h6M17 16h6"),
  copy: I("M9 9h11v11H9z", "M5 15H4V4h11v1"),
  key: I("M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7z"),
  bolt: I("M13 2L4 14h7l-1 8 9-12h-7z"),
  gauge: I("M12 14l4-4", "M3.5 18a9 9 0 1 1 17 0"),
  link: I("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1", "M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"),
  undo: I("M9 14L4 9l5-5", "M4 9h11a5 5 0 0 1 0 10h-3"),
  keyboard: I("M3 6h18v12H3z", "M7 10h.01M11 10h.01M15 10h.01M7 14h10"),
};

// ----------------------------------------------------------------- button

type ButtonOwnProps = {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  /**
   * The component, not an element: `icon={Icon.play}`. Button sizes it from
   * its own `size`, so `sm` and `md` stay proportionate and no callsite
   * repeats a magic number.
   */
  icon?: IconComponent;
  /** Disables and shows a spinner in place of the icon. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
};

/**
 * An icon-only button (no children) requires `aria-label` — that is a compile
 * error, not a runtime one, because half the old build's buttons shipped with
 * no accessible name and nothing caught it.
 */
type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> &
  ButtonOwnProps & { children?: ReactNode };

export type ButtonProps = ButtonBase &
  ({ children: ReactNode } | { children?: undefined; "aria-label": string });

/** Sized against each button's own text (12.5px at `sm`, 13px at `md`). */
const ICON_SIZE: Record<NonNullable<ButtonOwnProps["size"]>, number> = { sm: 13, md: 15 };

export function Button(props: ButtonProps) {
  // Annotated so the destructure reads off one object type rather than the
  // public union; the union's only job is to reject a nameless icon button.
  const {
    variant = "default",
    size = "md",
    icon: IconCmp,
    loading,
    children,
    ...rest
  }: ButtonBase = props;
  const iconOnly = children === undefined || children === null || children === false;

  if (iconOnly && !rest["aria-label"]) {
    // Unreachable through the types; reachable through `as any` at a callsite.
    console.error("Button: an icon-only button needs an aria-label", rest);
  }

  return (
    <button
      type="button"
      {...rest}
      className={[
        "btn",
        `btn-${variant}`,
        `btn-${size}`,
        iconOnly ? "btn-icon" : "",
        rest.className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <Spinner size={ICON_SIZE[size]} /> : IconCmp ? <IconCmp size={ICON_SIZE[size]} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

// ------------------------------------------------------------------ empty

/** Every empty state says what will fill it, and links to the action if there is one. */
export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

// ------------------------------------------------------------------ modal

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Escape closes, focus is trapped and restored, and the backdrop only closes
 * on a press that both starts and ends on the backdrop.
 *
 * There is no close-on-blur: WebKit does not focus a clicked <button>, so a
 * blur-to-close dialog unmounts before the click reaches its handler.
 */
export function Modal({
  title,
  hint,
  onClose,
  children,
  wide,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: ReactNode;
  /** The new-session dialog carries a table; it needs the room. */
  wide?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const hintId = useId();
  const downOnBackdrop = useRef(false);

  /** Whatever had focus when this dialog opened, so closing can hand it back.
   *
   * Captured during the first RENDER, not in the effect. By the time an effect
   * runs, an `autoFocus` inside the dialog has already taken focus — reading it
   * there recorded a node that is unmounted on close, so focus fell to <body>
   * and a keyboard user was dumped at the top of the document. */
  const [restoreTo] = useState<HTMLElement | null>(
    () => document.activeElement as HTMLElement | null,
  );

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const focusable = () =>
      [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    // Only take focus if nothing in here has it. React applies `autoFocus`
    // when it inserts the node, which is before this effect runs — focusing
    // the first focusable unconditionally stole focus from the field the view
    // deliberately marked, and landed the New Session dialog on its close X.
    if (!box.contains(document.activeElement)) (focusable()[0] ?? box).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !box) return;
      const els = focusable();
      if (els.length === 0) {
        e.preventDefault();
        box.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (!box.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = prevOverflow;
      // `isConnected`: the opener can itself have been removed by whatever the
      // dialog did — deleting a session unmounts the row its Delete lived in.
      if (restoreTo?.isConnected) restoreTo.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) onClose();
      }}
    >
      <div
        className={`modal${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hint ? hintId : undefined}
        tabIndex={-1}
        ref={boxRef}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <Button
            variant="ghost"
            size="sm"
            icon={Icon.x}
            aria-label="Close"
            onClick={onClose}
          />
        </div>
        {hint ? (
          <p className="modal-hint" id={hintId}>
            {hint}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** Destructive actions confirm; reversible ones do not. */
export function Confirm({
  title,
  body,
  danger,
  confirmLabel = danger ? "Delete" : "Confirm",
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Cancel takes the initial focus on a destructive prompt: Enter should not
  // be able to delete a worktree the person has not read the sentence about.
  useEffect(() => {
    if (danger) cancelRef.current?.focus();
  }, [danger]);

  return (
    <Modal title={title} onClose={onCancel}>
      <div className="confirm-body">{body}</div>
      <div className="modal-actions">
        <Button ref={cancelRef} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- form parts

/**
 * A labelled control. Pass a function child when the control needs the id
 * (`{(id) => <input id={id} />}`); plain children get an implicit label wrap,
 * which associates correctly as long as there is one control inside.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode | ((id: string) => ReactNode);
}) {
  const id = useId();
  // The label and hint live inside ONE element in both branches. They used to
  // be a fragment spliced straight into each branch, which meant they were
  // flex children of `.field` in the plain form and inline spans inside a
  // `<label>` in the function form — so the function form ran the label and
  // hint together with no break, on every field with an explicit id. Sharing
  // the wrapper is what makes the two branches unable to diverge visually.
  const head = (
    <>
      <span className="field-label">{label}</span>
      {hint ? <span className="field-hint">{hint}</span> : null}
    </>
  );

  if (typeof children === "function") {
    return (
      <div className="field">
        <label className="field-head" htmlFor={id}>
          {head}
        </label>
        {children(id)}
      </div>
    );
  }
  return (
    <label className="field">
      <span className="field-head">{head}</span>
      {children}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  labelHidden,
  disabled,
  id,
  "aria-describedby": describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Keeps the accessible name while the row already shows the text. */
  labelHidden?: boolean;
  disabled?: boolean;
  id?: string;
  /**
   * Id of the prose explaining what this switch does. A hint sitting next to a
   * switch is adjacent text and nothing announces it — a screen reader user
   * hears "Auto-approve tool calls, switch, off" and none of the paragraph
   * saying it removes every gate on what the agent runs.
   */
  "aria-describedby"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
      <span className={labelHidden ? "sr-only" : "toggle-label"}>{label}</span>
    </button>
  );
}

/**
 * Text that commits on blur or Enter, never per keystroke, and says so while
 * it is dirty. Escape reverts. In `multiline` mode Enter inserts a newline and
 * Ctrl/Cmd+Enter commits.
 */
export function CommitInput({
  value,
  onCommit,
  multiline,
  rows = 6,
  mono,
  placeholder,
  disabled,
  id,
  "aria-label": ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  multiline?: boolean;
  rows?: number;
  mono?: boolean;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [dirty, setDirty] = useState(false);

  // Accept server-pushed changes, but never over something being typed.
  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty]);

  function commit() {
    if (!dirty) return;
    setDirty(false);
    if (draft !== value) onCommit(draft);
  }

  function revert() {
    setDraft(value);
    setDirty(false);
  }

  const shared = {
    id,
    "aria-label": ariaLabel,
    value: draft,
    placeholder,
    disabled,
    onChange: (e: { target: { value: string } }) => {
      setDraft(e.target.value);
      setDirty(true);
    },
    onBlur: commit,
    className: `input ${mono ? "mono" : ""} ${dirty ? "dirty" : ""}`,
  };

  return (
    <div className="commit">
      {multiline ? (
        <textarea
          {...shared}
          rows={rows}
          onKeyDown={(e) => {
            if (e.key === "Escape") revert();
            else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : (
        <input
          {...shared}
          type="text"
          onKeyDown={(e) => {
            if (e.key === "Escape") revert();
            else if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      )}
      {dirty ? (
        <span className="commit-hint">
          Unsaved — {multiline ? "⌘/Ctrl+Enter" : "Enter"} or click away to save, Esc to revert
        </span>
      ) : null}
    </div>
  );
}
// --------------------------------------------------------------- relative

/**
 * Self-updating, off one page-wide interval. The snapshot is the formatted
 * string, so a row only re-renders when its label actually changes.
 */
export function RelativeTime({ ts }: { ts: number }) {
  const label = useSyncExternalStore(
    subscribeToClock,
    () => ago(ts, clockNow()),
    () => ago(ts, ts),
  );
  return (
    <time dateTime={new Date(ts).toISOString()} title={new Date(ts).toLocaleString()}>
      {label}
    </time>
  );
}
