import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../../../../src/core/types";
import { api, fmtCost, fmtTokens, guessHome, tildify } from "../../api";
import {
  AccountChip,
  BigBadge,
  ContextBar,
  CopyButton,
  HostBadge,
  PROVIDER_LABEL,
  ProviderBadge,
  StatusPill,
} from "../../bits";
import { Button, Confirm, Empty, Icon, RelativeTime, Toggle } from "../../components";
import { filterSessions, neighbourId, sectionsOf, titleOf, type SessionRow } from "../../lib/board";
import { usageSummary } from "../../lib/usage";
import { hrefOf, SESSION_TABS, type SessionTab } from "../../route";
import { Composer } from "./Composer";
import { DiffPanel } from "./DiffPanel";
import { LoadPanel } from "./LoadPanel";
import { useAction } from "./useAction";
import { useIsNarrow } from "./useIsNarrow";
import "./session.css";

const Terminal = lazy(() => import("./Terminal"));
// The timeline carries the markdown renderer, the second-heaviest dependency.
const Timeline = lazy(() => import("./Timeline").then((m) => ({ default: m.Timeline })));

const TAB_LABEL: Record<SessionTab, string> = {
  terminal: "Terminal",
  timeline: "Timeline",
  diff: "Diff",
  load: "Load",
};

/** Wide enough for a session rail beside the detail without squeezing the terminal. */
const RAIL_MIN_PX = 1280;

export function SessionView({
  state,
  id,
  tab,
  onTab,
  onOpen,
}: {
  state: AppState;
  id: string;
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
  onOpen: (id: string) => void;
}) {
  const session = state.sessions.find((s) => s.id === id) ?? null;
  const wide = useWide(RAIL_MIN_PX);

  // j/k switch sessions from anywhere that is not a text field or the terminal.
  const ordered = useMemo(
    () => sectionsOf(filterSessions(state.sessions, { query: "", provider: "all", account: "all", repo: "all", showArchived: session?.status === "archived" })).flatMap((s) => s.rows),
    [state.sessions, session?.status],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest(".xterm") || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector(".modal-backdrop")) return;
      if (e.key === "j" || e.key === "k") {
        const next = neighbourId(ordered, id, e.key === "j" ? 1 : -1);
        if (next && next !== id) {
          e.preventDefault();
          onOpen(next);
        }
      } else if (/^[1-4]$/.test(e.key)) {
        onTab(SESSION_TABS[Number(e.key) - 1]);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [ordered, id, onOpen, onTab]);

  return (
    <div className="sv" data-rail={wide ? "on" : "off"}>
      {wide ? <Rail rows={ordered} state={state} current={id} /> : null}
      {session ? (
        <Detail key={session.id} session={session} state={state} tab={tab} onTab={onTab} />
      ) : (
        <div className="sv-main">
          <Empty title="No such session" action={<a className="btn" href={hrefOf({ page: "sessions" })}>Back to sessions</a>}>
            <p>
              Nothing on the board has the id <code>{id}</code>. It may have been older than the board&apos;s{" "}
              {state.settings.boardDays}-day window, or the link is from another machine.
            </p>
          </Empty>
        </div>
      )}
    </div>
  );
}

