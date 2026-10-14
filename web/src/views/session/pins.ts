/** Pin, unpin, reorder and bookmark, optimistically: the list shows the change
 *  the moment you make it, and goes back, with the reason said, only if the
 *  server refuses. */

import { useMemo, useSyncExternalStore } from "react";
import type { Session } from "../../../../src/core/types";
import { api } from "../../api";
import { pinBetween, pinnedOf, titleOf } from "../../lib/board";
import { reportFailure } from "./closing";

type Marks = Pick<Session, "pinOrder" | "bookmarkedAt">;

/** What was asked of each session and the app state does not show yet. */
let asked: ReadonlyMap<string, Partial<Marks>> = new Map();
const listeners = new Set<() => void>();

function set(next: ReadonlyMap<string, Partial<Marks>>): void {
  asked = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function drop(id: string, mark: Partial<Marks>): void {
  const cur = asked.get(id);
  // A later ask of the same session is its own, and stays.
  if (!cur || Object.keys(mark).some((k) => cur[k as keyof Marks] !== mark[k as keyof Marks])) return;
  const next = new Map(asked);
  next.delete(id);
  set(next);
}

function ask(s: Pick<Session, "id" | "label" | "title" | "firstPrompt">, mark: Partial<Marks>, verb: string): void {
  set(new Map(asked).set(s.id, { ...asked.get(s.id), ...mark }));
  const patch = {
    ...(mark.pinOrder !== undefined ? { pinOrder: mark.pinOrder } : {}),
    ...(mark.bookmarkedAt !== undefined ? { bookmarked: mark.bookmarkedAt !== null } : {}),
  };
  api.patchSession(s.id, patch).then(
    // Held a little past the answer: the state push that shows it can land
    // just after, and the row should not blink back in between.
    () => setTimeout(() => drop(s.id, mark), 5000),
    (e: Error) => {
      drop(s.id, mark);
      reportFailure(s.id, titleOf(s), verb, e.message);
    },
  );
}

/** The sessions with what was just asked of them laid over. */
export function usePinned<T extends Session>(sessions: readonly T[]): readonly T[] {
  const a = useSyncExternalStore(subscribe, () => asked);
  return useMemo(() => (a.size === 0 ? sessions : sessions.map((s) => (a.has(s.id) ? { ...s, ...a.get(s.id) } : s))), [sessions, a]);
}

/** Pinned, it goes to the foot of the pinned; unpinned, back to its place in the list. */
export function togglePin(s: Session, sessions: readonly Session[]): void {
  if (s.pinOrder !== null) return ask(s, { pinOrder: null }, "unpin");
  const last = pinnedOf(sessions).at(-1)?.pinOrder ?? null;
  ask(s, { pinOrder: pinBetween(last, null) }, "pin");
}

/** Move a pinned session to just before or after another pinned one. */
export function movePin(s: Session, target: Session, where: "before" | "after", sessions: readonly Session[]): void {
  const pins = pinnedOf(sessions).filter((p) => p.id !== s.id);
  const i = pins.findIndex((p) => p.id === target.id);
  if (i === -1) return;
  const [a, b] = where === "before" ? [pins[i - 1], pins[i]] : [pins[i], pins[i + 1]];
  ask(s, { pinOrder: pinBetween(a?.pinOrder ?? null, b?.pinOrder ?? null) }, "move");
}

export function toggleBookmark(s: Session): void {
  ask(s, { bookmarkedAt: s.bookmarkedAt !== null ? null : Date.now() }, s.bookmarkedAt !== null ? "remove the bookmark from" : "bookmark");
}
