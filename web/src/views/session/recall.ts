import { useRef, type KeyboardEvent } from "react";
import type { Turn } from "../../../../src/core/types";
import { dropPasteTags, readSent } from "../../../../src/core/sent";
import { api } from "../../api";

/** The turn list caps a message's text at this; a longer one is read from the transcript. */
const TURN_CAP = 600;

/** A message's whole text: the turn list carries only its start. */
async function fullText(sessionId: string, turn: Turn): Promise<string> {
  if (turn.text.length < TURN_CAP) return turn.text;
  let before: string | undefined;
  for (;;) {
    const page = await api.timeline(sessionId, { before, limit: 1000 });
    const ev = page.events.find((e) => e.id === turn.id);
    if (ev?.kind === "user") return dropPasteTags(readSent(ev.text.trim()).text).trim();
    if (!page.before || page.before === before) return turn.text;
    before = page.before;
  }
}

/**
 * ↑ in an empty composer brings back the last thing you said to this session,
 * and again the one before; ↓ goes forward, and past the newest empties the
 * box. Any edit leaves the history where it is. Returns whether it took the key.
 */
export function useRecall(sessionId: string, text: string, setText: (t: string) => void) {
  const browsing = useRef<{ said: Turn[]; index: number; shown: string } | null>(null);
  if (browsing.current && text !== browsing.current.shown) browsing.current = null;

  async function step(by: 1 | -1) {
    const b = browsing.current ?? { said: [], index: -1, shown: "" };
    if (!browsing.current) {
      const list = await api.turns(sessionId).catch(() => null);
      b.said = (list?.turns ?? []).filter((t) => t.kind === "prompt" || t.kind === "command").reverse();
    }
    const index = Math.min(b.said.length - 1, b.index + by);
    if (index === b.index) return;
    const shown = index < 0 ? "" : await fullText(sessionId, b.said[index]!);
    browsing.current = index < 0 ? null : { ...b, index, shown };
    setText(shown);
  }

  return (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if ((e.key !== "ArrowUp" && e.key !== "ArrowDown") || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
    if (!(browsing.current ? text === browsing.current.shown : !text && e.key === "ArrowUp")) return false;
    e.preventDefault();
    void step(e.key === "ArrowUp" ? 1 : -1);
    return true;
  };
}
