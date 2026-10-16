/**
 * Generic events agentbox brings a superagent that names them in its
 * manifest (`"events": ["pr.ready"]`). Each superagent gets each event once
 * (`superagent_events`), so neither side keeps a wait of its own for it.
 * Each goes to each superagent that takes the event and shows in the PR's
 * project (or in every project), other than the one that sent it. A
 * superagent with a program gets it as an action of the event's name; one
 * without gets it in its main conversation.
 *
 * pr.ready: the session that owns a pull request found it ready on a head
 * (`agentbox pr ready <PR> --head <SHA>`), once per PR and head. The action
 * has `{repo, number, head, owner}` and the owner as the caller; the main
 * gets it as the owner's message.
 *
 * pr.tend: someone hands a pull request on to be taken to ready
 * (`agentbox pr tend <PR> [--note-file F]`): a person by hand, or a session
 * (a judge's that sends it back with findings). Once per PR, head and sender
 * (its superagent, else its session, else the person). The action has
 * `{repo, number, head, from, agent, note}`, with the sending session (or
 * null) as the caller; the main gets it as that session's message, or as
 * the person's.
 *
 * Each one given opens the other again for its PR and head (`reopen`), so a
 * PR sent back and made ready again on one head goes round again.
 */
import { getDb, getSessionRecord, listRepos } from "../db";
import { FleetError, type Fleet } from "../fleet";
import { sendAsAgent } from "../sendguard";
import type { Superagents } from "../superagents";
import type { SuperagentEvent, SuperagentInfo } from "../types";

export type PrReady = { repo: string; number: number; head: string };
export type PrTend = PrReady & { note: string | null };
/** Who handed a PR on: a session (and the superagent it acts for, when it does), or the person (both null). */
export type Sender = { session: string | null; agent: string | null };
export type Delivered = { superagent: string; state: "sent" | "already" | "failed"; to?: string; result: string };
export type Outcome = { state: "sent" | "already" | "skipped"; result: string; delivered: Delivered[] };

/** Findings longer than this are refused, not cut: a cut finding misleads. */
export const NOTE_MAX = 20_000;

/** Mark an event given, once: false when it was already. */
function once(name: string, key: string): boolean {
  return getDb().run("INSERT OR IGNORE INTO superagent_events (name, key, at) VALUES (?, ?, ?)", [name, key, Date.now()]).changes === 1;
}
const forget = (name: string, key: string) => getDb().run("DELETE FROM superagent_events WHERE name = ? AND key = ?", [name, key]);

/**
 * A PR goes back and forth on one head: a judge can send it back for a
 * check or a comment, which its owner clears with no new commit. So each
 * event that was given opens the other one again for that PR and head:
 * after a hand-off, the next ready report of the head is new, and after a
 * ready report, the next hand-off of it is new.
 */
function reopen(event: "pr.ready" | "pr.tend", pr: PrReady): void {
  const base = `${event}:${pr.repo.toLowerCase()}#${pr.number}@`, head = pr.head.toLowerCase();
  const rows = getDb().query("SELECT name, key FROM superagent_events WHERE substr(key, 1, ?) = ?").all(base.length, base) as { name: string; key: string }[];
  for (const r of rows) {
    // A head may be given short: the same commit either way.
    const h = r.key.slice(base.length).split(":")[0]!;
    if (head.startsWith(h) || h.startsWith(head)) forget(r.name, r.key);
  }
}
const at = (pr: PrReady) => `${pr.repo.toLowerCase()}#${pr.number}@${pr.head.toLowerCase()}`;

const checkHead = (head: string) => {
  if (!/^[0-9a-f]{7,40}$/i.test(head)) throw new FleetError(400, "--head is the commit SHA of the PR's head");
};

/** The enabled superagents that take `event` in the PR's project, other than the sender's own. */
function takers(hub: Superagents, event: SuperagentEvent, repo: string, from: string | null): { list: SuperagentInfo[]; where: string } {
  const project = listRepos().find((r) => r.fullName?.toLowerCase() === repo.toLowerCase()) ?? null;
  const list = hub
    .list()
    .filter((a) => a.enabled && !a.error && a.events.includes(event) && a.name !== from)
    .filter((a) => a.projects === null || (project !== null && a.projects.includes(project.id)));
  return { list, where: project ? ` in ${project.displayName}` : ` for ${repo}` };
}

/**
 * Give one event to each taker once for `key`: as the action `event` to a
 * program, else as `text` to its main conversation (from `session`, or the
 * person's message when null), else a main started for it.
 */
