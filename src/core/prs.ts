import { run, ghErrorMessage, repoFullNameOf, repoCheckoutPath } from "./git";
import type { PrInfo, Repo, Session } from "./types";

/**
 * A scan's result. The warnings matter as much as the rows: an empty `prs` with
 * no warning means "no open pull requests", and an empty `prs` with a warning
 * means we could not look. Collapsing those two into a bare array is how a
 * missing `gh` used to render as a clean, wrong, empty page.
 */
export interface PrScan {
  prs: PrInfo[];
  warnings: string[];
}

/**
 * Open pull requests across every registered GitHub repo, via `gh`.
 *
 * This spawns one subprocess per repo and must only be called from the cold
 * refresh in src/server/index.ts — never on a broadcast path.
 */
export function listPrs(repos: Repo[], sessions: Session[]): PrScan {
  const warnings: string[] = [];
  const slugs = new Set<string>();
  for (const repo of repos) {
    const slug = repo.fullName ?? (repo.kind === "github" ? repo.ref : repoFullNameOf(repoCheckoutPath(repo)));
    if (slug) slugs.add(slug);
  }
  if (slugs.size === 0) return { prs: [], warnings };

  const out: PrInfo[] = [];
  for (const slug of slugs) {
    const r = run([
      "gh", "pr", "list",
      "--repo", slug,
      "--state", "open",
      "--json", "number,title,headRefName,state,isDraft,url,createdAt,updatedAt,author",
      // Every open PR, not the newest few: a busy repo has well over 50, and a
      // PR past the cut is invisible to the prompt and the session's PR badge.
      "--limit", "500",
    ]);
    if (r.code !== 0) {
      const message = ghErrorMessage(r);
      // A broken `gh` fails identically for every repo; say it once.
      const scoped = message.startsWith("`gh`") ? message : `Could not list pull requests for ${slug}: ${message}`;
      if (!warnings.includes(scoped)) warnings.push(scoped);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      warnings.push(`Could not read gh's pull request list for ${slug}`);
      continue;
    }
    if (!Array.isArray(data)) {
      warnings.push(`gh returned an unexpected pull request list for ${slug}`);
      continue;
    }
    for (const raw of data) {
      const pr = raw as Record<string, unknown>;
      const number = typeof pr.number === "number" ? pr.number : null;
      const headRef = typeof pr.headRefName === "string" ? pr.headRefName : "";
      if (number === null) continue;
      const session = sessions.find((s) => s.branch === headRef && s.repoRoot !== null && slugOf(s.repoRoot) === slug);
      const author = pr.author as { login?: unknown } | undefined;
      out.push({
        number,
        repo: slug,
        title: typeof pr.title === "string" ? pr.title : `#${number}`,
        headRef,
        state: (pr.state as PrInfo["state"]) ?? "OPEN",
        isDraft: pr.isDraft === true,
        url: typeof pr.url === "string" ? pr.url : `https://github.com/${slug}/pull/${number}`,
        author: typeof author?.login === "string" ? author.login : "unknown",
        createdAt: typeof pr.createdAt === "string" ? pr.createdAt : new Date(0).toISOString(),
        updatedAt: typeof pr.updatedAt === "string" ? pr.updatedAt : new Date(0).toISOString(),
        sessionId: session?.id ?? null,
      });
    }
  }
  out.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return { prs: out, warnings };
}

const slugs = new Map<string, string | null>();
/** The GitHub slug of a checkout, cached: it costs a `git remote` call and a
 *  checkout's remote does not change under a running app. */
function slugOf(root: string): string | null {
  if (!slugs.has(root)) slugs.set(root, repoFullNameOf(root));
  return slugs.get(root)!;
}
