/** Which models an account can start a session on, for the new-session
 *  dialog's model picker.
 *
 * Every provider answers differently, because each CLI keeps its catalog in
 * a different place:
 *   - codex: `models_cache.json` in the account's CODEX_HOME — the list
 *     codex's own /model picker shows, so it is per-account. An account that
 *     has never run codex has no cache yet; the shared models.dev `openai`
 *     list fills in.
 *   - claude: no catalog on disk, so the models.dev `anthropic` list, the
 *     floating family aliases the binary knows (`sonnet`, `opus`, `fable`,
 *     `haiku`, `opusplan`, each with a `[1m]` variant), plus the extra
 *     options the CLI cached for this account (`additionalModelOptionsCache`
 *     in its `.claude.json`, e.g. a `[1m]` variant the server pushed).
 *   - omp: the providers declared in `models.yml`, with omp's own catalog for
 *     each (`models.db`), as `provider/id`.
 *   - devin: `devin models list --format json` — the CLI's own per-account
 *     list, run under the account's home. Effort is part of the model id
 *     there (`-low` … `-max`, `-fast`, `-priority`), which is why the list is
 *     hundreds of variants long and why devin has no effort picker.
 *
 * Release dates come from models.dev. agentbox downloads its own copy to
 * `<agentbox home>/cache/models-dev.json`, refreshed in the background once a
 * day; until that lands (and if it never can), opencode's own cache file is
 * read instead. All of it is best-effort: a missing file or a failed fetch is
 * an empty list, never an error — the picker still takes free text.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome, userHome } from "./paths";
import { exec } from "./accounts/exec";
import { claudeHome } from "./providers/claude";
import { codexHome } from "./providers/codex";
import { devinAdapter } from "./providers/devin";
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

// ------------------------------------------------------------- models.dev

type ModelsDev = Record<string, { models?: Record<string, { name?: string; release_date?: string }> }>;

const DEV_URL = "https://models.dev/api.json";
const DEV_TTL_MS = 24 * 60 * 60 * 1000;
const devPath = (): string => join(agentboxHome(), "cache", "models-dev.json");
const opencodeDevPath = (): string => join(userHome(), ".cache", "opencode", "models.json");

const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

let devInflight: Promise<void> | null = null;

/** Download models.dev's catalog into our cache. Deduped; a failure leaves
 *  whatever file was already there. */
