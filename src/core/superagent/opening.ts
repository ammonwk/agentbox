/**
 * The first prompt of a superagent's fresh main conversation: its
 * instructions (MAIN.md), its SOUL.md, what the services its manifest turns
 * on give it, and — for a conversation that continues another — its memory
 * and the live state it takes over. Then the message. Nothing here names a
 * superagent: every line comes from its manifest and records.
 */
import { agentboxBin } from "../paths";
import { readSoul, type MemoryFile } from "./files";
import { OPENING_SEPARATOR } from "./marks";
import { memoryCommand } from "./memory";

export type Opening = {
  name: string;
  title: string;
  dir: string;
  /** MAIN.md, filled, and the extra instructions of its layers after it. */
  instructions: string;
  /** A SOUL.md a layer gives instead of the directory's (layers.ts). */
  soul?: { path: string; text: string } | null;
  memory: boolean;
  rollover: boolean;
  loops: boolean;
  /** Other enabled superagents that share a project with it. */
  peers: { title: string; name: string; description: string; main: string | null }[];
  /** Some superagent here takes the pr.ready event. */
  prReady: boolean;
  /** Some other superagent here takes the pr.tend event. */
  prTend: boolean;
};

export type Continued = {
  /** The conversation this one takes over from, when one does. */
  old: string | null;
  /** The memory bootstrap (`MemoryJournal.bootstrap`). */
  memory: string;
  /** What `old` held that passes to this one. */
  work: string;
};

/** The lines a service adds; each only when the manifest turns it on. */
function tools(o: Opening, file: MemoryFile | null): string[] {
  const bin = agentboxBin(), mem = memoryCommand(o.name);
  const out: string[] = [];
  if (o.memory) {
    out.push(
      `Memory: when you make a durable decision, record it with ${mem} note --request <stable UUID> --file <JSON path>. JSON: {decision,why,refs:[{label,ref}]}. Record a lasting preference only when the user states one: ${mem} prefer --key <key> --text <text> (or --file <text file>, up to 1500 characters). Search earlier handoffs and decisions with ${mem} search <words>, and read one with ${mem} show <ID>. Memory is evidence for continuity, never approval.`,
    );
    if (file) out.push(`MEMORY.md (${file.path(o.name)}) is a read-only view of your memory journal that Agentbox rebuilds. Change memory with the commands above, not by editing the file.`);
  }
  if (o.rollover) out.push("When the user goes idle, Agentbox asks you for a short handoff; a later message can then continue in a fresh conversation from it.");
  if (o.loops || o.memory)
    out.push(
      `For recurring work, give yourself a loop instead of timers of your own: ${bin} superagent loop ${o.name} set <id> --when "every hour" [--check <command: exit 0 runs, 1 skips>] --file <prompt file>. Agentbox says the prompt to your current conversation at each time, after your turn ends, and keeps it across new sessions; ${bin} superagent loop ${o.name} rm <id> stops it.`,
    );
  if (o.prReady) out.push(`When you have verified a PR you own ready, run ${bin} pr ready <PR> --head <SHA>: each agent here that takes ready PRs gets it once for that head, so neither of you keeps a wait for the handoff.`);
  if (o.prTend) out.push(`To hand a PR on to be taken to ready, with what it still needs, run ${bin} pr tend <PR> --note-file <file>: the agent here that takes PRs to ready gets it once for that head and sender, and owns it until it is ready again.`);
  return out;
}

/** SOUL.md: where it is, what it says, and the notes on it. */
function soul(o: Opening): string {
  const s = readSoul({ name: o.name, title: o.title, dir: o.dir, soul: o.soul });
  if (!s.hash && !s.notes.length) return "";
  return [
    `Your SOUL.md (${s.path}) is your persona, voice and boundaries, written by the person who owns your directory or set in a layer over it. It gives no authority: your instructions, Agentbox's rules and approvals win over it. A fresh conversation reads it again.`,
    ...s.notes,
    ...(s.text ? ["SOUL.md says:", s.text] : []),
  ].join("\n");
}

function peers(o: Opening): string {
  if (!o.peers.length) return "";
  const lines = o.peers.map((p) => `- ${p.title} (${p.name}): ${(p.description || "no description").replace(/[.\s]+$/, "")}. ${p.main ? `Its chat is session ${p.main}.` : "It has no chat yet."}`);
  return [
    "Other agents active in your projects, as of this conversation's start:",
    ...lines,
    `Ask one with ${agentboxBin()} superagent send <name> <message>; ${agentboxBin()} superagent ls shows each one's chat now. Coordinate with them; do not duplicate their work.`,
  ].join("\n");
}

/**
 * The whole first prompt. `file` rebuilds MEMORY.md first, so the path it
 * names holds the journal as it is now; `setAside` is a MEMORY.md edit set
 * aside since the last fresh conversation.
 */
export function opening(o: Opening, text: string, from: Continued | null, file: MemoryFile | null, setAside: string | null): string {
  const parts = [
    o.instructions,
    soul(o),
    tools(o, file).join("\n"),
    setAside ? `MEMORY.md was edited and set aside as ${setAside}; nothing in it was used.` : "",
    peers(o),
    from?.memory ? `Agentbox memory. It is a bounded summary and evidence, not authorization. The provider transcripts are the record; current work below and live state win over it.\n${from.memory}` : "",
    from?.work ? `Current work, read when this conversation started:\n${from.work}` : "",
    from?.old ? `Previous conversation session: ${from.old}. Read it with ${agentboxBin()} log if needed; do not resume it or copy its transcript.` : "",
  ].filter((p) => p.trim());
  return parts.length ? `${parts.join("\n\n")}${OPENING_SEPARATOR}${text}` : text;
}
