/** OMP's own model settings and discovery cache. Both the picker and the
 *  context meter read these; polling only stats unchanged files. */
import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface OmpModel {
  id: string;
  name?: string;
  contextWindow?: number | null;
}

interface OmpModelsConfig {
  providers?: Record<string, {
    models?: OmpModel[];
    modelOverrides?: Record<string, { contextWindow?: number | null }>;
  }>;
}

function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "missing";
  }
}

const configs = new Map<string, { stamp: string; value: OmpModelsConfig | null }>();

export function ompModelsConfig(dir: string): OmpModelsConfig | null {
  const path = join(dir, "models.yml");
  const key = stamp(path);
  const hit = configs.get(path);
  if (hit?.stamp === key) return hit.value;
  let value: OmpModelsConfig | null = null;
  try {
    value = Bun.YAML.parse(readFileSync(path, "utf8")) as OmpModelsConfig;
  } catch {
    // A missing or broken config leaves the discovery cache available.
  }
  configs.set(path, { stamp: key, value });
  return value;
}

const catalogs = new Map<string, { stamp: string; value: Map<string, OmpModel[]> }>();

export function ompModelCatalog(dir: string): Map<string, OmpModel[]> {
  const path = join(dir, "models.db");
  // Discovery writes may still be in SQLite's WAL, without touching the DB.
  const key = `${stamp(path)}:${stamp(`${path}-wal`)}`;
  const hit = catalogs.get(path);
  if (hit?.stamp === key) return hit.value;
  const value = new Map<string, OmpModel[]>();
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const rows = db.query("SELECT provider_id, models FROM model_cache ORDER BY updated_at").all() as { provider_id: string; models: string }[];
    // OMP keys a provider as `provider` or `provider:models-v1:<hash>`.
    // As in its picker, the newest row for that provider wins.
    for (const row of rows) {
      try {
        const models = JSON.parse(row.models);
        if (Array.isArray(models)) value.set(row.provider_id.split(":")[0]!, models);
      } catch {
        // One bad row is not the whole catalog.
      }
    }
  } catch {
    // Missing, locked or an unknown schema: use declared models only.
  } finally {
    db?.close();
  }
  catalogs.set(path, { stamp: key, value });
  return value;
}

export function ompContextLimit(dir: string, model: string | null): number | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash < 1) return null;
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  const config = ompModelsConfig(dir)?.providers?.[provider];
  const window = config?.modelOverrides?.[id]?.contextWindow
    ?? config?.models?.find((m) => m.id === id)?.contextWindow
    ?? ompModelCatalog(dir).get(provider)?.find((m) => m.id === id)?.contextWindow;
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
}