function refreshModelsDev(): Promise<void> {
  return (devInflight ??= (async () => {
    try {
      const res = await fetch(DEV_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const text = await res.text();
      JSON.parse(text); // never cache a body that does not parse
      const path = devPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      fileCache.delete(path);
    } catch {
      // Offline or models.dev down: what is on disk stays the answer.
    } finally {
      devInflight = null;
    }
  })());
}

/** The catalog, stale-while-revalidate: a fresh-enough copy is served, an
 *  older one is served *and* refreshed for next time, and only with nothing
 *  on disk at all does the call wait on the fetch. */
async function modelsDev(): Promise<ModelsDev> {
  const self = devPath();
  const alt = opencodeDevPath();
  const selfM = mtime(self);
  if (!selfM || Date.now() - selfM > DEV_TTL_MS) void refreshModelsDev();
  const data = readCached<ModelsDev>(selfM >= mtime(alt) ? self : alt, (t) => JSON.parse(t) as ModelsDev);
  if (data) return data;
  // A fresh file that will not parse is worth one retry too.
  if (!devInflight) void refreshModelsDev();
  await devInflight;
  return readCached<ModelsDev>(self, (t) => JSON.parse(t) as ModelsDev) ?? {};
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

// --------------------------------------------------------------- claude

/** The floating aliases `--model` accepts for the newest of a family
 *  (`claude --help`, and the binary's `sonnet[1m]`/`opus[1m]`/`opusplan[1m]`
 *  strings — every alias but haiku has a 1M-context variant). They sort next
 *  to their family by borrowing its newest release date. */
const CLAUDE_ALIASES: { id: string; family: string; label: string; hint?: string; ctx1m?: boolean }[] = [
  { id: "fable", family: "claude-fable-", label: "latest Fable", ctx1m: true },
  { id: "opus", family: "claude-opus-", label: "latest Opus", ctx1m: true },
  { id: "sonnet", family: "claude-sonnet-", label: "latest Sonnet", ctx1m: true },
  { id: "haiku", family: "claude-haiku-", label: "latest Haiku" },
  { id: "opusplan", family: "claude-opus-", label: "latest Opus", hint: "plan mode", ctx1m: true },
];

function claudeModels(account: Account, dev: ModelsDev): ModelOption[] {
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
  const anthropic = dev.anthropic?.models ?? {};
  for (const a of CLAUDE_ALIASES) {
    const newest = Object.entries(anthropic)
      .filter(([id]) => id.startsWith(a.family))
      .sort((x, y) => (y[1].release_date ?? "").localeCompare(x[1].release_date ?? ""))[0];
    // models.dev's own names can end in "(latest)" — strip it before adding ours.
    const resolved = newest?.[1].name?.replace(/\s*\(latest\)$/i, "");
    const label = `${resolved ?? a.label}${a.hint ? ` · ${a.hint}` : ""}${resolved ? " (latest)" : ""}`;
    const releasedAt = newest?.[1].release_date ?? null;
    out.push({ id: a.id, label, releasedAt });
    if (a.ctx1m) out.push({ id: `${a.id}[1m]`, label: `${label} · 1M context`, releasedAt });
  }
  for (const [id, m] of Object.entries(anthropic)) {
    out.push({ id, label: m.name ?? id, releasedAt: m.release_date ?? null });
  }
  return byRelease(out);
}

// ---------------------------------------------------------------- codex

function codexModels(account: Account, dev: ModelsDev): ModelOption[] {
  const cache = readCached(
    join(codexHome(account), "models_cache.json"),
    (t) =>
      JSON.parse(t) as {
        models?: {
          slug: string;
          display_name?: string;
          visibility?: string;
          priority?: number;
          supported_reasoning_levels?: { effort?: string }[];
        }[];
      },
  );
  const listed = (cache?.models ?? []).filter((m) => m.visibility === "list").sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  if (listed.length === 0) {
    // An account that has never run codex has no cache; the shared catalog
    // is close enough until it does.
    return byRelease(
      Object.entries(dev.openai?.models ?? {}).map(([id, m]) => ({ id, label: m.name ?? id, releasedAt: m.release_date ?? null })),
    );
  }
  // codex's own priority order, not byRelease: a model models.dev has not
  // heard of yet is usually the newest one, and re-sorting by its dates would
  // sink it. The dates stay for display only.
  return listed.map((m) => {
    const efforts = (m.supported_reasoning_levels ?? []).map((l) => l.effort).filter((e): e is string => !!e);
    return {
      id: m.slug,
      label: m.display_name ?? m.slug,
      releasedAt: releaseDate(dev, "openai", m.slug),
      ...(efforts.length ? { efforts } : {}),
    };
  });
}

// ----------------------------------------------------------------- omp

/** omp's provider names are models.dev's, except zen, which models.dev calls `opencode`. */
const OMP_DEV_PROVIDER: Record<string, string> = { "opencode-zen": "opencode", "opencode-zen-responses": "opencode", "opencode-go-responses": "opencode-go" };

function ompModels(account: Account, dev: ModelsDev): ModelOption[] {
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

// --------------------------------------------------------------- devin

interface DevinModelList {
  families?: {
    family_label?: string;
    slug?: string;
    aliases?: string[];
    variants?: {
      model_uid?: string;
      label?: string;
      description?: string;
      cost_tier?: string;
      cost_summary?: string;
      is_new?: boolean;
      is_beta?: boolean;
    }[];
  }[];
}

/** The list follows the plan, so it is per-account and per-process-memory —
 *  re-fetched every few minutes at most, and the last good answer stands in
 *  for a failed one. */
const devinCatalog = new Map<string, { at: number; options: ModelOption[] }>();
const DEVIN_TTL_MS = 10 * 60 * 1000;

async function listDevinModels(account: Account): Promise<ModelOption[] | null> {
  // Under the account's own home, where its credentials.toml is; a stray
  // WINDSURF_API_KEY from the server's shell would answer for the wrong
  // login.
  const auth = devinAdapter.authEnv(account);
  const r = await exec(["devin", "models", "list", "--format", "json"], {
    env: auth.env,
    unset: [...(auth.unset ?? []), "WINDSURF_API_KEY"],
    timeoutMs: 15_000,
  });
  if (r.code !== 0) return null;
  let list: DevinModelList;
  try {
    list = JSON.parse(r.stdout) as DevinModelList;
  } catch {
    return null;
  }

  const out: ModelOption[] = [];
  for (const f of list.families ?? []) {
    const family = f.family_label ?? f.slug ?? "";
    // Floating picks first — `swe`, `opus`, `sonnet`… resolve to the family's
    // latest variant — then every concrete variant, in devin's own order.
    for (const alias of f.aliases ?? []) {
      out.push({ id: alias, label: family ? `${family} (latest)` : alias, releasedAt: null });
    }
    for (const v of f.variants ?? []) {
      if (!v.model_uid) continue;
      const note = [v.is_beta ? "beta" : "", v.is_new ? "new" : "", v.description ?? v.cost_tier ?? v.cost_summary ?? ""]
        .filter(Boolean)
        .join(" · ");
      out.push({ id: v.model_uid, label: v.label ?? v.model_uid, releasedAt: null, ...(note ? { note } : {}) });
    }
  }
  return byRelease(out);
}

async function devinModels(account: Account): Promise<ModelOption[]> {
  const hit = devinCatalog.get(account.id);
  if (hit && Date.now() - hit.at < DEVIN_TTL_MS) return hit.options;
  const options = await listDevinModels(account);
  if (options) devinCatalog.set(account.id, { at: Date.now(), options });
  return options ?? hit?.options ?? [];
}

// ------------------------------------------------------------------ api

export async function modelOptions(account: Account): Promise<ModelOption[]> {
  if (account.provider === "devin") return devinModels(account);
  const dev = await modelsDev();
  switch (account.provider) {
    case "claude":
      return claudeModels(account, dev);
    case "codex":
      return codexModels(account, dev);
    case "omp":
      return ompModels(account, dev);
    default:
      return [];
  }
}
