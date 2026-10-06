import type { AccountProvider, ProviderId } from "../types";

/** Whose accounts a provider's sessions run on. opencode has no login of its
 *  own here: it runs on OpenCode Go, which omp's implicit account already
 *  holds and reads usage for, so an opencode session is placed on, pinned to
 *  and metered against that account, by the same balancer as omp's. Its own
 *  module so the CLI and the MCP servers can ask without loading adapters. */
export function accountProvider(p: ProviderId): AccountProvider {
  return p === "opencode" ? "omp" : p;
}
