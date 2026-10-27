import { createContext, useSyncExternalStore } from "react";
import { api } from "../../api";

/** A file in the viewer (FileViewer.tsx): the session whose directory a
 *  relative path is read in, and the path as it was written, `:line` and all. */
export interface ViewerEntry {
  session: string;
  path: string;
}

/** What the viewer shows, as a stack: a link in a viewed file opens over it.
 *  Each file is a history entry, so a phone's back gesture steps back through
 *  them and then closes it, rather than leaving the session. */
let stack: ViewerEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

type Entry = { fileViewer?: number } | null;
const depthOf = (): number => (history.state as Entry)?.fileViewer ?? 0;

export function openInViewer(e: ViewerEntry): void {
  stack = [...stack, e];
  history.pushState({ ...(history.state as object | null), fileViewer: stack.length }, "", location.href);
  emit();
}

export function viewerBack(): void {
  if (depthOf() > 0) history.back();
  else closeViewer();
}

export function closeViewer(): void {
  const depth = depthOf();
  if (depth > 0) history.go(-depth);
  stack = [];
  emit();
}

addEventListener("popstate", () => {
  const depth = depthOf();
  if (depth === stack.length) return;
  stack = stack.slice(0, Math.min(depth, stack.length));
  emit();
});
// Following a link out of the viewer (a session) leaves it.
addEventListener("hashchange", () => {
  if (stack.length === 0) return;
  stack = [];
  emit();
});

export function useViewerStack(): ViewerEntry[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => stack,
  );
}

/** The directory of the file being viewed: a relative link or image in it is
 *  read beside it, not in the session's directory. */
export const FileBase = createContext<string | null>(null);

export function inBase(base: string | null, path: string): string {
  if (!base || /^(?:\/|~(?:\/|$)|file:)/.test(path)) return path;
  return `${base}/${path}`;
}

/** Whether this browser runs on the server's machine, where the desktop can
 *  open a file too: asked once. */
let here: boolean | null = null;
let asked: Promise<void> | null = null;
export function useOnThisMachine(): boolean {
  return useSyncExternalStore(
    (fn) => {
      asked ??= api.desktop().then(
        (d) => {
          here = d.here;
        },
        () => {
          here = false;
        },
      );
      void asked.then(fn);
      return () => undefined;
    },
    () => here ?? false,
  );
}
