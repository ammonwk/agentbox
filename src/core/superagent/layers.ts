/**
 * The layers of a superagent's config, and its enablement gates
 * (docs/superagents.md, "Overrides and gates").
 *
 * One registered directory is the definition of a generic agent. What a
 * person or a project changes is a layer over it, never a copy:
 *
 *   the agent's directory (superagent.json)               the base
 *   <user layer>/<name>.json                               the person's, every project
 *   <checkout>/.agentbox/superagents/<name>.json           the project's, shared by git
 *   <checkout>/.agentbox/superagents/<name>.local.json     the person's, in that project
 *
 * Each layer is a JSON merge patch (RFC 7396) over the manifest, with three
 * keys of its own: `enabled` (the gate), `instructions` (said after MAIN.md)
 * and `soul` (a SOUL.md; the most specific layer's wins).
 *
 * A project layer is a file in a repository that other people push to. It
 * can change what the agent is told and the agent's own fields, and turn the
 * agent on or off in that project. It cannot change what runs, where, or on
 * which credentials (`run`, `url`, `github`, `main.start`, `main.schedule`,
 * `main.instructions`, a loop's `check` or `file`) until the person approves
 * exactly those fields (`approve`); until then they are left out.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userHome } from "../paths";
import type { SuperagentLayer } from "../types";

export type LayerKind = "user" | "project" | "local";
/** Who decided a gate: a layer, or the manifest's own default. */
export type GateSource = LayerKind | "manifest";

/** The person's layer: one file per agent. `AGENTBOX_OVERRIDES` moves it (tests). */
export const userLayerDir = (): string => process.env.AGENTBOX_OVERRIDES || join(userHome(), ".agents", "overrides");
/** Where a project's layers are, from its checkout. */
export const PROJECT_LAYER_DIR = join(".agentbox", "superagents");
/** What `.git/info/exclude` gets, so a person's project layer is never committed by mistake. */
export const LOCAL_EXCLUDE = ".agentbox/superagents/*.local.json";

export const INSTRUCTIONS_MAX = 16_000;
export const SOUL_MAX = 64 * 1024;
const FILE_MAX = 256 * 1024;

export function layerPath(kind: LayerKind, name: string, checkout: string | null): string | null {
  if (kind === "user") return join(userLayerDir(), `${name}.json`);
  if (!checkout) return null;
  return join(checkout, PROJECT_LAYER_DIR, kind === "local" ? `${name}.local.json` : `${name}.json`);
}

export interface Layer {
  kind: LayerKind;
  path: string;
  exists: boolean;
  /** The merge patch: the file without its own keys. */
  patch: Record<string, unknown>;
  enabled: boolean | null;
  instructions: string | null;
  soul: string | null;
  /** Why the file cannot be used. A broken layer turns the agent off: it may have said so. */
  error: string | null;
}

const layers = new Map<string, { mtime: number; size: number; layer: Layer }>();

/** A layer file, read again only when its time or size changes. */
export function readLayer(kind: LayerKind, path: string): Layer {
  const none: Layer = { kind, path, exists: false, patch: {}, enabled: null, instructions: null, soul: null, error: null };
  let st: { mtimeMs: number; size: number; isFile(): boolean };
  try {
    st = statSync(path);
  } catch {
    // The same object while the file stays missing, so a resolution of it can be kept.
    const was = layers.get(path);
    if (was && !was.layer.exists && was.layer.kind === kind) return was.layer;
    layers.set(path, { mtime: -1, size: -1, layer: none });
    return none;
  }
  const cached = layers.get(path);
  if (cached && cached.layer.exists && cached.mtime === st.mtimeMs && cached.size === st.size && cached.layer.kind === kind) return cached.layer;
  const layer = parseLayer(kind, path, st);
  layers.set(path, { mtime: st.mtimeMs, size: st.size, layer });
  return layer;
}

