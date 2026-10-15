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
