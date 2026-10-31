/**
 * What extensions add to the app (docs/extensions.md, Its part in the app):
 * the client half of each one, loaded into this page at start, and what it
 * registered — pages in the rail, keys, items in the system bar, sections in
 * Settings, buttons on a session. The app draws these where they go; each
 * inside its own error boundary, so a broken one says so in its own space.
 *
 * Nothing here knows any extension by name. Review comes with agentbox, as an
 * extension in `extensions/review/`, through this same door.
 */

import { Component, createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AppState, Session } from "../../../src/core/types";
import { api, MOCK, request } from "../api";
import { ErrorBoundary, type IconComponent } from "../components";
import { CORE_HEADS } from "../route";

/** A page in the rail, at `#/<id>`. */
export type PageDef = {
  /** Its address, `#/<id>[/<rest>]`: lowercase letters, digits and dashes. */
  id: string;
  label: string;
  icon: IconComponent;
  /** The count on its rail entry; 0 shows none. Given what `render` is given. */
  badge?: (state: AppState) => number;
  /** What the count means, for its tooltip: "4 cards to review". */
  badgeTitle?: (n: number) => string;
  /** Filtered to the project selected at the top, as Sessions is. */
  scoped?: boolean;
  /** It draws its own header: no page title above it, and no padding. */
  flush?: boolean;
  /** Its own keys, listed under its label in the shortcuts (`?`): [key, what it does]. */
  keys?: [string, string][];
  render: (p: { state: AppState; rest: string }) => ReactNode;
};

/** A key that works anywhere outside a field: one character, no modifier. */
export type CommandDef = { key: string; label: string; run: () => void };

export type SettingsDef = { title: string; render: () => ReactNode };

/** What an extension's client is given: everything it adds, it adds through this. */
export type Plugin = {
  readonly name: string;
  page(def: PageDef): void;
  command(def: CommandDef): void;
  /** Something at the end of the system bar along the bottom. */
  status(render: () => ReactNode): void;
  /** A section at the end of Settings → General. */
  settings(def: SettingsDef): void;
  /** Buttons in an open session's tab bar. */
  sessionAction(render: (p: { session: Session }) => ReactNode): void;
  /** A JSON value of its own, kept by agentbox in its home (`data.json`), which its program can read too. */
  data: { load<T = unknown>(): Promise<T | null>; save(value: unknown): Promise<void> };
};

export type Loaded = {
  name: string;
  state: "loading" | "on" | "failed";
  error: string | null;
  pages: PageDef[];
  commands: CommandDef[];
  status: (() => ReactNode)[];
  settings: SettingsDef[];
  sessionActions: ((p: { session: Session }) => ReactNode)[];
};

/** Keys the app answers to itself. */
const CORE_KEYS = new Set(["n", "?", "/", "j", "k", "h", "l", "u", "1", "2", "3"]);
const PAGE_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** `?safe=1`: this page loads no extension's client, to get past one that breaks the app. */
export const SAFE = typeof location !== "undefined" && new URLSearchParams(location.search).has("safe");

