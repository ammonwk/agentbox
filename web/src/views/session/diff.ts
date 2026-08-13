/** Unified-patch parsing for the Diff tab. */

export type PatchLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

const META_PREFIXES = ["diff --git", "index ", "--- ", "+++ ", "new file", "deleted file", "similarity", "rename ", "old mode", "new mode", "Binary files"];

export function parsePatch(patch: string): PatchLine[] {
  const lines = patch.split("\n");
  // A trailing newline yields a final empty element that is not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return lines.map((text) => ({ kind: classify(text), text }));
}

function classify(text: string): PatchLineKind {
  if (text.startsWith("@@")) return "hunk";
  if (META_PREFIXES.some((p) => text.startsWith(p))) return "meta";
  if (text.startsWith("+")) return "add";
  if (text.startsWith("-")) return "del";
  return "context";
}

/** Added/removed counts as they appear *in the patch body*. */
export function patchStats(lines: PatchLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const l of lines) {
    if (l.kind === "add") additions++;
    else if (l.kind === "del") deletions++;
  }
  return { additions, deletions };
}

/**
 * Is the patch body smaller than the counts the server reported for the file?
 *
 * `SessionDiff` carries no truncation flag, so this is how we notice one: a
 * patch that shows fewer changed lines than `additions`/`deletions` claim has
 * been shortened somewhere, and rendering it as if it were the whole change
 * would quietly mislead the person judging the work.
 */
export function looksTruncated(
  lines: PatchLine[],
  reported: { additions: number; deletions: number },
): boolean {
  const actual = patchStats(lines);
  return actual.additions < reported.additions || actual.deletions < reported.deletions;
}
