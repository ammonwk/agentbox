import { useCallback, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
// A value import, not a type import: `conductor.ts` is pure and depends on
// nothing but types, and running the *same* derivation the server does is the
// whole point — a second implementation here is how the old build ended up with
// three call sites that each decided "urgent" for themselves. The sidebar badge
// counts `inboxItems(...).length` for the same reason.
import { inboxItems } from "../../../src/core/conductor";
import type {
  AppState,
  Attention,
  AttentionKind,
  PermissionRequest,
  PrInfo,
  Session,
} from "../../../src/core/types";
import { api, repoShort } from "../api";
import { AttentionBadge, Button, Empty, Icon, RelativeTime, StatusPill } from "../components";
import "./inbox.css";

/**
 * The kinds that ask for a human act, and so the only ones a row can carry.
 *
 * `inboxItems` filters to exactly these, but `InboxItem.attention` is typed as
 * the whole `Attention`, so the guarantee lives in that function rather than in
 * the type. It is restated once at the map below and the compiler carries it
 * from there. Deriving from `AttentionKind` rather than listing the four by
 * hand means a new kind added to the domain model is a compile error here
 * instead of a row that silently renders no action.
 */
type InboxKind = Exclude<AttentionKind, "none" | "idle">;

export function Inbox({
  state,
  onOpenSession,
}: {
  state: AppState;
  onOpenSession: (id: string) => void;
}) {
  const items = inboxItems(state.sessions, state.prs);

  if (items.length === 0) return <AllClear state={state} onOpenSession={onOpenSession} />;

  return (
    <div className="inbox">
      <p className="inbox-lede">
        {items.length === 1 ? "One thing wants you." : `${items.length} things want you.`}
      </p>
      <ul className="inbox-list">
        {items.map((item) => {
          const kind = item.attention.kind;
          if (kind === "none" || kind === "idle") return null;
          return (
            <SessionRow
              key={item.key}
              session={item.session}
              attention={item.attention}
              kind={kind}
              pr={item.pr}
              onOpenSession={onOpenSession}
            />
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- all clear

/**
 * An empty Inbox is the good outcome, so it reads like one — and then answers
 * the question a person actually has next, which is what the agents are doing.
 * This state is reachable now that `idle` no longer counts as wanting a human,
 * so it is a screen people will see rather than a theoretical branch.
 */
function AllClear({
  state,
  onOpenSession,
}: {
  state: AppState;
  onOpenSession: (id: string) => void;
}) {
  const working = state.sessions.filter(
    (s) => s.status === "running" || s.status === "spawning",
  );
  // Not in the Inbox: a finished turn with nothing wrong is not a demand. It is
  // still the most useful thing to show someone who has nothing to answer.
  const idle = state.sessions.filter((s) => s.status === "waiting");

  if (working.length === 0 && idle.length === 0) {
    const hasRepos = state.repos.length > 0;
    return (
      <div className="inbox">
        <Empty
          title="Nothing needs you"
          action={
            <a className="btn btn-primary btn-md" href={hasRepos ? "#/sessions" : "#/settings"}>
              <Icon.plus size={15} />
              {hasRepos ? "Start a session" : "Add a repository"}
            </a>
          }
        >
          {hasRepos
            ? "No agent is running and nothing is waiting on a decision. Start a session; anything that needs you will appear here."
            : "No repositories are registered, so there is nothing to run an agent against. Add one in Settings first."}
        </Empty>
      </div>
    );
  }

  return (
    <div className="inbox">
      <Empty title="Nothing needs you">
        Nothing is asking for a decision. Permission requests, failures, and
        finished work waiting on review all land here.
      </Empty>

      {working.length > 0 && (
        <QuietGroup
          heading={`Working now — ${working.length}`}
          sessions={working}
          onOpenSession={onOpenSession}
        />
      )}

      {idle.length > 0 && (
        <QuietGroup
          heading={`Idle — ${idle.length}`}
          note="These finished a turn and are holding their conversation open. Nothing is wrong with them; they are waiting for a next instruction whenever you have one."
          sessions={idle}
          action={(s) => (
            <SessionLink
              id={s.id}
              onOpenSession={onOpenSession}
              className="btn btn-default btn-sm"
            >
              Reply
            </SessionLink>
          )}
          onOpenSession={onOpenSession}
        />
      )}
    </div>
  );
}

function QuietGroup({
  heading,
  note,
  sessions,
  action,
  onOpenSession,
}: {
  heading: string;
  note?: string;
  sessions: Session[];
  action?: (s: Session) => ReactNode;
  onOpenSession: (id: string) => void;
}) {
  return (
    <div className="inbox-running">
      <h4>{heading}</h4>
      {note && <p className="hint">{note}</p>}
      <ul className="inbox-list">
        {sessions.map((s) => (
          <li className="inbox-row quiet" key={s.id}>
            <div className="inbox-row-main">
              <SessionLink id={s.id} onOpenSession={onOpenSession}>
                {s.title}
              </SessionLink>
              <div className="inbox-meta">
                <StatusPill status={s.status} />
                <RepoBranch session={s} />
                <span>{s.toolCalls} tool calls</span>
                <RelativeTime ts={s.updatedAt} />
              </div>
            </div>
            {action && <div className="inbox-actions">{action(s)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * `repo · branch`, with the repo shortened to its last path segment.
 *
 * A local repo's `ref` is an absolute path — worktrees under a temp dir run to
 * ~90 characters, which wraps the row onto two lines and pushes the branch out
 * of sight. The last segment is what identifies the repo to a person; the full
 * path stays on the title so it is still recoverable without leaving the row.
 */
function RepoBranch({ session }: { session: Session }) {
  return (
    <span className="mono" title={`${session.repo} · ${session.branch}`}>
      {repoShort(session.repo)} · {session.branch}
    </span>
  );
}

// -------------------------------------------------------------- navigation

/**
 * A real link, so middle-click and copy-link work, that still routes through
 * `onOpenSession` for an ordinary click. The href matches `App`'s `hrefOf`.
 */
function SessionLink({
  id,
  onOpenSession,
  className = "inbox-title",
  children,
}: {
  id: string;
  onOpenSession: (id: string) => void;
  className?: string;
  children: ReactNode;
}) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    // Let the browser handle "open in a new tab" and friends.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onOpenSession(id);
  }
  return (
    <a className={className} href={`#/sessions/${encodeURIComponent(id)}`} onClick={onClick}>
      {children}
    </a>
  );
}

// ------------------------------------------------------------- session rows

function SessionRow({
  session,
  attention,
  kind,
  pr,
  onOpenSession,
}: {
  session: Session;
  attention: Attention;
  kind: InboxKind;
  pr: PrInfo | null;
  onOpenSession: (id: string) => void;
}) {
  const { pending, error, run } = useAction();

  return (
    <li className={`inbox-row kind-${kind}`}>
      <div className="inbox-row-main">
        <div className="inbox-row-head">
          <SessionLink id={session.id} onOpenSession={onOpenSession}>
            {session.title}
          </SessionLink>
          <AttentionBadge attention={attention} />
        </div>

        {kind === "approval" && session.permission && (
          <PermissionDetail permission={session.permission} />
        )}

        <div className="inbox-meta">
          <StatusPill status={session.status} />
          <RepoBranch session={session} />
          {pr && (
            <span className="mono">
              #{pr.number}
              {pr.isDraft && " (draft)"}
            </span>
          )}
          <RelativeTime ts={session.updatedAt} />
        </div>

        {error && (
          <p className="inbox-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="inbox-actions">
        <SessionActions
          session={session}
          kind={kind}
          pr={pr}
          pending={pending}
          run={run}
          onOpenSession={onOpenSession}
        />
      </div>
    </li>
  );
}

/**
 * The thing you would actually do next, done here where that is possible — an
 * approval is answered inline and a halted run restarts inline, rather than
 * every row offering the same "Open" the old Conductor did.
 */
function SessionActions({
  session,
  kind,
  pr,
  pending,
  run,
  onOpenSession,
}: {
  session: Session;
  kind: InboxKind;
  pr: PrInfo | null;
  pending: string | null;
  run: RunAction;
  onOpenSession: (id: string) => void;
}) {
  const open = (
    <SessionLink id={session.id} onOpenSession={onOpenSession} className="btn btn-default btn-md">
      Open session
    </SessionLink>
  );

  const resume = (
    <Button
      variant="primary"
      icon={Icon.play}
      loading={pending === "resume"}
      disabled={pending !== null}
      onClick={() => run("resume", () => api.resumeSession(session.id))}
    >
      Resume
    </Button>
  );

  switch (kind) {
    case "approval":
      return (
        <>
          <Button
            variant="primary"
            icon={Icon.check}
            loading={pending === "approve"}
            disabled={pending !== null}
            onClick={() => run("approve", () => api.replyPermission(session.id, true))}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            icon={Icon.x}
            loading={pending === "deny"}
            disabled={pending !== null}
            onClick={() => run("deny", () => api.replyPermission(session.id, false))}
          >
            Deny
          </Button>
          {open}
        </>
      );

    case "flagged":
      return (
        <>
          {resume}
          {open}
        </>
      );

    // Covers `dead` and `failed` alike — `attentionOf` folds them together, and
    // resume handles both: it continues the omp conversation when there is one
    // and re-runs the original prompt when the spawn died before opening one.
    // Dismiss is here rather than on `flagged` because "that one was never
    // going to work" is a real answer to a failure and not to a supervisor stop.
    case "failed":
      return (
        <>
          {resume}
          {open}
          <Button
            variant="ghost"
            icon={Icon.archive}
            loading={pending === "archive"}
            disabled={pending !== null}
            onClick={() => run("archive", () => api.archiveSession(session.id))}
          >
            Dismiss
          </Button>
        </>
      );

    case "review":
      return (
        <>
          <PrLink session={session} pr={pr} />
          {open}
        </>
      );
  }
}

/**
 * `pr` comes from the cold-cached PR list, which can lag the session's own
 * `prNumber` by a few seconds. The number is enough to build the link, so a
 * cache that has not caught up costs the PR's title, not the ability to open it.
 */
function PrLink({ session, pr }: { session: Session; pr: PrInfo | null }) {
  const href =
    pr?.url ??
    (session.repoFullName && session.prNumber !== null
      ? `https://github.com/${session.repoFullName}/pull/${session.prNumber}`
      : null);
  if (!href) return null;

  const number = pr?.number ?? session.prNumber;
  return (
    <a className="btn btn-primary btn-md" href={href} target="_blank" rel="noreferrer">
      <Icon.external size={15} />
      Review PR #{number}
    </a>
  );
}

/**
 * What the agent actually asked for, so the answer is not a blind yes.
 *
 * `attentionOf` only returns `approval` for `blocked && permission`, so a
 * restarted session whose in-memory request died falls through to its status
 * and offers Resume instead of an Approve button that could only fail. The
 * caller still narrows on `permission` rather than trusting that across a
 * module boundary — the cost of being wrong is a missing paragraph, not a
 * crash, and this panel is the one screen a blocked session forces you to open.
 */
function PermissionDetail({ permission }: { permission: PermissionRequest }) {
  return (
    <p className="inbox-permission">
      <span className="mono">{permission.tool}</span> — {permission.title}
    </p>
  );
}

// ------------------------------------------------------------------ actions

type RunAction = (name: string, fn: () => Promise<unknown>) => void;

/**
 * One in-flight action per row, with its failure kept next to the button that
 * caused it. A failed Approve must never look like a successful one.
 */
function useAction(): { pending: string | null; error: string | null; run: RunAction } {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback<RunAction>((name, fn) => {
    setPending(name);
    setError(null);
    fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPending(null));
  }, []);

  return { pending, error, run };
}
