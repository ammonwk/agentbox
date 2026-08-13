/** Turning an untrusted JSON body into the shapes the core modules are typed for.
 *
 * Every reader takes the object to look in, the KEY to look up, and separately
 * the LABEL to name in the error. Conflating those two shipped a bug that made
 * the whole Supervision section of Settings unusable: the nested readers were
 * called as `requireBoolean(supervisor, "supervisor.enabled")`, which looks up
 * `supervisor["supervisor.enabled"]` — always undefined — so every payload
 * containing a `supervisor` key was rejected with a message insisting the field
 * was missing while it sat right there in the request.
 */

import type { SettingsPatch } from "../core/db";
import { HttpError } from "./router";

export function requireString(obj: Record<string, unknown>, key: string, label = key): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new HttpError(400, `${label} is required and must be a non-empty string`);
  }
  return v;
}

export function optionalString(obj: Record<string, unknown>, key: string, label = key): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.trim() === "") {
    throw new HttpError(400, `${label} must be a non-empty string when given`);
  }
  return v;
}

export function requireBoolean(obj: Record<string, unknown>, key: string, label = key): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") throw new HttpError(400, `${label} is required and must be a boolean`);
  return v;
}

export function requirePositiveInt(obj: Record<string, unknown>, key: string, label = key): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new HttpError(400, `${label} must be a positive integer`);
  }
  return v;
}

export function asObject(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new HttpError(400, `${label} must be an object`);
  }
  return v as Record<string, unknown>;
}

/** `?since=` on the events routes. */
export function sinceParam(url: URL): number | undefined {
  const raw = url.searchParams.get("since");
  if (raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "since must be a non-negative integer seq");
  return n;
}

/**
 * Validate a settings PUT body into a `SettingsPatch`.
 *
 * The merge itself belongs to db.ts — this only establishes that what arrived
 * over the wire is the shape the merge is typed for. Every field is optional at
 * every level: the UI sends partials like `{supervisor: {enabled: true}}`, and
 * the keys it leaves out must survive the merge rather than being reset. Unknown
 * keys are rejected rather than persisted, so a client typo is a 400 and not a
 * setting nothing reads.
 */
export function parseSettingsPatch(body: Record<string, unknown>): SettingsPatch {
  const known = ["theme", "model", "autoApprove", "maxMinutes", "systemPrompt", "supervisor", "advisor"];
  for (const key of Object.keys(body)) {
    if (!known.includes(key)) throw new HttpError(400, `unknown setting: ${key}`);
  }

  const patch: SettingsPatch = {};

  if (body.theme !== undefined) {
    if (body.theme !== "light" && body.theme !== "dark" && body.theme !== "system") {
      throw new HttpError(400, "theme must be light, dark or system");
    }
    patch.theme = body.theme;
  }
  if (body.model !== undefined) patch.model = requireString(body, "model");
  if (body.autoApprove !== undefined) patch.autoApprove = requireBoolean(body, "autoApprove");
  if (body.maxMinutes !== undefined) patch.maxMinutes = requirePositiveInt(body, "maxMinutes");
  if (body.systemPrompt !== undefined) {
    // An empty overlay is a legitimate choice, so this one may be blank.
    if (typeof body.systemPrompt !== "string") throw new HttpError(400, "systemPrompt must be a string");
    patch.systemPrompt = body.systemPrompt;
  }

  if (body.supervisor !== undefined) {
    const sup = asObject(body.supervisor, "supervisor");
    const next: NonNullable<SettingsPatch["supervisor"]> = {};
    if (sup.enabled !== undefined) next.enabled = requireBoolean(sup, "enabled", "supervisor.enabled");
    if (sup.everyToolCalls !== undefined) {
      next.everyToolCalls = requirePositiveInt(sup, "everyToolCalls", "supervisor.everyToolCalls");
    }
    if (sup.model !== undefined) next.model = requireString(sup, "model", "supervisor.model");
    patch.supervisor = next;
  }

  if (body.advisor !== undefined) {
    const adv = asObject(body.advisor, "advisor");
    const next: NonNullable<SettingsPatch["advisor"]> = {};
    if (adv.enabled !== undefined) next.enabled = requireBoolean(adv, "enabled", "advisor.enabled");
    if (adv.model !== undefined) next.model = requireString(adv, "model", "advisor.model");
    patch.advisor = next;
  }

  return patch;
}
