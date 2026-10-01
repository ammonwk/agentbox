import type { Session } from "../../../src/core/types";
import { dropPasteTags, isAgentSent } from "../../../src/core/sent";
import { api } from "../api";

export interface PromptHistoryEntry {
  sessionId: string;
  prompt: string;
}

/** Opening prompts from the provider's record, newest first. */
export function promptHistory(sessions: readonly Session[]): PromptHistoryEntry[] {
  return [...sessions].sort((a, b) => b.startedAt - a.startedAt).flatMap((s) => {
    const prompt = s.firstPrompt?.trim();
    if (s.parent || !prompt || isAgentSent(prompt)) return [];
    return [{ sessionId: s.id, prompt }];
  });
}

/** Claude and Codex cap board previews at 2000 characters. Recall the full
 *  opening prompt from their transcript when it may have been capped. */
export async function recallPrompt(entry: PromptHistoryEntry, isCurrent = () => true): Promise<string> {
  if (entry.prompt.length < 2000) return entry.prompt;
  let before: string | undefined;
  let prompt: string | null = null;
  do {
    if (!isCurrent()) return entry.prompt;
    const page = await api.timeline(entry.sessionId, { before, limit: 1000 });
    // Slash commands and setup messages may precede the opening prompt.
    const first = page.events.find((ev) => ev.kind === "user" && !isAgentSent(ev.text) &&
      dropPasteTags(ev.text).trim().startsWith(entry.prompt));
    if (first?.kind === "user") prompt = dropPasteTags(first.text).trim();
    if (!page.before || page.before === before) break;
    before = page.before;
  } while (true);
  if (prompt === null) throw new Error("The opening prompt is no longer in the transcript.");
  return prompt;
}
