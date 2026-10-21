/** The text a session is given, in files its launch names.
 *
 * An agent that carries its prompt or its briefing on its command line is
 * found by `pgrep -f` on any word in it: a `pkill -f release-rehearsal`
 * kills the agent that was told to run the rehearsal — and every other agent
 * that was told the same words, which is every agent of that repo. The words
 * go to files instead, and the command line names the files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "./paths";

/** Write the text, unless the file already holds it. */
function textFile(path: string, text: string): string {
  try {
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  } catch {
    /* the session starts without it */
  }
  return path;
}

export interface SessionText {
  /** The file the briefing is in: what the session is told about where it
   *  runs, and the user's rules for it. */
  briefing: string;
  /** The file the first prompt is in, when the CLI takes it from a file. */
  prompt?: string;
}

/**
 * A session's own text, in files under the agentbox home.
 *
 * One file per session, rewritten when the session is started again, so a rule
 * edited since the last launch reaches the next one without a restart of the
 * server.
 */
export function sessionText(sessionId: string, briefing: string, prompt?: string): SessionText {
  const dir = join(agentboxHome(), "sessions", sessionId);
  const files: SessionText = { briefing: textFile(join(dir, "briefing.md"), briefing) };
  if (prompt !== undefined) files.prompt = textFile(join(dir, "prompt.md"), prompt);
  return files;
}
