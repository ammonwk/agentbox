/** Presentation only: the provider transcript and approval text stay intact. */
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
