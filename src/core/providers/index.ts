/** Every provider agentbox knows, in the order the UI lists them. */

import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { devinAdapter } from "./devin";
import { ompAdapter } from "./omp";
import type { ProviderAdapter } from "./types";

export function adapters(): ProviderAdapter[] {
  return [claudeAdapter, codexAdapter, devinAdapter, ompAdapter];
}
