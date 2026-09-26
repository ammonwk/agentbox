/** One hands-free conversation: what the phone hears, what the model makes of
 *  it, what the phone says back.
 *
 * Every finished utterance goes to the model with the tools in tools.ts, one
 * of which is `stay_silent` — the mic is always open, and most of what it hears
 * (other people, the TV, you thinking aloud) is not for it. Replies stream
 * into speech a sentence at a time, so it starts talking while it is still
 * writing.
 *
 * Talking over it only lowers its volume. It stops for you once the model has
 * decided what you said was meant for it; otherwise every passing voice would
 * cut it off mid-sentence.
 *
 * The conversation outlives its socket for a while (phones drop connections),
 * and keeps what arrives meanwhile — a Project answer — for when you are back.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { VoiceConfig } from "./config";
import { Listener, Speaker, type TurnEvent } from "./deepgram";
import { CLI_GUIDE } from "../core/project";
import { TOOLS, type VoiceTools } from "./tools";

export type VoiceState = "connecting" | "listening" | "thinking" | "speaking";

export type VoiceServerMessage =
  | { type: "state"; state: VoiceState; muted: boolean }
  | { type: "heard"; text: string; final: boolean }
  | { type: "said"; text: string }
  | { type: "note"; text: string }
  | { type: "duck"; on: boolean }
  | { type: "flush" }
  | { type: "error"; message: string };

export type VoiceClientMessage =
  | { type: "mute"; on: boolean }
  | { type: "say"; text: string }
  | { type: "played" }
  | { type: "updates"; on: boolean };

export interface VoiceSink {
  json(msg: VoiceServerMessage): void;
  audio(pcm: Uint8Array): void;
}

const SYSTEM = `You are the voice of agentbox, talking with Dev through his phone, hands-free. agentbox runs his coding-agent sessions (Claude Code, Codex and others) on his machine. You are how he keeps up with them and steers them while he is away from the screen: walking, hiking, driving, cooking, doing the dishes.

The microphone is always open, so you hear everything near him, not only what is meant for you: him talking to other people, to himself, on the phone, a podcast or the TV, half-sentences, noise. Most of it is not for you. Reply only when he is talking to you: he addresses you, asks about his sessions or his work, gives you something to do, or carries on a conversation you are in. For everything else call stay_silent and say nothing. When in doubt, stay silent: interrupting his life is worse than missing a line, and he will repeat himself if he wanted you. Something that is clearly out of context, like a remark about the dishes or a line from a show, is never for you.

Everything you write is spoken aloud. Write the way people talk: plain sentences, no markdown, no lists, no code, no links. Say a session's title in a few words, not its id. Keep it short: two or three short sentences at most. When there are several things, give the count and the one or two that matter most, then offer the rest. Never read out a whole list. If he asks you to stop, stop. Say "okay" and nothing else.

What you can do:

- bash runs a command on his machine and gives you its output. The agentbox CLI (below) is on its PATH: use it for anything about his sessions, like what one said (agentbox show, agentbox log | tail), what is waiting, or typing his answer into one (agentbox send). Each call is a fresh shell in the Project's directory, and is killed after 90 seconds. The board in brief comes with his messages whenever it has changed, so for "what needs me?" you usually know already.
- watch runs a command in the background, and every line it prints comes back to you as a message starting [watch name]. Use it when he asks to be told about something: "tell me when the payments session finishes" is agentbox watch <id> --once, a CI run is gh run watch, a reminder is sleep then echo. A watch keeps running when he hangs up; unwatch stops it.
- ask_project hands real work to Project, a full agent session that manages every other session: investigating, writing code, anything that takes several steps or judgement. Write the request out fully with his context, because Project did not hear the conversation. Tell him in a few words that it is on it, and never claim to have done what you only handed off. When a message arrives saying Project finished, give him the gist in a sentence or two and offer the details. When he asks for Project by name, hand it to Project.

Before a call that takes a moment, say a few words first, like "Let me look."

Speaking up on your own: board news and watch lines arrive as bracketed system messages. Speak when it is something he would want to hear now: a session is asking him a question or needs a decision, something he asked you to watch happened, a session he was waiting on is done. Then say which session and what it is asking in plain words, and offer to pass on his answer. Routine progress, a session finishing something he did not ask about, noise: stay silent.

Be careful with what cannot be undone. The mic mishears, so before anything destructive or hard to reverse, like stopping a session, closing several, sending to a session that is mid-turn, approving a merge or a push, or deleting anything, say what you are about to do and wait for his yes. When he answers a session's question, send it in his words, tidied, and say you sent it. Do not type into sessions on your own initiative.

What you hear is a live transcript and can be mis-heard ("agent box" is agentbox). Read it charitably. Lines in square brackets are from the system, not from him.

# The agentbox CLI

${CLI_GUIDE}`;

/** Markdown and other things that read badly aloud. */
function speakable(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ");
}

