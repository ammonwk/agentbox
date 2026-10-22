/**
 * Every request agentbox itself makes to GitHub's API. It goes on `gh`'s
 * login, so it counts against the same limit as the agents' `gh` and needs
 * no setup of its own. And each answer GitHub charges for (anything but a
 * 304) is written to the gh wrapper's log, so `github-budget callers` shows
 * agentbox beside the agents instead of as a gap in the hour's count.
 */

import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ghErrorMessage, runAsync } from "./git";

let token: string | null = null;

/** `gh` cannot lend its login: not installed, or not logged in. */
export class NoGhLogin extends Error {}

async function ghToken(): Promise<string> {
  if (token) return token;
  const r = await runAsync(["gh", "auth", "token", "--hostname", "github.com"], undefined, { GH_PROMPT_DISABLED: "1" });
  const t = r.stdout.trim();
  if (r.code !== 0 || !t) {
    const message = ghErrorMessage(r);
    throw new NoGhLogin(message.startsWith("`gh`") ? message : "`gh` is not authenticated — run `gh auth login`");
  }
  return (token = t);
}

/** The wrapper's log: `ts session script kind rest actions graphql`, tab-separated. */
const BUDGET_DIR = process.env.GITHUB_BUDGET_DIR || join(homedir(), ".cache/github-budget");
/** What GitHub meters apart from the rest (as the wrapper measured it). */
const ACTIONS_PATH = /\/actions\/(runs\/\d+(?!\d|\/jobs)|jobs\/|workflows|runners|caches|artifacts)|\/check-runs\/\d+|\/check-suites/;

function logCall(caller: string, path: string): void {
  if (!existsSync(BUDGET_DIR)) return;
  const bare = path.split("?")[0];
  const counter = bare === "/graphql" ? 2 : ACTIONS_PATH.test(bare) ? 1 : 0;
  const kind = `api ${bare.replace(/^\/repos\/[^/]+\/[^/]+\//, "").replace(/^\//, "").replace(/\d+/g, "N")}`.slice(0, 52);
  const calls = [0, 0, 0];
  calls[counter] = 1;
  try {
    appendFileSync(join(BUDGET_DIR, "calls.log"), [Math.round(Date.now() / 1000), "agentbox", caller, kind, ...calls].join("\t") + "\n");
  } catch { /* the log is for reading the budget; a request does not depend on it */ }
}

/** One request to `https://api.github.com{path}`, logged under `caller` when it is charged. */
export async function github(caller: string, path: string, init: { method?: string; body?: string; etag?: string | null } = {}): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init.method ?? "GET",
    body: init.body,
    headers: {
      Authorization: `Bearer ${await ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.etag ? { "If-None-Match": init.etag } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status !== 304) logCall(caller, path);
  if (res.status === 401) token = null;
  return res;
}
