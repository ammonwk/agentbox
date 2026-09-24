/** URL ↔ route. Selection lives in the hash so every screen is linkable and
 *  the back button works; App.tsx is the only runtime consumer. */

export type SessionTab = "terminal" | "timeline" | "diff" | "load";
export const SESSION_TABS: readonly SessionTab[] = ["terminal", "timeline", "diff", "load"];

export type Route =
  | { page: "sessions" }
  | { page: "session"; id: string; tab: SessionTab }
  | { page: "accounts"; sub: "accounts" | "calibration" }
  | { page: "skills" }
  | { page: "settings" };

/** The rail entry a route lights up. */
export type NavId = "sessions" | "accounts" | "skills" | "settings";

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
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decode);
  const [head, a, b] = parts;
  if (head === "s" && a) {
    const tab = SESSION_TABS.includes(b as SessionTab) ? (b as SessionTab) : "terminal";
    return { page: "session", id: a, tab };
  }
  if (head === "accounts") return { page: "accounts", sub: a === "calibration" ? "calibration" : "accounts" };
  if (head === "skills") return { page: "skills" };
  if (head === "settings") return { page: "settings" };
  return { page: "sessions" };
}

export function hrefOf(route: Route): string {
  switch (route.page) {
    case "session":
      return `#/s/${encodeURIComponent(route.id)}${route.tab === "terminal" ? "" : `/${route.tab}`}`;
    case "accounts":
      return route.sub === "calibration" ? "#/accounts/calibration" : "#/accounts";
    default:
      return `#/${route.page}`;
  }
}
