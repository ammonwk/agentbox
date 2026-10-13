import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExpertiseProfile } from "../../cloud/agents";

export interface ExpertSuggestion {
  userId: string;
  login: string;
  score: number;
  evidence: string[];
  contact?: { repo: string; allowed: boolean; reason: string }[];
}
/** Suggestions only. Editable emails/logins are hints for matching history;
 * the separate OAuth/consent check is the sole authority for outreach. */
export function suggestExperts(
  profiles: ExpertiseProfile[],
  cwd: string | null,
  areas: string[],
  paths: string[],
) {
  const safePaths = paths
    .filter(
      (p) =>
        p.length < 500 &&
        !p.startsWith("/") &&
        !p.split("/").includes("..") &&
        !p.includes("\0"),
    )
    .slice(0, 40);
  const suggestions = new Map<string, ExpertSuggestion>();
  const add = (p: ExpertiseProfile, score: number, evidence: string) => {
    const s = suggestions.get(p.user_id) ?? {
      userId: p.user_id,
      login: p.github_login,
      score: 0,
      evidence: [],
    };
    s.score += score;
    s.evidence.push(evidence);
    suggestions.set(p.user_id, s);
  };
  for (const p of profiles) {
    const matches = p.areas.filter((a) =>
      areas.some((x) => x.toLowerCase() === a.toLowerCase()),
    );
    if (matches.length)
      add(p, 4 * matches.length, `Declared expertise: ${matches.join(", ")}`);
    const declared = p.paths.filter((prefix) =>
      safePaths.some((path) => path.startsWith(prefix)),
    );
    if (declared.length) add(p, 3, `Declared paths: ${declared.join(", ")}`);
  }
  const missing: string[] = [];
  if (cwd && safePaths.length) {
    const history = Bun.spawnSync(
      ["git", "log", "-200", "--format=%ae%x09%h", "--", ...safePaths],
      { cwd, stdout: "pipe", stderr: "ignore", timeout: 10000 },
    );
    if (history.exitCode)
      missing.push("Repository history is unavailable on this host.");
    else
      for (const p of profiles) {
        const commits = history.stdout
          .toString()
          .split("\n")
          .map((l) => l.split("\t"))
          .filter(([email]) =>
            p.git_emails.some((e) => e.toLowerCase() === email?.toLowerCase()),
          )
          .map(([, sha]) => sha!);
        if (commits.length)
          add(
            p,
            Math.min(10, commits.length),
            `${commits.length} recent commits affecting the requested paths (git email match; examples ${commits.slice(0, 3).join(", ")})`,
          );
      }
    const file = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]
      .map((p) => join(cwd, p))
      .find(existsSync);
    if (file) {
      const owners = new Map<string, string>();
      for (const line of readFileSync(file, "utf8")
        .slice(0, 500000)
        .split("\n")) {
        const [pattern, ...names] = line.trim().split(/\s+/);
        if (!pattern || pattern.startsWith("#") || pattern.startsWith("!"))
          continue;
        const glob = new Bun.Glob(
          `${pattern.startsWith("/") ? "" : "**/"}${pattern.replace(/^\//, "").replace(/\/$/, "/**")}`,
        );
        for (const path of safePaths)
          if (glob.match(path)) owners.set(path, names.join(" "));
      }
      for (const p of profiles) {
        const owned = [...owners]
          .filter(([, names]) =>
            names
              .split(/\s+/)
              .some(
                (n) => n.toLowerCase() === `@${p.github_login.toLowerCase()}`,
              ),
          )
          .map(([path]) => path);
        if (owned.length)
          add(
            p,
            5,
            `CODEOWNERS names this login for ${owned.join(", ")} (suggestion, not consent)`,
          );
      }
    }
  } else
    missing.push(
      "Choose repository paths to include contribution and CODEOWNERS evidence.",
    );
  return {
    suggestions: [...suggestions.values()].sort((a, b) => b.score - a.score),
    missing,
  };
}
