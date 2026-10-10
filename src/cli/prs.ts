/** Who has which pull request, from the CLI (src/core/prclaims.ts). */

import type { Api } from "../client";
import type { AppState, PrClaim } from "../core/types";
import { parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const HOW = { said: "claimed it", branch: "on its branch" } as const;

export async function pr(api: Api, args: string[]): Promise<number> {
  const [verb, ...more] = args;
  const { flags, rest } = parseArgs(more, ["for"], ["json"]);
  const body = { pr: rest[0], session: str(flags.get("for")), callerPid: process.pid, cwd: process.cwd() };
  switch (verb) {
    case "claim": {
      if (!rest[0]) throw new Error("pr claim needs the pull request: its number, owner/repo#number, or its URL");
      const c = await api<PrClaim>("POST", "/api/prs/claim", body);
      console.log(flags.has("json") ? JSON.stringify(c) : `${c.repo}#${c.number} is ${c.sessionId}'s until it stops, closes, or runs \`agentbox pr release ${c.number}\``);
      return 0;
    }
    case "release": {
      const { released } = await api<{ released: number }>("POST", "/api/prs/release", body);
      console.log(released ? `released ${released}` : "nothing to release: this session claimed no such pull request (a PR it holds by being on its branch is not released, only left)");
      return 0;
    }
    case "who": {
      if (!rest[0]) throw new Error("pr who needs the pull request: its number, owner/repo#number, or its URL");
      const w = await api<{ repo: string; number: number; claim: PrClaim | null }>("POST", "/api/prs/who", body);
      if (flags.has("json")) console.log(JSON.stringify(w));
      else if (!w.claim) console.log(`${w.repo}#${w.number}  nobody`);
      else {
        const s = (await api<AppState>("GET", "/api/state")).sessions.find((x) => x.id === w.claim!.sessionId);
        console.log(`${w.repo}#${w.number}  ${w.claim.sessionId}  ${HOW[w.claim.how]}  ${s?.status ?? "?"}  ${s?.label ?? s?.title ?? ""}`);
      }
      return w.claim ? 0 : 1;
    }
    case "claims":
    case "list":
    case "ls":
    case undefined: {
      const all = await api<PrClaim[]>("GET", "/api/prs/claims");
      if (flags.has("json")) console.log(JSON.stringify(all, null, 2));
      else for (const c of all) console.log(`${`${c.repo}#${c.number}`.padEnd(44)} ${c.sessionId}  ${HOW[c.how]}`);
      return 0;
    }
    default:
      throw new Error(`pr takes claim, release, who or claims: not "${verb}"`);
  }
}
