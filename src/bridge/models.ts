/** The models the devin bridge adds to devin (`src/bridge/devin.ts`), and
 * where the bridge listens. Apart from the bridge so the devin adapter and
 * the model picker can ask "is this one bridged?" without loading a server. */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "../core/paths";
import type { CatalogModel } from "./devin-wire";

export const DEFAULT_BRIDGE_PORT = 4480;

export function bridgePort(): number {
  return Number(process.env.AGENTBOX_DEVIN_BRIDGE_PORT) || DEFAULT_BRIDGE_PORT;
}
export const bridgeUrl = (): string => `http://127.0.0.1:${bridgePort()}`;

export interface BridgedModel extends CatalogModel {
  /** The OpenAI-compatible endpoint that serves it, and its name there. */
  baseUrl: string;
  upstreamModel: string;
  /** The key for that endpoint, read when a request needs it. */
  apiKey(): string | null;
  /** Where to send someone whose key is missing. */
  keyHint: string;
}

/** OpenCode Go's key, from opencode's own login (`opencode auth login`). */
function opencodeGoKey(): string | null {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  const path = join(process.env.XDG_DATA_HOME || join(userHome(), ".local", "share"), "opencode", "auth.json");
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (goKey && goKey.mtimeMs === mtimeMs) return goKey.key;
    const entry = (JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: unknown }>)["opencode-go"];
    const key = typeof entry?.key === "string" && entry.key ? entry.key : null;
    goKey = { mtimeMs, key };
    return key;
  } catch {
    return null;
  }
}
let goKey: { mtimeMs: number; key: string | null } | null = null;

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

/**
 * LongCat 2.5 Preview, free on OpenCode Go. Its window is 1M tokens, but it
 * is to be rolled before about 220k, so that is the window devin is told:
 * the summary is written from 160k and swapped in at 195k, which leaves a
 * turn's worth of tool output before 220k. The thresholds are devin's own
 * mechanism, set per model in the catalog.
 */
const longcat: BridgedModel = {
  uid: "longcat-2-5-preview-free",
  label: "LongCat 2.5 Preview (OpenCode Go)",
  family: "LongCat 2.5 Preview",
  alias: "longcat",
  // A reasoning model served over chat completions, in devin's harness for
  // models that are neither its own nor OpenAI's.
  template: "deepseek-v4-1-flash-max",
  contextTokens: envInt("AGENTBOX_LONGCAT_CONTEXT", 220_000),
  maxOutputTokens: 32_000,
  compaction: {
    spawn: envInt("AGENTBOX_LONGCAT_COMPACT_SPAWN", 160_000),
    apply: envInt("AGENTBOX_LONGCAT_COMPACT_APPLY", 195_000),
    hard: envInt("AGENTBOX_LONGCAT_CONTEXT", 220_000),
  },
  baseUrl: process.env.AGENTBOX_LONGCAT_BASE_URL || "https://opencode.ai/zen/go/v1",
  upstreamModel: "longcat-2.5-preview-free",
  apiKey: opencodeGoKey,
  keyHint: "log in to OpenCode Go (`opencode auth login`) or set OPENCODE_GO_API_KEY",
};

export const BRIDGED: readonly BridgedModel[] = [longcat];

/** The bridged model a devin `--model` value names, if any. */
export function bridgedModel(model: string | null | undefined): BridgedModel | null {
  if (!model) return null;
  return BRIDGED.find((m) => m.uid === model || m.alias === model) ?? null;
}
