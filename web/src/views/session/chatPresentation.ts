import type { TimelineEvent } from "../../../../src/core/types";
import { isCheckpointPrompt, OPENING_SEPARATOR } from "../../../../src/core/superagent/marks";
/** Presentation only: the provider transcript and approval text stay intact. */

/** What the viewed conversation's transcript and session say now:
 *  `message` is the newest message a person sent, `read` whether the agent
 *  has written anything after it, `working` whether a turn shown in Chat is
 *  open, and `queued` what it holds until its current step yields (claude). */
export type ChatPresence = { message: string | null; read: boolean; working: boolean; queued: string[] };

/** A conversation burst ends at a four-minute gap: its first and last messages show their time. */
export function chatTimestamps(events: readonly { id: string; at: number }[]): Set<string> {
  const times = new Set<string>();
  const separated = (a: { at: number }, b: { at: number }) => b.at - a.at >= 4 * 60_000;
  events.forEach((event, i) => {
    const before = events[i - 1], after = events[i + 1];
    if (!before || !after || separated(before, event) || separated(event, after)) times.add(event.id);
  });
  return times;
}

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;
export type AskEvent = ToolEvent & { ask: NonNullable<ToolEvent["ask"]> };
/** What an agent's Chat shows of its conversation: the messages, and each
 *  question the agent asked with what was answered. The question being asked
 *  now (`live`, its call's id) is the answerable card at the tail instead. */
export function chatShown<E extends TimelineEvent>(events: readonly E[], live: string | null) {
  return events.filter((e): e is E & (Extract<TimelineEvent, { kind: "user" | "assistant" }> | AskEvent) =>
    // Agentbox's request for a handoff is its own note, not the person's message.
    (e.kind === "user" && !isCheckpointPrompt(e.text)) || e.kind === "assistant" || (e.kind === "tool" && !!e.ask && e.ask.id !== live));
}

/** The separator that a main started before OPENING_SEPARATOR put before the
 *  person's message. It is also a markdown rule, so it is only a fallback. */
const OLD_OPENING = "\n\n---\n\n";

/** A main conversation's first message as the person wrote it: the
 *  instructions, SOUL.md and memory agentbox put before it stay in the
 *  transcript, out of Chat. Only for the event that starts the conversation. */
export function personsOpening<E extends TimelineEvent>(events: readonly E[], start: boolean): readonly E[] {
  const first = events[0];
  if (!start || first?.kind !== "user") return events;
  // The person's text follows the first separator, and can contain the separator itself.
  const at = first.text.indexOf(OPENING_SEPARATOR);
  const old = at < 0 ? first.text.lastIndexOf(OLD_OPENING) : -1;
  if (at < 0 && old < 0) return events;
  const text = at >= 0 ? first.text.slice(at + OPENING_SEPARATOR.length) : first.text.slice(old + OLD_OPENING.length);
  return [{ ...first, text }, ...events.slice(1)];
}
