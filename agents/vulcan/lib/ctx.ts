/** What every Vulcan module works with: its store, git and gh, the manifest's
 *  own settings, and a per-family lock so two operations never interleave. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionError } from "../../lib/sdk";
import type { Tools } from "./shell";
import type { Store } from "./store";

export type Config = {
  /** The writer's CLI unless the family says. */
  writerProvider: "claude" | "codex";
  /** The prompt revision new families pin (`revisions/<name>.md`). */
  promptRevision: string;
  /** Vulcan's directory: where the revisions are. */
  dir: string;
  /** How a session reaches this agentbox's CLI, for the prompts. */
  cli: string;
};

export class Ctx {
  private busy = new Set<string>();
  constructor(
    readonly store: Store,
    readonly tools: Tools,
    readonly config: Config,
  ) {}

  /** One operation per family at a time; the second is refused, not queued. */
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new ActionError("Another work operation is in progress", 409);
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }

  /** The text of a prompt revision a family pinned; a revision whose file is gone is an error, never silently another. */
  revision(name: string): string {
    if (!/^[\w.-]{1,80}$/.test(name)) throw new ActionError(`not a prompt revision name: ${name}`);
    try {
      return readFileSync(join(this.config.dir, "revisions", `${name}.md`), "utf8").trim();
    } catch {
      throw new ActionError(`prompt revision ${name} is not in ${join(this.config.dir, "revisions")}`, 409);
    }
  }
}

/** The manifest's own `vulcan` field, with defaults. Agentbox ignores it; this is where it is read. */
export function readConfig(dir: string, cli: string): Config {
  const m = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8")) as { vulcan?: { writer?: { provider?: string }; promptRevision?: string } };
  const provider = m.vulcan?.writer?.provider ?? "codex";
  if (provider !== "claude" && provider !== "codex") throw new Error(`agent.json: vulcan.writer.provider is claude or codex, not ${provider}`);
  return { writerProvider: provider, promptRevision: m.vulcan?.promptRevision ?? "producer-to-assertion-v1", dir, cli };
}
