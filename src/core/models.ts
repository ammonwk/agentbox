/**
 * What the Model dropdowns offer: a few recommended models first, then
 * everything OpenCode Go lists today.
 *
 * The recommended list is kept by hand because its selectors cannot be derived
 * from anything upstream publishes. Go serves Muse Spark over the Responses API
 * only, so omp reaches it through the `opencode-go-responses` provider declared
 * in ~/.omp/agent/models.yml. The plain `opencode-go/` selector for the same
 * model gets a 500 on chat/completions, and omp retries that into a hang.
 *
 * The rest is fetched from Go's `/models` (public, no key), so a model added
 * upstream appears without a code change. Its ids are offered as
 * `opencode-go/<id>`, which is how omp's own discovery lists them.
 */

import type { ModelCatalog, ModelOption } from "./types";

export const RECOMMENDED_MODELS: readonly ModelOption[] = [
  { id: "opencode-go-responses/muse-spark-1.3-contributor", label: "Muse Spark 1.3" },
  // Go's id carries no version. models.dev names it V4.1 Flash, released
  // 2026-09-10, and `deepseek-v4-flash` is the older model.
  { id: "opencode-go/deepseek-flash", label: "DeepSeek V4.1 Flash" },
];

const GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const GO_PREFIX = "opencode-go/";

/** Opening a dialog should not wait on opencode.ai; the list moves on the scale of days. */
const TTL_MS = 10 * 60_000;
/** A failure is retried sooner, but not on every dialog opened while offline. */
const FAILED_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The ids Go lists. Anything but a well-formed list is an error, not an empty one. */
export async function fetchGoModelIds(fetchImpl: Fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(GO_MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("the response carried no model list");
  return body.data.flatMap((m: unknown) => {
    const id = m && typeof m === "object" ? (m as { id?: unknown }).id : undefined;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * Go's ids as options: sorted, prefixed, and without the ones already
 * recommended or that cannot run under `opencode-go/`.
 */
export function goOptions(ids: readonly string[]): ModelOption[] {
  const recommended = new Set(RECOMMENDED_MODELS.map((m) => m.id));
  return [...new Set(ids)]
    .sort()
    .map((id) => ({ id: GO_PREFIX + id }))
    .filter((m) => !recommended.has(m.id) && !m.id.startsWith(`${GO_PREFIX}muse-spark-`));
}

let cached: { catalog: ModelCatalog; expires: number } | null = null;
let inflight: Promise<ModelCatalog> | null = null;

/**
 * The catalog, fetched at most once per TTL however many dialogs ask. A failed
 * fetch still returns the recommended models, with the last Go list that did
 * load and the reason this one did not.
 */
export function modelCatalog(fetchImpl: Fetch = fetch): Promise<ModelCatalog> {
  if (cached && Date.now() < cached.expires) return Promise.resolve(cached.catalog);
  inflight ??= fetchGoModelIds(fetchImpl)
    .then(
      (ids): ModelCatalog => ({ recommended: [...RECOMMENDED_MODELS], go: goOptions(ids), goError: null }),
      (e: unknown): ModelCatalog => ({
        recommended: [...RECOMMENDED_MODELS],
        go: cached?.catalog.go ?? [],
        goError: e instanceof Error ? e.message : String(e),
      }),
    )
    .then((catalog) => {
      cached = { catalog, expires: Date.now() + (catalog.goError ? FAILED_TTL_MS : TTL_MS) };
      return catalog;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
