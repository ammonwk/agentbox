/** Which GitHub repo a session's `#1234`s are about, from what it names.
 *  Pure.
 *
 *  A session's own checkout is the usual answer, but not always: one run from
 *  agentbox to look after another project's PRs works through `gh … -R
 *  owner/repo` and PR URLs, and its numbers belong to that project. Only the
 *  shapes that say "this repo's PRs" count — a `-R` on `gh`, a PR URL, a
 *  `repos/owner/repo/pulls` API path — not any `owner/name` in prose, and not
 *  an issue URL: those are mostly citations of someone else's bug. */

const NAME = String.raw`([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/([A-Za-z0-9_.-]+)`;

const SHAPES = [
  // `gh pr view 7251 -R acme-corp/web-app`, `--repo=owner/name`;
  // the flag within the same command, not a later `cp -R a/b` in a pipeline.
  new RegExp(String.raw`\bgh\s[^\n|;&]*?\s(?:-R\s*|--repo[=\s])["']?${NAME}`, "g"),
  new RegExp(String.raw`\bgithub\.com/${NAME}/pull/\d`, "g"),
  new RegExp(String.raw`\brepos/${NAME}/pulls\b`, "g"),
];

/** Each repo `text` names as the home of PRs, as `owner/name`, in order. */
export function prReposIn(text: string): string[] {
  if (!text.includes("/")) return [];
  const found: { at: number; slug: string }[] = [];
  for (const re of SHAPES) {
    for (const m of text.matchAll(re)) {
      const name = m[2]!.replace(/\.git$/i, "").replace(/\.+$/, "");
      if (name) found.push({ at: m.index, slug: `${m[1]}/${name}` });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.slug);
}

const MAX_REPOS = 20;

/**
 * Folds what a session writes into the repo it names most — the one it works
 * on, not the upstream PR it cited once. A tie goes to the latest named.
 */
export class PrRepoFold {
  /** Times named; a Map keeps them in the order last named, oldest first. */
  private counts = new Map<string, number>();

  add(text: unknown): void {
    if (typeof text !== "string" || !text) return;
    for (const slug of prReposIn(text)) {
      const n = (this.counts.get(slug) ?? 0) + 1;
      this.counts.delete(slug);
      if (n === 1 && this.counts.size >= MAX_REPOS) continue;
      this.counts.set(slug, n);
    }
  }

  get repo(): string | null {
    let best: string | null = null;
    let most = 0;
    for (const [slug, n] of this.counts) if (n >= most) [best, most] = [slug, n];
    return best;
  }
}
