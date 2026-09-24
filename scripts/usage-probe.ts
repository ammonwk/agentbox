#!/usr/bin/env bun
/** Manual check that the usage fetchers work against the real endpoints.
 *
 *   bun scripts/usage-probe.ts [--codex-home <dir>] [--devin]
 *
 * Reads the default claude and codex homes (plus any extra codex home given),
 * makes ONE usage request per account, and prints the mapped windows —
 * percentages and reset times only. It never prints a token, an email, or a
 * raw response body, and it touches no database. Each run costs one request
 * per endpoint; do not loop it.
 */

import type { Account } from "../src/core/types";
import { defaultHome } from "../src/core/accounts/homes";
import { defaultDeps, fetchUsage, readClaudeUsageCache, type Reading } from "../src/core/accounts/usage";

const args = process.argv.slice(2);
const extraCodex = args.includes("--codex-home") ? args[args.indexOf("--codex-home") + 1] : null;

function account(provider: Account["provider"], home: string, isDefault: boolean): Account {
  return { id: `probe-${provider}`, provider, label: provider, email: null, plan: null, home, isDefault, enabled: true, createdAt: 0 };
}

const targets: [string, Account][] = [
  ["claude (default)", account("claude", defaultHome("claude"), true)],
  ["codex (default)", account("codex", defaultHome("codex"), true)],
];
if (extraCodex) targets.push([`codex (${extraCodex})`, account("codex", extraCodex, false)]);
if (args.includes("--devin")) targets.push(["devin (default)", account("devin", defaultHome("devin"), true)]);

function show(label: string, r: Reading): void {
  if (r.kind !== "ok") {
    console.log(`${label}: ${r.kind} — ${r.stale}`);
    return;
  }
  console.log(`${label}: source=${r.source} at=${new Date(r.at).toISOString()}`);
  for (const w of r.windows) {
    const reset = w.resetsAt ? new Date(w.resetsAt).toISOString() : "—";
    console.log(`  ${w.id.padEnd(22)} ${w.kind.padEnd(7)} ${w.usedPct.toFixed(1).padStart(5)}%  resets ${reset}`);
  }
  for (const n of r.notes) console.log(`  note: ${n}`);
}

const deps = defaultDeps();
for (const [label, a] of targets) {
  if (a.provider === "claude") {
    const cache = readClaudeUsageCache(a);
    if (cache) show(`${label} [.claude.json cache]`, cache);
  }
  show(`${label} [live]`, await fetchUsage(a, deps));
}
