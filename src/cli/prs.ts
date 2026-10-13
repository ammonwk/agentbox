/** Who has which pull request, from the CLI (src/core/prclaims.ts). */

import type { Api } from "../client";
import type { AppState, PrClaim } from "../core/types";
import { idYou, me, parseArgs } from "./sessions";

const str = (v: string | true | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const HOW = { said: "claimed it", branch: "on its branch" } as const;

export async function pr(api: Api, args: string[]): Promise<number> {
  const [verb, ...more] = args;
  const { flags, rest } = parseArgs(more, ["for"], ["json"]);
  // The session is the one named, else the one this runs in, as `send` and
  // `card add` say it; the server walks up from the caller's process only
  // when neither reached here (Codex runs commands without the environment).
  const body = { pr: rest[0], session: str(flags.get("for")) ?? process.env.AGENTBOX_SESSION, callerPid: process.pid, cwd: process.cwd() };
  switch (verb) {
    case "claim": {
      if (!rest[0]) throw new Error("pr claim needs the pull request: its number, owner/repo#number, or its URL");
      const c = await api<PrClaim & { already?: boolean }>("POST", "/api/prs/claim", body);
      // Always in words, and "you" when it is yours: a session reads its own
      // id like any other, and silence on a claim it already had (a session
      // started with --claim that runs `pr claim` itself) told it nothing.
      const you = await me(api);
      if (flags.has("json")) console.log(JSON.stringify({ ...c, you: c.sessionId === you }));
      else if (c.sessionId !== you) console.log(`${c.repo}#${c.number} is ${c.sessionId}'s, not yours, until it stops, closes, or runs \`agentbox pr release ${c.number}\``);
      else if (c.already) console.log(`you already hold ${c.repo}#${c.number} (you are ${you}): it is yours to work`);
      else console.log(`you hold ${c.repo}#${c.number} now (you are ${you}): it is yours to work until you stop or close, or run \`agentbox pr release ${c.number}\``);
      return 0;
    }
    case "release": {
      const { released } = await api<{ released: number }>("POST", "/api/prs/release", body);
      console.log(released ? `released ${released}` : "no explicit claim removed; named PR waits and branch ownership are released");
      return 0;
    }
    case "who": {
      if (!rest[0]) throw new Error("pr who needs the pull request: its number, owner/repo#number, or its URL");
      const w = await api<{ repo: string; number: number; claim: PrClaim | null }>("POST", "/api/prs/who", body);
      const you = await me(api);
      if (flags.has("json")) console.log(JSON.stringify(w.claim ? { ...w, claim: { ...w.claim, you: w.claim.sessionId === you } } : w));
      else if (!w.claim) console.log(`${w.repo}#${w.number}  nobody`);
      else {
        const s = (await api<AppState>("GET", "/api/state")).sessions.find((x) => x.id === w.claim!.sessionId);
        console.log(`${w.repo}#${w.number}  ${idYou(w.claim.sessionId, you)}  ${HOW[w.claim.how]}  ${s?.status ?? "?"}  ${s?.label ?? s?.title ?? ""}`);
      }
      return w.claim ? 0 : 1;
    }
    case "claims":
    case "list":
    case "ls":
    case undefined: {
      const all = await api<PrClaim[]>("GET", "/api/prs/claims");
      const you = await me(api);
      if (flags.has("json")) console.log(JSON.stringify(all.map((c) => ({ ...c, you: c.sessionId === you })), null, 2));
      else for (const c of all) console.log(`${`${c.repo}#${c.number}`.padEnd(44)} ${idYou(c.sessionId, you)}  ${HOW[c.how]}`);
      return 0;
    }
    default:
      throw new Error(`pr takes claim, release, who or claims: not "${verb}"`);
  }
}
