import type { PromptHistoryEntry } from "../../../src/core/types";
import { dropPasteTags, isAgentSent, PROMPT_PREVIEW } from "../../../src/core/sent";
import { api } from "../api";

export type { PromptHistoryEntry };

/** The board carries the first `PROMPT_PREVIEW` characters of a prompt.
 *  Recall the full opening prompt from the transcript when it may have been capped. */
export async function recallPrompt(entry: PromptHistoryEntry, isCurrent = () => true): Promise<string> {
  if (entry.prompt.length < PROMPT_PREVIEW) return entry.prompt;
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
