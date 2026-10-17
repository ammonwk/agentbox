/** A conversation that went back to an earlier message and carried on from there.
 *
 * Claude's rewind (and agentbox's Edit, which drives it) leaves what was said
 * after the message in the transcript and starts again from the record before
 * it: the new message's `parentUuid` names that record instead of the one
 * written just before. The file is then a tree, read in the order it was
 * written. What is shown is one path through it, from the newest record back,
 * and the messages that started again from the same place are versions of
 * one another: "2/3".
 *
 * Only your messages can start a branch (the CLIs go back to a message, not
 * to a tool call), so this keeps a row per message rather than a parent per
 * record, plus the ids of the records a message continued from: what any
 * later message can go back to. Claude can also be pointed back at an older
 * branch's last record (an explicit `last-prompt`, then `/resume`): until the
 * next message, that record is where the conversation stands.
 *
 * A message can also be taken back: Esc before any reply puts it back in the
 * input box, and Claude carries on as if it was never sent, though the file
 * keeps it. Nothing is written to say so. The next message continues from
 * where the taken-back one did, which would read as a version of it: a
 * message with no reply that the next one goes back past is dropped instead.
 * Until then only the CLI can say it is idle again after it (`settled`).
 */

/** Messages as the fold keeps them: [record, record it continues from, 1 when that is not the record just before it], flattened. */
export type PromptRows = readonly number[];

export interface Branches {
  prompts: PromptRows;
  /** The record the conversation was pointed back to, until the next message; null when it stands at its newest record. */
  pinned: number | null;
  /** The record that pointed it there. */
  pinnedBy: number;
  /** The newest message while nothing has answered it: [record, record it continued from, written at (ms)]. */
  open: readonly [number, number, number] | null;
}

export class BranchFold {
  /** See `PromptRows`. */
  prompts: number[] = [];
  /** Record id -> index: each record a message continued from, and each branch's last record when another began. */
  anchors = new Map<string, number>();
  pinned: number | null = null;
  pinnedBy = -1;
  /** See `Branches.open`. */
  open: [number, number, number] | null = null;
  /** The id the open message continued from. */
  openParent: string | null = null;
  private lastId: string | null = null;
  private lastAt = -1;

  /**
   * One record of the conversation itself (not a side chain, not bookkeeping
   * without an id). `kind` says it is a message you could go back to, or
   * something that answers one (not the CLI's notes on it). `parent` is the
   * id it says it continues from, null for the first message; `at` is when
   * it was written (ms).
   */
  add(index: number, id: string, parent: string | null, kind: "prompt" | "reply" | "other", at = 0): void {
    if (kind === "prompt") {
      // Going back past the open message: it was taken back, not a version.
      const takenBack = this.open !== null && parent === this.openParent;
      if (takenBack) this.prompts.length -= 3;
      const from = parent === null ? -1 : this.anchors.get(parent);
      const jump = from !== undefined && (takenBack || (parent !== this.lastId && (parent !== null || this.prompts.length > 0)));
      if (this.lastId) this.anchors.set(this.lastId, this.lastAt);
      this.prompts.push(index, jump ? from! : this.lastAt, jump ? 1 : 0);
      this.pinned = null;
      this.open = [index, this.prompts[this.prompts.length - 2]!, at];
      this.openParent = parent;
    } else if (kind === "reply") this.open = null;
    this.lastId = id;
    this.lastAt = index;
  }

  /** The conversation was pointed at record `leaf` by record `index`; one it never branched at is not followed. */
  pin(index: number, leaf: string): void {
    // The branch it leaves can be pointed back to.
    if (this.lastId) this.anchors.set(this.lastId, this.lastAt);
    if (leaf === this.lastId) {
      this.pinned = null;
      return;
    }
    const at = this.anchors.get(leaf);
    if (at === undefined) return;
    this.pinned = at;
    this.pinnedBy = index;
  }

