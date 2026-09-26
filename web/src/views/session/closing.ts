/** Close, optimistically: the row leaves the list the moment you ask, and
 *  comes back — with the reason said — only if the server refuses. Stopping
 *  the process takes the server a moment, and nothing about that moment is
 *  worth watching. */

import { useSyncExternalStore } from "react";
import { api } from "../../api";

/** Ids asked to close whose close the app state does not show yet. */
let pending: ReadonlySet<string> = new Set();
let failure: { id: string; title: string; message: string } | null = null;
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

/** Hide it now; the server stops and closes it behind the scenes. */
export function closeNow(id: string, title: string): void {
  set(new Set(pending).add(id), failure?.id === id ? null : failure);
  api.close(id, true).then(
    // Held a little past the answer: the state push that shows it closed can
    // land just after, and the row should not blink back in between.
    () => setTimeout(() => forget(id), 5000),
    (e: Error) => {
      forget(id);
      set(pending, { id, title, message: e.message });
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
