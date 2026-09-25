/** Which models an account can start a session on, for the new-session
 *  dialog's model picker.
 *
 * Every source here is a cache some CLI already keeps, read-only:
 *   - codex: `models_cache.json` in the account's CODEX_HOME — the list codex's
 *     own /model picker shows, so it is per-account.
 *   - claude: no catalog on disk, so the models.dev `anthropic` list, plus the
 *     extra options the CLI cached for this account (`additionalModelOptionsCache`
 *     in its `.claude.json`, e.g. a `[1m]` variant).
 *   - omp: the providers declared in `models.yml`, with omp's own catalog for
 *     each (`models.db`), as `provider/id`.
 *   - devin: nothing; the dialog offers what past sessions used.
 *
 * Release dates come from opencode's models.dev cache when it is there. All of
 * it is best-effort: a missing or unreadable file is an empty list, never an
 * error — the picker still takes free text.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./paths";
import { claudeHome } from "./providers/claude";
import { codexHome } from "./providers/codex";
import { agentDirOf } from "./providers/omp";
import type { Account, ModelOption } from "./types";

/** Re-read a file only when its mtime moves; models.dev's cache is ~5 MB. */
const fileCache = new Map<string, { mtimeMs: number; value: unknown }>();

function readCached<T>(path: string, parse: (text: string) => T): T | null {
  try {
    const { mtimeMs } = statSync(path);
    const hit = fileCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
    const value = parse(readFileSync(path, "utf8"));
    fileCache.set(path, { mtimeMs, value });
    return value;
  } catch {
    return null;
  }
}

type ModelsDev = Record<string, { models?: Record<string, { name?: string; release_date?: string }> }>;

function modelsDev(): ModelsDev {
  return readCached(join(userHome(), ".cache", "opencode", "models.json"), (t) => JSON.parse(t) as ModelsDev) ?? {};
}

function devEntry(dev: ModelsDev, devProvider: string, id: string): { name?: string; release_date?: string } | undefined {
  return dev[devProvider]?.models?.[id];
}

function releaseDate(dev: ModelsDev, devProvider: string, id: string): string | null {
  return devEntry(dev, devProvider, id)?.release_date ?? null;
}

/** Newest first; undated last, in the order the source gave them. */
function byRelease(options: ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  return options
    .filter((o) => !seen.has(o.id) && seen.add(o.id))
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (b.o.releasedAt ?? "").localeCompare(a.o.releasedAt ?? "") || a.i - b.i)
    .map(({ o }) => o);
}

function claudeModels(account: Account): ModelOption[] {
  const dev = modelsDev();
  const out: ModelOption[] = [];
  const json = account.isDefault ? join(userHome(), ".claude.json") : join(claudeHome(account), ".claude.json");
  const cfg = readCached(json, (t) => JSON.parse(t) as { additionalModelOptionsCache?: { value?: string; description?: string }[] });
  for (const o of cfg?.additionalModelOptionsCache ?? []) {
    if (!o.value) continue;
    // `claude-fable-5-1[1m]`: the bracket is a variant, "1M context".
    const [, base = o.value, variant] = /^(.*?)(?:\[(\w+)\])?$/.exec(o.value) ?? [];
    const name = devEntry(dev, "anthropic", base)?.name ?? o.description?.split("·")[0]?.trim() ?? base;
    out.push({ id: o.value, label: variant ? `${name} · ${variant.toUpperCase()} context` : name, releasedAt: releaseDate(dev, "anthropic", base) });
  }
  for (const [id, m] of Object.entries(dev.anthropic?.models ?? {})) {
    out.push({ id, label: m.name ?? id, releasedAt: m.release_date ?? null });
  }
  return byRelease(out);
}

function codexModels(account: Account): ModelOption[] {
  const dev = modelsDev();
  const cache = readCached(
    join(codexHome(account), "models_cache.json"),
    (t) => JSON.parse(t) as { models?: { slug: string; display_name?: string; visibility?: string; priority?: number }[] },
  );
  const listed = (cache?.models ?? []).filter((m) => m.visibility === "list").sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return byRelease(
    listed.map((m) => ({ id: m.slug, label: m.display_name ?? m.slug, releasedAt: releaseDate(dev, "openai", m.slug) })),
  );
}

/** omp's provider names are models.dev's, except zen, which models.dev calls `opencode`. */
const OMP_DEV_PROVIDER: Record<string, string> = { "opencode-zen": "opencode", "opencode-zen-responses": "opencode", "opencode-go-responses": "opencode-go" };

function ompModels(account: Account): ModelOption[] {
  const dev = modelsDev();
  const dir = agentDirOf(account);
  const yml = readCached(join(dir, "models.yml"), (t) => Bun.YAML.parse(t) as { providers?: Record<string, { models?: { id: string; name?: string }[] }> });
  const providers = Object.entries(yml?.providers ?? {});
  if (providers.length === 0) return [];

  // omp keys its catalog `provider` or `provider:models-v1:<hash>`; the newest
  // row per provider wins.
  const catalog = new Map<string, { id: string; name?: string }[]>();
  const dbPath = join(dir, "models.db");
  if (existsSync(dbPath)) {
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db.query("SELECT provider_id, models FROM model_cache ORDER BY updated_at").all() as { provider_id: string; models: string }[];
      for (const r of rows) {
        try {
          catalog.set(r.provider_id.split(":")[0]!, JSON.parse(r.models));
        } catch {
          // one bad row is not the whole catalog
        }
      }
    } catch {
      // locked or a schema we do not know: declared models only
    } finally {
      db?.close();
    }
  }

  const out: ModelOption[] = [];
  for (const [provider, p] of providers) {
    const devProvider = OMP_DEV_PROVIDER[provider] ?? provider;
    for (const m of [...(p.models ?? []), ...(catalog.get(provider) ?? [])]) {
      const d = devEntry(dev, devProvider, m.id);
      out.push({
        id: `${provider}/${m.id}`,
        // omp's catalog often names a model by its id; models.dev does better.
        label: (m.name && m.name !== m.id ? m.name : d?.name) ?? m.id,
        releasedAt: d?.release_date ?? null,
      });
    }
  }
  return byRelease(out);
}

export function modelOptions(account: Account): ModelOption[] {
  switch (account.provider) {
    case "claude":
      return claudeModels(account);
    case "codex":
      return codexModels(account);
    case "omp":
      return ompModels(account);
    case "devin":
      return [];
  }
}
