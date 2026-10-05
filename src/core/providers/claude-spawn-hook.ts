/**
 * Claude's PreToolUse hook on its Agent tool, run as a script by every claude
 * agentbox launches (`claude.ts` passes it with `--settings`). When the one
 * spawning is itself a subagent, the child's prompt is told who started it.
 *
 * Claude keeps every subagent of a process in one flat list and resolves
 * `SendMessage({to: "main"})` to the top-level conversation, whoever did the
 * spawning. A worker two levels down is told nothing about its parent, takes
 * "main" for its coordinator, and its questions land in the conversation the
 * user is reading, which never heard of the task. Only this hook can name the
 * parent: SubagentStart's input carries the child alone, and the child's
 * `.meta.json` (which has `parentAgentId`) is not written until after it.
 *
 * Imports nothing of agentbox's: it runs before every spawn, and bun starts a
 * bare script in a fraction of the time the CLI takes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SpawnHookInput {
  hook_event_name?: string;
  transcript_path?: string;
  /** Present only when a subagent made the call. */
  agent_id?: string;
  agent_type?: string;
  tool_input?: Record<string, unknown>;
}

/** What the spawner is addressed by: the name it was given, else its id. */
export function spawnerAddress(input: SpawnHookInput, metas: Record<string, { name?: unknown }>): string | null {
  const id = input.agent_id;
  if (!id) return null;
  const meta = metas[id];
  return typeof meta?.name === "string" && meta.name ? meta.name : id;
}

export function startedByNote(address: string): string {
  return [
    `(agentbox note) You were started by the agent \`${address}\`, not by the main conversation, and your final message is returned to it.`,
    `To reach it sooner, SendMessage to \`${address}\`. \`main\` is this session's top-level conversation, which did not start you and may know nothing about your task.`,
    `\`${address}\` may be waiting on you and unable to read a message until you finish, so whatever it must act on belongs in your final message.`,
  ].join(" ");
}

/** The hook's answer, or null to leave the call as it is. */
export function spawnHookOutput(input: SpawnHookInput, metas: Record<string, { name?: unknown }>): object | null {
  if (input.hook_event_name !== "PreToolUse") return null;
  const address = spawnerAddress(input, metas);
  const prompt = input.tool_input?.prompt;
  if (!address || typeof prompt !== "string" || !prompt) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input.tool_input, prompt: `${prompt}\n\n${startedByNote(address)}` },
    },
  };
}

/** `<transcript>/subagents/agent-<id>.meta.json`, by id. */
function readMetas(transcriptPath: string | undefined): Record<string, { name?: unknown }> {
  const metas: Record<string, { name?: unknown }> = {};
  if (!transcriptPath?.endsWith(".jsonl")) return metas;
  const dir = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return metas;
  }
  for (const name of names) {
    const id = /^agent-(.+)\.meta\.json$/.exec(name)?.[1];
    if (!id) continue;
    try {
      metas[id] = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      // Half-written or gone: the id still addresses it.
    }
  }
  return metas;
}

if (import.meta.main) {
  // Any failure leaves the spawn untouched: a hook that exits non-zero or
  // prints something else would be shown to the agent as an error.
  try {
    const input = JSON.parse(await Bun.stdin.text()) as SpawnHookInput;
    const out = input.agent_id ? spawnHookOutput(input, readMetas(input.transcript_path)) : null;
    if (out) console.log(JSON.stringify(out));
  } catch {
    // Nothing to say.
  }
}
