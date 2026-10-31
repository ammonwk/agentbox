/** URL ↔ route. Selection lives in the hash so every screen is linkable and
 *  the back button works; go() is how the app moves between them. */

export type SessionTab = "terminal" | "timeline" | "load";
/** The tabs as they appear, left to right. The first is the default. */
export const SESSION_TABS: readonly SessionTab[] = ["timeline", "terminal", "load"];

export type Route =
  | { page: "sessions" }
  /** An extension's page (docs/extensions.md), or the first one's: a tab of Settings. */
  | { page: "extensions"; name: string | null }
  /** A session; `at`, one message in its timeline: the conversation opened there. */
  | { page: "session"; id: string; tab: SessionTab; at?: string }
  | { page: "accounts"; sub: "accounts" | "calibration" }
  /** One account's usage insights. */
  | { page: "accounts"; sub: "insights"; account: string }
  /** What agents are told: rules, instruction files and skills. */
  | { page: "context" }
  /** The global MCP servers every agent is given. */
  | { page: "mcps" }
  /** A page an extension added (web/src/plugin/registry.tsx), at `#/<id>[/<rest>]`. */
  | { page: "ext"; id: string; rest: string }
  | { page: "voice" }
  | { page: "settings" };

/** The rail entry a route lights up. */
export type NavId = "sessions" | "voice" | "accounts" | "context" | "mcps" | "settings" | (string & {});

export function navOf(route: Route): NavId {
  if (route.page === "extensions") return "settings";
  if (route.page === "ext") return route.id;
  return route.page === "session" ? "sessions" : route.page;
}

function decode(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    // A hand-mangled URL is not worth a crash; treat it as the literal.
    return p;
  }
}

/** How each core page's head parses, keyed by its `page`: the type makes every
 *  page routePath writes as `#/<page>` parse back to itself. */
type Parse = (a: string | undefined, b: string | undefined, parts: string[]) => Route;
const PAGES: { [P in Exclude<Route["page"], "ext" | "session">]: Parse } = {
  sessions: () => ({ page: "sessions" }),
  extensions: (a) => ({ page: "extensions", name: a ?? null }),
  accounts: (a, b) => (a === "insights" && b ? { page: "accounts", sub: "insights", account: b } : { page: "accounts", sub: a === "calibration" ? "calibration" : "accounts" }),
  context: () => ({ page: "context" }),
  mcps: () => ({ page: "mcps" }),
  voice: () => ({ page: "voice" }),
  settings: () => ({ page: "settings" }),
};
const HEADS: Record<string, Parse> = {
  ...PAGES,
  s: (a, b, parts) => {
    if (!a) return { page: "sessions" };
    if (b === "at" && parts[3]) return { page: "session", id: a, tab: "timeline", at: parts[3] };
    return { page: "session", id: a, tab: SESSION_TABS.includes(b as SessionTab) ? (b as SessionTab) : "timeline" };
  },
  // Old names: agents were what extensions replaced, and Skills became Context.
  agents: PAGES.extensions,
  skills: PAGES.context,
};

/** The heads the app's own pages answer to: no extension's page may take one. */
export const CORE_HEADS: ReadonlySet<string> = new Set(Object.keys(HEADS));

