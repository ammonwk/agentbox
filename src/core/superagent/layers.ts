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

/** How deep a layer's JSON may nest: deeper is no config, and every walk of it would recurse. */
const DEPTH_MAX = 32;

/** The nesting depth of a JSON value, counted without recursion. */
function depthOf(root: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[root, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (!v || typeof v !== "object") continue;
    if (d > max) max = d;
    if (max > DEPTH_MAX) return max;
    for (const x of Array.isArray(v) ? v : Object.values(v)) stack.push([x, d + 1]);
  }
  return max;
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
  return layerFromJson(kind, path, raw);
}

/** A layer from its file's JSON, checked as a file of it is. */
export function layerFromJson(kind: LayerKind, path: string, raw: unknown): Layer {
  const out: Layer = { kind, path, exists: true, patch: {}, enabled: null, instructions: null, soul: null, error: null };
  const fail = (why: string): Layer => ({ ...out, error: `${path}: ${why}` });
  if (!isObject(raw)) return fail("a layer is a JSON object");
  if (depthOf(raw) > DEPTH_MAX) return fail(`it nests deeper than ${DEPTH_MAX} levels`);
  const unsafe = unsafeKey(raw);
  if (unsafe) return fail(`it has a key "${unsafe}", which agentbox does not read`);
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

/** Keys that would reach an object's prototype instead of the object. */
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** Whether a JSON value has a key that names a prototype, at any depth. */
function unsafeKey(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const k = unsafeKey(x);
      if (k) return k;
    }
    return null;
  }
  if (!isObject(v)) return null;
  for (const [k, x] of Object.entries(v)) {
    if (UNSAFE.has(k)) return k;
    const inner = unsafeKey(x);
    if (inner) return inner;
  }
  return null;
}

/** RFC 7396: an object merges key by key, null removes a key, anything else
 *  replaces. A key that names a prototype is never merged: it could give the
 *  result a field that no walk of the patch sees. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE.has(k)) continue;
    if (v === null) delete out[k];
    else Object.defineProperty(out, k, { value: mergePatch(Object.hasOwn(out, k) ? out[k] : undefined, v), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** What a project layer changes with no approval besides its own keys and the agent's declared fields. */
const PROJECT_FREE = new Set(["title", "description", "icon", "memory", "sweep", "events"]);
/** What a project layer never changes, and is not asked about: an instance's own. */
const PROJECT_IGNORED = new Set(["name", "projects", "projectFields"]);
/** Agentbox's own fields that need approval: an agent cannot declare them safe for a project. */
const PROJECT_RESTRICTED = new Set(["run", "url", "github"]);

/**
 * Split a project layer's patch into what it may change and what needs the
 * person's approval. It may change, with no approval: `title`,
 * `description`, `icon`, `memory`, `sweep`, `events`, `main.rollover`,
 * `main.loops` with prompts only, and the agent's own fields that its
 * manifest declares safe for a project (`projectFields`, dotted paths: a
 * path and everything under it). Everything else needs approval: what runs
 * (`run`, `url`, a loop's `check`), where and on which credentials
 * (`main.start`, `main.schedule`), what it reads from disk
 * (`main.instructions`, a loop's `file`), what it may do on GitHub
 * (`github`), and every own field the agent did not declare, which only its
 * program knows the meaning of. Each restricted part is given with its
 * value, for the digest the person approves.
 */
export function splitProjectPatch(patch: Record<string, unknown>, declared: readonly string[]): { free: Record<string, unknown>; restricted: { field: string; value: unknown }[] } {
  const free: Record<string, unknown> = {};
  const restricted: { field: string; value: unknown }[] = [];
  const own = (path: string, value: unknown): unknown => {
    if (declared.some((d) => path === d || path.startsWith(`${d}.`))) return value;
    if (isObject(value) && declared.some((d) => d.startsWith(`${path}.`))) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const kept = own(`${path}.${k}`, v);
        if (kept !== undefined) out[k] = kept;
      }
      return Object.keys(out).length ? out : undefined;
    }
    restricted.push({ field: path, value });
    return undefined;
  };
  for (const [k, v] of Object.entries(patch)) {
    if (PROJECT_IGNORED.has(k)) continue;
    if (PROJECT_FREE.has(k)) free[k] = v;
    else if (PROJECT_RESTRICTED.has(k)) restricted.push({ field: k, value: v });
    else if (k === "main") {
      // Taking `main` away, or giving something that is not an object, takes `main.start` with it.
      if (!isObject(v)) {
        restricted.push({ field: "main", value: v });
        continue;
      }
      const main: Record<string, unknown> = {};
      for (const [mk, mv] of Object.entries(v)) {
        const promptsOnly = mk === "loops" && Array.isArray(mv) && mv.every((l) => isObject(l) && !("check" in l) && !("file" in l));
        if (mk === "rollover" || promptsOnly) main[mk] = mv;
        else restricted.push({ field: `main.${mk}`, value: mv });
      }
      if (Object.keys(main).length) free.main = main;
    } else {
      const kept = own(k, v);
      if (kept !== undefined) free[k] = kept;
    }
  }
  return { free, restricted };
}

/** The fields of a project layer that need approval, when the agent declares no field of its own safe. */
export const restrictedOf = (patch: Record<string, unknown>, declared: readonly string[] = []) => splitProjectPatch(patch, declared).restricted;

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
    // The agent's own fields a project may set, as its directory and the person say: never a project's own say.
    const declared = Array.isArray(raw.projectFields) ? raw.projectFields.filter((x): x is string => typeof x === "string") : [];
    const split = l.kind === "user" ? { free: l.patch, restricted: [] } : splitProjectPatch(l.patch, declared);
    const restricted = split.restricted;
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
      restricted: digest ? { fields: restricted.map((r) => r.field), values: Object.fromEntries(restricted.map((r) => [r.field, r.value])), digest, approved: ok } : null,
    });
    if (!l.exists) continue;
    if (l.error) {
      error ??= l.error;
      continue;
    }
    // A project layer never names where the agent shows, or what a project may set: those are not its own.
    const patch = l.kind === "user" ? l.patch : ok ? Object.fromEntries(Object.entries(l.patch).filter(([k]) => !PROJECT_IGNORED.has(k))) : split.free;
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
