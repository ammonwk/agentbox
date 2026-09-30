/** Claude's subagent transcripts, folded into their session's tokens. */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TokenTotals } from "../types";
import { emptyTotals } from "../pricing";
import { JsonlTail, type JsonlTailState } from "./jsonl";
import { ClaudeTokenFold } from "./claude-transcript";
import { loadFields, saveFields } from "./foldstate";

/**
 * Tokens spent by a session's subagents, which Claude writes to their own
 * files under `<sessionId>/subagents/`. They are the session's spend — a turn
 * that fans out to five agents costs six agents' tokens — so the reader folds
 * them in. Finished subagent files never change again, so only recently
 * written ones are re-stat'd on each refresh, with a full re-check now and
 * then for one that was resumed.
 */
const SUB_HOT_MS = 10 * 60_000;
const SUB_FULL_MS = 60_000;

export interface SavedSubagents {
  files: { path: string; tail: JsonlTailState; fold: Record<string, unknown>; mtimeMs: number; size: number }[];
  cached: TokenTotals | null;
}

export class SubagentTokens {
  private files = new Map<string, { tail: JsonlTail; fold: ClaudeTokenFold; mtimeMs: number; size: number }>();
  private dirMtimes = new Map<string, number>();
  private lastFull = 0;
  private cached: TokenTotals | null = null;

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  totals(): TokenTotals | null {
    return this.cached;
  }

  /** Each subagent file's position and token fold, for `restore`. */
  state(): SavedSubagents {
    return {
      files: [...this.files].map(([path, f]) => ({ path, tail: f.tail.state(), fold: saveFields(f.fold), mtimeMs: f.mtimeMs, size: f.size })),
      cached: this.cached,
    };
  }

  /** Take up a saved state. A file whose tail no longer fits is left out, and
   *  the first refresh — a full listing, as nothing is known of the
   *  directories — finds it and reads it from the start. */
  restore(s: SavedSubagents): void {
    for (const f of s.files) {
      const tail = new JsonlTail(f.path);
      if (!tail.restore(f.tail)) continue;
      const fold = new ClaudeTokenFold();
      loadFields(fold, f.fold);
      this.files.set(f.path, { tail, fold, mtimeMs: f.mtimeMs, size: f.size });
    }
    this.cached = s.files.length === this.files.size ? s.cached : null;
  }

  /** Paths of subagent transcripts: `subagents/agent-*.jsonl` and
   *  `subagents/workflows/<wf>/agent-*.jsonl`. */
  private list(): string[] | null {
    const out: string[] = [];
    let changed = false;
    const walk = (d: string, depth: number) => {
      let st;
      try {
        st = statSync(d);
      } catch {
        return;
      }
      if (this.dirMtimes.get(d) !== st.mtimeMs) changed = true;
      this.dirMtimes.set(d, st.mtimeMs);
      let ents;
      try {
        ents = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl")) out.push(join(d, e.name));
        else if (e.isDirectory() && depth < 2 && (depth === 1 || e.name === "workflows")) walk(join(d, e.name), depth + 1);
      }
    };
    walk(this.dir, 0);
    return changed || this.files.size === 0 ? out : null;
  }

  refresh(): boolean {
    let rootMtime: number;
    try {
      rootMtime = statSync(this.dir).mtimeMs;
    } catch {
      return false;
    }
    const now = this.now();
    // A new subagent file changes the directory; a new workflow agent only
    // its own directory, which the periodic full pass catches.
    const full = now - this.lastFull >= SUB_FULL_MS || rootMtime !== this.dirMtimes.get(this.dir);
    const listed = full ? this.list() : null;
    if (full) this.lastFull = now;
    const paths = listed ?? [...this.files.keys()];
    let changed = false;
    for (const p of paths) {
      let f = this.files.get(p);
      if (f && !full && now - f.mtimeMs > SUB_HOT_MS) continue;
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (f && st.mtimeMs === f.mtimeMs && st.size === f.size) continue;
      if (!f) this.files.set(p, (f = { tail: new JsonlTail(p), fold: new ClaudeTokenFold(), mtimeMs: 0, size: 0 }));
      f.mtimeMs = st.mtimeMs;
      f.size = st.size;
      const fold = f.fold;
      let last = -1;
      f.tail.read((rec) => {
        if (rec.index <= last) fold.reset();
        last = rec.index;
        try {
          fold.add(rec.value);
        } catch {
          /* one odd record */
        }
      });
      changed = true;
    }
    if (changed || (this.cached === null && this.files.size)) {
      const t = emptyTotals();
      for (const f of this.files.values()) {
        t.input += f.fold.totals.input;
        t.output += f.fold.totals.output;
        t.cacheRead += f.fold.totals.cacheRead;
        t.cacheWrite += f.fold.totals.cacheWrite;
        t.costEquiv += f.fold.totals.costEquiv;
      }
      this.cached = t;
    }
    return changed;
  }
}
