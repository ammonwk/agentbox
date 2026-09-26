/** The phone's end of voice mode: the mic in, the agent's voice out.
 *
 * After widget-platform's practice call (utils/practiceCallAudio.ts): one
 * AudioContext at 24 kHz for both, so nothing is resampled, created inside the
 * tap that starts it (Safari only lets a context start from a gesture), and a
 * mic with echo cancellation — without it the agent hears itself and answers.
 */

export const SAMPLE_RATE = 24_000;
const PLAYBACK_LEAD_SECONDS = 0.06;
const DUCKED = 0.22;

export function createVoiceContext(): AudioContext {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("This browser cannot record or play audio.");
  return new Ctor({ sampleRate: SAMPLE_RATE });
}

export interface Mic {
  stop(): void;
}

/** Frames of PCM16 at 24 kHz, 20 ms each, plus a 0–1 level for the meter. */
export async function startMic(ctx: AudioContext, onFrame: (pcm: ArrayBuffer, level: number) => void): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(window.isSecureContext ? "This browser has no microphone access." : "The microphone needs HTTPS — open the https:// address.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  await ctx.audioWorklet.addModule("/pcm-capture-worklet.js");
  const node = new AudioWorkletNode(ctx, "pcm-capture");
  const source = ctx.createMediaStreamSource(stream);
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const s = new Int16Array(e.data);
    let sum = 0;
    for (let i = 0; i < s.length; i += 4) sum += s[i]! * s[i]!;
    onFrame(e.data, Math.min(1, Math.sqrt(sum / (s.length / 4)) / 6000));
  };
  source.connect(node);
  // A worklet with nothing downstream is not pulled in every browser; zero
  // gain keeps it running without playing you back to yourself.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  node.connect(sink).connect(ctx.destination);
  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/** Queues the agent's PCM gaplessly; `flush` drops the rest (it moved on),
 *  `duck` lowers it while you talk over it. */
export class VoicePlayer {
  private cursor = 0;
  private live = new Set<AudioBufferSourceNode>();
  private out: GainNode;
  private analyser: AnalyserNode;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private ctx: AudioContext,
    private onDrained: () => void,
  ) {
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.out.connect(this.analyser).connect(ctx.destination);
  }

  push(pcm: ArrayBuffer): void {
    const samples = new Int16Array(pcm);
    if (samples.length === 0) return;
    const buffer = this.ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i]! / 32768;
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.out);
    const floor = this.ctx.currentTime + PLAYBACK_LEAD_SECONDS;
    if (this.cursor < floor) this.cursor = floor;
    node.start(this.cursor);
    this.cursor += buffer.duration;
    this.live.add(node);
    node.onended = () => this.live.delete(node);
    this.watchDrain();
  }

  private watchDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.pendingSeconds() > 0.05) return;
      clearInterval(this.drainTimer!);
      this.drainTimer = null;
      this.onDrained();
    }, 150);
  }

  flush(): void {
    for (const n of this.live) {
      try {
        n.stop();
      } catch {
        /* already done */
      }
    }
    this.live.clear();
    this.cursor = 0;
  }

  duck(on: boolean): void {
    this.out.gain.setTargetAtTime(on ? DUCKED : 1, this.ctx.currentTime, 0.05);
  }

  pendingSeconds(): number {
    return Math.max(0, this.cursor - this.ctx.currentTime);
  }

  /** 0–1, how loud it is saying something right now. */
  level(): number {
    const d = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(d);
    let sum = 0;
    for (const v of d) sum += (v - 128) * (v - 128);
    return Math.min(1, Math.sqrt(sum / d.length) / 40);
  }
}
