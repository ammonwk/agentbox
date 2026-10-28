/** One recording, including a permission request that may outlive its gesture. */
export function recordVoice({ onStart, onDone, onError }: {
  onStart: () => void;
  onDone: (audio: Blob) => void;
  onError: (why: string) => void;
}): { stop: (keep: boolean) => void } {
  let ended = false;
  let keep = false;
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  const release = () => stream?.getTracks().forEach((track) => track.stop());
  const stop = (save: boolean) => {
    if (ended) return;
    ended = true;
    keep = save;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    release();
  };
  const fail = (why: string) => {
    if (ended) return;
    stop(false);
    onError(why);
  };
  void (async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error(window.isSecureContext ? "this browser cannot record" : "the microphone needs HTTPS — open the https:// address");
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (ended) { release(); return; }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((mime) => MediaRecorder.isTypeSupported(mime));
      const rec = recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      let bytes = 0;
      rec.ondataavailable = (e) => {
        if (!e.data.size || (ended && !keep)) return;
        bytes += e.data.size;
        if (bytes > 40 * 1024 * 1024) {
          keep = false;
          if (!ended) stop(false);
          onError("the recording is too long to send");
        } else chunks.push(e.data);
      };
      rec.onstop = () => {
        release();
        if (!keep) return;
        const audio = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
        if (audio.size) onDone(audio);
        else onError("nothing was recorded");
      };
      rec.onerror = () => fail("the recording failed");
      rec.start(1000);
      onStart();
    } catch (error) {
      const err = error as Error;
      fail(err.name === "NotAllowedError" ? "the microphone is blocked for this page — allow it in the browser's site settings" : `no microphone: ${err.message}`);
    }
  })();
  return { stop };
}
