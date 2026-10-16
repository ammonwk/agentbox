/**
 * Steward's program: the SDK wired to `Steward` (steward.ts), which holds
 * what it does. Another superagent runs this same file with its own
 * manifest (`run: ["bun", "<agentbox>/superagents/steward/main.ts"]`): its
 * config is `me.manifest`, its owner prompt its own directory's when it has
 * one, else this code's.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentbox, call, every, me, serve, store } from "../lib/sdk";
import { Steward, type Config } from "./steward";

// Its manifest as it runs: the directory's, with the person's and the project's layers over it.
const manifest = me.manifest as { title?: string; steward: Config };
const cfg = manifest.steward;

const steward = new Steward(
  store(),
  cfg,
  {
    state: () => agentbox.state(false),
    prWho: (pr) => agentbox.prWho(pr),
    start: (spec) => agentbox.start(spec),
    send: (id, text, opts) => agentbox.send(id, text, opts),
    main: async () => (await agentbox.self()).main,
    chat: (text) => call("POST", `/api/superagents/${me.name}/chat`, { text, sendId: crypto.randomUUID() }),
  },
  async (args) => {
    const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")}: ${err.trim().slice(0, 300)}`);
    return out;
  },
  {
    name: me.name,
    title: manifest.title ?? me.name,
    project: me.project,
    bin: me.bin,
    template: (file) => readFileSync(existsSync(join(me.dir, file)) ? join(me.dir, file) : join(import.meta.dir, file), "utf8"),
  },
);

every(cfg.every * 1000, () => steward.pass());
serve({ action: (req) => steward.action(req), view: (tab) => steward.view(tab) });
console.log(`steward ${me.name}: every ${cfg.every}s over ${cfg.repos.join(", ") || steward.everywhere}${steward.discover ? "" : ", only PRs handed to it"}`);
