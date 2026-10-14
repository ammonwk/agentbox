import type { PrInfo } from "../../../../src/core/types";
import { Icon } from "../../components";
import { matchPrs, parseWorktreeRef } from "../../lib/newsession";
import { Dropdown, type MenuItem } from "./Dropdown";

/**
 * Where in the repo it runs: a new worktree, the main checkout, an open PR's
 * branch, or any branch typed into the search. `text` is what the old box
 * held — blank for the main checkout, `#123` for a PR, else a branch — so
 * parseWorktreeRef still reads it.
 */
export function WorktreeField({
  on,
  onToggle,
  text,
  onText,
  prs,
  hint,
  fromPrompt,
  note,
}: {
  on: boolean;
  onToggle: (on: boolean) => void;
  text: string;
  onText: (text: string) => void;
  prs: PrInfo[];
  /** Where it will run, in a sentence: the pill's tooltip. */
  hint?: string;
  /** The prompt named the PR, so the choice was made for you. */
  fromPrompt?: boolean;
  note?: string;
}) {
  const wt = parseWorktreeRef(text, prs);
  const selected = on || wt.kind === "new" ? "new" : wt.kind === "main" ? "main" : wt.kind === "pr" ? `pr:${wt.number}` : `branch:${wt.branch}`;
  const label =
    on || wt.kind === "new"
      ? "New worktree"
      : wt.kind === "main"
        ? "Main checkout"
        : wt.kind === "pr"
          ? `#${wt.number}${wt.pr ? ` ${wt.pr.title}` : ""}`
          : wt.branch;

  function items(query: string): MenuItem[] {
    const out: MenuItem[] = [];
    if (!query) {
      out.push(
        { key: "new", children: <Row main="New worktree" sub="a fresh branch" /> },
        { key: "main", children: <Row main="Main checkout" sub="the branch it has out" /> },
      );
    }
    for (const p of matchPrs(prs, query)) {
      out.push({
        key: `pr:${p.number}`,
        group: "Open PRs",
        children: <Row main={`#${p.number} ${p.isDraft ? "(draft) " : ""}${p.title}`} sub={p.headRef} mono />,
      });
    }
    if (query) {
      const q = parseWorktreeRef(query, prs);
      if (q.kind === "pr" && !q.pr) out.push({ key: `pr:${q.number}`, children: <Row main={`PR #${q.number}`} sub="not open; fetch its head" /> });
      else if (q.kind === "branch") out.push({ key: `branch:${q.branch}`, children: <Row main={`Branch ${q.branch}`} sub="its worktree, or a new one" /> });
    }
    return out;
  }

  function pick(key: string) {
    if (key === "new") {
      onText("");
      onToggle(true);
      return;
    }
    onToggle(false);
    if (key === "main") onText("");
    else if (key.startsWith("pr:")) onText(`#${key.slice(3)}`);
    else onText(key.slice("branch:".length));
  }

  return (
    <Dropdown
      label="Worktree"
      title={hint}
      tone={fromPrompt ? "accent" : undefined}
      width={340}
      search="PR number or branch…"
      selected={selected}
      onPick={pick}
      footer={note}
      trigger={
        <>
          <Icon.branch size={13} />
          <span className="ns-pill-text">{label}</span>
        </>
      }
      items={items}
    />
  );
}

function Row({ main, sub, mono }: { main: string; sub: string; mono?: boolean }) {
  return (
    <>
      <span className="ns-item-main">{main}</span>
      <span className={`ns-item-sub${mono ? " mono" : ""}`}>{sub}</span>
    </>
  );
}
