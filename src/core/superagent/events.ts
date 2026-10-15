/**
 * Generic events agentbox brings a superagent that names them in its
 * manifest (`"events": ["pr.ready"]`). Each superagent gets each event once
 * (`superagent_events`), so neither side keeps a wait of its own for it.
 *
 * pr.ready: the session that owns a pull request found it ready on a head
 * (`agentbox pr ready <PR> --head <SHA>`). It goes to each superagent that
 * takes the event and shows in the PR's project (or in every project), once
 * per PR and head, other than the one whose session reported it. A
 * superagent with a program gets it as an action (`pr.ready`, with
 * `{repo, number, head, owner}` and the owner as the caller); one without
 * gets it in its main conversation, as the owner's message.
 */
import { getDb, getSessionRecord, listRepos } from "../db";
import { FleetError, type Fleet } from "../fleet";
import { sendAsAgent } from "../sendguard";
import type { Superagents } from "../superagents";

export type PrReady = { repo: string; number: number; head: string };
export type Delivered = { superagent: string; state: "sent" | "already" | "failed"; to?: string; result: string };

/** Mark an event given, once: false when it was already. */
function once(name: string, key: string): boolean {
  return getDb().run("INSERT OR IGNORE INTO superagent_events (name, key, at) VALUES (?, ?, ?)", [name, key, Date.now()]).changes === 1;
}
const forget = (name: string, key: string) => getDb().run("DELETE FROM superagent_events WHERE name = ? AND key = ?", [name, key]);

export async function prReady(hub: Superagents, fleet: Fleet, owner: string, pr: PrReady): Promise<{ state: "sent" | "already" | "skipped"; result: string; delivered: Delivered[] }> {
  if (!/^[0-9a-f]{7,40}$/i.test(pr.head)) throw new FleetError(400, "--head is the commit SHA the PR was found ready on");
  const project = listRepos().find((r) => r.fullName?.toLowerCase() === pr.repo.toLowerCase()) ?? null;
  const from = hub.ownerOf(owner);
  const takers = hub
    .list()
    .filter((a) => a.enabled && !a.error && a.events.includes("pr.ready") && a.name !== from)
    .filter((a) => a.projects === null || (project !== null && a.projects.includes(project.id)));
  if (!takers.length) return { state: "skipped", result: `No agent here takes ready PRs${project ? ` in ${project.displayName}` : ` for ${pr.repo}`}: give one "events": ["pr.ready"] in its manifest`, delivered: [] };
  const key = `pr.ready:${pr.repo.toLowerCase()}#${pr.number}@${pr.head.toLowerCase()}`;
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const text = `PR ready for your review: ${url} on head ${pr.head}. Its owner, ${from ? `${from} in session ${owner}` : `session ${owner}`}, verified it ready. Review that exact head, and send your verdict back with agentbox send ${owner} <verdict>.`;
  const delivered: Delivered[] = [];
  for (const a of takers) {
    if (!once(a.name, key)) {
      delivered.push({ superagent: a.name, state: "already", result: `${a.title} already has ${pr.repo}#${pr.number} on ${pr.head.slice(0, 10)}` });
      continue;
    }
    try {
      if (a.hasPage && a.process?.state !== "stopped") {
        await hub.action(a.name, { action: "pr.ready", values: { ...pr, owner }, tab: null }, { session: owner, via: "api" });
        delivered.push({ superagent: a.name, state: "sent", result: `Handed to ${a.title}'s program` });
      } else if (a.main && getSessionRecord(a.main)) {
        const sent = await sendAsAgent(fleet, a.main, text, { from: owner, wake: true, verified: true, agent: from }, Date.now());
        if ("refused" in sent) throw new FleetError(409, sent.refused);
        delivered.push({ superagent: a.name, state: "sent", to: sent.to, result: `Handed to ${a.title} in session ${sent.to}` });
      } else {
        const r = await hub.chat(a.name, text, crypto.randomUUID());
        delivered.push({ superagent: a.name, state: "sent", to: r.session, result: `${a.title} had no chat, so this started one: session ${r.session}` });
      }
    } catch (e) {
      // Not handed over: the next report of this head tries again.
      forget(a.name, key);
      delivered.push({ superagent: a.name, state: "failed", result: `${a.title} did not take it: ${(e as Error).message}` });
    }
  }
  const sent = delivered.filter((d) => d.state === "sent");
  const state = sent.length ? "sent" : delivered.every((d) => d.state === "already") ? "already" : "skipped";
  if (state === "skipped" && delivered.some((d) => d.state === "failed")) throw new FleetError(409, delivered.map((d) => d.result).join("; "));
  return { state, result: delivered.map((d) => d.result).join("; "), delivered };
}