let loaded: Loaded[] = [];
let ready = false;
const listeners = new Set<() => void>();
const emit = () => {
  loaded = [...loaded];
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Every extension's client and what it added, and whether loading has finished. */
export function usePlugins(): { loaded: Loaded[]; ready: boolean } {
  const l = useSyncExternalStore(subscribe, () => loaded);
  const r = useSyncExternalStore(subscribe, () => ready);
  return { loaded: l, ready: r };
}

/** Every page extensions added, first come first served. */
export function pagesOf(all: Loaded[]): (PageDef & { ext: string })[] {
  return all.flatMap((l) => l.pages.map((p) => ({ ...p, ext: l.name })));
}

function plugin(l: Loaded): Plugin {
  const taken = (what: string) => {
    throw new Error(`${l.name}: ${what}`);
  };
  const data = `/api/extensions/${encodeURIComponent(l.name)}/data`;
  return {
    name: l.name,
    page(def) {
      if (!PAGE_ID.test(def.id)) taken(`page id ${JSON.stringify(def.id)}: lowercase letters, digits and dashes, starting with a letter`);
      if (CORE_HEADS.has(def.id) || loaded.some((o) => o.pages.some((p) => p.id === def.id))) taken(`a page called ${def.id} is already there`);
      l.pages.push(def);
      emit();
    },
    command(def) {
      if (def.key.length !== 1 || CORE_KEYS.has(def.key) || loaded.some((o) => o.commands.some((c) => c.key === def.key))) taken(`the key ${JSON.stringify(def.key)} is taken, or not one character`);
      l.commands.push(def);
      emit();
    },
    status(render) {
      l.status.push(render);
      emit();
    },
    settings(def) {
      l.settings.push(def);
      emit();
    },
    sessionAction(render) {
      l.sessionActions.push(render);
      emit();
    },
    data: {
      load: <T,>() => request<T | null>("GET", data),
      save: (value) => request<void>("PUT", data, { value }),
    },
  };
}

/**
 * Load each extension's client that is on, once, at start: its module from
 * `/api/extensions/<name>/client.js`, bundled by the server against this
 * build's React and `agentbox/client`. Its default export is called with
 * the `Plugin` it adds things through. One that throws is shown failed on
 * Settings → Extensions; the others load regardless.
 */
export async function loadPlugins(): Promise<void> {
  if (MOCK || SAFE) {
    ready = true;
    emit();
    return;
  }
  try {
    // Those that come with agentbox first, so a page of yours goes after theirs in the rail.
    const exts = (await api.extensions()).filter((x) => x.client && x.enabled).sort((a, b) => Number(b.builtIn) - Number(a.builtIn));
    loaded = exts.map((x) => ({ name: x.name, state: "loading", error: null, pages: [], commands: [], status: [], settings: [], sessionActions: [] }));
    emit();
    await Promise.all(
      loaded.map(async (l) => {
        try {
          const mod = (await import(/* @vite-ignore */ `/api/extensions/${encodeURIComponent(l.name)}/client.js`)) as { default?: (p: Plugin) => unknown };
          if (typeof mod.default !== "function") throw new Error("its client has no default export: export default function (p: Plugin) { … }");
          await mod.default(plugin(l));
          l.state = "on";
        } catch (e) {
          l.state = "failed";
          l.error = (e as Error).message;
          console.error(`agentbox: extension ${l.name}`, e);
        }
        emit();
      }),
    );
  } catch (e) {
    console.error("agentbox: could not list extensions", e);
  }
  ready = true;
  emit();
}

/** Run the command for `key`, if an extension has one: true when one ran. */
export function runCommand(key: string): boolean {
  for (const l of loaded) {
    const c = l.commands.find((x) => x.key === key);
    if (!c) continue;
    try {
      c.run();
    } catch (e) {
      console.error(`agentbox: extension ${l.name}, key ${key}`, e);
    }
    return true;
  }
  return false;
}

/** One thing an extension drew, fenced off: its failure is its own. A page or
 *  a section says so in full; a button or a status item, which has no room
 *  for that, as a mark that names the extension, with the error on hover. */
export function Fenced({ ext, what, reset, small, children }: { ext: string; what: string; reset?: string; small?: boolean; children: ReactNode }) {
  if (small) return <SmallFence ext={ext} what={what} reset={reset}>{children}</SmallFence>;
  return (
    <ErrorBoundary label={`${what} from the ${ext} extension`} resetKey={reset}>
      {children}
    </ErrorBoundary>
  );
}

class SmallFence extends Component<{ ext: string; what: string; reset?: string; children: ReactNode }, { error: Error | null; reset?: string }> {
  state: { error: Error | null; reset?: string } = { error: null, reset: this.props.reset };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { reset?: string }, state: { error: Error | null; reset?: string }) {
    return props.reset !== state.reset ? { error: null, reset: props.reset } : null;
  }
  componentDidCatch(error: Error) {
    console.error(`agentbox: ${this.props.what} from the ${this.props.ext} extension`, error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <span className="ext-broken" title={`${this.props.what} from the ${this.props.ext} extension crashed: ${this.state.error.message}`}>
        ⚠ {this.props.ext}
      </span>
    );
  }
}

/** What the app is showing: all of it, and the part the selected project filters to. */
export type Seen = { state: AppState; scoped: AppState; project: string | null };
export const SeenContext = createContext<Seen | null>(null);

export function useSeen(): Seen {
  const s = useContext(SeenContext);
  if (!s) throw new Error("useAgentbox() is for what an extension draws inside the app");
  return s;
}

/** The buttons extensions add to an open session's tab bar. */
export function ExtSessionActions({ session }: { session: Session }) {
  const { loaded: all } = usePlugins();
  return (
    <>
      {all.flatMap((l) =>
        l.sessionActions.map((render, i) => (
          <Fenced key={`${l.name}:${i}`} ext={l.name} what="A session button" reset={session.id} small>
            {render({ session })}
          </Fenced>
        )),
      )}
    </>
  );
}

/** What has loaded now, outside React: for a list drawn once, like the shortcuts. */
export const loadedPlugins = (): Loaded[] => loaded;
