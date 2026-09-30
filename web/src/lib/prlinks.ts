/** Pull-request references in agent output — `#6307`, `PR 6644`, a bare
 *  `6644` — as GitHub links. Pure.
 *
 *  Deliberately loose: a four-digit number next to a PR conversation usually
 *  is one, and GitHub redirects `/pull/N` to the issue when N is an issue.
 *  What it does skip is the shapes that are plainly something else: times,
 *  decimals, paths, hex colours, dates, years, and numbers glued to a word
 *  (`gac-6644`). */

import type { AppState, Session } from "../../../src/core/types";

export interface PrRef {
  /** Offsets into the text, end exclusive; they cover the prefix too. */
  start: number;
  end: number;
  number: number;
}

// Prefix optional; the lookarounds keep it off anything glued to a word, a
// path, a time or a decimal. A trailing full stop is allowed — "merge #6321
// first." — but not a decimal point.
const REF = /(?<![\w.:/@$%#-])(PR ?#?|#)?(\d{2,5})(?![\w%:/-]|\.\d)/gi;

export function prRefs(text: string): PrRef[] {
  const out: PrRef[] = [];
  for (const m of text.matchAll(REF)) {
    const [whole, prefix, digits] = m;
    // Bare numbers only at the length PRs have now, and never a year.
    if (!prefix && (digits.length !== 4 || /^(19|20)\d\d$/.test(digits))) continue;
    out.push({ start: m.index, end: m.index + whole.length, number: Number(digits) });
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

export function prUrl(base: string, n: number): string {
  return `${base}/pull/${n}`;
}
