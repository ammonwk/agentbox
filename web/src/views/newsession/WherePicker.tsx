import { useEffect, useRef, useState } from "react";
import type { Repo } from "../../../../src/core/types";
import { api } from "../../api";
import { Icon, Spinner } from "../../components";
import { Dropdown, type MenuItem } from "./Dropdown";

/**
 * Where it runs, in one menu: the registered repos (which get a worktree
 * choice beside this), then folders picked before. The search takes a path to
 * open as a folder, or a path or owner/repo slug to register as a repo.
 *
 * What is typed completes against the server's disk (`/api/dirs`): a path
 * (`/…`, `~/…`) lists the folders it could go on to, a bare name the ones in
 * the home folder that match. Tab puts the active folder's path in the box to
 * go into it; only a folder that exists is offered, so a guess cannot be opened.
 */
export function WherePicker({
  repos,
  folders,
  where,
  repoId,
  path,
  adding,
  onRepo,
  onFolder,
  onForgetFolder,
  onAddRepo,
}: {
  repos: Repo[];
  folders: string[];
  where: "repo" | "path";
  repoId: string;
  path: string;
  adding: boolean;
  onRepo: (id: string) => void;
  onFolder: (path: string) => void;
  onForgetFolder: (path: string) => void;
  onAddRepo: (ref: string) => void;
}) {
  const repo = where === "repo" ? repos.find((r) => r.id === repoId) ?? null : null;
  const folder = where === "path" ? path.trim() : "";
  const done = useDirCompletion();

  function folderRow(f: string, group: string, forget: boolean): MenuItem {
    return {
      key: `folder:${f}`,
      group,
      children: (
        <>
          <Icon.folder size={14} />
          <span className="ns-item-main">{base(f)}</span>
          <span className="ns-item-sub mono">{tilde(parent(f))}</span>
          {forget ? (
            <button
              type="button"
              className="ns-item-x"
              title="Forget this folder"
              aria-label={`Forget ${tilde(f)}`}
              onClick={(e) => {
                e.stopPropagation();
                onForgetFolder(f);
              }}
            >
              <Icon.x size={12} />
            </button>
          ) : null}
        </>
      ),
    };
  }

  function items(query: string): MenuItem[] {
    const q = query.toLowerCase();
    const pathish = isPath(query);
    const hit = (...s: (string | null | undefined)[]) => !q || s.some((x) => x?.toLowerCase().includes(q));
    // The answer for this query; until it comes, the last one's folders that
    // still fit what is typed, so the list narrows instead of flickering.
    const current = !!query && done.query === query.trim();
    const comp = current
      ? done
      : query && done.query && isPath(done.query) === pathish
        ? {
            exact: null,
            entries: done.entries.filter((f) =>
              pathish ? tilde(f).toLowerCase().startsWith(q) || f.toLowerCase().startsWith(q) : base(f).toLowerCase().includes(q),
            ),
          }
        : null;
    const out: MenuItem[] = [];
    const seen = new Set<string>();
    const push = (r: MenuItem) => {
      if (seen.has(r.key)) return;
      seen.add(r.key);
      out.push(r);
    };

    // A typed path: the folder it names, then the ones it could go on to.
    if (pathish && comp) {
      if (comp.exact && !comp.entries.includes(comp.exact))
        push({
          key: `folder:${comp.exact}`,
          noCheck: true,
          children: (
            <>
              <Icon.folder size={14} />
              <span className="ns-item-main">
                Open <span className="mono">{tilde(comp.exact)}</span>
              </span>
            </>
          ),
        });
      for (const f of comp.entries) push(folderRow(f, `In ${tilde(parent(f))}`, false));
    }

    for (const r of repos) {
      if (!hit(r.displayName, r.fullName, r.ref)) continue;
      push({
        key: `repo:${r.id}`,
        group: "Repositories",
        children: (
          <>
            <Icon.branch size={14} />
            <span className="ns-item-main">{r.displayName}</span>
            <span className="ns-item-sub">{r.fullName ?? tilde(r.ref)}</span>
          </>
        ),
      });
    }
    // The open folder heads the list even when nothing else remembers it.
    for (const f of folder && !folders.includes(folder) ? [folder, ...folders] : folders) {
      if (hit(f)) push(folderRow(f, "Recent folders", folders.includes(f)));
    }
    // A bare name: the home folder's folders that match it.
    if (!pathish && comp) for (const f of comp.entries) push(folderRow(f, "In ~", false));

    // Not before a path's folders are in: Enter would add it as a repo.
    if (query && (pathish ? current : query.includes("/") || query.includes(":")))
      push({
        key: `add:${query}`,
        children: (
          <>
            <Icon.plus size={14} />
            <span className="ns-item-main">
              Add repository <span className="mono">{query}</span>
            </span>
          </>
        ),
      });
    return out;
  }

  return (
    <Dropdown
      label="Where"
      title={repo ? repo.ref : folder || undefined}
      tone={!repo && !folder ? "warn" : undefined}
      width={420}
      search="Search, or type a path (~/…) or owner/repo…"
      selected={repo ? `repo:${repo.id}` : folder ? `folder:${folder}` : null}
      onQuery={done.ask}
      onTab={(k) => (k.startsWith("folder:") ? `${tilde(k.slice(7)).replace(/\/$/, "")}/` : null)}
      onPick={(k) => {
        if (k.startsWith("repo:")) onRepo(k.slice(5));
        else if (k.startsWith("folder:")) onFolder(k.slice(7));
        else if (k.startsWith("add:")) onAddRepo(k.slice(4));
      }}
      footer={(q) => {
        if (!q) return repos.length + folders.length > 0 ? null : "Type a folder's path, or a repo to add.";
        if (done.query !== q) return null;
        if (done.entries.length > 0) return "Tab goes into a folder · Enter opens it";
        if (isPath(q) && !done.exact) return `No folder matches ${q}`;
        return null;
      }}
      trigger={
        <>
          {adding ? <Spinner size={13} /> : repo ? <Icon.branch size={13} /> : <Icon.folder size={13} />}
          <span className="ns-pill-text">{adding ? "Adding…" : repo ? repo.displayName : folder ? base(folder) : "Choose where"}</span>
        </>
      }
      items={items}
    />
  );
}

/**
 * The server's folders for what is typed, a beat after typing stops; only
 * the answer to the latest query is kept. Text with a slash that is not a
 * path is an owner/repo slug and asks nothing.
 */
function useDirCompletion() {
  const [done, setDone] = useState<{ query: string; exact: string | null; entries: string[] }>({
    query: "",
    exact: null,
    entries: [],
  });
  const latest = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function ask(raw: string) {
    const query = raw.trim();
    latest.current = query;
    clearTimeout(timer.current);
    if (!query || (!isPath(query) && query.includes("/"))) return;
    timer.current = setTimeout(() => {
      api
        .completeDir(query)
        .then((r) => {
          if (latest.current === query && r) setDone({ query, exact: r.exact, entries: r.entries });
        })
        .catch(() => {});
    }, 80);
  }
  return { ...done, ask };
}

const isPath = (q: string) => /^[/~]/.test(q.trim());
/** `/Users/me/x` reads `~/x`; the server expands it back. */
const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const parent = (p: string) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
