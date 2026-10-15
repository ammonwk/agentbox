import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * The new-session dialog's folder field: what a typed path could go on to
 * be, and which remembered folders still exist. Directories only — a session
 * runs in a folder — and names, never contents.
 */

/** `~` and `~/x` to the server's home; anything else as given, made absolute. */
export function expandDir(p: string, home = homedir()): string {
  const t = p.trim();
  const expanded = t === "~" ? home : t.startsWith("~/") ? home + t.slice(1) : t;
  return resolve(home, expanded);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface DirCompletion {
  /** The typed path itself, absolute, when it is a directory. */
  exact: string | null;
  /** Folders in the typed path's parent whose names go on from what follows its last slash. */
  entries: string[];
}

/**
 * `~/Doc` → `~/Documents`, `~/Documents/` → what is in it. A name that starts
 * with what is typed comes before one that only contains it, and case does
 * not matter; dot-folders show once the typed name starts with a dot.
 */
export function completeDir(typed: string, limit = 40, home = homedir()): DirCompletion {
  const t = typed.trim();
  const exact = t && isDir(expandDir(t, home)) ? expandDir(t, home) : null;
  const slash = t.lastIndexOf("/");
  const dir = slash < 0 ? (t.startsWith("~") ? null : home) : expandDir(t.slice(0, slash + 1) || "/", home);
  if (!dir) return { exact, entries: [] };
  const name = t.slice(slash + 1).toLowerCase();
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isDirectory() || (e.isSymbolicLink() && isDir(`${dir}/${e.name}`))))
      .map((e) => e.name);
  } catch {
    return { exact, entries: [] };
  }
  const rank = (n: string) => {
    const l = n.toLowerCase();
    return l.startsWith(name) ? 0 : name && l.includes(name) ? 1 : -1;
  };
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  const entries = names
    .filter((n) => (name.startsWith(".") || !n.startsWith(".")) && rank(n) >= 0)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, limit)
    .map((n) => base + n);
  return { exact, entries };
}

/** Each path → itself absolute when it is a directory, null when it is not. */
export function resolveDirs(paths: readonly string[], home = homedir()): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of paths.slice(0, 200)) {
    const abs = expandDir(p, home);
    out[p] = isDir(abs) ? abs.replace(/(.)\/+$/, "$1") : null;
  }
  return out;
}
