/** Pull-request references in agent output — `#6307`, `PR 6644`,
 *  `owner/repo#12`, `gh pr view 6644`, a bare `6644` — as GitHub links. Pure.
 *
 *  Deliberately loose: a missed PR costs more than a stray link, and GitHub
 *  redirects `/pull/N` to the issue when N is an issue. A `#` or a `PR`
 *  before a number is enough whatever punctuation follows (`#7654:`,
 *  `#7653/#7654`, `PR-7654`). Only a bare number needs care, so it skips the
 *  shapes that are plainly something else: times, decimals, paths, dates,
 *  years, and numbers glued to a word (`gac-6644`). */

import type { AppState, Session } from "../../../src/core/types";

export interface PrRef {
  /** Offsets into the text, end exclusive; they cover the prefix too. */
  start: number;
  end: number;
  number: number;
  /** `owner/repo` when the text names one (`acme/app#12`); else the session's. */
  repo?: string;
}

// Each alternative is tried at every position, the first that fits wins, so
// `PR #12` is one reference and not `PR` plus `#12`. `END` keeps a number off
// the front of a longer word (`#7654abc` is a colour, `6644-fix` a branch).
const END = String.raw`(?![\p{L}\p{N}_]|\.\d)`;
const REF = new RegExp(
  [
    // owner/repo#12
    String.raw`(?<![\w./-])(?<repo>[A-Za-z0-9][\w.-]*\/[\w.-]+)#(?<qn>\d{1,6})${END}`,
    // gh pr view 6644 — only the number is the link
    String.raw`\bgh pr [a-z-]+ (?<gn>\d{1,6})${END}`,
    // PR 6644, PR #6644, PR-6644, PR: 6644, PRs 6644, pull request 6644
    String.raw`(?<![\p{L}\p{N}_])(?:PRs?|pull requests?)[ \t]*(?:[-:][ \t]*)?#?(?<pn>\d{1,6})${END}`,
    // #6644, but not &#123; or abc#12
    String.raw`(?<![\p{L}\p{N}_&])#(?<hn>\d{1,6})${END}`,
    // A bare 6644: not in a path, a time, a decimal or a word. `7653/7654`
    // and `7654:` are fine; `/tmp/7654`, `12:3456` and `v1.2345` are not.
    String.raw`(?<![\w.:@$%#&-])(?<!(?<!\d)\/)(?<bn>\d{4})(?![\w%]|[.:]\d|-\w|\/(?!#?\d))`,
  ].join("|"),
  "giud",
);

/** `code` is inline code, where only a number with a `#` or a `PR` before it
 *  counts: a bare one there is a port, a pid, a line count. */
export function prRefs(text: string, code = false): PrRef[] {
  const out: PrRef[] = [];
  for (const m of text.matchAll(REF)) {
    const g = m.groups!;
    if (g.bn !== undefined) {
      // Bare numbers only at the length PRs have now, and never a year.
      if (code || /^(19|20)\d\d$/.test(g.bn)) continue;
      out.push({ start: m.index, end: m.index + 4, number: Number(g.bn) });
    } else if (g.gn !== undefined) {
      const [s, e] = m.indices!.groups!.gn!;
      out.push({ start: s, end: e, number: Number(g.gn) });
    } else {
      const digits = g.qn ?? g.pn ?? g.hn!;
      out.push({ start: m.index, end: m.index + m[0].length, number: Number(digits), ...(g.repo ? { repo: g.repo } : {}) });
    }
  }
  return out;
}

/**
 * The `https://github.com/owner/repo` a session's numbers refer to: the repo
 * it names most as the home of PRs (`gh -R`, a PR URL), since one run from
 * here to look after another project's PRs is talking about that project's;
 * else its own repo when that is a registered GitHub one; for a session
 * outside any repo (a scratch dir) the repo most sessions work in. A session
 * in some other, unregistered repo gets none — linking its numbers to a
 * different project would be wrong every time.
 */
export function prBaseFor(session: Pick<Session, "repoRoot" | "prRepo">, state: Pick<AppState, "repos" | "sessions">): string | null {
  if (session.prRepo) return `https://github.com/${session.prRepo}`;
  const slugOf = (root: string | null) => state.repos.find((r) => r.fullName && (r.ref === root || r.fullName === root))?.fullName ?? null;
  if (session.repoRoot) {
    const own = slugOf(session.repoRoot);
    return own ? `https://github.com/${own}` : null;
  }
  const count = new Map<string, number>();
  for (const s of state.sessions) {
    const slug = slugOf(s.repoRoot);
    if (slug) count.set(slug, (count.get(slug) ?? 0) + 1);
  }
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return top ? `https://github.com/${top}` : null;
}

/** Where a reference goes: its own repo when it names one, else `base`. */
export function prUrl(base: string, n: number, repo?: string): string {
  return `${repo ? `https://github.com/${repo}` : base}/pull/${n}`;
}