  /** The id of the last record on the path ending at `leaf` that a pointer can name. */
  idAt(leaf: number): string | null {
    if (leaf >= this.lastAt) return this.lastId;
    let best: [string, number] | null = null;
    for (const [id, at] of this.anchors) if (at <= leaf && (!best || at > best[1])) best = [id, at];
    return best?.[0] ?? null;
  }

  view(): Branches {
    return { prompts: this.prompts, pinned: this.pinned, pinnedBy: this.pinnedBy, open: this.open };
  }

  reset(): void {
    this.prompts = [];
    this.anchors.clear();
    this.pinned = null;
    this.pinnedBy = -1;
    this.open = null;
    this.openParent = null;
    this.lastId = null;
    this.lastAt = -1;
  }
}

const jumps = function* (rows: PromptRows): Generator<[at: number, from: number]> {
  for (let i = 0; i < rows.length; i += 3) if (rows[i + 2]) yield [rows[i]!, rows[i + 1]!];
};

/** Has any message started again from an earlier place? */
export function branched(b: Branches): boolean {
  return b.pinned !== null || !jumps(b.prompts).next().done;
}

/**
 * The records not on the path that ends at `leaf`, as inclusive ranges, in no
 * particular order. Walking back from the leaf, a message that started again
 * hides what was written between the record it continued from and it.
 */
export function hiddenRanges(rows: PromptRows, leaf: number): [number, number][] {
  const out: [number, number][] = [[leaf + 1, Number.MAX_SAFE_INTEGER]];
  let pos = leaf;
  for (let i = rows.length - 3; i >= 0; i -= 3) {
    const at = rows[i]!;
    if (at > pos || !rows[i + 2]) continue;
    const from = rows[i + 1]!;
    if (at - 1 >= from + 1) out.push([from + 1, at - 1]);
    pos = from;
  }
  return out;
}

export function isHidden(ranges: readonly [number, number][], index: number): boolean {
  for (const [lo, hi] of ranges) if (index >= lo && index <= hi) return true;
  return false;
}

/** The versions of the message at record `at`: every message that continued
 *  from the same record, oldest first. Null when it has only the one. */
export function versionsOf(rows: PromptRows, at: number): number[] | null {
  let from: number | undefined;
  for (let i = 0; i < rows.length; i += 3) if (rows[i] === at) from = rows[i + 1];
  if (from === undefined) return null;
  const out: number[] = [];
  for (let i = 0; i < rows.length; i += 3) if (rows[i + 1] === from) out.push(rows[i]!);
  return out.length > 1 ? out : null;
}

/** The leaf the conversation stands at: where it was pointed, else its newest
 *  record, or before the newest message when the CLI took it back. */
export function currentLeaf(b: Branches, records: number, takenBack = false): number {
  if (takenBack && b.open) return b.open[1];
  return b.pinned ?? records - 1;
}

/** Has the CLI, idle since `idleSince`, taken back the newest message: sent before then and never answered? */
export function settled(b: Branches, idleSince: number | null): boolean {
  return !!b.open && idleSince !== null && b.open[2] > 0 && b.open[2] < idleSince;
}

/** The newest branch through message `at`: the last record of the latest-
 *  written path that passes through it. Every branch ends at the newest
 *  record or just before a message that went back. */
export function leafThrough(rows: PromptRows, at: number, records: number): number {
  const leaves = [records - 1, ...[...jumps(rows)].map(([u]) => u - 1)].sort((a, b) => b - a);
  for (const leaf of leaves) if (leaf >= at && !isHidden(hiddenRanges(rows, leaf), at)) return leaf;
  return records - 1;
}

/** Did a message, or a pointer, at or after record `from` go back to before it? */
export function wentBack(b: Branches, from: number): boolean {
  if (b.pinned !== null && b.pinnedBy >= from) return true;
  for (let i = b.prompts.length - 3; i >= 0 && b.prompts[i]! >= from; i -= 3) if (b.prompts[i + 2]) return true;
  return false;
}
