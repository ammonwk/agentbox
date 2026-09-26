import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AppState, ProviderId } from "../../../../src/core/types";
import { api, fmtCost, fmtTokens, guessHome, tildify } from "../../api";
import {
  AccountChip,
  ContextBar,
  CopyButton,
  HostBadge,
  PROVIDER_LABEL,
  ProviderBadge,
  StatusDot,
  StatusPill,
} from "../../bits";
import { Button, Confirm, Empty, Icon, RelativeTime } from "../../components";
import { filterSessions, neighbourId, sectionsOf, sentTip, titleOf, usualProvider, type Nested, type Section, type SessionRow } from "../../lib/board";
import { openParents } from "../Board";
import { hrefOf, SESSION_TABS, type SessionTab } from "../../route";
import { Composer } from "./Composer";
import { DiffPanel } from "./DiffPanel";
import { LoadPanel } from "./LoadPanel";
import { useAction } from "./useAction";
import { useOpenProject } from "../project";
import { useIsNarrow } from "./useIsNarrow";
import { prBaseFor } from "../../lib/prlinks";
import { PrBase } from "./prbase";
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
  // Folded as on the board, but never with this session folded out of sight.
  const sections = useMemo(() => {
    const byId = new Map(state.sessions.map((s) => [s.id, s]));
    const above = new Set<string>();
    for (let p = session?.parent; p && !above.has(p); p = byId.get(p)?.parent) above.add(p);
    return sectionsOf(
      filterSessions(
        state.sessions.filter((s) => s.id !== state.project.sessionId),
        { query: "", provider: "all", account: "all", repo: "all", showArchived: session?.status === "archived" },
      ),
      (id) => openParents.has(id) || above.has(id),
    );
  }, [state.sessions, state.project.sessionId, session?.status, session?.parent]);
  const ordered = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
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
      {wide ? <Rail sections={sections} state={state} current={id} /> : null}
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
function Rail({ sections, state, current }: { sections: Section<Nested<SessionRow>>[]; state: AppState; current: string }) {
  const usual = useMemo(() => usualProvider(sections.flatMap((s) => s.rows)), [sections]);
  const cur = useRef<HTMLAnchorElement>(null);
  // A block body, not `() => el.scrollIntoView()`: newer browsers return a
  // Promise from scrollIntoView, and React calls whatever an effect returns as
  // its cleanup — `destroy is not a function` took the whole app down.
  useEffect(() => {
    cur.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <nav className="rail" aria-label="Sessions">
      <RailProject state={state} current={current} />
      <div className="rail-scroll">
        {sections.map((sec) => (
          <div key={sec.kind} className="rail-sec" data-kind={sec.kind}>
            <div className="rail-label">
              {sec.label} <span>{sec.rows.filter((s) => s.depth === 0).length}</span>
            </div>
            {sec.rows.map((s) => (
              <a
                key={s.id}
                ref={s.id === current ? cur : undefined}
                className="rail-row"
                href={hrefOf({ page: "session", id: s.id, tab: "terminal" })}
                aria-current={s.id === current ? "page" : undefined}
                data-status={s.status}
                data-depth={s.depth || undefined}
                style={s.depth ? ({ "--depth": s.depth } as CSSProperties) : undefined}
                title={railTip(s)}
              >
                <StatusDot status={s.status} />
                <span className="rail-title">{titleOf(s)}</span>
                {s.provider !== usual ? <ProviderBadge provider={s.provider} short /> : null}
                <span className="rail-when">
                  <RelativeTime ts={s.lastPromptAt} short title={sentTip(s)} />
                </span>
              </a>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

/** What the row no longer spells out, on hover. */
function railTip(s: SessionRow): string {
  const said = s.status === "blocked" ? s.attention.reason : s.lastMessage ?? s.lastPrompt ?? s.firstPrompt;
  return [titleOf(s), said ? said.replace(/\s+/g, " ").slice(0, 240) : null].filter(Boolean).join("\n\n");
}

/** The Project session, pinned above the rail's scroll so it is one click
 *  from any session. */
function RailProject({ state, current }: { state: AppState; current: string }) {
  const p = useOpenProject(state, (id) => (location.hash = hrefOf({ page: "session", id, tab: "terminal" })));
  return (
    <button
      type="button"
      className="rail-project"
      aria-current={p.session?.id === current ? "page" : undefined}
      disabled={p.busy}
      title={p.error ?? "The Project session: sees and manages every session"}
      onClick={() => void p.open()}
    >
      <StatusDot status={p.running ? p.session!.status : "stopped"} />
      <Icon.sessions size={13} />
      <span className="rail-title">Project</span>
      <ProviderBadge provider={state.project.provider} short />
    </button>
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
  const home = useMemo(() => guessHome(state.accounts.map((a) => a.home).concat(state.sessions.map((s) => s.cwd))), [state.accounts, state.sessions]);
  // listPrs matched it by branch; the newest-updated one wins if there are several.
  const pr = state.prs.find((p) => p.sessionId === session.id) ?? null;
  const attach = `agentbox attach ${session.id}`;
  const isProject = session.id === state.project.sessionId;
  const sessionIds = useMemo(() => new Set(state.sessions.map((s) => s.id)), [state.sessions]);
  const openSession = (id: string) => (location.hash = hrefOf({ page: "session", id, tab }));
  const prBase = useMemo(() => prBaseFor(session, state), [session, state]);

  return (
    <div className="sv-main">
      <header className="sx-header">
        <div className="sx-header-top">
          <ProviderBadge provider={session.provider} />
          <TitleEdit session={session} />
          <CopyButton text={session.id} label={session.id} className="sx-id" />
          <StatusPill status={session.status} />
          {/* tmux is the normal case; only say where it runs when it is not ours. */}
          {session.host === "external" ? <HostBadge host={session.host} /> : null}

          <div className="sx-header-actions">
            {isProject ? (
              <>
                <select
                  className="sx-harness"
                  aria-label="Project harness"
                  title="Which agent runs the Project. Changing it starts a fresh one."
                  value={state.project.provider}
                  disabled={busy}
                  onChange={(e) => void run(async () => openSession((await api.project(e.target.value as ProviderId)).id))}
                >
                  {state.providers.filter((p) => p.installed).map((p) => (
                    <option key={p.id} value={p.id}>
                      {PROVIDER_LABEL[p.id]}
                    </option>
                  ))}
                </select>
                {state.project.canCompact && session.host === "tmux" ? (
                  <Button size="sm" icon={Icon.move} disabled={busy} title="Summarise the conversation so far to free context" onClick={() => void run(() => api.compactProject())}>
                    Compact
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  icon={Icon.refresh}
                  disabled={busy}
                  title="Start a fresh Project conversation; this one is archived"
                  onClick={() => void run(async () => openSession((await api.clearProject()).id))}
                >
                  Clear
                </Button>
              </>
            ) : null}
            {session.host === "tmux" ? <CopyButton text={attach} label={attach} className="attach-copy" /> : null}
            <button
              type="button"
              className="sx-big"
              aria-pressed={session.big}
              disabled={busy}
              title={session.big ? "Big session: claims the larger share of the account's weekly. Click to make it normal." : "Mark as Big: claims the larger share of the account's weekly"}
              onClick={() => void run(() => api.patchSession(session.id, { big: !session.big }))}
            >
              <Icon.bolt size={12} /> Big
            </button>
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
            {isProject ? null : session.status === "archived" ? (
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
            <AccountChip
              accountId={session.accountId}
              accounts={state.accounts}
              cold={session.cold}
              onClick={() => (location.hash = hrefOf({ page: "accounts", sub: "accounts" }))}
            />
          </span>
          <span className="fact mono fact-cwd" title={session.cwd}>
            <Icon.folder size={12} />
            <span className="fact-cwd-text">
              <span dir="ltr">{tildify(session.cwd, home)}</span>
            </span>
          </span>
          {session.branch ? (
            <span className="fact mono">
              <Icon.branch size={12} /> {session.branch}
            </span>
          ) : null}
          {session.model ? (
            <span className="fact mono">
              {session.model}
              {session.effort ? <span className="muted"> · {session.effort}</span> : null}
            </span>
          ) : null}
          <span className="fact">
            <ContextBar used={session.contextUsed} limit={session.contextLimit} wide />
          </span>
          <span
            className="fact"
            title={`input ${session.tokens.input.toLocaleString()} · output ${session.tokens.output.toLocaleString()} · cache read ${session.tokens.cacheRead.toLocaleString()} · cache write ${session.tokens.cacheWrite.toLocaleString()}\nCost is what these tokens would cost at API prices — the common unit usage is apportioned in.\nStarted ${new Date(session.startedAt).toLocaleString()}`}
          >
            {fmtTokens(session.tokens.input + session.tokens.output)} tok · {fmtTokens(session.tokens.cacheRead)} cached ·{" "}
            <span className="muted">≈{fmtCost(session.tokens.costEquiv)}</span>
          </span>
          {pr && (
            <a className="fact" href={pr.url} target="_blank" rel="noreferrer">
              <Icon.prs size={12} /> #{pr.number}
              {pr.isDraft ? " (draft)" : ""}
            </a>
          )}
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

      <PrBase.Provider value={prBase}>
      <div className="sv-body" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "terminal" ? (
          session.host === "tmux" ? (
            <Suspense fallback={<Empty title="Loading the terminal…" />}>
              <Terminal sessionId={session.id} sessionIds={sessionIds} prBase={prBase} />
            </Suspense>
          ) : (
            <TranscriptInstead session={session} busy={busy} onAdopt={() => void run(() => api.adopt(session.id))} onResume={() => void run(() => api.resume(session.id))} />
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
      </PrBase.Provider>

      <Composer session={session} accounts={state.accounts} claimIdleMin={state.settings.balancer.claimIdleMin} />

      {confirmStop ? (
        <Confirm
          title={`Stop “${titleOf(session)}”?`}
          confirmLabel="Stop"
          body={
            <p>
              Ends the {PROVIDER_LABEL[session.provider]} process
              {session.host === "external" ? " running in your other terminal" : " and its tmux session"}. The conversation is kept and Resume
              continues it — on the same account while its cache is warm, on whichever has room once it has been idle an hour.
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

/**
 * The Terminal tab when there is no terminal to attach to: the conversation
 * itself, under one line saying why it is not live and how to make it so.
 * Reading a stopped session should not cost a resume.
 */
function TranscriptInstead({
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
  const external = session.host === "external";
  return (
    <div className="term-transcript">
      <div className="term-transcript-bar">
        <Icon.terminal size={13} />
        {external ? (
          <span>
            Running in a terminal agentbox did not start, so there is no live terminal here — this is its transcript. Adopt it to take it over:
            agentbox proves the conversation resumes, stops that process, and continues it in its own tmux.
          </span>
        ) : (
          <span>
            {session.status === "archived" ? "Archived" : "Stopped"} — this is its transcript. Resume, or type a prompt below, to get the live
            terminal back
            {session.cold ? " on whichever account has room (its cache is cold)" : " on the same account"}.
          </span>
        )}
        {external ? (
          <Button size="sm" variant="primary" icon={Icon.link} loading={busy} onClick={onAdopt}>
            Adopt
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon={Icon.play} loading={busy} onClick={onResume}>
            Resume
          </Button>
        )}
      </div>
      <Suspense fallback={<Empty title="Loading the transcript…" />}>
        <Timeline session={session} />
      </Suspense>
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
