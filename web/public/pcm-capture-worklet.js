// Microphone → PCM16 frames for voice mode. From widget-platform's practice
// call (apps/web/public/pcm-capture-worklet.js): it lives in public/ because a
// bundled small file becomes a data: URL, which WebKit will not load as a
// worklet. 20 ms frames rather than one message per 128-sample render quantum.
const FRAME_SAMPLES = 480; // 20 ms at 24 kHz

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.filled += 1;
      if (this.filled === FRAME_SAMPLES) {
        const frame = this.buffer;
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.buffer = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
