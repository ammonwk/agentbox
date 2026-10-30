/**
 * A conversation of an extension's own that runs for months, as a line of
 * sessions (docs/extensions.md). What the extension says goes to the session
 * it has now; a fresh one takes over when that one is closed, stopped at a
 * usage limit, holds more than `freshOver` tokens of context, or runs on a
 * fallback while its own provider has room again. A fresh one is told the
 * instructions, the handoff its predecessor wrote, and whom it follows; what
 * the predecessor held (its sessions, cards, PRs) goes to it, and the
 * predecessor is closed. It is pinned on the board, so it is not parked the
 * moment its turn ends.
 *
 * From TypeScript, `conversation(opts)`. From any other language, the same
 * as a command, configured by the `conversation` field of the extension's
 * own extension.json (agentbox reads only `title`, `description` and `run`):
 *
 *   "conversation": {
 *     "start": { "provider": "claude", "cwd": ".", "fallbacks": ["codex"] },   a POST /api/sessions body; cwd is from the directory
 *     "instructions": "MAIN.md",                                             told to each fresh one first
 *     "freshOver": 150000,
 *     "state": "~/somewhere/conversation.json"                               default: its home's conversation.json
 *   }
 *
 *   bun <agentbox>/sdk/conversation.ts say [--note] < text   say it; --note: skipped while it is mid-turn or showing a prompt
 *   bun <agentbox>/sdk/conversation.ts tick                  each minute or so: asks for a handoff while that is cheap
 *   bun <agentbox>/sdk/conversation.ts show                  {main, previous}: the session it is now, and the ones before
 *
 * The state file is `{main, previous}`, for the extension's own code to read.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Session } from "../src/core/types";
import { agentbox, me, type Start } from "./extension";

/** Mid-turn, or showing a prompt it needs answered. */
const atWork = (s: Session | null): boolean => !!s && (s.status === "running" || s.status === "blocked");
const HANDOFF_ASK = "[agentbox: you have been idle and your prompt cache goes cold in a few minutes,";
/** A conversation this close to going cold is asked for its handoff. */
const HANDOFF_LEAD_MS = 5 * 60_000;

export type Options = {
  start: Start;
  /** A file told to each fresh session first, read each time. */
  instructions?: string;
  freshOver?: number;
  /** Where it keeps `{main, previous}`; the handoff is beside it. */
  state?: string;
};

type State = { main: string | null; previous: string[] };

