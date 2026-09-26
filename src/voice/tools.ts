/** What the voice agent can do: a shell with the `agentbox` CLI on it (the
 *  same powers the Project session has), background watches whose output
 *  comes back to it as news, and handing real work to the Project session.
 *
 * The voice agent is the fast half of a pair. It answers in a sentence what a
 * command or two can tell it, and anything that needs thought, code or
 * digging goes to Project — an ordinary agent session — whose answer comes
 * back through `ProjectRelay` to be spoken.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { attentionOf } from "../core/attention";
import type { Fleet } from "../core/fleet";
import { ensureProject, projectState } from "../core/project";
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
  {
    name: "ask_project",
    description:
      "Hand a task or question to Project, the agent session that manages every session and can do real work: research, code, start and steer sessions, check PRs. It works in the background and its answer is brought back to you to relay. Write the request fully, with the context the user gave; Project did not hear the conversation.",
    input_schema: {
      type: "object",
      properties: { request: { type: "string" } },
      required: ["request"],
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
    private relay: ProjectRelay,
    readonly watches: Watches,
  ) {}

  private live(): Session[] {
    const project = projectState().sessionId;
    return this.fleet.sessions().filter((s) => s.id !== project && s.status !== "closed");
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
      case "ask_project":
        return this.relay.ask(String(input.request ?? ""));
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
    const pending = this.relay.pending();
    if (pending) out.push(`Project is working on: ${clip(pending, 160)}`);
    out.push(...this.watches.list());
    return out.join("\n") || "nothing active";
  }
}

/**
 * Hands requests to the Project session and brings its answers back.
 *
 * A request is typed into Project with a note that the answer will be read
 * aloud. When Project has been working and comes back to rest — its turn over —
 * everything it said since the request is its answer. One request at a time is
 * tracked; a second one while the first is out simply joins it, since Project
 * reads them in order anyway.
 */
export class ProjectRelay {
  private out: { request: string; since: number; sawWork: boolean } | null = null;

  constructor(
    private fleet: Fleet,
    private onAnswer: (answer: string, request: string) => void,
  ) {
    fleet.on("sessions", () => void this.check());
    fleet.on("transcript", (id: string) => {
      if (id === projectState().sessionId) void this.check();
    });
  }

  pending(): string | null {
    return this.out?.request ?? null;
  }

  async ask(request: string): Promise<string> {
    const s = await ensureProject(this.fleet);
    const note =
      "[From the voice assistant — the user is away from the screen and your reply will be read aloud to them. " +
      "Do the work as usual; then end with a short plain-speech answer first (one to three sentences, no tables or code), details after.]";
    await this.fleet.send(s.id, `${note}\n\n${request}`);
    const since = this.out ? this.out.since : Date.now();
    this.out = { request: this.out ? `${this.out.request}; ${request}` : request, since, sawWork: false };
    return "Sent to Project. It is working on it; its answer will come back to you when it is done.";
  }

  private checking = false;
  private async check(): Promise<void> {
    const out = this.out;
    const id = projectState().sessionId;
    if (!out || !id || this.checking) return;
    let s: Session;
    try {
      s = this.fleet.get(id);
    } catch {
      return;
    }
    if (s.status === "running" || s.status === "blocked") {
      out.sawWork = true;
      return;
    }
    // Not working. Only an answer if it worked since the request (or the
    // request is old enough that we missed the running tick).
    if (!out.sawWork && Date.now() - out.since < 15_000) return;
    this.checking = true;
    try {
      const page = await this.fleet.timeline(id, null, 80);
      const said = page.events.filter((e) => e.kind === "assistant" && e.at >= out.since - 2_000).map((e) => (e as { text: string }).text);
      if (!said.length) return;
      this.out = null;
      this.onAnswer(said.join("\n\n"), out.request);
    } finally {
      this.checking = false;
    }
  }
}
