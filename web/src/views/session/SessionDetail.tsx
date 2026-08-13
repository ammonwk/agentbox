import { useState, useSyncExternalStore } from "react";
import type { Attention, Session } from "../../../../src/core/types";
import { api, clockNow, fmtCost, fmtDuration, fmtTokens, repoShort, subscribeToClock } from "../../api";
import { AttentionBadge, Button, Confirm, Icon, RelativeTime, StatusPill } from "../../components";
import { Activity } from "./Activity";
import { DiffPanel } from "./DiffPanel";
import { Steer } from "./Steer";
import { canInterrupt, canResume, RESUME_HINT, shortModel } from "./format";
import { useAction } from "./useAction";

type Tab = "activity" | "diff" | "task";

export function SessionDetail({
  session,
  attention,
  onDeleted,
}: {
  session: Session;
  attention: Attention;
  onDeleted: () => void;
}) {
  const [tab, setTab] = useState<Tab>("activity");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { run, busy, error } = useAction();
  // The shared 1s ticker, so a running session's elapsed time moves without
  // this screen owning an interval of its own.
  const now = useSyncExternalStore(subscribeToClock, clockNow);
  const elapsed = session.startedAt == null ? "—" : fmtDuration(Math.max(0, now - session.startedAt));

  return (
    <div className="sx-detail">
      <div className="sx-header">
        <div className="sx-header-top">
          <h2>{session.title}</h2>
          <StatusPill status={session.status} />
          <div className="sx-header-actions">
            {canInterrupt(session) && (
              <Button
                size="sm"
                icon={Icon.stop}
                disabled={busy}
                onClick={() => void run(() => api.interruptSession(session.id))}
              >
                Interrupt
              </Button>
            )}
            {canResume(session) && (
              // One click, always available on a halted session: a supervisor
              // whose stop is expensive to undo gets switched off.
              <Button
                size="sm"
                variant="primary"
                icon={Icon.play}
                title={RESUME_HINT}
                disabled={busy}
                onClick={() => void run(() => api.resumeSession(session.id))}
              >
                Resume
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={Icon.archive}
              disabled={busy || session.archivedAt != null}
              title={session.archivedAt ? "Already archived" : "Archive this session"}
              onClick={() => void run(() => api.archiveSession(session.id))}
            >
              {session.archivedAt ? "Archived" : "Archive"}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={Icon.trash}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </div>
        </div>

        <div className="sx-facts">
          <span title={session.repo}>{repoShort(session.repo)}</span>
          <code>{session.branch}</code>
          <span>{shortModel(session.model)}</span>
          <span>{elapsed} elapsed</span>
          <span>
            {fmtCost(session.costUsd)} · {fmtTokens(session.tokens)} tok
          </span>
          <span>
            {session.toolCalls} tool call{session.toolCalls === 1 ? "" : "s"}
          </span>
          {session.followUps > 0 && <span>{session.followUps} follow-up{session.followUps === 1 ? "" : "s"}</span>}
          <span>
            updated <RelativeTime ts={session.updatedAt} />
          </span>
          {session.prNumber != null && session.repoFullName && (
            <a
              href={`https://github.com/${session.repoFullName}/pull/${session.prNumber}`}
              target="_blank"
              rel="noreferrer"
            >
              PR #{session.prNumber}
            </a>
          )}
          {session.exitCode != null && session.exitCode !== 0 && (
            <span style={{ color: "var(--danger)" }}>exit {session.exitCode}</span>
          )}
        </div>

        {(attention.kind !== "none" || session.flagReason) && (
          <div className={`sx-attention-line ${session.status === "flagged" ? "flagged" : ""}`}>
            {/* AttentionBadge already carries the label, so only the flag
                reason — which nothing else on the header shows — is added. */}
            <AttentionBadge attention={attention} />
            {session.flagReason && (
              <div style={{ marginTop: 6 }}>
                <strong>The supervisor halted this run:</strong> {session.flagReason}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="sx-attention-line" style={{ borderColor: "var(--danger)" }}>
            That action failed: {error}
          </div>
        )}

        <div className="sx-tabs" role="tablist" aria-label="Session detail">
          <TabButton id="activity" tab={tab} setTab={setTab} label="Activity" count={session.toolCalls} />
          <TabButton id="diff" tab={tab} setTab={setTab} label="Diff" />
          <TabButton id="task" tab={tab} setTab={setTab} label="Task" />
        </div>
      </div>

      {tab === "activity" && <Activity session={session} />}
      {tab === "diff" && (
        <DiffPanel
          sessionId={session.id}
          active={session.status === "running" || session.status === "spawning"}
        />
      )}
      {tab === "task" && <TaskPanel session={session} />}

      <Steer session={session} />

      {confirmDelete && (
        <Confirm
          title="Delete this session?"
          body={
            <>
              The worktree at <code>{session.worktree ?? "(already gone)"}</code> and the branch{" "}
              <code>{session.branch}</code> are destroyed along with the record. Anything the agent
              wrote and did not push is lost. This cannot be undone.
            </>
          }
          danger
          confirmLabel="Delete session"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void run(async () => {
              await api.deleteSession(session.id);
              onDeleted();
            });
          }}
        />
      )}
    </div>
  );
}

function TabButton({
  id,
  tab,
  setTab,
  label,
  count,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      className="sx-tab"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
    >
      {label}
      {count != null && count > 0 && <span className="sx-tab-count">{count}</span>}
    </button>
  );
}

function TaskPanel({ session }: { session: Session }) {
  return (
    <div className="sx-panel">
      <div className="sx-facts" style={{ marginTop: 0, marginBottom: 10 }}>
        <span>
          Given <RelativeTime ts={session.createdAt} />
        </span>
        <span>{session.followUps} follow-up message{session.followUps === 1 ? "" : "s"} since</span>
      </div>
      <div className="sx-task-prompt">{session.prompt}</div>

      {session.flagReason && (
        <div className="sx-block verdict-spiraling" style={{ marginTop: 12 }}>
          <div className="sx-block-head">Flagged</div>
          <div className="sx-block-body">{session.flagReason}</div>
        </div>
      )}

      {session.lastMessage && (
        <div style={{ marginTop: 12 }}>
          <div className="sx-block-head">Last thing it said</div>
          <div className="sx-assistant">{session.lastMessage}</div>
        </div>
      )}
    </div>
  );
}
