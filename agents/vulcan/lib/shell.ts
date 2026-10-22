/** git and gh, as Vulcan runs them: bounded, non-interactive, and replaceable
 *  by a test's fakes (`Tools`). */
import { ActionError } from "../../lib/sdk";

export type Git = (cwd: string, ...args: string[]) => Promise<string>;
export type Gh = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export type Tools = { git: Git; gh: Gh };

async function command(args: string[], cwd?: string, input?: unknown): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
    stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code) throw new ActionError(`${args[0]} ${args[1]} failed (${code}): ${err.trim().split("\n")[0] ?? ""}; inspect credentials, repository access and the prepared revision`, 502);
  return out.trim();
}

export const git: Git = (cwd, ...args) => command(["git", "--no-pager", ...args], cwd);

/** `gh api <path>`, as the user gh is logged in as: the grant's actor, checked each time it matters. */
export const gh: Gh = async <T>(path: string, body?: unknown, method = "POST"): Promise<T> => {
  const out = await command(["gh", "api", path, ...(body === undefined ? [] : ["--method", method, "--input", "-"])], undefined, body);
  return (out ? JSON.parse(out) : null) as T;
};

export const tools: Tools = { git, gh };

/** The gh login right now, lower-cased for comparing with a grant's actor. */
export const ghLogin = async (t: Tools): Promise<string> => (await t.gh<{ login: string }>("user")).login.toLowerCase();

/** The sha a branch is at on GitHub, read fresh. */
export const remoteBase = async (t: Tools, repo: string, branch: string): Promise<string> =>
  (await t.gh<{ object: { sha: string } }>(`repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