export function conversation(opts: Options) {
  const file = opts.state ?? join(me.home, "conversation.json");
  const handoffFile = join(dirname(file), "handoff.md");
  const freshOver = opts.freshOver ?? 150_000;
  const read = (): State => {
    try {
      return { main: null, previous: [], ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      return { main: null, previous: [] };
    }
  };
  const write = (s: State) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s, null, 2));
  };
  /** The session it is now, following handovers made elsewhere. */
  const current = async (st: State): Promise<Session | null> => {
    let s = st.main ? await agentbox.session(st.main) : null;
    for (let n = 0; s?.successor && n < 20; n++) {
      st.previous = [s.id, ...st.previous.filter((x) => x !== s!.id)].slice(0, 200);
      st.main = s.successor;
      s = await agentbox.session(s.successor);
      write(st);
    }
    return s;
  };
  /** Why the next message leaves `s` for a fresh session, or null. */
  const why = async (s: Session): Promise<string | null> => {
    if (s.status === "closed") return "it was closed";
    if (s.limitHit) return "it stopped at a usage limit";
    if ((s.contextUsed ?? 0) > freshOver) return `it held ${Math.round(s.contextUsed! / 1000)}k tokens of context, over the ${Math.round(freshOver / 1000)}k it is kept to`;
    const own = opts.start.provider;
    if (s.provider !== own && (await agentbox.hasRoom(own, opts.start.model))) return `it ran on ${s.provider} while ${own} had no room, and ${own} has room again`;
    return null;
  };
  /** Typed into it, or resumed with it when it is not running. */
  const send = (s: Session, text: string) => (s.host === "none" ? agentbox.resume(s.id, text) : agentbox.say(s.id, text));
  let starting = false;
  return {
    /** The session it is now, and the ones before, newest first. */
    show: read,
    /**
     * Say `text` to it. `note`: something the extension noticed, skipped while
     * it is mid-turn or showing a prompt (the next note says what is still true).
     */
    async say(text: string, o: { note?: boolean } = {}): Promise<{ session: string; started: boolean } | { quiet: string }> {
      const st = read();
      const last = await current(st);
      const busy = atWork(last);
      if (busy && o.note) return { quiet: "it is mid-turn or showing a prompt" };
      // A busy one is never replaced: it is told, and replaced at the next message once it is idle.
      const over = !last ? "none yet" : busy ? null : await why(last);
      if (last && !over) {
        await send(last, text);
        return { session: last.id, started: false };
      }
      if (starting) return { quiet: "a fresh one is being started this moment" };
      starting = true;
      try {
        let handoff = "";
        try {
          if (last && statSync(handoffFile).mtimeMs >= last.startedAt) handoff = readFileSync(handoffFile, "utf8").trim().slice(0, 8_000);
        } catch {
          // None written.
        }
        const follows = last
          ? `[you take over from ${last.id}, this conversation until now (${over}).${handoff ? ` It left you this handoff:\n\n${handoff}\n\n` : " "}What it did is in \`agentbox log ${last.id} | tail -60\`; it will not be spoken to again.]\n\n`
          : "";
        const instructions = opts.instructions ? `${readFileSync(opts.instructions, "utf8").trim()}\n\n---\n\n` : "";
        const s = await agentbox.start({ ...opts.start, prompt: `${instructions}${follows}[via agentbox ext ${me.name}] ${text}` });
        await agentbox.pin(s.id);
        write({ main: s.id, previous: last ? [last.id, ...st.previous.filter((x) => x !== last.id)].slice(0, 200) : st.previous });
        if (last) {
          await agentbox.pin(last.id, null);
          // It is idle (a busy one is not replaced), so closing it cuts nothing short.
          await agentbox.handover(last.id, s.id, last.status !== "closed");
        }
        return { session: s.id, started: true };
      } finally {
        starting = false;
      }
    },
    /** Asks an idle, large one about to go cold for the handoff its successor will be told, while that costs a short turn and not a re-read. */
    async tick(now = Date.now()): Promise<void> {
      const s = await current(read());
      if (!s || s.status !== "waiting" || s.host !== "tmux" || s.lastPrompt?.includes(HANDOFF_ASK)) return;
      if (s.cacheWarmUntil < now || s.cacheWarmUntil - now > HANDOFF_LEAD_MS || (s.contextUsed ?? 0) < freshOver / 2) return;
      await send(
        s,
        `${HANDOFF_ASK} and your conversation is large, so the next message may start a fresh session in your place. Write what it needs to carry on to ${handoffFile}, replacing what is there, in at most 500 words: what you are in the middle of, what you decided and why, what you are waiting on, and who asked for what. Then end your turn without a reply.]`,
      );
    },
  };
}

/** The extension's own extension.json's `conversation`, with its paths made absolute. */
function fromManifest(): Options {
  const home = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
  const c = (JSON.parse(readFileSync(join(me.dir, "extension.json"), "utf8")) as { conversation?: Options }).conversation;
  if (!c?.start) throw new Error(`${join(me.dir, "extension.json")} has no conversation.start`);
  return {
    ...c,
    start: { ...c.start, cwd: resolve(me.dir, home(c.start.cwd ?? ".")) },
    instructions: c.instructions && resolve(me.dir, home(c.instructions)),
    state: c.state && resolve(me.dir, home(c.state)),
  };
}

if (import.meta.main) {
  const [verb, ...flags] = process.argv.slice(2);
  const conv = conversation(fromManifest());
  if (verb === "say") {
    const text = (await Bun.stdin.text()).trim();
    if (!text) throw new Error("say reads what to say from stdin");
    const out = await conv.say(text, { note: flags.includes("--note") });
    console.log("quiet" in out ? `quiet: ${out.quiet}` : `${out.session} ${out.started ? "started" : "told"}`);
  } else if (verb === "tick") await conv.tick();
  else if (verb === "show") console.log(JSON.stringify(conv.show()));
  else throw new Error("conversation.ts takes say [--note], tick or show");
}
