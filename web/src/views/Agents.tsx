import { useEffect, useMemo, useState } from "react";
import type { AppState, Session } from "../api";
import { ago, fmtCost, fmtTokens, api, repoShort, type TranscriptLine } from "../api";
import { Icon, StatusPill, Empty, Modal } from "../components";

const SECTION_ORDER: { status: string; label: string }[] = [
  { status: "spawning", label: "Starting" },
  { status: "running", label: "Running" },
  { status: "waiting", label: "Waiting on you" },
  { status: "blocked", label: "Need your approval" },
  { status: "failed", label: "Failed" },
  { status: "dead", label: "Lost" },
  { status: "done", label: "Done" },
];

function groupSessions(sessions: Session[]): Map<string, Session[]> {
  const map = new Map<string, Session[]>();
  for (const s of sessions) {
    const key = s.blocked && s.status === "waiting" ? "blocked" : s.status;
    const arr = map.get(key) ?? [];
    arr.push(s);
    map.set(key, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => b.createdAt - a.createdAt);
  return map;
}

export function Agents({
  state, focusSessionId,
}: {
  state: AppState;
  focusSessionId: string | null;
}) {
  const [showNew, setShowNew] = useState(false);
  const [transcriptOf, setTranscriptOf] = useState<Session | null>(null);
  const [tl, setTl] = useState<TranscriptLine[] | null>(null);

  const groups = useMemo(() => groupSessions(state.sessions), [state.sessions]);
  const busy = state.sessions.filter((s) => s.status === "running" || s.status === "spawning").length;
  const blocked = state.sessions.filter((s) => s.status === "waiting" && s.blocked).length;

  async function openTranscript(s: Session) {
    setTranscriptOf(s);
    setTl(null);
    try {
      setTl(await api.transcript(s.id));
    } catch {
      setTl([]);
    }
  }

  // Poll the transcript while the modal is open so it streams live.
  useEffect(() => {
    if (!transcriptOf) return;
    const iv = setInterval(() => {
      api.transcript(transcriptOf.id).then(setTl).catch(() => {});
    }, 2000);
    return () => clearInterval(iv);
  }, [transcriptOf]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <div className="sub">
          {busy} active{blocked > 0 ? `, ${blocked} need approval` : ""}, {state.sessions.length} total
        </div>
        <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setShowNew(true)}>
          <Icon.plus size={14} /> New session
        </button>
      </div>

      {state.sessions.length === 0 && (
        <Empty title="No sessions yet">
          Spawn your first omp session — pick a repo, describe the task, and
          agentbox will create a worktree and run it. You can steer it live.
        </Empty>
      )}

      {SECTION_ORDER.map(({ status, label }) => {
        const list = groups.get(status);
        if (!list || list.length === 0) return null;
        return (
          <div key={status}>
            <div className="section-label">
              {label} · {list.length}
            </div>
            <div className="grid">
              {list.map((s) => (
                <SessionCard
                  key={s.id}
                  session={s}
                  highlighted={focusSessionId === s.id}
                  onOpenTranscript={() => openTranscript(s)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {showNew && <NewSessionForm state={state} onClose={() => setShowNew(false)} />}
      {transcriptOf && (
        <Modal
          title={transcriptOf.title}
          hint={`${repoShort(transcriptOf.repo)} · ${transcriptOf.branch}`}
          onClose={() => setTranscriptOf(null)}
        >
          <div style={{ maxHeight: "60vh", overflow: "auto" }} className="tl">
            {tl === null && <p style={{ color: "var(--muted)" }}>Loading…</p>}
            {tl !== null && tl.length === 0 && (
              <p style={{ color: "var(--muted)" }}>No transcript recorded.</p>
            )}
            {tl?.map((l, i) => (
              <div className={`msg ${l.role}`} key={i}>
                <div className="who">{l.role}</div>
                <pre>{l.text}</pre>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function SessionCard({
  session: s, highlighted, onOpenTranscript,
}: {
  session: Session;
  highlighted: boolean;
  onOpenTranscript: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [steer, setSteer] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const running = s.status === "running" || s.status === "spawning";

  async function sendSteer() {
    const text = steer.trim();
    if (!text || sending) return;
    setSending(true);
    setErr(null);
    try {
      await api.sendMessage(s.id, text);
      setSteer("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="card card-hover session-card"
      style={highlighted ? { borderColor: "var(--accent)", boxShadow: "var(--shadow-md)" } : undefined}
    >
      <div className="row1">
        <div className="title" style={{ cursor: "pointer" }} onClick={onOpenTranscript}>
          {s.title}
        </div>
        <StatusPill status={s.status} />
      </div>

      <div className="meta">
        <span title={s.repo}>{repoShort(s.repo)}</span>
        <code>{s.branch.replace("vk/ab-", "ab-")}</code>
        {s.prNumber && (
          <a href={`https://github.com/${s.repoFullName ?? ""}/pull/${s.prNumber}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
            PR #{s.prNumber}
          </a>
        )}
        <span>· {fmtTokens(s.tokens)} tok</span>
        <span>· {fmtCost(s.costUsd)}</span>
        {s.followUps > 0 && <span>· {s.followUps}× continued</span>}
      </div>

      {s.lastMessage && <div className="msg">{s.lastMessage}</div>}

      {s.blocked && s.permission && (
        <div
          style={{
            border: "1px solid var(--border-strong)",
            background: "var(--raised)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 12px",
          }}
        >
          <div style={{ fontSize: 12.5, marginBottom: 8 }}>
            <span style={{ fontWeight: 600 }}>Approval needed:</span>{" "}
            {s.permission.title}
            {s.permission.tool && (
              <span style={{ color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 11 }}> — {s.permission.tool}</span>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-primary" onClick={() => api.replyPermission(s.id, true)}>
              <Icon.check size={13} /> Approve
            </button>
            <button className="btn" onClick={() => api.replyPermission(s.id, false)}>
              Deny
            </button>
          </div>
        </div>
      )}

      <div className="meta" style={{ justifyContent: "space-between" }}>
        <span>{ago(s.updatedAt)}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
          {s.model.split("/").pop()}
          {s.waitingForInput && !s.blocked ? " · awaiting you" : ""}
        </span>
      </div>

      {/* steer */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="input"
          placeholder={running ? "Steer (queued until the turn ends)…" : "Tell the agent what's next…"}
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendSteer()}
          disabled={sending}
        />
        <button className="btn btn-primary" onClick={sendSteer} disabled={sending || !steer.trim()}>
          <Icon.play size={13} />
        </button>
      </div>
      {err && <p style={{ color: "var(--danger)", fontSize: 12 }}>{err}</p>}

      <div className="actions">
        {running && (
          <button className="btn" onClick={() => api.interruptSession(s.id)}>
            <Icon.stop size={13} /> Interrupt
          </button>
        )}
        <button className="btn" onClick={onOpenTranscript}>
          <Icon.chat size={13} /> Transcript
        </button>
        <button className="btn btn-ghost" onClick={() => api.archiveSession(s.id)} title="Archive">
          <Icon.archive size={13} />
        </button>
        <button className="btn btn-ghost" style={{ color: "var(--danger)" }} title="Delete" onClick={() => setDeleting(true)}>
          <Icon.trash size={13} />
        </button>
      </div>

      {deleting && (
        <Modal title="Delete this session?" hint="Removes the worktree, logs, and session record. This cannot be undone." onClose={() => setDeleting(false)}>
          <div className="actions">
            <button className="btn" onClick={() => setDeleting(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => { api.deleteSession(s.id); setDeleting(false); }}>
              <Icon.trash size={13} /> Delete
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NewSessionForm({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [repoId, setRepoId] = useState(state.repos[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(state.settings.model);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!repoId || !prompt.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.spawnSession(repoId, prompt.trim(), model.trim() || undefined);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New session" hint="agentbox creates a fresh worktree off the repo's default branch and runs omp on it. You can steer it live." onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="field">
          <label className="label">Repository</label>
          <select className="select" value={repoId} onChange={(e) => setRepoId(e.target.value)}>
            {state.repos.length === 0 && <option value="">— add a repo in Settings first —</option>}
            {state.repos.map((r) => (
              <option key={r.id} value={r.id}>{r.displayName}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label">Task</label>
          <textarea className="textarea" autoFocus placeholder="Describe the change you want…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">Model</label>
          <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        {err && <p style={{ color: "var(--danger)", fontSize: 12.5 }}>{err}</p>}
        <div className="actions">
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !repoId || !prompt.trim()}>
            <Icon.play size={13} /> {busy ? "Spawning…" : "Spawn"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