function useWide(px: number): boolean {
  const narrow = useIsNarrow();
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.innerWidth >= px);
  useEffect(() => {
    const mq = matchMedia(`(min-width: ${px}px)`);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return wide && !narrow;
}

// -------------------------------------------------------------------- rail

/** The fleet, demoted to a sidebar while you work on one session. Same order
 *  and sections as the board, so a session is never somewhere else here. */
function Rail({ rows, state, current }: { rows: SessionRow[]; state: AppState; current: string }) {
  const sections = useMemo(() => sectionsOf(rows), [rows]);
  const cur = useRef<HTMLAnchorElement>(null);
  useEffect(() => cur.current?.scrollIntoView({ block: "nearest" }), [current]);
  return (
    <nav className="rail" aria-label="Sessions">
      {sections.map((sec) => (
        <div key={sec.kind} className="rail-sec" data-kind={sec.kind}>
          <div className="rail-label">
            {sec.label} <span>{sec.rows.length}</span>
          </div>
          {sec.rows.map((s) => (
            <a
              key={s.id}
              ref={s.id === current ? cur : undefined}
              className="rail-row"
              href={hrefOf({ page: "session", id: s.id, tab: "terminal" })}
              aria-current={s.id === current ? "page" : undefined}
              data-status={s.status}
            >
              <span className="rail-top">
                <span className={`rail-dot st-${s.status}`} aria-hidden="true" />
                <ProviderBadge provider={s.provider} short />
                <span className="rail-title">{titleOf(s)}</span>
              </span>
              <span className="rail-sub">
                <AccountChip accountId={s.accountId} accounts={state.accounts} />
                <span className="rail-when">
                  <RelativeTime ts={s.lastActivityAt} />
                </span>
              </span>
            </a>
          ))}
        </div>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------------ detail

function Detail({
  session,
  state,
  tab,
  onTab,
}: {
  session: SessionRow;
  state: AppState;
  tab: SessionTab;
  onTab: (t: SessionTab) => void;
}) {
  const { run, busy, error, clear } = useAction();
  const [confirmStop, setConfirmStop] = useState(false);
  const account = state.accounts.find((a) => a.id === session.accountId) ?? null;
  const home = useMemo(() => guessHome(state.accounts.map((a) => a.home).concat(state.sessions.map((s) => s.cwd))), [state.accounts, state.sessions]);
  // listPrs matched it by branch; the newest-updated one wins if there are several.
  const pr = state.prs.find((p) => p.sessionId === session.id) ?? null;
  const attach = `agentbox attach ${session.id}`;
  const usageText = account ? usageSummary(account) : "";

  return (
    <div className="sv-main">
      <header className="sx-header">
        <div className="sx-header-top">
          <ProviderBadge provider={session.provider} />
          <TitleEdit session={session} />
          <StatusPill status={session.status} />
          <HostBadge host={session.host} />
          {session.big ? <BigBadge /> : null}

          <div className="sx-header-actions">
            {session.host === "tmux" ? <CopyButton text={attach} label={attach} className="attach-copy" /> : null}
            {session.host === "external" ? (
              <Button size="sm" variant="primary" icon={Icon.link} loading={busy} onClick={() => void run(() => api.adopt(session.id))}>
                Adopt
              </Button>
            ) : null}
            {session.host === "none" ? (
              <Button size="sm" variant="primary" icon={Icon.play} loading={busy} onClick={() => void run(() => api.resume(session.id))}>
                Resume
              </Button>
            ) : null}
            {session.host !== "none" ? (
              <Button size="sm" icon={Icon.stop} disabled={busy} onClick={() => setConfirmStop(true)}>
                Stop
              </Button>
            ) : null}
            {session.status === "archived" ? (
              <Button size="sm" variant="ghost" icon={Icon.undo} disabled={busy} onClick={() => void run(() => api.archive(session.id, false))}>
                Unarchive
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={Icon.archive}
                disabled={busy}
                title="Take it off the board. The transcript and worktree stay; it can be resumed."
                onClick={() => void run(() => api.archive(session.id, true))}
              >
                Archive
              </Button>
            )}
          </div>
        </div>

        <div className="sx-facts">
          <span className="fact">
            <AccountChip accountId={session.accountId} accounts={state.accounts} detail={usageText || undefined} onClick={() => (location.hash = hrefOf({ page: "accounts", sub: "accounts" }))} />
          </span>
          <span className="fact mono" title={session.cwd}>
            <Icon.folder size={12} /> {tildify(session.cwd, home)}
          </span>
          {session.branch ? (
            <span className="fact mono">
              <Icon.branch size={12} /> {session.branch}
            </span>
          ) : null}
          {session.model ? <span className="fact mono">{session.model}</span> : null}
          <span className="fact">
            <ContextBar used={session.contextUsed} limit={session.contextLimit} wide />
          </span>
          <span
            className="fact"
            title={`input ${session.tokens.input.toLocaleString()} · output ${session.tokens.output.toLocaleString()} · cache read ${session.tokens.cacheRead.toLocaleString()} · cache write ${session.tokens.cacheWrite.toLocaleString()}\nCost is what these tokens would cost at API prices — the common unit usage is apportioned in.`}
          >
            {fmtTokens(session.tokens.input + session.tokens.output)} tok · {fmtTokens(session.tokens.cacheRead)} cached ·{" "}
            <span className="muted">≈{fmtCost(session.tokens.costEquiv)}</span>
          </span>
          <span className="fact">
            started <RelativeTime ts={session.startedAt} />
          </span>
          {pr && (
            <a className="fact" href={pr.url} target="_blank" rel="noreferrer">
              <Icon.prs size={12} /> #{pr.number}
              {pr.isDraft ? " (draft)" : ""}
            </a>
          )}
          <span className="fact big-toggle">
            <Toggle
              checked={session.big}
              disabled={busy}
              label="Big"
              onChange={(v) => void run(() => api.patchSession(session.id, { big: v }))}
            />
          </span>
        </div>

        {session.status === "blocked" || error ? (
          <div className="sx-attention-line bad" role={error ? "alert" : undefined}>
            {error ? (
              <>
                That did not work: {error}{" "}
                <button className="linkish" onClick={clear}>
                  dismiss
                </button>
              </>
            ) : (
              <>
                <Icon.alert size={13} /> {session.attention.reason}. The Terminal tab shows the prompt.
              </>
            )}
          </div>
        ) : null}

        <div className="sx-tabs" role="tablist" aria-label="Session views">
          {SESSION_TABS.map((t, i) => (
            <button
              key={t}
              className="sx-tab"
              role="tab"
              aria-selected={tab === t}
              title={`${TAB_LABEL[t]} (${i + 1})`}
              onClick={() => onTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </header>

      <div className="sv-body" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "terminal" ? (
          session.host === "tmux" ? (
            <Suspense fallback={<Empty title="Loading the terminal…" />}>
              <Terminal sessionId={session.id} attach={attach} />
            </Suspense>
          ) : (
            <TermPlaceholder session={session} busy={busy} onAdopt={() => void run(() => api.adopt(session.id))} onResume={() => void run(() => api.resume(session.id))} />
          )
        ) : tab === "timeline" ? (
          <Suspense fallback={<Empty title="Loading the timeline…" />}>
            <Timeline session={session} />
          </Suspense>
        ) : tab === "diff" ? (
          <DiffPanel sessionId={session.id} active={session.status === "running"} />
        ) : (
          <LoadPanel sessionId={session.id} />
        )}
      </div>

      <Composer session={session} />

      {confirmStop ? (
        <Confirm
          title={`Stop “${titleOf(session)}”?`}
          confirmLabel="Stop"
          body={
            <p>
              Ends the {PROVIDER_LABEL[session.provider]} process
              {session.host === "external" ? " running in your other terminal" : " and its tmux session"}. The conversation is kept and Resume
              continues it on the same account.
            </p>
          }
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            void run(() => api.stop(session.id));
          }}
        />
      ) : null}
    </div>
  );
}

function TermPlaceholder({
  session,
  busy,
  onAdopt,
  onResume,
}: {
  session: SessionRow;
  busy: boolean;
  onAdopt: () => void;
  onResume: () => void;
}) {
  return (
    <div className="term-placeholder">
      {session.host === "external" ? (
        <Empty
          title="Running in another terminal"
          action={
            <Button variant="primary" icon={Icon.link} loading={busy} onClick={onAdopt}>
              Adopt it here
            </Button>
          }
        >
          <p>
            This {PROVIDER_LABEL[session.provider]} session was started outside agentbox, so there is no tmux to attach to. Adopt it to control
            it here: agentbox proves the conversation will resume, stops that process, and continues it in its own tmux on the same
            account. The Timeline tab already shows what it is doing.
          </p>
        </Empty>
      ) : (
        <Empty
          title={session.status === "archived" ? "Archived" : "Stopped"}
          action={
            <Button variant="primary" icon={Icon.play} loading={busy} onClick={onResume}>
              Resume
            </Button>
          }
        >
          <p>
            No process is running. Resume starts {PROVIDER_LABEL[session.provider]} again in agentbox&apos;s tmux with this conversation,
            on the account it started on — or type a prompt below to resume with it.
          </p>
        </Empty>
      )}
    </div>
  );
}

/** The title, click to rename. Clearing it falls back to the derived title. */
function TitleEdit({ session }: { session: SessionRow }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const { run, busy } = useAction();
  const title = titleOf(session);

  if (!editing) {
    return (
      <h2 className="sx-title">
        <button
          className="sx-title-btn"
          title="Rename"
          onClick={() => {
            setDraft(session.label ?? title);
            setEditing(true);
          }}
        >
          <span className="sx-title-text">{title}</span>
          <Icon.edit size={13} className="sx-title-pen" />
        </button>
      </h2>
    );
  }

  const commit = async () => {
    const next = draft.trim();
    if (next === (session.label ?? title)) {
      setEditing(false);
      return;
    }
    if (await run(() => api.patchSession(session.id, { label: next || null }))) setEditing(false);
  };

  return (
    <input
      className="sx-title-input"
      aria-label="Session label"
      autoFocus
      value={draft}
      disabled={busy}
      placeholder={session.title || "Label"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setEditing(false);
        }
      }}
    />
  );
}
