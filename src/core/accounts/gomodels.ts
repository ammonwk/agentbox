/** Which OpenCode Go models speak Anthropic's API rather than OpenAI's.
 *
 * The Console's config gives those models an endpoint of their own
 * (`…/inference/go/anthropic/v1`), which opencode uses over the provider's —
 * so pointing the provider at the bridge is not enough for them, and each
 * needs its own override (providers/opencode.ts). The list is the Console's,
 * asked with any signed-in account's token once a day; until then, and with
 * no account signed in, it is the list as it stood when this was written.
 */

import { GO_CONSOLE_UPSTREAM, goLoginHomes, readGoLogin } from "./gocred";

const KNOWN = ["minimax-m2.7", "minimax-m3", "qwen3.7-plus", "qwen3.8-flash", "qwen3.8-max"];
const DAY = 24 * 3_600_000;

let models: readonly string[] = KNOWN;
let askedAt = 0;

/** The Anthropic-shaped models named in a Console config. */
export function anthropicGoModelsIn(config: unknown): string[] {
  const go = (config as { providers?: Record<string, { models?: Record<string, { package?: unknown; settings?: { baseURL?: unknown } }> }> } | null)?.providers?.["opencode-go"];
  return Object.entries(go?.models ?? {})
    .filter(([, m]) => m?.settings?.baseURL === GO_CONSOLE_UPSTREAM.anthropic || (typeof m?.package === "string" && m.package.includes("anthropic")))
    .map(([id]) => id);
}

/** The list now. Never waits: a refresh that is due runs behind it. */
export function anthropicGoModels(now = Date.now()): readonly string[] {
  if (now - askedAt > DAY) {
    askedAt = now;
    void refresh(goLoginHomes(), now).catch(() => undefined);
  }
  return models;
}

async function refresh(homes: readonly string[], now: number): Promise<void> {
  for (const home of homes) {
    const login = readGoLogin(home);
    // Read-only: an expired token is the bridge's to refresh, not ours.
    if (!login || login.expires <= now) continue;
    const res = await fetch(`${login.server}/api/v2/config`, {
      headers: { authorization: `Bearer ${login.access}`, ...(login.orgID ? { "x-opencode-org-id": login.orgID } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) continue;
    const found = anthropicGoModelsIn(await res.json());
    // Models only ever join the known ones: a config that lists none is a
    // config we misread, not proof that none remain.
    if (found.length > 0) models = [...new Set([...KNOWN, ...found])];
    return;
  }
}
