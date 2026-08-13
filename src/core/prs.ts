import { run, repoFullNameOf, repoCheckoutPath } from "./git";
import type { PrInfo, Repo, Session } from "./types";

/**
 * Open pull requests across every registered GitHub repo, via `gh`.
 * Local-only repos with a GitHub origin are still covered — we resolve the
 * remote slug from the checkout and query it like any other.
 */
export function listPrs(repos: Repo[], sessions: Session[]): PrInfo[] {
  const slugs = new Set<string>();
  for (const repo of repos) {
    if (repo.kind === "github") {
      slugs.add(repo.ref);
    } else {
      const slug = repoFullNameOf(repoCheckoutPath(repo));
      if (slug) slugs.add(slug);
    }
  }

  const out: PrInfo[] = [];
  for (const slug of slugs) {
    const r = run([
      "gh", "pr", "list",
      "--repo", slug,
      "--state", "open",
      "--json", "number,title,headRefName,state,isDraft,url,createdAt,updatedAt,author",
      "--limit", "50",
    ]);
    if (r.code !== 0) continue;
    let data: any[];
    try {
      data = JSON.parse(r.stdout);
    } catch {
      continue;
    }
    for (const p of data) {
      const session = sessions.find(
        (s) => s.branch === p.headRefName && s.repoFullName === slug
      );
      out.push({
        number: p.number,
        repo: slug,
        title: p.title,
        headRef: p.headRefName,
        state: p.state,
        isDraft: !!p.isDraft,
        url: p.url,
        author: p.author?.login ?? "unknown",
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        sessionId: session?.id ?? null,
      });
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return out;
}
