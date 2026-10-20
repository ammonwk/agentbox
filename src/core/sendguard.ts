/**
 * What stops one agent's `agentbox send` (and the fleet MCP's `send`) from
 * costing more than it is worth. Two refusals, both said to the sender in
 * words it can act on, and neither ever applied to you — the app, voice mode —
 * or to the fleet's own notes (keep-warm, recovery, a schedule's note).
 *
 * Waking: a message to a session that is stopped, parked, or whose prompt
 * cache has gone cold (`Session.cacheWarmUntil`, cache.ts) makes it read its
 * whole context again at full price to hear one line. That is refused unless
 * the sender says waking it is the point (`wake`).
 *
 * Chatter: more than `CHATTER_MAX` messages from one session to another in
 * `CHATTER_WINDOW_MS`. Each one interrupts the reader and stays in its
 * context. Of 185 sender→reader pairs in this machine's transcripts, 169 never
 * passed two in an hour and 175 never passed three; the few that reached five
 * and six were coordinators narrating to workers.
 *
 * Taken over: a session another has taken over from (a schedule's
 * replacement, `Fleet.handOver`) is not who an agent means any more, and
 * waking it would give its job two sessions. The message goes to its heir,
 * told who it was for, and the refusals above are its heir's.
 */

import type { Fleet } from "./fleet";
import { agentSentMark } from "./sent";
import type { Session } from "./types";

export const CHATTER_MAX = 3;
export const CHATTER_WINDOW_MS = 60 * 60_000;

/** `312k`, `8k`: a context size as the board says it. */
const size = (tokens: number | null): string => (tokens ? `${Math.max(1, Math.round(tokens / 1000))}k tokens` : "an unknown amount");

function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`;
}

/**
 * Why an agent's message to `s` would wake it, or null when it would not:
 * it runs and its cache is warm, or it is mid-turn (the message joins a turn
 * that is paying for the context anyway).
 */
export function wakeRefusal(s: Session, now: number): string | null {
  const asleep = s.host === "none";
  const cold = s.cold || now > s.cacheWarmUntil;
  if (!asleep && (!cold || s.status === "running" || s.status === "blocked")) return null;
  const state = asleep
    ? s.status === "closed"
      ? "is closed"
      : s.status === "stopped"
        ? "is stopped"
        : "was parked for sitting idle"
    : `has a cold prompt cache (it ran out ${span(now - s.cacheWarmUntil)} ago)`;
  return (
    `not sent: ${s.id} ${state} and holds ${size(s.contextUsed)} of context, so a message ${asleep ? "resumes" : "wakes"} it and it re-reads all of that at full price. ` +
    `Read it instead: \`agentbox show ${s.id}\`, \`agentbox log ${s.id} | tail -60\`. ` +
    `If its work must go on, start a fresh session with a handoff that points at that log. ` +
    `Send again with --wake only when waking it is the point: the answer to a question it asked, or a blocker only it can clear.`
  );
}

/**
 * Why a message cannot get `s` going: it stopped at its account's usage limit
 * and the limit has a known end that has not come. Every message before then
 * is refused by the provider the same way and stays in its context, so `wake`
 * does not lift this. Null when it is not at a limit, or nothing says when
 * the limit ends.
 */
export function limitRefusal(s: Session, now: number): string | null {
  const until = s.limitHit?.until;
  if (!until || until <= now) return null;
  const when = new Date(until).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    `not sent: ${s.id} stopped at its account's usage limit, which lasts until ${when} (in ${span(until - now)}). ` +
    `Until then its provider refuses every message the same way, so there is nothing to retry and --wake does not help. ` +
    `\`limitHit.until\` in \`agentbox ls --json\` is that time: wait for it, or if its work cannot, start a fresh session on another account or provider with a handoff that points at \`agentbox log ${s.id}\`.`
  );
}

/** Agent messages delivered, by `sender→reader`, within the window. In memory:
 *  a restart forgets an hour of counts, which costs nothing worth a table. */
const sent = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const kept = (sent.get(key) ?? []).filter((t) => now - t < CHATTER_WINDOW_MS);
  if (kept.length) sent.set(key, kept);
  else sent.delete(key);
  return kept;
}

/** A sender that could not be told is one sender: unknown ones share a count. */
const pair = (from: string | null, to: string): string => `${from ?? "?"}→${to}`;

/** Why `from` has said enough to `to` for now, or null. */
export function chatterRefusal(from: string | null, to: string, now: number, max = CHATTER_MAX): string | null {
  const times = recent(pair(from, to), now);
  if (times.length < max) return null;
  return (
    `not sent: ${from ?? "this session"} has already sent ${to} ${times.length} messages in the last hour, and each one interrupts it and stays in its context. ` +
    `Put everything it still needs from you into one message and send that in ${span(times[0]! + CHATTER_WINDOW_MS - now)}, when the limit (${max} an hour to one session) next has room; ` +
    `or do not send it: \`agentbox wait session ${to}\` tells you when its turn ends, and \`agentbox log ${to} | tail\` what it did.`
  );
}

/** A message from `from` reached `to`. */
export function countSend(from: string | null, to: string, now: number): void {
  sent.set(pair(from, to), [...recent(pair(from, to), now), now]);
}

/**
 * An agent's message to `id` (`from` is the sending session, when known):
 * delivered to `id`, or to whoever has taken over from it, and counted; or
 * refused before anything is typed or resumed. `wake`: waking it is the
 * point, and a stopped one is resumed with the message.
 */
/**
 * Where an agent's message to `id` goes (`to`: `id`, or whoever took over
 * from it) and why it may not, before anything is typed: the one check for
 * an agent's `agentbox send`.
 */
export function agentRefusal(
  fleet: Pick<Fleet, "get" | "heir">,
  id: string,
  opts: { from: string | null; wake: boolean },
  now: number,
): { meant: string; to: string; refusal: string | null } {
  const meant = fleet.get(id).id;
  const to = fleet.get(fleet.heir(meant));
  const refusal = limitRefusal(to, now) ?? (opts.wake ? null : wakeRefusal(to, now)) ?? chatterRefusal(opts.from, to.id, now);
  return { meant, to: to.id, refusal: refusal && (to.id === meant ? refusal : `${meant} has been taken over by ${to.id}. ${refusal}`) };
}

export async function sendAsAgent(
  fleet: Pick<Fleet, "get" | "heir" | "send">,
  id: string,
  text: string,
  opts: { from: string | null; wake: boolean },
  now: number,
): Promise<{ to: string } | { refused: string }> {
  const { meant, to: toId, refusal } = agentRefusal(fleet, id, opts, now);
  if (refusal) return { refused: refusal };
  const to = { id: toId };
  const told = to.id === meant ? "" : `[sent to ${meant}, which you took over from] `;
  // Counted once it is in, so one that could not be delivered costs nothing.
  await fleet.send(to.id, `${agentSentMark(opts.from)} ${told}${text}`, undefined, opts.wake);
  countSend(opts.from, to.id, now);
  return { to: to.id };
}
