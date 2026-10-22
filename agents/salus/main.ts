/**
 * Salus: production crashes to verified fixes (docs/agents.md).
 *
 * Every minute it reads its crash source when a poll is due (PostHog's
 * exceptions), has a read-only session triage each new crash against the code
 * within a daily budget, and shows the verdicts on its page. A person decides;
 * Fix files the issue and hands a prepared family to the fixer (Vulcan)
 * through Salus's main conversation. It then follows the fix to its merge and
 * counts whether the crash stopped. State is SQLite in its home.
 */
import { every, me, serve, store } from "../lib/sdk";
import { action } from "./lib/actions";
import { Ctx, tools } from "./lib/ctx";
import { Store } from "./lib/store";
import { tick } from "./lib/tick";
import { view } from "./lib/view";

/** How a session reaches this agentbox: its CLI, pointed at this server when it is not the default one. */
function cli(): string {
  const port = new URL(process.env.AGENTBOX_URL ?? "http://127.0.0.1:4479").port || "80";
  const env = [...(process.env.AGENTBOX_HOME ? [`AGENTBOX_HOME=${process.env.AGENTBOX_HOME}`] : []), ...(port !== "4479" ? [`AGENTBOX_PORT=${port}`] : [])];
  return env.length ? `env ${env.join(" ")} ${me.bin}` : me.bin;
}

const ctx = new Ctx(new Store(store()), tools, me.home, cli());

serve({
  view: (tab) => view(ctx, tab),
  action: (req) => action(ctx, req),
});

every(60_000, () => tick(ctx));

console.log(`salus answering on :${process.env.PORT}, state in ${me.home}`);
