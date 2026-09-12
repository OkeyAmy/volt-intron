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

export function decodeWav(buf: Buffer): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      const audioFormat = buf.readUInt16LE(body);
      if (audioFormat !== 1) throw new Error(`unsupported WAV format ${audioFormat}; need PCM (1)`);
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("data chunk before fmt chunk");
      if (fmt.bits !== 16) throw new Error(`unsupported bit depth ${fmt.bits}; need 16`);
      const count = Math.floor(size / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("no data chunk found");
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

/**
 * Resample by averaging each source window. Averaging rather than picking the
 * nearest sample avoids the aliasing that a naive decimation introduces, which
 * would otherwise show up as extra ASR errors and be mistaken for model quality.
 */
export function resample(pcm: Pcm, target: number): Pcm {
  if (pcm.channels !== 1) throw new Error("resample expects mono; call toMono first");
  if (pcm.sampleRate === target) return pcm;
  const ratio = pcm.sampleRate / target;
  const n = Math.floor(pcm.samples.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(Math.floor((i + 1) * ratio), pcm.samples.length);
    let sum = 0;
    for (let j = a; j < b; j++) sum += pcm.samples[j];
    out[i] = b > a ? Math.round(sum / (b - a)) : 0;
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
