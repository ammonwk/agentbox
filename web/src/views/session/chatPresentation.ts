import type { TimelineEvent } from "../../../../src/core/types";
import { isCheckpointPrompt } from "../../../../src/core/superagent/marks";
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

/** The separator agentbox puts between a fresh main's first prompt and the
 *  person's message (`opening`, src/core/superagent/opening.ts). */
const OPENING = "\n\n---\n\n";

/** A main conversation's first message as the person wrote it: the
 *  instructions, SOUL.md and memory agentbox put before it stay in the
 *  transcript, out of Chat. Only for the event that starts the conversation. */
export function personsOpening<E extends TimelineEvent>(events: readonly E[], start: boolean): readonly E[] {
  const first = events[0];
  if (!start || first?.kind !== "user") return events;
  const at = first.text.lastIndexOf(OPENING);
  if (at < 0) return events;
  return [{ ...first, text: first.text.slice(at + OPENING.length) }, ...events.slice(1)];
}
