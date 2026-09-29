/** Deepgram, both ways: Flux to hear, Aura to speak.
 *
 * Settings from agentbox's own practice calls, which measured them: 24 kHz
 * linear16 end to end so nothing is resampled, and Flux turn-taking at
 * `eot_threshold` 0.7 — 0.6 answered sooner but cut people off mid-sentence.
 * The LLM is not Deepgram's here (see conversation.ts), so hearing and
 * speaking are two sockets rather than their Voice Agent.
 */

export const SAMPLE_RATE = 24_000;
/** Flux asks for 80 ms chunks; the browser sends 20 ms frames. */
const FLUX_CHUNK_BYTES = (SAMPLE_RATE * 2 * 80) / 1000;

/** The bias list every connection gets, before the personal ones: the box's
 *  name and the words a fleet conversation is likely to say. */
const BASE_KEYTERMS = ["agentbox", "Claude", "Codex", "Devin", "PR", "merge"];

export type TurnEvent = {
  event: "StartOfTurn" | "Update" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
  transcript: string;
};

/** Flux: a live transcript, cut into turns. Reconnects on its own while wanted. */
export class Listener {
  private ws: WebSocket | null = null;
  private ready = false;
  private chunk = new Uint8Array(FLUX_CHUNK_BYTES);
  private filled = 0;
  private queued: Uint8Array[] = [];
  private wanted = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private key: string,
    /** Words it should expect to hear: the user's name and the repos in play,
     *  passed in per connection rather than known here. */
    private keyterms: string[],
    private onTurn: (e: TurnEvent) => void,
    private onTrouble: (why: string) => void,
  ) {}

  start(): void {
    this.wanted = true;
    if (!this.ws) this.connect();
  }

  /** Stop hearing (mute): the socket closes, so a muted phone costs nothing. */
  stop(): void {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close();
    this.ws = null;
    this.ready = false;
    this.filled = 0;
    this.queued = [];
  }

  /** user.env changed: the next connect biases toward the new names. */
  retune(keyterms: string[]): void {
    this.keyterms = keyterms;
  }

  private connect(): void {
    const q = new URLSearchParams({
      model: "flux-general-en",
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      eot_threshold: "0.7",
      eot_timeout_ms: "5000",
    });
    for (const k of [...BASE_KEYTERMS, ...this.keyterms]) q.append("keyterm", k);
    const ws = new WebSocket(`wss://api.deepgram.com/v2/listen?${q}`, {
      headers: { Authorization: `Token ${this.key}` },
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onmessage = (m) => {
      if (typeof m.data !== "string") return;
      let msg: { type?: string; event?: string; transcript?: string; description?: string };
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.type === "Connected") {
        this.ready = true;
        for (const c of this.queued) ws.send(c);
        this.queued = [];
      } else if (msg.type === "TurnInfo" && msg.event) {
        this.onTurn({ event: msg.event as TurnEvent["event"], transcript: msg.transcript ?? "" });
      } else if (msg.type === "Error") {
        this.onTrouble(`speech recognition: ${msg.description ?? "error"}`);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      if (!this.wanted) return;
      if (e.code !== 1000) this.onTrouble(`speech recognition dropped (${e.code}${e.reason ? `: ${e.reason}` : ""}); reconnecting`);
      this.retry = setTimeout(() => this.wanted && this.connect(), 500);
    };
  }

  /** PCM16 mono at SAMPLE_RATE, any length. */
  push(pcm: Uint8Array): void {
    if (!this.wanted) return;
    let off = 0;
    while (off < pcm.length) {
      const n = Math.min(pcm.length - off, FLUX_CHUNK_BYTES - this.filled);
      this.chunk.set(pcm.subarray(off, off + n), this.filled);
      this.filled += n;
      off += n;
      if (this.filled === FLUX_CHUNK_BYTES) {
        const c = this.chunk;
        this.chunk = new Uint8Array(FLUX_CHUNK_BYTES);
        this.filled = 0;
        if (this.ready && this.ws) this.ws.send(c);
        // Two seconds of backlog while connecting; older than that is stale.
        else if (this.queued.push(c) > 25) this.queued.shift();
      }
    }
  }
}

/**
 * Aura over a socket: text in, PCM out as it is made. `speak` queues text;
 * `flush` makes it start — Deepgram allows 20 flushes a minute, so a reply
 * flushes after its first sentence (to start talking early) and at its end.
 * `cut` throws away whatever it has not said yet by dropping the socket.
 */
export class Speaker {
  private ws: WebSocket | null = null;
  private ready = false;
  private queued: string[] = [];
  private outstanding = 0;

  constructor(
    private key: string,
    private voice: string,
    /** Aura's speaking-rate multiplier (0.7–1.5); null leaves Deepgram's 1.0. */
    private speed: number | null,
    private onAudio: (pcm: Uint8Array) => void,
    private onDone: () => void,
    private onTrouble: (why: string) => void,
  ) {}

  private send(msg: object): void {
    const s = JSON.stringify(msg);
    if (this.ready && this.ws) this.ws.send(s);
    else {
      this.queued.push(s);
      if (!this.ws) this.connect();
    }
  }

  private connect(): void {
    const q = new URLSearchParams({ model: this.voice, encoding: "linear16", sample_rate: String(SAMPLE_RATE) });
    if (this.speed !== null) q.set("speed", String(this.speed));
    const ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${q}`, {
      headers: { Authorization: `Token ${this.key}` },
    } as unknown as string[]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.ready = true;
      for (const m of this.queued) ws.send(m);
      this.queued = [];
    };
    ws.onmessage = (m) => {
      if (this.ws !== ws) return;
      if (typeof m.data !== "string") {
        this.onAudio(new Uint8Array(m.data as ArrayBuffer));
        return;
      }
      try {
        const msg = JSON.parse(m.data) as { type?: string; description?: string };
        if (msg.type === "Flushed") {
          this.outstanding = Math.max(0, this.outstanding - 1);
          if (this.outstanding === 0) this.onDone();
        } else if (msg.type === "Error" || msg.type === "Warning") {
          this.onTrouble(`speech: ${msg.description ?? msg.type}`);
        }
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      if (this.outstanding > 0) {
        this.outstanding = 0;
        this.onDone();
      }
    };
  }

  speak(text: string): void {
    if (text.trim()) this.send({ type: "Speak", text });
  }

  flush(): void {
    this.outstanding++;
    this.send({ type: "Flush" });
  }

  /** A different Aura voice or speed from the next thing it says. */
  setVoice(voice: string, speed: number | null): void {
    if (voice === this.voice && speed === this.speed) return;
    this.voice = voice;
    this.speed = speed;
    this.cut();
  }

  get busy(): boolean {
    return this.outstanding > 0;
  }

  cut(): void {
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.queued = [];
    this.outstanding = 0;
    ws?.close();
  }

  close(): void {
    this.cut();
  }
}
