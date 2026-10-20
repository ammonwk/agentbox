import type { AccountProvider, ProviderId } from "../types";

/** Whose accounts a provider's sessions run on. opencode has no login of its
 *  own here: it runs on OpenCode Go, which omp's accounts are sign-ins to
 *  and read usage for, so an opencode session is placed on, pinned to and
 *  metered against one of those accounts, by the same balancer as omp's. Its own
 *  module so the CLI and the MCP servers can ask without loading adapters. */
export function accountProvider(p: ProviderId): AccountProvider {
  return p === "opencode" ? "omp" : p;
}

/** The providers whose logins an org can pool (docs/org.md): the ones with a
 *  refresh token the store can own and no machine-local state a second member
 *  would need. Shared with the board, which offers Move to <org> for these. */
export const ORG_PROVIDERS: readonly AccountProvider[] = ["claude", "codex", "omp"];
