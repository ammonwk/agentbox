/**
 * The Context page's files.
 *
 * An agent is told things beyond its own working files, from two places that
 * stay separate here because they are edited differently:
 *
 *   rules         the user's own, agentbox appends them to the system prompt
 *                 (`core/rules.ts`, `providers/briefing.ts`). Global, and one
 *                 per repo.
 *   instructions  the CLIs read these themselves, from their own config home
 *                 and from the checkout they run in. agentbox reads none of
 *                 them — it only knows where each CLI looks, which is what
 *                 makes them showable and writable here.
 *
 * The browser never sends a path: a doc is named by an id, and this module is
 * the only thing that turns one into a file, from its own catalogue and the
 * repos table. That is what keeps the write endpoint from being an
 * arbitrary-file primitive (`server/guard.ts` exists for the same reason).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultHome } from "../core/accounts/homes";
import { listRepos } from "../core/db";
import { repoCheckoutPath } from "../core/git";
import { userHome } from "../core/paths";
import { RULES_MAX_BYTES, readRules, repoRulesPath, rulesPath, writeRules } from "../core/rules";
import type { ContextDoc, ProviderId, Repo } from "../core/types";

/** The CLIs that are given the briefing, and so read the rules files. */
const RULED: ProviderId[] = ["claude", "codex", "omp", "opencode"];

/** The instruction file each CLI loads for itself at its global location.
 *  omp and opencode are one lineage and read the same XDG config file. */
const GLOBAL_INSTRUCTIONS: { key: string; name: string; dir: () => string; providers: ProviderId[] }[] = [
  { key: "claude", name: "CLAUDE.md", dir: () => defaultHome("claude"), providers: ["claude"] },
  { key: "codex", name: "AGENTS.md", dir: () => defaultHome("codex"), providers: ["codex"] },
  { key: "opencode", name: "AGENTS.md", dir: () => join(userHome(), ".config", "opencode"), providers: ["omp", "opencode"] },
];

/** The instruction files a CLI looks for in the checkout it runs in. */
const REPO_INSTRUCTIONS: { key: string; name: string; providers: ProviderId[] }[] = [
  { key: "AGENTS.md", name: "AGENTS.md", providers: ["codex", "omp", "opencode"] },
  { key: "CLAUDE.md", name: "CLAUDE.md", providers: ["claude"] },
];

function bytesOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Where a doc id points, or null when it names nothing this server manages. */
export function contextDocPath(id: string, repos: readonly Repo[] = listRepos()): string | null {
  if (!id || id.includes("\0")) return null;
  if (id === "rules:global") return rulesPath();
  if (id.startsWith("rules:repo:")) {
    const repo = repos.find((r) => r.id === id.slice("rules:repo:".length));
    return repo ? repoRulesPath(repo.id) : null;
  }
  if (id.startsWith("instructions:global:")) {
    const entry = GLOBAL_INSTRUCTIONS.find((g) => g.key === id.slice("instructions:global:".length));
    return entry ? join(entry.dir(), entry.name) : null;
  }
  if (id.startsWith("instructions:repo:")) {
    const [, , repoId, key] = id.split(":");
    const repo = repos.find((r) => r.id === repoId);
    const entry = REPO_INSTRUCTIONS.find((r) => r.key === key);
    return repo && entry ? join(repoCheckoutPath(repo), entry.name) : null;
  }
  return null;
}

/** Every file the Context page can show, grouped by kind then scope. */
export function contextDocs(repos: readonly Repo[] = listRepos()): ContextDoc[] {
  const out: ContextDoc[] = [];
  const add = (doc: Omit<ContextDoc, "exists" | "bytes">): void => {
    out.push({ ...doc, exists: existsSync(doc.path), bytes: bytesOf(doc.path) });
  };

  add({
    id: "rules:global",
    kind: "rules",
    scope: "global",
    scopeLabel: "Every session",
    label: "Rules",
    read: "every session, after the briefing",
    providers: RULED,
    path: rulesPath(),
    cap: RULES_MAX_BYTES,
  });
  for (const repo of repos) {
    add({
      id: `rules:repo:${repo.id}`,
      kind: "rules",
      scope: repo.id,
      scopeLabel: repo.displayName,
      label: "Rules",
      read: `every session in ${repo.displayName}`,
      providers: RULED,
      path: repoRulesPath(repo.id),
      cap: RULES_MAX_BYTES,
    });
  }
  for (const entry of GLOBAL_INSTRUCTIONS) {
    add({
      id: `instructions:global:${entry.key}`,
      kind: "instructions",
      scope: "global",
      scopeLabel: "Every session",
      label: entry.name,
      read: `${entry.providers.join(", ")}, in every directory`,
      providers: entry.providers,
      path: join(entry.dir(), entry.name),
    });
  }
  for (const repo of repos) {
    for (const entry of REPO_INSTRUCTIONS) {
      add({
        id: `instructions:repo:${repo.id}:${entry.key}`,
        kind: "instructions",
        scope: repo.id,
        scopeLabel: repo.displayName,
        label: entry.name,
        read: `${entry.providers.join(", ")}, in ${repo.displayName}`,
        providers: entry.providers,
        path: join(repoCheckoutPath(repo), entry.name),
      });
    }
  }
  return out;
}

/** A doc's whole file, for the editor. The rules cap is injection's, not the
 *  file's: what is shown is what is on disk. Empty when there is none yet. */
export function readContextDoc(id: string, repos: readonly Repo[] = listRepos()): { path: string; body: string } | null {
  const path = contextDocPath(id, repos);
  if (!path) return null;
  try {
    return { path, body: readFileSync(path, "utf8") };
  } catch {
    return { path, body: "" };
  }
}

/** Write a doc, and say what a session would now be given from it. */
export function writeContextDoc(id: string, body: string, repos: readonly Repo[] = listRepos()): { path: string; injected: string } | null {
  const path = contextDocPath(id, repos);
  if (!path) return null;
  writeRules(path, body);
  return { path, injected: readRules(path) };
}
