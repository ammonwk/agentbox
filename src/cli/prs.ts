/** Who has which pull request, from the CLI (src/core/prclaims.ts). */

import type { Api } from "../client";
import type { AppState, PrClaim } from "../core/types";
import { parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const HOW = { said: "claimed it", branch: "on its branch" } as const;

export async function pr(api: Api, args: string[]): Promise<number> {
  const [verb, ...more] = args;
  const { flags, rest } = parseArgs(more, ["for", "expect", "to"], ["json"]);
  // The session is the one named, else the one this runs in, as `send` and
  // `card add` say it; the server walks up from the caller's process only
  // when neither reached here (Codex runs commands without the environment).
  const body = { pr: rest[0], session: str(flags.get("for")) ?? process.env.AGENTBOX_SESSION, callerPid: process.pid, cwd: process.cwd() };
  switch (verb) {
    case "transfer": {
      const expected = str(flags.get("expect"));
      const to = str(flags.get("to"));
      if (!rest[0] || !expected || !to) throw new Error("pr transfer <repo#n> --expect <current holder> --to <new holder>, run by the current holder");
      const c = await api<PrClaim>("POST", "/api/prs/transfer", { ...body, expected, to });
      console.log(flags.has("json") ? JSON.stringify(c) : `${c.repo}#${c.number} handed from ${expected} to ${c.sessionId}`);
      return 0;
    }
    case "claim": {
      if (!rest[0]) throw new Error("pr claim needs the pull request: its number, owner/repo#number, or its URL");
      const c = await api<PrClaim & { already?: boolean }>("POST", "/api/prs/claim", body);
      // Claiming what you hold is no news: a session started with --claim
      // that runs `pr claim` itself (green-and-clean does) hears nothing.
      if (flags.has("json")) console.log(JSON.stringify(c));
      else if (!c.already) console.log(`${c.repo}#${c.number} is ${c.sessionId}'s until it stops, closes, or runs \`agentbox pr release ${c.number}\``);
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
      throw new Error(`pr takes claim, transfer, release, who or claims: not "${verb}"`);
  }
}
