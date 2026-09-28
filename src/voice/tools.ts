/** What the voice agent can do: a shell with the `agentbox` CLI on it, and
 *  background watches whose output comes back to it as news.
 *
 * The voice agent answers in a sentence what a command or two can tell it.
 * Anything bigger it starts as its own detached session (`agentbox claude
 * --detach`) and watches for the answer.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { attentionOf } from "../core/attention";
import type { Fleet } from "../core/fleet";
import type { Session } from "../core/types";
import { runShell, type Watches } from "./shell";

export const TOOLS: Anthropic.ToolUnion[] = [
  {
    name: "stay_silent",
    description:
      "Say nothing this turn. Use it whenever what was heard is not addressed to you: the user talking to someone else, to themselves, background talk, a TV, half a sentence, noise. Also when nothing needs a reply, like news not worth interrupting him for.",
    input_schema: {
      type: "object",
      properties: { why: { type: "string", description: "A few words, for the log." } },
      required: ["why"],
      additionalProperties: false,
    },
  },
  // Anthropic-defined: the model knows it. Each call is a fresh shell (see shell.ts).
  { type: "bash_20250124", name: "bash" },
  {
    name: "watch",
    description:
      "Run a shell command in the background. Every line it prints comes back to you as a message, `[watch <name>] <line>`, and so does its end; you then decide whether to tell him. For following things: `agentbox watch <id> --once` (tell me when it finishes), `gh run watch <run> > /dev/null; echo CI done`, reminders (`sleep 1200; echo 'remind: take the bread out'`). Print only lines worth hearing: filter with grep. It keeps running when he hangs up.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name to refer to it by, like ci-6921 or bread." },
        command: { type: "string" },
      },
      required: ["name", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "unwatch",
    description: "Stop a watch by name.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export const titleOf = (s: Session): string =>
  s.label?.trim() || s.title?.trim() || s.firstPrompt?.split("\n")[0]?.slice(0, 80) || "untitled";

/** How long a single bash call may take before it is killed. */
const BASH_TIMEOUT_MS = 90_000;

export class VoiceTools {
  constructor(
    private fleet: Fleet,
    readonly watches: Watches,
  ) {}

  private live(): Session[] {
    return this.fleet.sessions().filter((s) => s.status !== "closed");
  }

  /** The tool's output, or a thrown error for `is_error`. */
  async run(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "bash": {
        if (input.restart) return "Each command already runs in a fresh shell; nothing to restart.";
        // The exit code is in the text; a grep that matched nothing is not an error.
        return (await runShell(String(input.command ?? ""), BASH_TIMEOUT_MS)).text;
      }
      case "watch":
        return this.watches.start(String(input.name ?? ""), String(input.command ?? ""));
      case "unwatch":
        return this.watches.stop(String(input.name ?? ""));
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  /** The board in brief, sent along with each turn when it has changed, so
   *  "what needs me?" costs no tool call: blocked and finished sessions with a
   *  line each, running ones by title, and what is being watched. */
  glance(): string {
    const all = this.live().filter((s) => s.status !== "stopped");
    const by = (st: Session["status"]) => all.filter((s) => s.status === st).sort((a, b) => b.lastPromptAt - a.lastPromptAt);
    const blocked = by("blocked");
    const waiting = by("waiting").slice(0, 12);
    const running = by("running");
    const out: string[] = [];
    for (const s of blocked) out.push(`needs an answer: ${s.id} "${clip(titleOf(s), 60)}" — ${attentionOf(s, this.fleet.blockedReason(s.id)).reason}`);
    for (const s of waiting) out.push(`your turn: ${s.id} "${clip(titleOf(s), 60)}" — ${clip(s.lastMessage, 140)}`);
    if (running.length) out.push(`running: ${running.map((s) => `${s.id} "${clip(titleOf(s), 40)}"`).join(", ")}`);
    out.push(...this.watches.list());
    return out.join("\n") || "nothing active";
  }
}
