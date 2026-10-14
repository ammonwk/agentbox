/** URL ↔ route. Selection lives in the hash so every screen is linkable and
 *  the back button works; go() is how the app moves between them. */

export type SessionTab = "terminal" | "timeline" | "diff" | "load";
/** The tabs as they appear, left to right. The first is the default. */
export const SESSION_TABS: readonly SessionTab[] = ["timeline", "terminal", "diff", "load"];

export type Route =
  | { page: "agents"; id?: string; thread?: string; view?: "chat" | "about" | "feed" | "sessions" }
  | { page: "sessions" }
  | { page: "session"; id: string; tab: SessionTab }
  | { page: "accounts"; sub: "accounts" | "calibration" }
  /** One account's usage insights. */
  | { page: "accounts"; sub: "insights"; account: string }
  | { page: "skills" }
  /** The global MCP servers every agent is given. */
  | { page: "mcps" }
  /** The cards sessions handed you: to decide, or to know. */
  | { page: "review" }
  | { page: "voice" }
  | { page: "team" }
  | { page: "settings" };

/** The rail entry a route lights up. */
export type NavId = "agents" | "sessions" | "review" | "voice" | "accounts" | "skills" | "mcps" | "team" | "settings";

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
  if (head === "agents") return { page: "agents", ...(a ? { id: a } : {}), ...(b ? { view: ["about", "feed", "sessions"].includes(b) ? b as "about" | "feed" | "sessions" : "chat", ...(parts[3] ? { thread: parts[3] } : {}) } : {}) };
  if (head === "s" && a) {
    const tab = SESSION_TABS.includes(b as SessionTab) ? (b as SessionTab) : "timeline";
    return { page: "session", id: a, tab };
  }
  if (head === "accounts") {
    if (a === "insights" && b) return { page: "accounts", sub: "insights", account: b };
    return { page: "accounts", sub: a === "calibration" ? "calibration" : "accounts" };
  }
  if (head === "skills") return { page: "skills" };
  if (head === "mcps") return { page: "mcps" };
  if (head === "voice") return { page: "voice" };
  if (head === "review") return { page: "review" };
  if (head === "settings") return { page: "settings" };
  if (head === "team") return { page: "team" };
  return { page: "sessions" };
}

function routePath(route: Route): string {
  switch (route.page) {
    case "agents": return `#/agents${route.id ? `/${encodeURIComponent(route.id)}` : ""}${route.view || route.thread ? `/${route.view ?? "chat"}${route.thread ? `/${encodeURIComponent(route.thread)}` : ""}` : ""}`;
    case "session":
      return `#/s/${encodeURIComponent(route.id)}${route.tab === "timeline" ? "" : `/${route.tab}`}`;
    case "accounts":
      if (route.sub === "insights") return `#/accounts/insights/${encodeURIComponent(route.account)}`;
      return route.sub === "calibration" ? "#/accounts/calibration" : "#/accounts";
    default:
      return `#/${route.page}`;
  }
}

/** Scope is part of each history entry, so separate tabs and Back cannot
 * silently change the context of a draft. No process changes on navigation. */
export function scopeOf(hash = location.hash): URLSearchParams {
  return new URLSearchParams(hash.split("?")[1] ?? "");
}
export function hrefOf(route: Route): string {
  const scope = scopeOf().toString();
  return routePath(route) + (scope ? `?${scope}` : "");
}
export function selectScope(key: "project" | "workspace", value: string | null, to?: Route, replace = false): void {
  const scope = scopeOf();
  scope.set(key, value ?? ""); // explicit All overrides any remembered default
  const from = parseHash(location.hash);
  const route = to ?? (from.page === "agents" ? { page: "agents" } : from.page === "session" ? { page: "sessions" } : from);
  const href = routePath(route) + `?${scope}`;
  if (href === location.hash) return;
  history[replace ? "replaceState" : "pushState"](null, "", href);
  try { localStorage.setItem("agentbox.navigationScope", scope.toString()); } catch { /* private browser */ }
  moved.forEach((fn) => fn());
}
export function restoreScope(): void {
  if (location.hash.includes("?")) return;
  // Old deep links are intentionally unscoped: their actual detail remains reachable.
  const route = parseHash(location.hash);
  if (route.page === "session" || (route.page === "agents" && route.id)) return;
  try {
    const scope = localStorage.getItem("agentbox.navigationScope");
    if (scope) history.replaceState(history.state, "", routePath(route) + `?${scope}`);
  } catch { /* private browser */ }
}

// ------------------------------------------------------------------ moving

/** Below this the board shows one pane at a time (useIsNarrow, session.css). */
const NARROW = "(max-width: 900px)";

/** The history entry's own state: whether the entry under it is the list. */
type Entry = { overList?: boolean; agentList?: string } | null;

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
    if (to.page === "agents" && from.page === "agents" && to.id === from.id) {
      const beneath = (history.state as Entry)?.agentList === to.id;
      if (!to.view && from.view && beneath) { history.back(); return; }
      if (to.view && from.view) replace = true;
    }
    if (to.page === "sessions" && from.page === "session" && over) {
      history.back();
      return;
    }
    if (to.page === "session" && from.page === "session") replace = true;
  }
  const state: Entry = to.page === "agents" && to.view && from.page === "agents" && from.id === to.id && (!from.view || (history.state as Entry)?.agentList === to.id) ? { agentList: to.id } : to.page === "session" && (from.page === "sessions" || (from.page === "session" && replace && over)) ? { overList: true } : null;
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
  const agent = parseHash(location.hash);
  if (matchMedia(NARROW).matches && agent.page === "agents" && agent.id && agent.view && (history.state as Entry)?.agentList !== agent.id) {
    const href = hrefOf(agent);
    history.replaceState(null, "", hrefOf({ page: "agents", id: agent.id, view: "sessions", thread: agent.thread }));
    history.pushState({ agentList: agent.id }, "", href);
    return;
  }
  if (!matchMedia(NARROW).matches || parseHash(location.hash).page !== "session" || overList()) return;
  const href = hrefOf(parseHash(location.hash));
  history.replaceState(null, "", hrefOf({ page: "sessions" }));
  history.pushState({ overList: true } satisfies Entry, "", href);
}

/**
 * Send the app's own links through go() to preserve the selected project
 * and the narrow-screen session history. On React's root and added after it: React's handlers
 * have run (a preventDefault is seen) and its stopPropagation, which a link
 * in a clickable row uses, does not hide the click from a listener on the
 * same element.
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
