import type { AccountView, Session } from "../../../src/core/types";

/**
 * The subscriptions along the bottom: every enabled account across every
 * provider, most recently active first — a session on it (started or touched),
 * or else its last usage reading. The open session's account is always among
 * them. The bar caps them with `limit`, so a fleet of accounts cannot crowd
 * out the machine figures; the plans sheet it opens lists them all.
 */
export function recentAccounts(
  accounts: readonly AccountView[],
  sessions: readonly Pick<Session, "accountId" | "lastActivityAt" | "startedAt">[],
  focusAccount: string | null,
  limit = Infinity,
): AccountView[] {
  const active = new Map<string, number>();
  for (const s of sessions) {
    if (!s.accountId) continue;
    const at = Math.max(s.lastActivityAt, s.startedAt);
    if (at > (active.get(s.accountId) ?? 0)) active.set(s.accountId, at);
  }
  const recency = (a: AccountView) => Math.max(active.get(a.id) ?? 0, a.usage.at ?? 0);
  const ranked = accounts
    .filter((a) => a.enabled)
    .sort((a, b) => recency(b) - recency(a) || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .slice(0, limit);
  if (focusAccount && !ranked.some((a) => a.id === focusAccount)) {
    const focused = accounts.find((a) => a.id === focusAccount);
    if (focused) ranked.splice(Math.max(0, ranked.length - 1), 1, focused);
  }
  return ranked;
}