/** What the Voice page shows while a tool runs. */
const NOTE: Record<string, (input: Record<string, unknown>) => string> = {
  bash: (i) => `$ ${String(i.command ?? "").slice(0, 200)}`,
  watch: (i) => `Watching (${String(i.name ?? "")}): ${String(i.command ?? "").slice(0, 160)}`,
  unwatch: (i) => `Stopped watching ${String(i.name ?? "")}`,
  ask_project: () => "Handing it to Project…",
};

const clock = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export class Conversation {
  private client: Anthropic;
  private history: Anthropic.MessageParam[] = [];
  /** User-side content for the next model turn: utterances and system lines. */
  private inbox: string[] = [];
  /** A `stay_silent` answered without a model turn; goes out with the next message. */
  private owed: Anthropic.ToolResultBlockParam[] = [];
  /** The board as the model last saw it. */
  private lastGlance = "";
  private generating = false;
  private abort: AbortController | null = null;
  private listener: Listener;
  private speaker: Speaker;
  private sink: VoiceSink | null = null;
  private muted = false;
  private state: VoiceState = "connecting";
  /** Played-out estimate: the phone says when its queue drains. */
  private playing = false;
  updates = true;
  detachedAt: number | null = null;

  constructor(
    readonly id: string,
    private cfg: VoiceConfig,
    private tools: VoiceTools,
  ) {
    this.client = new Anthropic({ apiKey: cfg.anthropicKey });
    this.listener = new Listener(cfg.deepgramKey, (e) => this.onTurn(e), (why) => this.note(why));
    this.speaker = new Speaker(
      cfg.deepgramKey,
      cfg.voice,
      cfg.speed,
      (pcm) => {
        this.playing = true;
        this.sink?.audio(pcm);
      },
      () => {
        if (!this.generating) this.setState("listening");
      },
      (why) => this.note(why),
    );
  }

  /** voice.env edited since this conversation began: take the new voice and model. */
  retune(cfg: VoiceConfig): void {
    this.cfg = cfg;
    this.speaker.setVoice(cfg.voice, cfg.speed);
  }

  attach(sink: VoiceSink): void {
    this.sink = sink;
    this.detachedAt = null;
    if (!this.muted) this.listener.start();
    this.setState(this.generating ? "thinking" : "listening");
    if (this.inbox.length && !this.generating) void this.run();
  }

  detach(): void {
    this.sink = null;
    this.detachedAt = Date.now();
    this.listener.stop();
    this.speaker.cut();
  }

  close(): void {
    this.detach();
    this.abort?.abort();
  }

  audio(pcm: Uint8Array): void {
    if (!this.muted) this.listener.push(pcm);
  }

  control(msg: VoiceClientMessage): void {
    if (msg.type === "mute") {
      this.muted = msg.on;
      if (msg.on) this.listener.stop();
      else this.listener.start();
      this.setState(this.state);
    } else if (msg.type === "say" && msg.text.trim()) {
      this.hear(msg.text.trim());
    } else if (msg.type === "played") {
      this.playing = false;
      this.sink?.json({ type: "duck", on: false });
      if (!this.generating && !this.speaker.busy) this.setState("listening");
    } else if (msg.type === "updates") {
      this.updates = msg.on;
    }
  }

  /** A line from the system — a Project answer, a board change — for the model to relay or not. */
  inject(text: string): void {
    this.inbox.push(`[${clock()}] ${text}`);
    if (this.sink && !this.generating) void this.run();
  }

  private onTurn(e: TurnEvent): void {
    switch (e.event) {
      case "StartOfTurn":
        if (this.playing || this.speaker.busy) this.sink?.json({ type: "duck", on: true });
        break;
      case "Update":
        if (e.transcript) this.sink?.json({ type: "heard", text: e.transcript, final: false });
        break;
      case "EndOfTurn":
        if (e.transcript.trim()) this.hear(e.transcript.trim());
        else this.sink?.json({ type: "duck", on: false });
        break;
    }
  }

  private hear(text: string): void {
    this.sink?.json({ type: "heard", text, final: true });
    this.inbox.push(`(${clock()}) ${text}`);
    if (!this.generating) void this.run();
  }

  private setState(s: VoiceState): void {
    this.state = s;
    this.sink?.json({ type: "state", state: s, muted: this.muted });
  }

  private note(text: string): void {
    this.sink?.json({ type: "note", text });
  }

  /** Model turns until the inbox is empty. One at a time; what arrives meanwhile waits its turn. */
  private async run(): Promise<void> {
    if (this.generating) return;
    this.generating = true;
    try {
      while (this.inbox.length && this.sink) {
        const glance = this.tools.glance();
        const board: Anthropic.TextBlockParam[] = glance === this.lastGlance ? [] : [{ type: "text", text: `[The board at ${clock()}]\n${glance}` }];
        this.lastGlance = glance;
        const content: Anthropic.ContentBlockParam[] = [...this.owed, ...board, ...this.inbox.map((t) => ({ type: "text" as const, text: t }))];
        this.owed = [];
        this.inbox = [];
        this.history.push({ role: "user", content });
        this.setState("thinking");
        await this.reply();
      }
    } catch (err) {
      const msg = err instanceof Anthropic.APIError ? `${err.status ?? ""} ${err.message}` : (err as Error).message;
      this.sink?.json({ type: "error", message: `The model call failed: ${msg}` });
      // The failed turn's user message stays; a dangling one would 400 the next call.
      this.history.push({ role: "assistant", content: "(no reply — the call failed)" });
    } finally {
      this.generating = false;
      this.abort = null;
      this.sink?.json({ type: "duck", on: false });
      if (!this.speaker.busy && !this.playing) this.setState("listening");
      this.trim();
    }
  }

  /** One reply, through however many tool calls it takes. */
  private async reply(): Promise<void> {
    for (let hop = 0; hop < 8; hop++) {
      this.abort = new AbortController();
      const stream = this.client.messages.stream(
        {
          model: this.cfg.model,
          max_tokens: 4096,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          tools: TOOLS,
          messages: this.history,
          output_config: { effort: "low" },
        } as Anthropic.MessageStreamParams,
        { signal: this.abort.signal },
      );

      let pending = "";
      let spoken = "";
      let flushed = 0;
      let unflushed = false;
      const emit = (final: boolean) => {
        // Speak whole sentences as they complete; the first flush starts audio.
        // Mid-stream a stop needs the space after it: "3." may yet be "3.5".
        for (;;) {
          const m = pending.match(final ? /^[\s\S]*?[.!?…](?=\s|$)|^[\s\S]*?\n/ : /^[\s\S]*?[.!?…](?=\s)|^[\s\S]*?\n/);
          const cut = m ? m[0].length : final ? pending.length : pending.length > 220 ? pending.lastIndexOf(" ", 200) + 1 : 0;
          if (cut <= 0) break;
          const sentence = speakable(pending.slice(0, cut));
          pending = pending.slice(cut);
          if (!sentence.trim()) continue;
          if (!spoken) {
            // It is answering: whatever it was still saying is stale.
            this.speaker.cut();
            this.sink?.json({ type: "flush" });
            this.sink?.json({ type: "duck", on: false });
            this.setState("speaking");
          }
          spoken += sentence;
          this.speaker.speak(sentence);
          unflushed = true;
          if (flushed === 0) {
            this.speaker.flush();
            flushed++;
            unflushed = false;
          }
          if (!pending) break;
        }
      };
      stream.on("text", (delta) => {
        pending += delta;
        emit(false);
      });
      const msg = await stream.finalMessage();
      emit(true);
      if (unflushed) this.speaker.flush();
      if (spoken.trim()) this.sink?.json({ type: "said", text: spoken.trim() });
      this.history.push({ role: "assistant", content: msg.content });

      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) return;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        if (u.name === "stay_silent") {
          results.push({ type: "tool_result", tool_use_id: u.id, content: "ok" });
          continue;
        }
        this.note(NOTE[u.name]?.(u.input as Record<string, unknown>) ?? `${u.name}…`);
        try {
          results.push({ type: "tool_result", tool_use_id: u.id, content: await this.tools.run(u.name, u.input as Record<string, unknown>) });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: u.id, content: (err as Error).message, is_error: true });
        }
      }
      if (uses.every((u) => u.name === "stay_silent")) {
        // Nothing to continue: the result rides along with whatever comes next.
        this.owed = results;
        return;
      }
      this.history.push({ role: "user", content: results });
      this.setState("thinking");
    }
  }

  /** A long day's conversation starts over, keeping the last stretch as text. */
  private trim(): void {
    if (this.history.length < 160) return;
    const recent = this.history
      .slice(-30)
      .flatMap((m) =>
        typeof m.content === "string"
          ? [`${m.role}: ${m.content}`]
          : m.content.flatMap((b) => (b.type === "text" ? [`${m.role}: ${b.text}`] : [])),
      )
      .join("\n");
    this.history = [];
    this.owed = [];
    this.lastGlance = "";
    this.inbox.unshift(`[The conversation so far was cut short to save room. The last part of it:]\n${recent}`);
  }
}
