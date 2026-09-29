/** The server's side of voice mode: conversations by id (a phone that drops
 *  its connection comes back to the same one), the watches the voice agent
 *  started, and news from the board. */

import { attentionOf } from "../core/attention";
import { ChangeWatcher, changeLine } from "../core/changes";
import type { Fleet } from "../core/fleet";
import { listRepos } from "../core/db";
import { readUserIdentity } from "../core/user";
import { voiceConfig } from "./config";
import { Conversation, type VoiceClientMessage, type VoiceSink } from "./conversation";
import { Watches } from "./shell";
import { VoiceTools } from "./tools";

/** A conversation nobody has come back to in this long is over. */
const KEEP_MS = 30 * 60_000;
/** Board changes are gathered this long and told as one. */
const NEWS_MS = 20_000;

export class VoiceHub {
  private convs = new Map<string, Conversation>();
  private tools: VoiceTools;
  /** Watch output that came with no conversation to tell. */
  private unheard: string[] = [];
  private changes = new ChangeWatcher();
  private news: string[] = [];
  private newsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private fleet: Fleet) {
    this.tools = new VoiceTools(fleet, new Watches((text) => this.tell(text)));
    fleet.on("sessions", () => this.watch());
    setInterval(() => this.reap(), 60_000).unref?.();
  }

  /** To every conversation, or kept for the next one. */
  private tell(text: string): void {
    if (this.convs.size === 0) {
      this.unheard.push(text);
      if (this.unheard.length > 40) this.unheard.shift();
    }
    for (const c of this.convs.values()) c.inject(text);
  }

  /** Whether voice can run, and if not, what is missing. */
  status(): { ready: boolean; missing?: string } {
    const cfg = voiceConfig();
    return "missing" in cfg ? { ready: false, missing: cfg.missing } : { ready: true };
  }

  open(id: string, sink: VoiceSink): Conversation | string {
    const cfg = voiceConfig();
    if ("missing" in cfg) return `voice is not set up: missing ${cfg.missing}`;
    const identity = readUserIdentity();
    const repos = listRepos().map((r) => r.displayName);
    let c = this.convs.get(id);
    if (c) c.retune(cfg, identity, repos);
    else {
      c = new Conversation(id, cfg, this.tools, identity, repos);
      this.convs.set(id, c);
      for (const t of this.unheard.splice(0)) c.inject(t);
    }
    c.attach(sink);
    return c;
  }

  message(c: Conversation, raw: string): void {
    let msg: VoiceClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    c.control(msg);
  }

  private reap(): void {
    for (const [id, c] of this.convs) {
      if (c.detachedAt && Date.now() - c.detachedAt > KEEP_MS) {
        c.close();
        this.convs.delete(id);
      }
    }
  }

  /** Sessions that just finished their turn or started asking something:
   *  the same changes `agentbox watch` prints, gathered and told as one. */
  private watch(): void {
    const rows = this.fleet
      .sessions()
      .map((s) => ({ ...s, reason: attentionOf(s, this.fleet.blockedReason(s.id)).reason }));
    for (const c of this.changes.next(rows)) if (c.kind === "blocked" || c.kind === "waiting") this.news.push(changeLine(c));
    if (this.news.length && !this.newsTimer) {
      this.newsTimer = setTimeout(() => {
        this.newsTimer = null;
        const items = this.news.splice(0);
        const listeners = [...this.convs.values()].filter((c) => c.updates && !c.detachedAt);
        if (!items.length || !listeners.length) return;
        const text =
          "Board news (id, what happened, title, then what it is asking or the end of its last message). " +
          "Speak up, in a sentence or two, when a session is asking them something they would want to answer or has finished something they are waiting on: " +
          "say what it is asking in plain words and offer to pass on their answer. Stay silent for routine progress.\n" +
          items.slice(0, 12).join("\n");
        for (const c of listeners) c.inject(text);
      }, NEWS_MS);
    }
  }
}
