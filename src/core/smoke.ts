/** What `scripts/interrupt-smoke.ts` found for each provider CLI, by version.
 *  Interrupting a running turn (`Fleet.interrupt`, a rewind mid-turn) depends
 *  on how the CLI handles Escape, which only a live run shows, so `agentbox doctor` warns
 *  when the installed version is not one that passed. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "./paths";

export type SmokeResult = { version: string; ok: boolean; detail: string; at: number; endedInMs?: number };
const file = () => join(agentboxHome(), "smoke", "interrupt.json");

export function smokeRecord(): Record<string, SmokeResult> {
  try {
    return existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
  } catch {
    return {};
  }
}

export function recordSmoke(provider: string, r: SmokeResult): void {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify({ ...smokeRecord(), [provider]: r }, null, 2));
}

/** `2.1.300` from `2.1.300 (Claude Code)`, `0.156.1` from `codex-cli 0.156.1`; null when it will not run. */
export function installedVersion(provider: string): string | null {
  try {
    const p = Bun.spawnSync([provider, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    return p.exitCode === 0 ? (/\d+\.\d+(?:\.\d+)?[\w.-]*/.exec(p.stdout.toString())?.[0] ?? null) : null;
  } catch {
    return null;
  }
}

/** For doctor: whether the installed CLI's Escape handling has passed the live check. */
export function interruptCheck(provider: "claude" | "codex"): { ok: boolean; detail: string } | null {
  const version = installedVersion(provider);
  if (!version) return null;
  const r = smokeRecord()[provider];
  if (r?.version === version && r.ok) return { ok: true, detail: `${version} passed the live Escape check` };
  const why = r?.version === version ? `failed the live Escape check: ${r.detail}` : `has not had the live Escape check${r ? ` (${r.version} was the last)` : ""}`;
  return { ok: false, detail: `${version} ${why}; run bun scripts/interrupt-smoke.ts ${provider}` };
}
