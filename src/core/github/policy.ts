/**
 * Which GitHub App a superagent acts as, and what it can do there.
 *
 * A superagent's manifest proposes a policy in its `github` field. It takes
 * effect only when the host owner pins it (`agentbox github pin`, from a
 * terminal or the app, never from a session or a program): the pin records the
 * policy's digest and the path of the App's private key, which is host
 * config and never in a manifest. A manifest that changes its policy after
 * the pin gets every action refused until the owner pins it again.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { getDb } from "../db";
import { FleetError } from "../fleet";
import { readManifest } from "../superagents";
import { GITHUB_ACTION_KINDS, repoName } from "./broker";

export const BrokerPolicy = z
  .object({
    app: z
      .object({
        appId: z.number().int().positive(),
        installationId: z.number().int().positive(),
        /** The App's bot account, `slug[bot]`. */
        login: z.string().regex(/^[a-z\d][a-z\d-]{0,38}\[bot\]$/i, "login is the App's slug[bot]"),
      })
      .strict(),
    repos: z.array(repoName).min(1).max(100),
    actions: z.array(z.enum(GITHUB_ACTION_KINDS)).max(GITHUB_ACTION_KINDS.length),
    /** prepare: a person approves each action on a Review card; automatic: within policy at once. */
    approval: z.enum(["prepare", "automatic"]).default("prepare"),
    mergePolicy: z
      .object({
        requiredChecks: z.array(z.string().min(1).max(160)).max(40).default([]),
        minApprovals: z.number().int().min(1).max(10).default(1),
      })
      .strict()
      .default({ requiredChecks: [], minApprovals: 1 }),
  })
  .strict();
export type BrokerPolicy = z.infer<typeof BrokerPolicy>;

export type Pin = { superagent: string; digest: string; policy: BrokerPolicy; appKeyPath: string; pinnedAt: number };

/** Sorted repos and kinds, sorted keys: the same policy always has the same digest. */
export function policyDigest(p: BrokerPolicy): string {
  const canon = { ...p, repos: [...new Set(p.repos)].sort(), actions: [...new Set(p.actions)].sort() };
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash("sha256").update(JSON.stringify(stable(canon))).digest("hex");
}

/** What the manifest in `dir` proposes now, or null when it proposes nothing. */
export function proposedPolicy(dir: string): { policy: BrokerPolicy; digest: string } | null {
  const raw = (readManifest(dir) as Record<string, unknown>).github;
  if (raw === undefined) return null;
  const p = BrokerPolicy.safeParse(raw);
  if (!p.success) throw new FleetError(400, `superagent.json github: ${p.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ")}`);
  return { policy: p.data, digest: policyDigest(p.data) };
}

type Row = { superagent: string; digest: string; policy: string; app_key_path: string; pinned_at: number };

export function pinOf(superagent: string): Pin | null {
  const r = getDb().query("SELECT * FROM github_pins WHERE superagent = ?").get(superagent) as Row | null;
  return r && { superagent: r.superagent, digest: r.digest, policy: BrokerPolicy.parse(JSON.parse(r.policy)), appKeyPath: r.app_key_path, pinnedAt: r.pinned_at };
}

/** The key must be a private file of this host: absolute, mode 0600 or stricter. */
export function checkAppKey(path: string): void {
  if (!isAbsolute(path)) throw new FleetError(400, "give the App's private key as an absolute path");
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new FleetError(400, `${path} does not exist`);
  }
  if (!info.isFile() || info.mode & 0o077 || info.size > 32000) throw new FleetError(400, `${path} must be a private (0600) PEM file`);
}

/**
 * Pin what the manifest proposes now. `digest` is the one the owner saw: a
 * manifest that changed between the look and the pin is refused, so the pin
 * is always of what the owner read.
 */
export function pin(superagent: string, dir: string, digest: string, appKeyPath: string | null, now = Date.now()): Pin {
  const proposed = proposedPolicy(dir);
  if (!proposed) throw new FleetError(409, `${superagent}'s superagent.json proposes no github policy`);
  if (proposed.digest !== digest) throw new FleetError(409, `${superagent}'s github policy is now ${proposed.digest.slice(0, 12)}, not ${digest.slice(0, 12)}: read it again before you pin it`);
  const key = appKeyPath ?? pinOf(superagent)?.appKeyPath;
  if (!key) throw new FleetError(400, "give the App's private key path (--key) the first time");
  checkAppKey(key);
  getDb().run(
    `INSERT INTO github_pins (superagent, digest, policy, app_key_path, pinned_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(superagent) DO UPDATE SET digest = excluded.digest, policy = excluded.policy, app_key_path = excluded.app_key_path, pinned_at = excluded.pinned_at`,
    [superagent, proposed.digest, JSON.stringify(proposed.policy), key, now],
  );
  return pinOf(superagent)!;
}

export function unpin(superagent: string): boolean {
  return getDb().run("DELETE FROM github_pins WHERE superagent = ?", [superagent]).changes > 0;
}

/**
 * The pin an action runs under, if the manifest still proposes exactly what
 * was pinned. Every refusal says what the owner must do.
 */
export function effectivePin(superagent: string, dir: string): Pin {
  const pinned = pinOf(superagent);
  if (!pinned) throw new FleetError(403, `${superagent} has no pinned GitHub policy: the host owner must run \`agentbox github pin ${superagent} --key <pem>\``);
  let now: string | null;
  try {
    now = proposedPolicy(dir)?.digest ?? null;
  } catch (e) {
    throw new FleetError(403, `${superagent}'s manifest cannot be read, so its pinned GitHub policy is not used: ${(e as Error).message}`);
  }
  if (now !== pinned.digest)
    throw new FleetError(
      403,
      `${superagent}'s github policy changed since it was pinned (pinned ${pinned.digest.slice(0, 12)}, now ${now?.slice(0, 12) ?? "none"}): the host owner must run \`agentbox github pin ${superagent}\` again`,
    );
  return pinned;
}