async function deliver(
  hub: Superagents,
  fleet: Fleet,
  ev: { event: SuperagentEvent; key: string; label: string; values: Record<string, unknown>; text: string; session: string | null; agent: string | null },
  list: SuperagentInfo[],
): Promise<Outcome> {
  const delivered: Delivered[] = [];
  for (const a of list) {
    if (!once(a.name, ev.key)) {
      delivered.push({ superagent: a.name, state: "already", result: `${a.title} already has ${ev.label}` });
      continue;
    }
    try {
      if (a.hasPage && a.process?.state !== "stopped") {
        await hub.action(a.name, { action: ev.event, values: ev.values, tab: null }, { session: ev.session, via: "api" });
        delivered.push({ superagent: a.name, state: "sent", result: `Handed to ${a.title}'s program` });
      } else if (ev.session && a.main && getSessionRecord(a.main)) {
        const sent = await sendAsAgent(fleet, a.main, ev.text, { from: ev.session, wake: true, verified: true, agent: ev.agent }, Date.now());
        if ("refused" in sent) throw new FleetError(409, sent.refused);
        delivered.push({ superagent: a.name, state: "sent", to: sent.to, result: `Handed to ${a.title} in session ${sent.to}` });
      } else {
        // The person's own message, or a main that does not exist yet: its chat, which starts one when it has none.
        const r = await hub.chat(a.name, ev.text, crypto.randomUUID());
        delivered.push({ superagent: a.name, state: "sent", to: r.session, result: r.started ? `${a.title} had no chat, so this started one: session ${r.session}` : `Handed to ${a.title} in session ${r.session}` });
      }
    } catch (e) {
      // Not handed over: the next report of it tries again.
      forget(a.name, ev.key);
      delivered.push({ superagent: a.name, state: "failed", result: `${a.title} did not take it: ${(e as Error).message}` });
    }
  }
  const sent = delivered.filter((d) => d.state === "sent");
  const state = sent.length ? "sent" : delivered.every((d) => d.state === "already") ? "already" : "skipped";
  if (state === "skipped" && delivered.some((d) => d.state === "failed")) throw new FleetError(409, delivered.map((d) => d.result).join("; "));
  return { state, result: delivered.map((d) => d.result).join("; "), delivered };
}

export async function prReady(hub: Superagents, fleet: Fleet, owner: string, pr: PrReady): Promise<Outcome> {
  checkHead(pr.head);
  const from = hub.ownerOf(owner);
  const { list, where } = takers(hub, "pr.ready", pr.repo, from);
  if (!list.length) return { state: "skipped", result: `No agent here takes ready PRs${where}: give one "events": ["pr.ready"] in its manifest`, delivered: [] };
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const out = await deliver(
    hub,
    fleet,
    {
      event: "pr.ready",
      key: `pr.ready:${at(pr)}`,
      label: `${pr.repo}#${pr.number} on ${pr.head.slice(0, 10)}`,
      values: { ...pr, owner },
      text: `PR ready for your review: ${url} on head ${pr.head}. Its owner, ${from ? `${from} in session ${owner}` : `session ${owner}`}, verified it ready. Review that exact head, and send your verdict back with agentbox send ${owner} <verdict>.`,
      session: owner,
      agent: from,
    },
    list,
  );
  if (out.state === "sent") reopen("pr.tend", pr);
  return out;
}

/**
 * `letGo` runs once some agent took the event, and never when none did: the
 * route uses it to release the PR when the sender holds it, so that the
 * taker can give it to a fresh owner.
 */
export async function prTend(hub: Superagents, fleet: Fleet, sender: Sender, pr: PrTend, letGo: () => void = () => {}): Promise<Outcome> {
  checkHead(pr.head);
  if (pr.note && pr.note.length > NOTE_MAX) throw new FleetError(400, `the note has ${pr.note.length} characters, more than ${NOTE_MAX}: put the rest in the PR and link to it`);
  const { list, where } = takers(hub, "pr.tend", pr.repo, sender.agent);
  if (!list.length) return { state: "skipped", result: `No agent here takes PRs to ready${where}: give one "events": ["pr.tend"] in its manifest`, delivered: [] };
  const url = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const who = sender.agent && sender.session ? `${sender.agent} in session ${sender.session}` : sender.session ? `session ${sender.session}` : "the person";
  const out = await deliver(
    hub,
    fleet,
    {
      event: "pr.tend",
      key: `pr.tend:${at(pr)}:${sender.agent ?? sender.session ?? "person"}`,
      label: `${pr.repo}#${pr.number} on ${pr.head.slice(0, 10)} from ${who}`,
      values: { ...pr, from: sender.session, agent: sender.agent },
      text: `PR handed to you to take to ready: ${url}, head ${pr.head}, from ${who}.${pr.note ? `\nWhat it needs:\n${pr.note}` : ""}`,
      session: sender.session,
      agent: sender.agent,
    },
    list,
  );
  if (out.state === "sent") {
    reopen("pr.ready", pr);
    letGo();
  }
  return out;
}
