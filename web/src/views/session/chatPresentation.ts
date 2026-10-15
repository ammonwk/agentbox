import type { TimelineEvent } from "../../../../src/core/types";
/** Presentation only: the provider transcript and approval text stay intact. */

/** What the viewed conversation's transcript and session say now:
 *  `message` is the newest message a person sent, `read` whether the agent
 *  has written anything after it, `working` whether a turn shown in Chat is
 *  open, and `queued` what it holds until its current step yields (claude). */
export type ChatPresence = { message: string | null; read: boolean; working: boolean; queued: string[] };
export type ReplyRecommendation = { id: string; title: string; next_step: string };
const GUIDANCE = /^\[Guidance on recommendation ([0-9a-f-]{36})\]\s*\n([\s\S]*)$/i;
const SCOPE = " Only this next step is authorized; other actions and outreach keep their existing requirements.";
export function recommendationReply(text: string, recommendations: readonly ReplyRecommendation[]) {
  const match = GUIDANCE.exec(text);
  if (!match) return null;
  const id = match[1]!, proposal = recommendations.find((p) => p.id === id);
  let body = match[2]!, quote = proposal?.next_step ?? "";
  const prefix = `Approved recommendation ${id}: `;
  if (body.startsWith(prefix) && body.endsWith(SCOPE)) {
    quote ||= body.slice(prefix.length, -SCOPE.length);
    body = "Approved this step. Only this next step is authorized; other actions and outreach keep their existing requirements.";
  }
  return { id, title: proposal?.title ?? "Recommendation", quote, body };
}

/** A conversation burst ends at a four-minute gap or a carried-history boundary. */
export function chatTimestamps(events: readonly { id: string; at: number; source?: string }[]): Set<string> {
  const times = new Set<string>();
  const separated = (a: typeof events[number], b: typeof events[number]) => b.at - a.at >= 4 * 60_000 || a.source !== b.source;
  events.forEach((event, i) => {
    const before = events[i - 1], after = events[i + 1];
    if (!before || !after || separated(before, event) || separated(event, after)) times.add(event.id);
  });
  return times;
}

/** A card in the chat (a creation draft, a recommendation) sits at its time,
 *  like a message: before the first message newer than it. One older than the
 *  loaded page shows with that page; one newer than every message comes last. */
export function placeCards<C extends { at: number }>(messages: readonly { id: string; at: number }[], cards: readonly C[], earlier: boolean) {
  const before = new Map<string, C[]>(), after: C[] = [];
  const oldest = messages[0]?.at ?? -Infinity;
  for (const card of [...cards].sort((a, b) => a.at - b.at)) {
    if (earlier && card.at < oldest) continue;
    const next = messages.find((m) => m.at > card.at);
    if (next) before.set(next.id, [...(before.get(next.id) ?? []), card]);
    else after.push(card);
  }
  return { before, after };
}

type ToolEvent = Extract<TimelineEvent, { kind: "tool" }>;
export type AskEvent = ToolEvent & { ask: NonNullable<ToolEvent["ask"]> };
/** What an agent's Chat shows of its conversation: the messages, and each
 *  question the agent asked with what was answered. The question being asked
 *  now (`live`, its call's id) is the answerable card at the tail instead. */
export function chatShown<E extends TimelineEvent>(events: readonly E[], live: string | null) {
  return events.filter((e): e is E & (Extract<TimelineEvent, { kind: "user" | "assistant" }> | AskEvent) =>
    e.kind === "user" || e.kind === "assistant" || (e.kind === "tool" && !!e.ask && e.ask.id !== live));
}
