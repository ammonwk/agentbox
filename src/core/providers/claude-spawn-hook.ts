/**
 * Claude's PreToolUse hook on its Agent tool, run as a script by every claude
 * agentbox launches (`claude.ts` passes it with `--settings`). Every child's
 * prompt is told what a subagent is for (`subagentScopeNote`), and when the
 * one spawning is itself a subagent, who started it.
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

/**
 * A subagent lives inside its parent's turn: a five-minute prompt cache, no
 * way to wait without holding its turn open, messages it may not read until
 * it finishes, and a parent that must stay up for as long as it runs. A pull
 * request's CI and review rounds take hours, so a PR is handed to a session of
 * its own, which waits at its prompt, keeps an hour's cache and owns the PR to
 * the end.
 */
export function subagentScopeNote(): string {
  return [
    "(agentbox note) You are a subagent: your final message returns to whoever started you, who may be waiting on it.",
    "If your task leads to a pull request, do not take it through CI and review yourself: once it is pushed, hand it to an agentbox session of its own,",
    "started from the PR's worktree with `agentbox claude --detach '<the PR, what is left to do, and every constraint you were given>'`,",
    "which owns it from there, and finish with the PR and that session's id in your final message.",
  ].join(" ");
}

/** The hook's answer, or null to leave the call as it is. */
export function spawnHookOutput(input: SpawnHookInput, metas: Record<string, { name?: unknown }>): object | null {
  if (input.hook_event_name !== "PreToolUse") return null;
  const prompt = input.tool_input?.prompt;
  if (typeof prompt !== "string" || !prompt) return null;
  const address = spawnerAddress(input, metas);
  const notes = [subagentScopeNote(), ...(address ? [startedByNote(address)] : [])];
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input.tool_input, prompt: `${prompt}\n\n${notes.join("\n\n")}` },
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
    const out = spawnHookOutput(input, input.agent_id ? readMetas(input.transcript_path) : {});
    if (out) console.log(JSON.stringify(out));
  } catch {
    // Nothing to say.
  }
}
