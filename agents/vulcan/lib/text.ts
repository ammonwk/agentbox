/** Text rules Vulcan holds every publication to: the title, no closing
 *  keywords, no mentions, no credentials; and the canonical form of an issue link. */
import { ActionError } from "../../lib/sdk";

export const AGENT_NAME = "Vulcan";

/** `[Vulcan · Human] summary`: who wrote it and who answers for it, first. */
export function agentPrTitle(agent: string, human: string, summary: string): string {
  const clean = (s: string) =>
    s
      .replace(/[@\[\]\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const a = clean(agent).slice(0, 60);
  const h = clean(human).slice(0, 60);
  if (!a || !h) throw new ActionError("Publication requires the actual agent and accountable human names");
  const prefix = `[${a} · ${h}] `;
  const text = clean(summary.replace(/^\[[^\]]*\]\s*/, ""));
  if (!text) throw new ActionError("Describe the concrete change in the PR title");
  return `${prefix}${text.slice(0, 256 - prefix.length)}`;
}

/** GitHub would close the issue on merge, ahead of any resolution policy: plain links only. */
export function refuseAutomaticClosure(body: string): void {
  if (
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#\d+|\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s+https:\/\/github\.com\/[^\s]+\/issues\/\d+/i.test(body)
  )
    throw new ActionError("Use plain issue links instead of automatic closing keywords; issue closure has its own resolution policy and approval.");
}

/** Conservative: quoted text, code, escaped mentions and HTML entities count
 *  too. A team mention has no individual consent and is refused outright. */
export function mentionedPeople(text: string): string[] {
  const decoded = text.replace(/&#(?:x0*40|0*64);?|&commat;/gi, "@");
  const names = [...decoded.matchAll(/@([a-z\d][a-z\d-]{0,38}(?:\/[\w-]+)?)/gi)].map((x) => x[1]!.toLowerCase());
  if (names.some((x) => x.includes("/"))) throw new ActionError("Team mentions cannot establish each person's consent. Ask the responsible human in Agentbox.", 403);
  return [...new Set(names)];
}

export const CREDENTIAL = /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|-----BEGIN .*PRIVATE KEY-----|sk-(?:live-|proj-)?[A-Za-z0-9_-]{24,})/;

/** An issue link as one key: `github:owner/repo#12`, whatever casing or path it came in. */
export function canonicalSource(raw: string): { key: string; url: string; repo: string | null; number: number | null } {
  const u = new URL(raw.trim());
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new ActionError("use an http(s) source link without credentials");
  const gh = u.hostname.toLowerCase() === "github.com" && /^\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/([1-9]\d*)\/?$/.exec(u.pathname);
  if (gh) {
    const r = `${gh[1]}/${gh[2]}`.toLowerCase();
    return { key: `github:${r}#${gh[3]}`, url: `https://github.com/${r}/issues/${gh[3]}`, repo: r, number: Number(gh[3]) };
  }
  u.hash = "";
  u.searchParams.sort();
  return { key: u.href, url: u.href, repo: null, number: null };
}

/** `owner/name` from a GitHub remote URL, in any of git's three shapes; null for a remote that is not GitHub. */
export function slugFromRemoteUrl(url: string): string | null {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
  const scp = scheme ? null : /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+)$/.exec(url);
  const m = scheme ?? scp;
  if (!m) return null;
  if (!/^(www\.)?github\.com$/i.test(m[1]!)) return null;
  const parts = m[2]!.replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const name = parts[1]!.replace(/\.git$/i, "");
  return parts[0] && name ? `${parts[0]}/${name}` : null;
}
