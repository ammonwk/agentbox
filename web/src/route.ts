/** URL ↔ route. Selection lives in the hash so every screen is linkable and
 *  the back button works; App.tsx is the only runtime consumer. */

export type Route =
  | { page: "inbox" }
  | { page: "sessions"; sessionId: string | null }
  | { page: "skills" }
  | { page: "settings" };

export type PageId = Route["page"];

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        // A hand-mangled URL is not worth a crash; treat it as the literal.
        return p;
      }
    });
  if (parts[0] === "sessions") return { page: "sessions", sessionId: parts[1] ?? null };
  if (parts[0] === "skills") return { page: "skills" };
  if (parts[0] === "settings") return { page: "settings" };
  return { page: "inbox" };
}

export function hrefOf(route: Route): string {
  if (route.page === "sessions") {
    return route.sessionId ? `#/sessions/${encodeURIComponent(route.sessionId)}` : "#/sessions";
  }
  return `#/${route.page}`;
}
