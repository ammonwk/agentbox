/** Side questions (Claude's /btw), asked and read through the session's pane.
 *
 * Claude answers a /btw as a one-off request on the main thread's cached
 * prefix and keeps the answer only in memory, so agentbox cannot ask it
 * itself (a new process builds another prefix, and misses the cache) and
 * cannot read it from any file. It types the /btw into the TUI, waits for the
 * panel to say it has answered, presses `c` — inside tmux Claude copies with
 * `tmux load-buffer`, so the markdown lands whole in a paste buffer — and
 * takes that buffer. The panel is read by `claude-btw.ts`.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "./fleet";
import { readBtwPanel, showsQuestion } from "./providers/claude-btw";

/** How long an answer may take: a big context asked cold is slow. */
export const BTW_TIMEOUT_MS = 10 * 60_000;
const POLL_MS = 400;

export class BtwError extends Error {}

/**
 * Until the panel shows `question` answered (`null`: whatever it is asking).
 * It must be up within `openMs`, and closing it before the answer is an error.
 */
export async function awaitAnswer(rt: Runtime, pane: string, question: string | null, openMs: number, timeoutMs = BTW_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  let seen = false;
  while (Date.now() - start < timeoutMs) {
    const p = readBtwPanel(rt.capture(pane) ?? "");
    if (!p) {
      if (seen) throw new BtwError("the /btw panel was closed before it answered");
      if (Date.now() - start > openMs) throw new BtwError("the /btw panel did not open");
    } else {
      seen = true;
      // Another question is on show while you browse the history: wait.
      const ours = question === null || showsQuestion(p, question);
      if (ours && p.state === "failed") throw new BtwError(p.error ?? "Claude could not answer it");
      if (ours && p.state === "answered") return;
    }
    await Bun.sleep(POLL_MS);
  }
  throw new BtwError(`no answer within ${Math.round(timeoutMs / 60_000)} minutes`);
}

/** Press `c` on the answered panel and take what Claude copied into tmux. */
export async function copyAnswer(rt: Runtime, pane: string): Promise<string> {
  if (!rt.bufferNames || !rt.takeBuffer) throw new BtwError("cannot read tmux's paste buffers here");
  const before = new Set(rt.bufferNames());
  rt.sendKeys(pane, ["c"]);
  for (let t = 0; t < 3_000; t += 50) {
    await Bun.sleep(50);
    const added = rt.bufferNames().find((b) => !before.has(b));
    const text = added ? rt.takeBuffer(added) : null;
    if (text !== null) return text.replace(/\s+$/, "");
  }
  throw new BtwError("pressing c did not copy the answer");
}

/**
 * Close the panel if it is up, and wait until it has gone: what is typed
 * while it closes is lost. Escape once, and only on seeing the panel — at the
 * prompt, Escape interrupts the turn.
 */
export async function closePanel(rt: Runtime, pane: string): Promise<void> {
  if (!readBtwPanel(rt.capture(pane) ?? "")) return;
  rt.sendKeys(pane, ["Escape"]);
  for (let t = 0; t < 3_000; t += 100) {
    await Bun.sleep(100);
    if (!readBtwPanel(rt.capture(pane) ?? "")) break;
  }
  await Bun.sleep(150);
}

/**
 * Get a panel out of the way before typing into the pane: typed into it,
 * `x` clears Claude's /btw history and `f` forks the session. One still
 * asking is let finish first (its answer is kept: `Fleet.watchTerminalBtw`).
 */
export async function clearPanel(rt: Runtime, pane: string): Promise<void> {
  const p = readBtwPanel(rt.capture(pane) ?? "");
  if (!p) return;
  if (p.state === "asking") await awaitAnswer(rt, pane, null, 0, 2 * 60_000).catch(() => {});
  await closePanel(rt, pane);
}

export interface HistoryBtw {
  agentSessionId: string;
  question: string;
  at: number;
}

/**
 * The /btw lines appended to each Claude home's prompt history
 * (`history.jsonl`, one line per prompt with its session id): the side
 * questions asked in the terminal. Claude writes the question there, never
 * the answer. Stat each pass; read only what was appended.
 */
export class BtwHistory {
  private offsets = new Map<string, number>();

  /** What was appended since the last call. The first call for a file only notes where it ends. */
  read(homes: readonly string[]): HistoryBtw[] {
    const out: HistoryBtw[] = [];
    for (const home of new Set(homes)) {
      const path = join(home, "history.jsonl");
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      const from = this.offsets.get(path);
      if (from === undefined || size < from) {
        this.offsets.set(path, size);
        continue;
      }
      if (size === from) continue;
      const buf = Buffer.alloc(size - from);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, buf.length, from);
      } finally {
        closeSync(fd);
      }
      const end = buf.lastIndexOf(10);
      if (end < 0) continue; // a line still being written
      this.offsets.set(path, from + end + 1);
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        try {
          const e = JSON.parse(line) as { display?: unknown; sessionId?: unknown; timestamp?: unknown };
          if (typeof e.display !== "string" || typeof e.sessionId !== "string" || !/^\/btw\s+\S/.test(e.display)) continue;
          out.push({
            agentSessionId: e.sessionId,
            question: e.display.replace(/^\/btw\s+/, "").trim(),
            at: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
          });
        } catch {
          /* not a line of JSON */
        }
      }
    }
    return out;
  }
}
