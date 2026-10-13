/** Every provider agentbox knows, in the order the UI lists them. */

import type { ProviderId } from "../types";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { devinAdapter } from "./devin";
import { ompAdapter } from "./omp";
import { opencodeAdapter } from "./opencode";
import type { ProviderAdapter } from "./types";

export function adapters(): ProviderAdapter[] {
  return [claudeAdapter, codexAdapter, devinAdapter, ompAdapter, opencodeAdapter];
}

const byId: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  devin: devinAdapter,
  omp: ompAdapter,
  opencode: opencodeAdapter,
};

/** One provider's adapter — how the accounts module learns where a provider's
 *  homes are and how its CLI is pointed at one. */
export function adapterFor(id: ProviderId): ProviderAdapter {
  return byId[id];
}

export { accountProvider } from "./account";
