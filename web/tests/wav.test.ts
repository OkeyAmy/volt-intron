/**
 * WAV decode / resample regression tests.
 *
 * The reproduced bug: upsampling reused the downsampling window, whose average
 * covered an empty range for every other output sample and so inserted zeros --
 * 8kHz->16kHz of a constant signal became [0, x, 0, x, ...]. These tests pin the
 * fix and the parse-validation hardening.
 */
import { describe, it, expect } from "vitest";
import { decodeWav, encodeWav, resample, toMono, loadAs16kMono, WavError, type Pcm } from "@/lib/audio/wav";

function pcm(samples: number[], sampleRate: number, channels = 1): Pcm {
  return { samples: Int16Array.from(samples), sampleRate, channels };
}

describe("decode / encode", () => {
  it("round-trips samples, rate and channels", () => {
    const original = pcm([0, 1000, -1000, 32767, -32768], 16000);
    const decoded = decodeWav(encodeWav(original));
    expect(Array.from(decoded.samples)).toEqual(Array.from(original.samples));
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
  });

  it("rejects a file that is too short", () => {
    expect(() => decodeWav(Buffer.alloc(4))).toThrow(WavError);
  });

  it("rejects a non-RIFF file", () => {
    expect(() => decodeWav(Buffer.alloc(64))).toThrow(WavError);
  });

  it("rejects non-PCM formats", () => {
    const buf = encodeWav(pcm([1, 2, 3, 4], 16000));
    buf.writeUInt16LE(3, 20); // format 3 = IEEE float
    expect(() => decodeWav(buf)).toThrow(/format/);
  });

  it("does not read past the buffer when the declared data size is too large", () => {
    const buf = encodeWav(pcm([1, 2, 3, 4], 16000));
    buf.writeUInt32LE(0xffffffff, 40); // lie about the data size
    const decoded = decodeWav(buf); // clamps to what is actually present
    expect(decoded.samples.length).toBe(4);
  });
});

describe("toMono", () => {
  it("averages interleaved stereo down to one channel", () => {
    const stereo = pcm([100, 300, 1000, 2000], 16000, 2); // frames: (100,300),(1000,2000)
    const mono = toMono(stereo);
    expect(mono.channels).toBe(1);
    expect(Array.from(mono.samples)).toEqual([200, 1500]);
  });
});

describe("resample", () => {
  it("upsamples a constant signal without inserting zeros (the reproduced bug)", () => {
    const out = resample(pcm([1000, 1000, 1000, 1000], 8000), 16000);
    expect(out.sampleRate).toBe(16000);
    expect(out.samples.length).toBe(8);
    expect(Array.from(out.samples).every((v) => v === 1000)).toBe(true);
  });

  it("interpolates between differing samples rather than duplicating or zeroing", () => {
    const out = resample(pcm([0, 1000], 8000), 16000);
    // Endpoints preserved; the inserted samples fall strictly between them.
    expect(out.samples[0]).toBe(0);
    expect(out.samples[out.samples.length - 1]).toBe(1000);
    expect(Array.from(out.samples).some((v) => v > 0 && v < 1000)).toBe(true);
  });

  it("preserves duration when upsampling", () => {
    const out = resample(pcm(new Array(8000).fill(500), 8000), 16000);
    expect(out.samples.length).toBe(16000); // 1s stays 1s
  });

  it("preserves duration when downsampling", () => {
    const out = resample(pcm(new Array(48000).fill(500), 48000), 16000);
    expect(out.samples.length).toBe(16000);
    expect(Array.from(out.samples).every((v) => v === 500)).toBe(true);
  });

  it("is a no-op at the same rate", () => {
    const p = pcm([1, 2, 3], 16000);
    expect(resample(p, 16000)).toBe(p);
  });

  it("rejects an invalid target rate", () => {
    expect(() => resample(pcm([1, 2], 8000), 0)).toThrow(WavError);
    expect(() => resample(pcm([1, 2], 8000), -16000)).toThrow(WavError);
  });

  it("refuses to resample multi-channel audio", () => {
    expect(() => resample(pcm([1, 2, 3, 4], 8000, 2), 16000)).toThrow(/mono/);
  });
});

describe("loadAs16kMono", () => {
  it("normalises an 8kHz stereo WAV to 16kHz mono PCM16 bytes", () => {
    const wav = encodeWav(pcm([100, 300, 1000, 2000], 8000, 2)); // 2 frames stereo @ 8k
    const bytes = loadAs16kMono(wav);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    // 2 mono frames @ 8k -> 4 frames @ 16k -> 8 bytes of PCM16.
    expect(bytes.length).toBe(8);
  });
});
