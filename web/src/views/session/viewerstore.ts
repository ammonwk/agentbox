import { createContext, useSyncExternalStore } from "react";
import { api } from "../../api";
import { NOWHERE, type AgentPlaces } from "../../lib/timeline";
import { trailFrom, type Trail } from "../../lib/previews";

/** A file in the viewer (FileViewer.tsx): the session whose directory a
 *  relative path is read in, the path as it was written, `:line` and all,
 *  and where the agent was when it wrote it (`AgentDir`), tried first. */
export interface ViewerEntry {
  session: string;
  path: string;
  dirs?: readonly string[];
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
  if (next.length === stack.length && next.every((e, i) => e.path === stack[i]!.path && e.session === stack[i]!.session && String(e.dirs) === String(stack[i]!.dirs))) return;
  stack = next;
  listeners.forEach((fn) => fn());
};

/** The files beside the link each open one came from, by depth, which ← and
 *  → step through (`lib/previews`). Kept here, not in the history entry, so a
 *  reload leaves the file open but steps nowhere. */
const trails: (Trail | null)[] = [];

export function openInViewer(e: ViewerEntry, from?: HTMLElement): void {
  trails.length = stack.length;
  trails.push(from ? trailFrom(from) : null);
  history.pushState({ ...(history.state as object | null), fileViewer: [...stack, e] }, "", location.href);
  sync();
}

export const trailAt = (depth: number): Trail | null => trails[depth - 1] ?? null;

/** In place of the file on top, the one `step` along its trail. */
export function stepViewer(step: -1 | 1): void {
  const trail = trails[stack.length - 1];
  const next = trail?.items[trail.at + step];
  if (!trail || !next) return;
  trails[stack.length - 1] = { ...trail, at: trail.at + step };
  history.replaceState({ ...(history.state as object | null), fileViewer: [...stack.slice(0, -1), JSON.parse(next.target) as ViewerEntry] }, "", location.href);
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

/** Where the agent had been when it wrote the text being read
 *  (`agentPlaces`): a relative path it names is looked for there
 *  (`placesFor`) before the session's own directory. */
export const AgentDir = createContext<AgentPlaces>(NOWHERE);

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
