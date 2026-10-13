/** The primitive set. Everything else in web/ is built out of these.
 *
 * Two rules hold this file together: an interactive thing is a real element
 * with a real accessible name, and nothing here knows what page it is on.
 */

import {
  Component,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ErrorInfo,
  type ReactNode,
  type Ref,
} from "react";
import { ago, clockNow, subscribeToClock } from "./api";
import { isMissingChunk, reloadForMissingChunk } from "./lib/update";

import { Icon, type IconComponent } from "./icons";
export { Icon, type IconComponent, type IconProps } from "./icons";

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

// ---------------------------------------------------------- error boundary

/**
 * A crash in one view shows an error there instead of unmounting the whole
 * app — without one, any render or effect error left a blank page. `resetKey`
 * clears the error when it changes, so navigating away is the way out.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; label?: string },
  { error: Error | null; key: string | undefined }
> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { error: Error | null; key: string | undefined }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isMissingChunk(error) && reloadForMissingChunk()) return;
    console.error(`agentbox: ${this.props.label ?? "view"} crashed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Trying again cannot help: React keeps the failed import. Only a reload
    // fetches the build that replaced it.
    if (isMissingChunk(error)) {
      return (
        <Empty
          title="agentbox was updated"
          action={
            <Button icon={Icon.refresh} onClick={() => location.reload()}>
              Reload
            </Button>
          }
        >
          <p>This page is from the previous build, and part of it is gone. Reload to use the new one.</p>
        </Empty>
      );
    }
    return (
      <Empty
        title={`${this.props.label ?? "This view"} crashed`}
        action={
          <Button icon={Icon.refresh} onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        }
      >
        <p className="mono error-detail">{error.message}</p>
        <p>The rest of agentbox is fine. The details are in the browser console.</p>
      </Empty>
    );
  }
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
export function RelativeTime({ ts, short, title }: { ts: number; short?: boolean; title?: string }) {
  const label = useSyncExternalStore(
    subscribeToClock,
    () => fmt(ago(ts, clockNow()), short),
    () => fmt(ago(ts, ts), short),
  );
  return (
    <time dateTime={new Date(ts).toISOString()} title={title ?? new Date(ts).toLocaleString()}>
      {label}
    </time>
  );
}

/** "12m ago" → "12m", for columns where every entry is in the past. */
function fmt(label: string, short?: boolean): string {
  if (!short) return label;
  return label === "just now" ? "now" : label.replace(/ ago$/, "");
}
