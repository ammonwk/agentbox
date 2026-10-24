/** `agentbox your-time [--days N] [--json]`: how much of your time the fleet
 *  took each day, and on what (src/core/yourtime.ts). */

import type { Api } from "../client";
import type { YourTime } from "../core/yourtime";
import { parseArgs } from "./sessions";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export async function yourTime(api: Api, args: string[]): Promise<number> {
  const { flags } = parseArgs(args, ["days"], ["json"]);
  const days = flags.get("days") ?? "14";
  const t = await api<YourTime>("GET", `/api/you/time?days=${encodeURIComponent(String(days))}`);
  if (flags.has("json")) {
    console.log(JSON.stringify(t, null, 2));
    return 0;
  }
  for (const d of t.days) {
    const h = d.minutes >= 60 ? `${Math.floor(d.minutes / 60)}h ${String(d.minutes % 60).padStart(2, "0")}m` : `${d.minutes}m`;
    const c = d.counts;
    console.log(`${d.day}  ${h.padStart(7)}  ${plural(c.message, "message")}, ${plural(c.card, "card")}, ${plural(c.mfa, "MFA code")}, ${plural(c.login, "login")}`);
  }
  console.log(`(${t.timezone}; ${t.rule})`);
  return 0;
}
