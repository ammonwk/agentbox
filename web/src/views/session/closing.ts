/** Close, optimistically: the row leaves the list the moment you ask, and
 *  comes back — with the reason said — only if the server refuses. Stopping
 *  the process takes the server a moment, and nothing about that moment is
 *  worth watching. */

import { useSyncExternalStore } from "react";
import { api } from "../../api";

/** Ids asked to close whose close the app state does not show yet. */
let pending: ReadonlySet<string> = new Set();
/** The last thing that could not be done, and to what: "close" unless said. */
let failure: { id: string; title: string; message: string; verb?: string } | null = null;
const listeners = new Set<() => void>();

function set(next: ReadonlySet<string>, f = failure): void {
  pending = next;
  failure = f;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useClosing(): { pending: ReadonlySet<string>; failure: typeof failure; dismiss: () => void } {
  const p = useSyncExternalStore(subscribe, () => pending);
  const f = useSyncExternalStore(subscribe, () => failure);
  return { pending: p, failure: f, dismiss: () => set(pending, null) };
}

/** Hide it and the sessions it started now; the server stops and closes them behind the scenes. */
export function closeNow(id: string, title: string, family: readonly string[] = []): void {
  const ids = [id, ...family.filter((x) => x !== id)];
  set(new Set([...pending, ...ids]), failure && ids.includes(failure.id) ? null : failure);
  api.close(id, true).then(
    // Held a little past the answer: the state push that shows them closed can
    // land just after, and the rows should not blink back in between.
    () => setTimeout(() => ids.forEach(forget), 5000),
    (e: Error) => {
      ids.forEach(forget);
      set(pending, { id, title, message: e.message });
    },
  );
}

/** Hidden now, gone for good once `act` settles; back, with the reason said, if it fails. */
export function hideWhile(id: string, title: string, verb: string, act: Promise<unknown>): void {
  set(new Set(pending).add(id), failure?.id === id ? null : failure);
  act.then(
    () => setTimeout(() => forget(id), 5000),
    (e: Error) => {
      forget(id);
      set(pending, { id, title, message: e.message, verb });
    },
  );
}

/** No longer hidden: it closed, failed, or is being reopened. */
export function forget(id: string): void {
  if (!pending.has(id)) return;
  const next = new Set(pending);
  next.delete(id);
  set(next);
}
