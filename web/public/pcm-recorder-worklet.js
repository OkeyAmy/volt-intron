/**
 * PCM capture worklet.
 *
 * MediaRecorder produces compressed WebM/Opus, which the Intron socket cannot
 * accept -- it wants raw PCM16. So capture runs through the Web Audio graph and
 * this worklet resamples the live microphone stream to 16 kHz mono PCM16 and posts
 * frames to the main thread.
 *
 * The resampler carries its fractional read position and the previous frame's last
 * sample across process() calls, so there is no discontinuity at the 128-sample
 * block boundaries the browser delivers.
 */
class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    // `sampleRate` is the AudioWorkletGlobalScope's context rate (e.g. 48000).
    this.ratio = sampleRate / this.targetRate;
    this.readPos = 0;      // fractional position within the current input frame
    this.prev = 0;         // last sample of the previous frame, for interpolation
    this.cap = 2048;       // Int16 samples per posted frame (4096 bytes)
    this.buf = new Int16Array(this.cap);
    this.bufLen = 0;
    this.levelCountdown = 0;
  }

  flush() {
    if (this.bufLen === 0) return;
    const out = this.buf.slice(0, this.bufLen);
    this.port.postMessage({ type: "audio", buffer: out.buffer }, [out.buffer]);
    this.bufLen = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const n = ch.length;
    const ratio = this.ratio;

    const sampleAt = (k) => (k < 0 ? this.prev : k >= n ? ch[n - 1] : ch[k]);

    let peak = 0;
    let pos = this.readPos;
    while (pos <= n - 1) {
      const k0 = Math.floor(pos);
      const f = pos - k0;
      const s = sampleAt(k0) * (1 - f) + sampleAt(k0 + 1) * f;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      let v = Math.round(s * 32767);
      v = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      this.buf[this.bufLen++] = v;
      if (this.bufLen >= this.cap) this.flush();
      pos += ratio;
    }
    this.readPos = pos - n;    // carry the leftover into the next frame
    this.prev = ch[n - 1];

    // Post a level roughly every ~50ms so the meter animates without flooding.
    this.levelCountdown -= n;
    if (this.levelCountdown <= 0) {
      this.levelCountdown = (sampleRate * 0.05) | 0;
      this.port.postMessage({ type: "level", value: peak });
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
