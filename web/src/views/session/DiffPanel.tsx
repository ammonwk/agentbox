import { useCallback, useEffect, useMemo, useState } from "react";
import type { DiffFile, SessionDiff } from "../../../../src/core/types";
import { api } from "../../api";
import { Button, Empty, Icon } from "../../components";
import { looksTruncated, parsePatch } from "./diff";

/** Beyond this a patch stops being reviewable in a panel; we say so instead of
 *  pretending, rather than freezing the tab rendering 40k <div>s. */
const MAX_RENDERED_LINES = 600;

export function DiffPanel({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDiff(await api.diff(sessionId));
    } catch (e) {
      // The diff shells out to git; when it fails the reason is the useful part.
      setError(e instanceof Error ? e.message : String(e));
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="sx-panel">
      <div className="sx-diff-summary">
        {diff && !diff.unavailable && (
          <>
            <strong style={{ fontWeight: 600, color: "var(--text)" }}>
              {diff.files.length} file{diff.files.length === 1 ? "" : "s"}
            </strong>
            <span className="sx-add">+{diff.additions}</span>
            <span className="sx-del">−{diff.deletions}</span>
            <span>vs {diff.base}</span>
          </>
        )}
        {loading && <span>Loading the diff…</span>}
        <span style={{ marginLeft: "auto" }}>
          <Button
            size="sm"
            variant="ghost"
            icon={Icon.refresh}
            onClick={() => void load()}
            loading={loading}
            disabled={loading}
          >
            Refresh
          </Button>
        </span>
      </div>

      {error && (
        <div className="sx-error">
          Could not read the diff: {error}
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </div>
      )}

      {diff?.unavailable && (
        <Empty title="No worktree to diff">
          The worktree for this session is gone — deleted, moved, or never created — so there is
          nothing to compare against <code>{diff.base}</code>. This is not "no changes": the branch
          may still exist in the repo, and its commits with it.
        </Empty>
      )}

      {/* "Yet" is a promise about the future, so it is only honest while the
          agent is still running. A finished session that changed nothing has
          finished changing nothing. */}
      {diff && !diff.unavailable && diff.files.length === 0 && (
        <Empty title={active ? "No changes yet" : "This session changed no files"}>
          {active
            ? `The agent has not written anything to the worktree. Files it creates or edits appear here, per file, as soon as it does — measured against ${diff.base}.`
            : `Nothing in the worktree differs from ${diff.base}. The agent may have only read and searched, or it may have stopped before writing anything — the Activity tab shows which.`}
        </Empty>
      )}

      {diff && !diff.unavailable && diff.files.map((f) => <FileDiff key={f.path} file={f} />)}
    </div>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  // Small changes open by default: the common case is a handful of files and
  // scanning them should not cost a click each.
  const [open, setOpen] = useState(file.additions + file.deletions <= 60);

  const lines = useMemo(() => (file.patch ? parsePatch(file.patch) : null), [file.patch]);
  const truncated = lines ? looksTruncated(lines, file) : false;
  const clipped = lines ? Math.max(0, lines.length - MAX_RENDERED_LINES) : 0;

  return (
    <div className="sx-file">
      <button className="sx-file-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span aria-hidden="true" style={{ color: "var(--muted)", fontFamily: "var(--mono)" }}>
          {open ? "▾" : "▸"}
        </span>
        <span className="sx-file-path">{file.path}</span>
        <span className="sx-file-tag">{file.status}</span>
        <span className="sx-add">+{file.additions}</span>
        <span className="sx-del">−{file.deletions}</span>
      </button>

      {open && !lines && (
        <div className="sx-note">
          No text patch for this file — it is binary, or git reported no body. The counts above are
          what the server measured.
        </div>
      )}

      {open && lines && (
        <>
          {truncated && (
            <div className="sx-note">
              This patch is shorter than the {file.additions} added / {file.deletions} removed lines
              the server counted — it was truncated upstream. Treat what follows as a sample, not
              the whole change.
            </div>
          )}
          <div className="sx-patch">
            {lines.slice(0, MAX_RENDERED_LINES).map((l, i) => (
              <div key={i} className={`sx-patch-line ${l.kind}`}>
                {l.text === "" ? " " : l.text}
              </div>
            ))}
          </div>
          {clipped > 0 && (
            <div className="sx-note">
              {clipped} further line{clipped === 1 ? "" : "s"} not rendered — this file is too large
              to review here. Read it in the worktree.
            </div>
          )}
        </>
      )}
    </div>
  );
}
