/** The marker of agentbox's handoff request to a superagent's main
 *  (rollover.ts). It finds the request again in a transcript, and Chat keeps
 *  it out of view: it is agentbox's note, not the person's message. No imports,
 *  so the web bundle can use it. */
export const CHECKPOINT_MARK = "[agentbox: memory checkpoint";

export const isCheckpointPrompt = (text: string): boolean => text.includes(CHECKPOINT_MARK);

/** The separator between a fresh main's first prompt and the person's message
 *  (opening.ts). It is unique, so Chat finds the person's message at its first
 *  occurrence, and a markdown rule in the message stays in the message. */
export const OPENING_SEPARATOR = "\n\n--- message ---\n\n";

/** The separator mains started before OPENING_SEPARATOR used. */
const OLD_OPENING = "\n\n---\n\n";

/** A fresh main's first prompt as the person wrote it: what follows the
 *  first separator, or for an older main the last old one; the whole text
 *  when it has neither. */
export function personsText(text: string): string {
  const at = text.indexOf(OPENING_SEPARATOR);
  if (at >= 0) return text.slice(at + OPENING_SEPARATOR.length);
  const old = text.lastIndexOf(OLD_OPENING);
  return old >= 0 ? text.slice(old + OLD_OPENING.length) : text;
}