export function parseHash(hash: string): Route {
  const parts = hash.split("?")[0]!.replace(/^#\/?/, "").split("/").filter(Boolean).map(decode);
  const [head, a, b] = parts;
  if (!head) return { page: "sessions" };
  const core = Object.hasOwn(HEADS, head) ? HEADS[head] : undefined;
  if (core) return core(a, b, parts);
  // Anything else is a page an extension adds, once it has loaded (or says there is none).
  if (/^[a-z][a-z0-9-]{0,39}$/.test(head)) return { page: "ext", id: head, rest: parts.slice(1).join("/") };
  return { page: "sessions" };
}

function routePath(route: Route): string {
  switch (route.page) {
    case "session":
      if (route.at) return `#/s/${encodeURIComponent(route.id)}/at/${encodeURIComponent(route.at)}`;
      return `#/s/${encodeURIComponent(route.id)}${route.tab === "timeline" ? "" : `/${route.tab}`}`;
    case "extensions":
      return route.name ? `#/extensions/${encodeURIComponent(route.name)}` : "#/extensions";
    case "ext":
      return `#/${route.id}${route.rest ? `/${route.rest.split("/").map(encodeURIComponent).join("/")}` : ""}`;
    case "accounts":
      if (route.sub === "insights") return `#/accounts/insights/${encodeURIComponent(route.account)}`;
      return route.sub === "calibration" ? "#/accounts/calibration" : "#/accounts";
    default:
      return `#/${route.page}`;
  }
}

// ------------------------------------------------------------------- scope

/**
 * What the board is looking at, beside where: the selected project (a repo
 * id; "" is an explicit All projects), as `#/route?project=…`. Part of each history entry, so Back,
 * a reload and separate tabs cannot silently change the context a draft or
 * a list is in. Selecting one is navigation only: no process starts or stops.
 */
export type ScopeKey = "project";

export function scopeOf(hash = location.hash): URLSearchParams {
  return new URLSearchParams(hash.split("?")[1] ?? "");
}

/** The link to a route, in the scope the page is in now. */
export function hrefOf(route: Route): string {
  const scope = scopeOf().toString();
  return routePath(route) + (scope ? `?${scope}` : "");
}

const SCOPE_KEY = "agentbox.navigationScope";

/** A route whose detail (an open session) may not belong to the new scope,
 *  mapped to its list. A later page with details of its own extends this. */
function listOf(route: Route): Route {
  return route.page === "session" ? { page: "sessions" } : route;
}

/** Whether the route is a detail an old, unscoped link may point at. */
function isDetail(route: Route): boolean {
  return route.page === "session";
}

/** Select a scope, staying on the page (its list, if it was a detail) or
 *  going to `to`, and remember it as what unscoped links open in. */
export function selectScope(key: ScopeKey, value: string | null, to?: Route, replace = false): void {
  const scope = scopeOf();
  scope.set(key, value ?? ""); // an explicit All overrides the remembered default
  const href = routePath(to ?? listOf(parseHash(location.hash))) + `?${scope}`;
  if (href === location.hash) return;
  history[replace ? "replaceState" : "pushState"](null, "", href);
  try {
    localStorage.setItem(SCOPE_KEY, scope.toString());
  } catch {
    /* private mode: this tab remembers it */
  }
  moved.forEach((fn) => fn());
}

/** On first render: an unscoped link to a list opens in the scope this
 *  browser last used. A link to a detail stays unscoped — the detail says
 *  which project it is in once it is known — so old links keep working. */
export function restoreScope(): void {
  if (location.hash.includes("?")) return;
  const route = parseHash(location.hash);
  if (isDetail(route)) return;
  try {
    const scope = localStorage.getItem(SCOPE_KEY);
    if (scope) history.replaceState(history.state, "", routePath(route) + `?${scope}`);
  } catch {
    /* private mode: nothing remembered */
  }
}

// ------------------------------------------------------------------ moving

/** Below this the board shows one pane at a time (useIsNarrow, session.css). */
const NARROW = "(max-width: 900px)";

/** The history entry's own state: whether the entry under it is the list. */
type Entry = { overList?: boolean } | null;

function overList(): boolean {
  return (history.state as Entry)?.overList === true;
}

const moved = new Set<() => void>();

/** Called after go() changes the route without a hashchange (a replace, a back). */
export function onGo(fn: () => void): () => void {
  moved.add(fn);
  return () => moved.delete(fn);
}

/**
 * Go somewhere. On a narrow screen a session is a page laid over the list, so
 * the history under any session is the list: the back gesture, closing it and
 * the Sessions tab all go there, never to the session before or the dialog
 * that made it. A session opened from another one takes its entry, and going
 * to the list from one goes back to the entry beneath it rather than pushing
 * a second list.
 */
export function go(to: Route, replace = false): void {
  const href = hrefOf(to);
  if (href === location.hash) return;
  const from = parseHash(location.hash);
  const over = overList();
  if (matchMedia(NARROW).matches) {
    if (to.page === "sessions" && from.page === "session" && over) {
      history.back();
      return;
    }
    if (to.page === "session" && from.page === "session") replace = true;
  }
  const state: Entry = to.page === "session" && (from.page === "sessions" || (from.page === "session" && replace && over)) ? { overList: true } : null;
  if (replace) {
    history.replaceState(state, "", href);
    moved.forEach((fn) => fn());
  } else {
    location.hash = href;
    if (state) history.replaceState(state, "", href);
  }
}

/** On a narrow screen, put the list under a session the app was opened on (a
 *  link, a notification, a reload), so back from it is the list too. */
export function listUnderSession(): void {
  if (!matchMedia(NARROW).matches || parseHash(location.hash).page !== "session" || overList()) return;
  // A file open in the viewer: this tab made the history under it already.
  if ((history.state as { fileViewer?: unknown } | null)?.fileViewer) return;
  const href = hrefOf(parseHash(location.hash));
  history.replaceState(null, "", hrefOf({ page: "sessions" }));
  history.pushState({ overList: true } satisfies Entry, "", href);
}

/**
 * Send the app's own links through go(), so they keep the scope the page is
 * in and, on a narrow screen, history as go() keeps it. A link into another
 * scope is a plain hash navigation: it means that scope. On React's root and
 * added after it: React's handlers have run (a preventDefault is seen) and
 * its stopPropagation, which a link in a clickable row uses, does not hide
 * the click from a listener on the same element.
 */
export function followLinks(root: HTMLElement): void {
  root.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element | null)?.closest?.("a[href^='#/']");
    if (!a || a.getAttribute("target")) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.includes("?") && scopeOf(href).toString() !== scopeOf().toString()) {
      location.hash = href;
      return;
    }
    go(parseHash(href));
  });
}
