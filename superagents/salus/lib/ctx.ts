/** What every Salus module works with: its store, its settings, the crash
 *  source, git and gh, and a per-crash lock so two operations never interleave. */
import { ActionError } from "../../lib/sdk";
import { readKey, readSettings, type Settings } from "./settings";
import { PostHog, type Source } from "./source";
import type { Store } from "./store";

export type Git = (cwd: string, ...args: string[]) => Promise<string>;
export type Gh = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export type Tools = { git: Git; gh: Gh };

export class Ctx {
  private busy = new Set<string>();
  constructor(
    readonly store: Store,
    readonly tools: Tools,
    readonly home: string,
    /** How a session reaches this agentbox's CLI, for the prompts. */
    readonly cli: string,
    /** The crash source for these settings; null when it is not set up. A test passes its own. */
    readonly sourceFor: (s: Settings, home: string) => Source | null = postHogFor,
  ) {}

  settings(): Settings {
    return readSettings(this.home);
  }
  source(): Source | null {
    return this.sourceFor(this.settings(), this.home);
  }

  /** One operation per crash at a time; the second is refused, not queued. */
  async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new ActionError("Another operation on this crash is in progress", 409);
    this.busy.add(id);
    try {
      return await fn();
    } finally {
      this.busy.delete(id);
    }
  }
}

function postHogFor(s: Settings, home: string): Source | null {
  const key = readKey(home);
  return key && s.projectId ? new PostHog(s.posthogHost, s.projectId, key) : null;
}

async function command(args: string[], cwd?: string, input?: unknown): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new ActionError(`${args[0]} ${args[1]} failed (${code}): ${err.trim().split("\n")[0] ?? ""}`, 502);
  return out.trim();
}

export const tools: Tools = {
  git: (cwd, ...args) => command(["git", "--no-pager", ...args], cwd),
  /** `gh api <path>`, as the user gh is logged in as. */
  gh: async <T>(path: string, body?: unknown, method = "POST"): Promise<T> => {
    const out = await command(["gh", "api", path, ...(body === undefined ? [] : ["--method", method, "--input", "-"])], undefined, body);
    return (out ? JSON.parse(out) : null) as T;
  },
};
