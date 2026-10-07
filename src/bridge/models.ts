/** The models the devin bridge adds to devin (`src/bridge/devin.ts`), and
 * where the bridge listens. Apart from the bridge so the devin adapter and
 * the model picker can ask "is this one bridged?" without loading a server. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** OpenCode Go's key, from opencode's own login (`opencode auth login`).
 *  For the free model below only: no OpenCode Go account is this key
 *  (src/core/accounts/gocred.ts). */
function opencodeGoKey(): string | null {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  try {
    const path = join(process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local", "share"), "opencode", "auth.json");
    const key = (JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: unknown }>)["opencode-go"]?.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : fallback;
};

/** LongCat 2.5 Preview, free on OpenCode Go, at a given window and devin
 *  compaction thresholds. Its own window is 1M tokens, but it is reported to
 *  degrade past about 200k, so it is told less and summarised before then. */
function longcat(uid: string, alias: string, label: string, window: number, compaction: BridgedModel["compaction"]): BridgedModel {
  return {
    uid,
    label,
    family: "LongCat 2.5 Preview",
    alias,
    // A reasoning model served over chat completions, in devin's harness for
    // models that are neither its own nor OpenAI's.
    template: "deepseek-v4-1-flash-max",
    contextTokens: window,
    maxOutputTokens: 32_000,
    compaction,
    baseUrl: process.env.AGENTBOX_LONGCAT_BASE_URL || "https://opencode.ai/zen/go/v1",
    upstreamModel: "longcat-2.5-preview-free",
    apiKey: opencodeGoKey,
    keyHint: "log in to OpenCode Go (`opencode auth login`) or set OPENCODE_GO_API_KEY",
  };
}

/** Rolled before 220k: the summary is written from 160k and swapped in at
 *  195k, which leaves a turn's worth of tool output before 220k. */
const longcatWindow = envInt("AGENTBOX_LONGCAT_CONTEXT", 220_000);
const longcat220k = longcat("longcat-2-5-preview-free", "longcat", "LongCat 2.5 Preview (OpenCode Go)", longcatWindow, {
  spawn: envInt("AGENTBOX_LONGCAT_COMPACT_SPAWN", 160_000),
  apply: envInt("AGENTBOX_LONGCAT_COMPACT_APPLY", 195_000),
  hard: longcatWindow,
});

/** The same model given 400k before it is summarised, to measure whether
 *  fewer summaries are worth running further past 200k. */
const longcat400k = longcat("longcat-2-5-preview-free-400k", "longcat-400k", "LongCat 2.5 Preview, 400k (OpenCode Go)", 400_000, {
  spawn: 300_000,
  apply: 370_000,
  hard: 400_000,
});

export const BRIDGED: readonly BridgedModel[] = [longcat220k, longcat400k];

/** The bridged model a devin `--model` value names, if any. */
export function bridgedModel(model: string | null | undefined): BridgedModel | null {
  if (!model) return null;
  return BRIDGED.find((m) => m.uid === model || m.alias === model) ?? null;
}
