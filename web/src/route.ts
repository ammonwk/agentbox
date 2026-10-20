/** URL ↔ route. Selection lives in the hash so every screen is linkable and
 *  the back button works; go() is how the app moves between them. */

export type SessionTab = "terminal" | "timeline" | "load";
/** The tabs as they appear, left to right. The first is the default. */
export const SESSION_TABS: readonly SessionTab[] = ["timeline", "terminal", "load"];

export type Route =
  | { page: "sessions" }
  /** A superagent: its chat, a tab of its page, its sessions or about it. */
  | { page: "agents"; name: string | null; tab: string | null }
  | { page: "session"; id: string; tab: SessionTab }
  | { page: "accounts"; sub: "accounts" | "calibration" }
  /** One account's usage insights. */
  | { page: "accounts"; sub: "insights"; account: string }
  /** What agents are told: rules, instruction files and skills. */
  | { page: "context" }
  /** The global MCP servers every agent is given. */
  | { page: "mcps" }
  /** The cards sessions handed you: to decide, or to know. */
  | { page: "review" }
  | { page: "voice" }
  | { page: "team" }
  | { page: "settings" };

/** The rail entry a route lights up. */
export type NavId = "agents" | "sessions" | "review" | "voice" | "accounts" | "context" | "mcps" | "team" | "settings";

export function navOf(route: Route): NavId {
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

export function parseHash(hash: string): Route {
  const parts = hash.split("?")[0]!.replace(/^#\/?/, "").split("/").filter(Boolean).map(decode);
  const [head, a, b] = parts;
  if (head === "s" && a) {
    const tab = SESSION_TABS.includes(b as SessionTab) ? (b as SessionTab) : "timeline";
    return { page: "session", id: a, tab };
  }
  if (head === "accounts") {
    if (a === "insights" && b) return { page: "accounts", sub: "insights", account: b };
    return { page: "accounts", sub: a === "calibration" ? "calibration" : "accounts" };
  }
  if (head === "agents") return { page: "agents", name: a ?? null, tab: a && b ? b : null };
  // `#/skills` is the page before it became Context; old links keep working.
  if (head === "context" || head === "skills") return { page: "context" };
  if (head === "mcps") return { page: "mcps" };
  if (head === "voice") return { page: "voice" };
  if (head === "review") return { page: "review" };
  if (head === "settings") return { page: "settings" };
  if (head === "team") return { page: "team" };
  return { page: "sessions" };
}

function routePath(route: Route): string {
  switch (route.page) {
    case "session":
      return `#/s/${encodeURIComponent(route.id)}${route.tab === "timeline" ? "" : `/${route.tab}`}`;
    case "agents":
      return `#/agents${route.name ? `/${encodeURIComponent(route.name)}${route.tab ? `/${encodeURIComponent(route.tab)}` : ""}` : ""}`;
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
