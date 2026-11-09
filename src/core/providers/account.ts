import type { AccountProvider, ProviderId, ServiceId } from "../types";

/** Whose accounts a provider's sessions run on. opencode has no login of its
 *  own here: it runs on OpenCode Go, which omp's Go accounts are sign-ins to
 *  and read usage for, so an opencode session is placed on, pinned to and
 *  metered against one of those accounts, by the same balancer as omp's. Its own
 *  module, free of Node, so the CLI, the MCP servers and the board can ask
 *  without loading adapters. */
export function accountProvider(p: ProviderId): AccountProvider {
  return p === "opencode" ? "omp" : p;
}

/** The providers whose logins an org can pool (docs/org.md): claude, codex
 *  and omp refresh in the store; devin's key and muse's api_key do not
 *  rotate. Shared with the board, which offers sharing these with the org. */
export const ORG_PROVIDERS: readonly AccountProvider[] = ["claude", "codex", "devin", "omp", "muse"];

// --------------------------------------------------------------- services

/* The model services a CLI's accounts can be on (docs/v2.md, Accounts).
 *
 * A claude or codex account is its CLI's own login. An omp account is a
 * login to a service that sells models: OpenCode Go (a Console sign-in the
 * bridge puts on each request) or Morph (an API key). A model id names its
 * service by its provider, the part before the slash: `opencode-go/…`, as a
 * block of omp's `models.yml` or one of opencode's providers, is Go's, and
 * `morph/…` is Morph's. So the model a session runs on decides which
 * accounts can take it, and an account decides which models it offers.
 *
 * Adding a service is an entry here, plus its block in `models.yml` naming
 * `keyEnv` as its `apiKey`. */

/** A service that sells models, which an omp account is a login to. */
export interface ModelService {
  id: ServiceId;
  label: string;
  /** The CLIs whose sessions can run on it. */
  harnesses: readonly ProviderId[];
  /** How an account gets its credential: agentbox's OpenCode Console device
   *  sign-in (accounts/gocred.ts), or a key you paste, kept in its home
   *  (accounts/services.ts). */
  login: "go-console" | "api-key";
  /** What stands in for usage windows, for a service that reports none. */
  limits?: string;
  /** The providers, in a `provider/model` id, whose models it serves. */
  providers: readonly string[];
  /** api-key: the variable its `models.yml` block names as `apiKey`. A session
   *  on the account is given the account's key in it. */
  keyEnv?: string;
  /** api-key: a GET that answers 200 to a good key and 401 to a bad one. */
  keyCheck?: string;
  /** Whether it meters a plan in windows the balancer weighs. Sessions on one
   *  that does not claim nothing. */
  metered: boolean;
  /** How long a limit stop holds its account when the stop names no wait. */
  limitHoldMs?: number;
}

export const SERVICES: readonly ModelService[] = [
  {
    id: "opencode-go",
    label: "OpenCode Go",
    harnesses: ["omp", "opencode"],
    login: "go-console",
    providers: ["opencode-go", "opencode-go-responses"],
    metered: true,
  },
  {
    id: "morph",
    label: "Morph",
    harnesses: ["omp"],
    login: "api-key",
    providers: ["morph"],
    keyEnv: "MORPH_API_KEY",
    keyCheck: "https://api.morphllm.com/v1/models",
    metered: false,
    // Morph caps uncached input and output tokens per minute per model, and
    // reports neither the cap nor what is left of it (no header, no endpoint).
    limits: "No daily or weekly limit. Tokens are capped per minute; Morph does not say how much of the minute is left.",
    limitHoldMs: 60_000,
  },
];

export function service(id: string | null | undefined): ModelService | null {
  return SERVICES.find((s) => s.id === id) ?? null;
}

/** The service a model is sold by, from its `provider/` part; null for a
 *  model no service here sells, which any of the harness's accounts runs. */
export function serviceOfModel(model: string | null | undefined): ModelService | null {
  const slash = model?.indexOf("/") ?? -1;
  if (!model || slash < 1) return null;
  const provider = model.slice(0, slash);
  return SERVICES.find((s) => s.providers.includes(provider)) ?? null;
}

/** Whether a session of `harness` can run on this account on some model:
 *  its accounts, and of those on a service, the services it can use. */
export function runsOn(a: { provider: AccountProvider; service: ServiceId | null }, harness: ProviderId): boolean {
  return a.provider === accountProvider(harness) && (service(a.service)?.harnesses.includes(harness) ?? true);
}

/** Whether a session of `harness` on `model` can run on an account of
 *  `svc` (null: a CLI's own login, which runs whatever its CLI does). */
export function servesModel(svc: ServiceId | null, harness: ProviderId, model: string | null | undefined): boolean {
  const own = service(svc);
  if (!own) return true;
  if (!own.harnesses.includes(harness)) return false;
  const sold = serviceOfModel(model);
  return !sold || sold.id === own.id;
}