function parseLayer(kind: LayerKind, path: string, st: { size: number; isFile(): boolean }): Layer {
  const out: Layer = { kind, path, exists: true, patch: {}, enabled: null, instructions: null, soul: null, error: null };
  const fail = (why: string): Layer => ({ ...out, error: `${path}: ${why}` });
  if (!st.isFile()) return fail("not a file");
  if (st.size > FILE_MAX) return fail(`over ${FILE_MAX / 1024} KB`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(`not JSON: ${(e as Error).message}`);
  }
  if (!isObject(raw)) return fail("a layer is a JSON object");
  const { enabled, instructions, soul, name: _name, ...patch } = raw;
  if (enabled !== undefined && enabled !== null && typeof enabled !== "boolean") return fail("enabled is true, false or null");
  if (instructions !== undefined && instructions !== null && (typeof instructions !== "string" || instructions.length > INSTRUCTIONS_MAX))
    return fail(`instructions is text of at most ${INSTRUCTIONS_MAX} characters`);
  if (soul !== undefined && soul !== null && (typeof soul !== "string" || soul.length > SOUL_MAX)) return fail(`soul is text of at most ${SOUL_MAX / 1024} KB`);
  return {
    ...out,
    patch,
    enabled: typeof enabled === "boolean" ? enabled : null,
    instructions: typeof instructions === "string" && instructions.trim() ? instructions.trim() : null,
    soul: typeof soul === "string" ? soul : null,
  };
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** RFC 7396: an object merges key by key, null removes a key, anything else replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

/**
 * The parts of a patch a project layer may not change without the person's
 * approval: what runs (`run`, `url`, a loop's `check`), where and on which
 * credentials (`main.start`, `main.schedule`), what it reads from disk
 * (`main.instructions`, a loop's `file`) and what it may do on GitHub
 * (`github`). Each is given with its value, for the digest the person approves.
 */
export function restrictedOf(patch: Record<string, unknown>): { field: string; value: unknown }[] {
  const out: { field: string; value: unknown }[] = [];
  for (const k of ["run", "url", "github"]) if (k in patch) out.push({ field: k, value: patch[k] });
  if (!("main" in patch)) return out;
  const main = patch.main;
  // Taking `main` away, or giving something that is not an object, takes `main.start` with it.
  if (!isObject(main)) return [...out, { field: "main", value: main }];
  for (const k of ["start", "schedule", "instructions"]) if (k in main) out.push({ field: `main.${k}`, value: main[k] });
  if ("loops" in main) {
    const loops = main.loops;
    if (!Array.isArray(loops) || loops.some((l) => !isObject(l) || "check" in l || "file" in l)) out.push({ field: "main.loops", value: loops });
  }
  return out;
}

/** The patch without its restricted parts: what a project layer gives with no approval. */
export function withoutRestricted(patch: Record<string, unknown>): Record<string, unknown> {
  const fields = new Set(restrictedOf(patch).map((r) => r.field));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (fields.has(k)) continue;
    if (k === "main" && isObject(v)) {
      const main = Object.fromEntries(Object.entries(v).filter(([mk]) => !fields.has(`main.${mk}`)));
      if (Object.keys(main).length) out.main = main;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** The same restricted fields with the same values always give the same digest. */
export function restrictedDigest(r: { field: string; value: unknown }[]): string {
  return createHash("sha256").update(JSON.stringify(stable(r))).digest("hex");
}

export function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (isObject(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, stable(v[k])]),
    );
  return v;
}

/** A layer as Settings shows it, with what it asks for and could not have. */
export type LayerView = SuperagentLayer;

export interface Resolution {
  /** The merged manifest, before it is checked. */
  raw: Record<string, unknown>;
  enabled: boolean;
  by: GateSource;
  /** Extra instructions, each layer's in order, after MAIN.md. */
  instructions: { from: string; text: string }[];
  /** The most specific layer's SOUL.md, when one gives it. */
  soul: { path: string; text: string } | null;
  layers: LayerView[];
  /** A layer that cannot be read: the agent is off, and this says why. */
  error: string | null;
}

/**
 * Merge the layers over the base manifest (`base` is its JSON), from the
 * least specific to the most, and resolve the gate: the project's gate when
 * one is set (the person's local one first), else the person's, else the
 * manifest's `enabled`, else off. `approved` is the digest the person
 * approved for each project layer.
 */
export function resolveLayers(base: Record<string, unknown>, given: Layer[], approved: Partial<Record<LayerKind, string>>): Resolution {
  let raw: Record<string, unknown> = structuredClone(base);
  const instructions: Resolution["instructions"] = [];
  let soul: Resolution["soul"] = null;
  const views: LayerView[] = [];
  let error: string | null = null;
  for (const l of given) {
    const restricted = l.kind === "user" ? [] : restrictedOf(l.patch);
    const digest = restricted.length ? restrictedDigest(restricted) : null;
    const ok = !digest || approved[l.kind] === digest;
    views.push({
      kind: l.kind,
      path: l.path,
      exists: l.exists,
      enabled: l.enabled,
      fields: Object.keys(l.patch),
      instructions: !!l.instructions,
      soul: l.soul !== null,
      error: l.error,
      restricted: digest ? { fields: restricted.map((r) => r.field), digest, approved: ok } : null,
    });
    if (!l.exists) continue;
    if (l.error) {
      error ??= l.error;
      continue;
    }
    // A project layer never names where the agent shows: its instance is in that project.
    const patch = l.kind === "user" ? l.patch : ok ? l.patch : withoutRestricted(l.patch);
    if (l.kind !== "user") delete patch.projects;
    raw = mergePatch(raw, patch) as Record<string, unknown>;
    if (l.instructions) instructions.push({ from: l.path, text: l.instructions });
    if (l.soul !== null) soul = { path: `${l.path} (soul)`, text: l.soul };
  }
  // The most specific gate that is set decides.
  let enabled = base.enabled === true;
  let by: GateSource = "manifest";
  for (const l of given) if (l.exists && !l.error && l.enabled !== null) (enabled = l.enabled), (by = l.kind);
  if (error) enabled = false;
  delete raw.enabled;
  return { raw, enabled, by, instructions, soul, layers: views, error };
}

/** Write one key of a layer file, keeping the rest of it. `null` removes the
 *  key, unless `keepNull`: a merge patch's null, which removes the key below it. */
export function writeLayerKey(path: string, key: string, value: unknown, keepNull = false): void {
  let body: Record<string, unknown> = {};
  if (existsSync(path)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`${path} is not JSON (${(e as Error).message}): fix it by hand first`);
    }
    if (!isObject(raw)) throw new Error(`${path} is not a JSON object: fix it by hand first`);
    body = raw;
  }
  if (value === null && !keepNull) delete body[key];
  else body[key] = value;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, path);
  layers.delete(path);
}

/** Keep a person's project layers out of git: `.git/info/exclude` of the checkout. */
export function excludeLocalLayers(checkout: string): void {
  const r = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "--git-path", "info/exclude"], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return;
  const rel = r.stdout.toString().trim();
  if (!rel) return;
  const file = rel.startsWith("/") ? rel : join(checkout, rel);
  const now = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (now.split("\n").some((l) => l.trim() === LOCAL_EXCLUDE)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${now}${now && !now.endsWith("\n") ? "\n" : ""}# agentbox: a person's own superagent settings in this project\n${LOCAL_EXCLUDE}\n`);
}

/** Whether git tracks the file: a "local" layer that is committed is anyone's. */
export function tracked(checkout: string, path: string): boolean {
  return Bun.spawnSync(["git", "-C", checkout, "ls-files", "--error-unmatch", path], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}
