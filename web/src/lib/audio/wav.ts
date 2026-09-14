/**
 * Minimal WAV read/write and resampling.
 *
 * Deliberately dependency-free: ffmpeg is not installed on the target machine, and
 * the benchmark must run identically everywhere. Scope is exactly what we need —
 * uncompressed PCM16, which is what both our recorder and Intron speak.
 */

export interface Pcm {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

/** WavError distinguishes a malformed/unsupported file from a programming bug. */
export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavError";
  }
}

const MAX_CHANNELS = 8;
const MAX_SAMPLE_RATE = 384_000;

export function decodeWav(buf: Buffer): Pcm {
  if (buf.length < 12) throw new WavError("file is too short to be a WAV");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new WavError("not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      if (size < 16 || body + 16 > buf.length) throw new WavError("fmt chunk is truncated");
      const audioFormat = buf.readUInt16LE(body);
      if (audioFormat !== 1) throw new WavError(`unsupported WAV format ${audioFormat}; need PCM (1)`);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (channels < 1 || channels > MAX_CHANNELS) {
        throw new WavError(`unsupported channel count ${channels}`);
      }
      if (sampleRate < 1 || sampleRate > MAX_SAMPLE_RATE) {
        throw new WavError(`unsupported sample rate ${sampleRate}`);
      }
      fmt = { channels, sampleRate, bits };
    } else if (id === "data") {
      if (!fmt) throw new WavError("data chunk before fmt chunk");
      if (fmt.bits !== 16) throw new WavError(`unsupported bit depth ${fmt.bits}; need 16`);
      // Never read past the buffer even if the declared size is wrong or hostile.
      const available = buf.length - body;
      const usable = Math.max(0, Math.min(size, available));
      const frameBytes = 2 * fmt.channels;
      // Truncate to a whole number of frames so channel de-interleaving stays aligned.
      const count = Math.floor(usable / frameBytes) * fmt.channels;
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new WavError("no data chunk found");
}

/** Average interleaved channels down to one. */
export function toMono(pcm: Pcm): Pcm {
  if (pcm.channels === 1) return pcm;
  const frames = Math.floor(pcm.samples.length / pcm.channels);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < pcm.channels; c++) sum += pcm.samples[f * pcm.channels + c];
    out[f] = Math.round(sum / pcm.channels);
  }
  return { samples: out, sampleRate: pcm.sampleRate, channels: 1 };
}

function clampInt16(v: number): number {
  const r = Math.round(v);
  return r < -32768 ? -32768 : r > 32767 ? 32767 : r;
}

/**
 * Resample mono PCM16 to `target` Hz.
 *
 * Two regimes, because one formula does not serve both:
 *  - Downsampling: average the source window that maps to each output sample. This
 *    is a box-filter low-pass -- it attenuates, but does not fully eliminate,
 *    aliasing; a polyphase/FIR resampler would do better and is the upgrade path if
 *    ASR quality ever warrants it.
 *  - Upsampling: linearly interpolate between neighbouring source samples. The
 *    previous version reused the downsampling window here, whose window was empty
 *    for every other output sample and so inserted zeros -- e.g. 8kHz->16kHz of a
 *    constant signal produced [0, x, 0, x, ...], a 6dB square-wave artefact.
 *
 * This is a stateless whole-buffer resampler for the file/benchmark path. Live
 * capture, which arrives in frames, needs a resampler that carries phase across
 * frames; that is intentionally not this function.
 */
export function resample(pcm: Pcm, target: number): Pcm {
  if (pcm.channels !== 1) throw new WavError("resample expects mono; call toMono first");
  if (!Number.isInteger(target) || target < 1 || target > MAX_SAMPLE_RATE) {
    throw new WavError(`invalid target sample rate ${target}`);
  }
  if (pcm.sampleRate === target) return pcm;

  const src = pcm.samples;
  if (src.length === 0) return { samples: new Int16Array(0), sampleRate: target, channels: 1 };

  // Preserve duration: outputSamples = inputSamples * target / sourceRate.
  const n = Math.max(1, Math.round((src.length * target) / pcm.sampleRate));
  const out = new Int16Array(n);

  if (target < pcm.sampleRate) {
    const ratio = pcm.sampleRate / target; // source samples per output sample (> 1)
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.ceil((i + 1) * ratio), src.length);
      let sum = 0;
      let cnt = 0;
      for (let j = start; j < end; j++) { sum += src[j]; cnt++; }
      out[i] = cnt > 0 ? clampInt16(sum / cnt) : src[Math.min(start, src.length - 1)];
    }
  } else {
    const step = (src.length - 1) / Math.max(1, n - 1); // map output index -> source position
    for (let i = 0; i < n; i++) {
      const pos = i * step;
      const a = Math.floor(pos);
      const b = Math.min(a + 1, src.length - 1);
      const frac = pos - a;
      out[i] = clampInt16(src[a] * (1 - frac) + src[b] * frac);
    }
  }
  return { samples: out, sampleRate: target, channels: 1 };
}

/** Little-endian PCM16 bytes — the wire format Intron's streaming API expects. */
export function toBuffer(pcm: Pcm): Buffer {
  const buf = Buffer.allocUnsafe(pcm.samples.length * 2);
  for (let i = 0; i < pcm.samples.length; i++) buf.writeInt16LE(pcm.samples[i], i * 2);
  return buf;
}

/** Read a WAV and normalise it to the 16 kHz mono PCM16 every provider receives. */
export function loadAs16kMono(buf: Buffer): Buffer {
  return toBuffer(resample(toMono(decodeWav(buf)), 16000));
}

export function encodeWav(pcm: Pcm): Buffer {
  const data = toBuffer(pcm);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(pcm.channels, 22);
  header.writeUInt32LE(pcm.sampleRate, 24);
  header.writeUInt32LE(pcm.sampleRate * pcm.channels * 2, 28);
  header.writeUInt16LE(pcm.channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
