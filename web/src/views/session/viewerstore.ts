import { createContext, useSyncExternalStore } from "react";
import { api } from "../../api";

/** A file in the viewer (FileViewer.tsx): the session whose directory a
 *  relative path is read in, and the path as it was written, `:line` and all. */
export interface ViewerEntry {
  session: string;
  path: string;
}

/** What the viewer shows, as a stack: a link in a viewed file opens over it.
 *  The stack lives in the history entry, one entry per file, so a phone's
 *  back gesture steps back through them and then closes it, forward opens
 *  them again, and a reload leaves the viewer as it was. */
type Entry = { fileViewer?: ViewerEntry[] } | null;
const stackOf = (): ViewerEntry[] => {
  const s = (history.state as Entry)?.fileViewer;
  return Array.isArray(s) ? s : [];
};

let stack = stackOf();
const listeners = new Set<() => void>();
const sync = () => {
  const next = stackOf();
  if (next.length === stack.length && next.every((e, i) => e.path === stack[i]!.path && e.session === stack[i]!.session)) return;
  stack = next;
  listeners.forEach((fn) => fn());
};

export function openInViewer(e: ViewerEntry): void {
  history.pushState({ ...(history.state as object | null), fileViewer: [...stack, e] }, "", location.href);
  sync();
}

export function viewerBack(): void {
  history.back();
}

export function closeViewer(): void {
  history.go(-stack.length);
}

addEventListener("popstate", sync);
addEventListener("hashchange", sync);

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
