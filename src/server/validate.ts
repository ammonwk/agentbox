/** Turning an untrusted JSON body into the shapes the core modules are typed for.
 *
 * Every reader takes the object to look in, the KEY to look up, and separately
 * the LABEL to name in the error. Conflating those two once made a whole
 * section of Settings unusable: a nested reader called as
 * `requireBoolean(section, "section.enabled")` looks up
 * `section["section.enabled"]` — always undefined — so every payload carrying
 * that section was rejected with a message insisting the field was missing
 * while it sat right there in the request.
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

/**
 * Validate a settings PUT body into a `SettingsPatch`.
 *
 * The merge itself belongs to db.ts — this only establishes that what arrived
 * over the wire is the shape the merge is typed for. Every field is optional at
 * every level: the UI sends partials like `{balancer: {claimBig: 25}}`, and
 * the keys it leaves out must survive the merge rather than being reset. Unknown
 * keys are rejected rather than persisted, so a client typo is a 400 and not a
 * setting nothing reads.
 */
export function parseSettingsPatch(body: Record<string, unknown>): SettingsPatch {
  const known = ["theme", "boardDays", "autoApprove", "parkIdleMin", "models", "balancer"];
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
  if (body.boardDays !== undefined) patch.boardDays = requirePositiveInt(body, "boardDays");
  if (body.autoApprove !== undefined) patch.autoApprove = requireBoolean(body, "autoApprove");
  if (body.parkIdleMin !== undefined) {
    const v = body.parkIdleMin;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 7 * 24 * 60) {
      throw new HttpError(400, "parkIdleMin must be a whole number of minutes from 0 (never) to 10080");
    }
    patch.parkIdleMin = v;
  }

  if (body.models !== undefined) {
    const m = asObject(body.models, "models");
    const next: NonNullable<SettingsPatch["models"]> = {};
    for (const [k, v] of Object.entries(m)) {
      if (!["claude", "codex", "devin", "omp"].includes(k)) throw new HttpError(400, `unknown provider in models: ${k}`);
      if (typeof v !== "string") throw new HttpError(400, `models.${k} must be a string`);
      next[k as keyof typeof next] = v.trim();
    }
    patch.models = next;
  }

  if (body.balancer !== undefined) {
    const b = asObject(body.balancer, "balancer");
    const next: NonNullable<SettingsPatch["balancer"]> = {};
    const ranges: Record<string, [number, number]> = {
      claimNormal: [0, 100],
      claimBig: [0, 100],
      shortWindowInWeekly: [1, 100],
      claimIdleMin: [1, 24 * 60],
      resetHorizonMin: [0, 300],
    };
    for (const [k, v] of Object.entries(b)) {
      const range = ranges[k];
      if (!range) throw new HttpError(400, `unknown balancer setting: ${k}`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < range[0] || v > range[1]) {
        throw new HttpError(400, `balancer.${k} must be a number from ${range[0]} to ${range[1]}`);
      }
      next[k as keyof typeof next] = v;
    }
    patch.balancer = next;
  }

  return patch;
}
