/**
 * Vulcan: reported issues to a reviewed pull request (docs/superagents.md).
 *
 * A program on agentbox's HTTP API, nothing in core knows it. Its page is
 * `lib/view.ts`, its actions `lib/actions.ts`, and the process they drive is
 * in `lib/`: grants, work families, review rounds, publication, outcomes and
 * the Feed. State is SQLite in its home. Every 30s it checks that each
 * family's authority still stands and stops what no longer has any.
 */
import { every, me, serve, store } from "../lib/sdk";
import { action } from "./lib/actions";
import { Ctx, readConfig } from "./lib/ctx";
import { enforceAuthority } from "./lib/grants";
import { tools } from "./lib/shell";
import { adoptLegacyClaims } from "./lib/work";
import { Store } from "./lib/store";
import { view } from "./lib/view";

/** How a session reaches this agentbox: its CLI, pointed at this server when it is not the default one. */
function cli(): string {
  const port = new URL(process.env.AGENTBOX_URL ?? "http://127.0.0.1:4479").port || "80";
  const env = [...(process.env.AGENTBOX_HOME ? [`AGENTBOX_HOME=${process.env.AGENTBOX_HOME}`] : []), ...(port !== "4479" ? [`AGENTBOX_PORT=${port}`] : [])];
  return env.length ? `env ${env.join(" ")} ${me.bin}` : me.bin;
}

const ctx = new Ctx(new Store(store()), tools, readConfig(me.dir, cli()));

serve({
  view: (tab) => view(ctx, tab),
  action: (req) => action(ctx, req),
});

void adoptLegacyClaims(ctx).catch((e) => console.error(`issue claims not moved to agentbox: ${(e as Error).message}`));

every(30_000, async () => {
  const stopped = await enforceAuthority(ctx);
  if (stopped.length) console.log(`authority gone: stopped ${stopped.join(", ")}`);
});

console.log(`vulcan answering on :${process.env.PORT}, state in ${me.home}`);
