import type { Repo } from "../../../../src/core/types";
import { Icon, Spinner } from "../../components";
import { Dropdown, type MenuItem } from "./Dropdown";

/**
 * Where it runs, in one menu: the registered repos (which get a worktree
 * choice beside this), then folders picked before. The search takes a path to
 * open as a folder, or a path or owner/repo slug to register as a repo.
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
  onAddRepo: (ref: string) => void;
}) {
  const repo = where === "repo" ? repos.find((r) => r.id === repoId) ?? null : null;
  const folder = where === "path" ? path.trim() : "";

  function items(query: string): MenuItem[] {
    const q = query.toLowerCase();
    const hit = (...s: (string | null | undefined)[]) => !q || s.some((x) => x?.toLowerCase().includes(q));
    const out: MenuItem[] = [];
    for (const r of repos) {
      if (!hit(r.displayName, r.fullName, r.ref)) continue;
      out.push({
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
      if (!hit(f)) continue;
      out.push({
        key: `folder:${f}`,
        group: "Folders",
        children: (
          <>
            <Icon.folder size={14} />
            <span className="ns-item-main">{base(f)}</span>
            <span className="ns-item-sub mono">{tilde(parent(f))}</span>
          </>
        ),
      });
    }
    if (query) {
      if (/^[/~]/.test(query) && query !== folder && !folders.includes(query))
        out.push({
          key: `folder:${query}`,
          noCheck: true,
          children: (
            <>
              <Icon.folder size={14} />
              <span className="ns-item-main">
                Open <span className="mono">{query}</span>
              </span>
            </>
          ),
        });
      out.push({
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
    }
    return out;
  }

  return (
    <Dropdown
      label="Where"
      title={repo ? repo.ref : folder || undefined}
      tone={!repo && !folder ? "warn" : undefined}
      width={380}
      search="Search, or type a path or owner/repo…"
      selected={repo ? `repo:${repo.id}` : folder ? `folder:${folder}` : null}
      onPick={(k) => {
        if (k.startsWith("repo:")) onRepo(k.slice(5));
        else if (k.startsWith("folder:")) onFolder(k.slice(7));
        else if (k.startsWith("add:")) onAddRepo(k.slice(4));
      }}
      footer={(q) => (q || repos.length + folders.length > 0 ? null : "Type a folder's path, or a repo to add.")}
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

/** `/Users/me/x` reads `~/x`; the server expands it back. */
const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const parent = (p: string) => p.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
