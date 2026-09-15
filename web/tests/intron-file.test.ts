/**
 * The file fallback keeps a recording alive when streaming fails. These tests use a
 * mocked fetch, so an ordinary run spends no Intron credits.
 */
import { describe, it, expect, vi } from "vitest";
import { transcribeFile, pcm16ToWav, IntronFileError, INTRON_FILE_URL } from "@/lib/speech/intron-file";
import { decodeWav } from "@/lib/audio/wav";
import { friendlyVoiceError } from "@/lib/speech/errors";

function pcm(samples: number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

/** Await a rejected transcribeFile call, returning the typed error. */
async function expectErr(p: Promise<unknown>): Promise<IntronFileError> {
  try { await p; throw new Error("expected a rejection"); }
  catch (e) { return e as IntronFileError; }
}

const okResponse = (transcript: string) =>
  new Response(JSON.stringify({ data: { audio_transcript: transcript, processed_audio_duration_in_seconds: 3, file_id: "f1" } }), {
    status: 200, headers: { "content-type": "application/json" },
  });

describe("pcm16ToWav", () => {
  it("wraps PCM16 into a valid 16kHz mono WAV the app can read back", () => {
    const wav = pcm16ToWav(pcm([0, 1000, -1000, 32767, -32768]), 16000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(16000);
    expect(back.channels).toBe(1);
    expect(Array.from(back.samples)).toEqual([0, 1000, -1000, 32767, -32768]);
  });
});

describe("transcribeFile", () => {
  it("posts multipart to the file endpoint with a Bearer header and returns the transcript", async () => {
    const fetchImpl = vi.fn(async (url: string, opts: RequestInit) => {
      expect(url).toBe(INTRON_FILE_URL);
      expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
      // We must NOT hand-set Content-Type; FormData supplies the boundary.
      expect((opts.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      expect(opts.body).toBeInstanceOf(FormData);
      const form = opts.body as FormData;
      expect(form.get("use_language_asr_input")).toBe("pcm");
      expect(form.get("audio_file_blob")).toBeInstanceOf(Blob);
      return okResponse("five bags of cement");
    });
    const r = await transcribeFile(pcm([1, 2, 3, 4]), { apiKey: "secret-key", language: "pcm", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.transcript).toBe("five bags of cement");
    expect(r.durationSec).toBe(3);
  });

  it("never puts the API key in the URL or the form body", async () => {
    let seenUrl = ""; let bodyHasKey = false;
    const fetchImpl = vi.fn(async (url: string, opts: RequestInit) => {
      seenUrl = url;
      for (const [, v] of (opts.body as FormData)) if (typeof v === "string" && v.includes("secret-key")) bodyHasKey = true;
      return okResponse("ok");
    });
    await transcribeFile(pcm([1, 2]), { apiKey: "secret-key", language: "en", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(seenUrl).not.toContain("secret-key");
    expect(bodyHasKey).toBe(false);
  });

  it("maps 401 to a non-recoverable AUTHENTICATION_ERROR (no retry/fallback loop)", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const err = await expectErr(transcribeFile(pcm([1, 2]), { apiKey: "k", language: "en", fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err).toBeInstanceOf(IntronFileError);
    expect(err.code).toBe("AUTHENTICATION_ERROR");
    expect(err.recoverable).toBe(false);
  });

  it("maps 429 to a recoverable RESOURCE_EXHAUSTED", async () => {
    const fetchImpl = vi.fn(async () => new Response("busy", { status: 429 }));
    const err = await expectErr(transcribeFile(pcm([1, 2]), { apiKey: "k", language: "en", fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err.code).toBe("RESOURCE_EXHAUSTED");
    expect(err.recoverable).toBe(true);
  });

  it("treats a 5xx as recoverable", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 502 }));
    const err = await expectErr(transcribeFile(pcm([1, 2]), { apiKey: "k", language: "en", fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err.recoverable).toBe(true);
  });

  it("fails clearly when the response has no transcript", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }));
    const err = await expectErr(transcribeFile(pcm([1, 2]), { apiKey: "k", language: "en", fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err.code).toBe("FILE_NO_TRANSCRIPT");
  });

  it("times out via AbortController", async () => {
    const fetchImpl = vi.fn((_url: string, opts: RequestInit) => new Promise((_res, rej) => {
      (opts.signal as AbortSignal).addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const err = await expectErr(transcribeFile(pcm([1, 2]), { apiKey: "k", language: "en", timeoutMs: 20, fetchImpl: fetchImpl as unknown as typeof fetch }));
    expect(err.code).toBe("FILE_TIMEOUT");
  });
});

describe("friendlyVoiceError", () => {
  it("never leaks a raw transport code to the user", () => {
    for (const code of ["WS_ERR_EXPECTED_FIN", "SOCKET_ERROR", "CLOSED_EARLY", "CONNECT_TIMEOUT", "FINALIZE_TIMEOUT", "STREAM_FATAL"]) {
      const msg = friendlyVoiceError(code);
      expect(msg).not.toContain(code);
      expect(msg).not.toMatch(/websocket|frame|fin/i);
      expect(msg.length).toBeGreaterThan(10);
    }
  });
  it("points auth/quota failures at typing", () => {
    expect(friendlyVoiceError("AUTHENTICATION_ERROR")).toMatch(/type/i);
    expect(friendlyVoiceError("QUOTA_EXCEEDED")).toMatch(/type/i);
  });
});
