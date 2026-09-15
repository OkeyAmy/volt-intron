/**
 * Intron synchronous FILE transcription — the reliability fallback for streaming.
 *
 * When the streaming WebSocket fails with a recoverable transport/protocol error
 * (e.g. `WS_ERR_EXPECTED_FIN` "Invalid WebSocket frame: FIN must be set", seen
 * through some proxies), the gateway sends the whole buffered recording here as a
 * WAV file instead of losing it. This is STILL Sahara/Intron — same provider, a
 * different transport — not a swap to Whisper/Gemini/etc.
 *
 * Endpoint (docs.voice.intron.io/docs/stt/file-upload-sync):
 *   POST https://infer.voice.intron.io/file/v1/upload/sync
 *   multipart/form-data: audio_file_name, audio_file_blob, use_language_asr_input
 *   Authorization: Bearer <key>   ·   files <= 120s   ·   data.audio_transcript
 */
import { encodeWav, type Pcm } from "../audio/wav";

export const INTRON_FILE_URL = "https://infer.voice.intron.io/file/v1/upload/sync";

export interface FileTranscriptResult {
  transcript: string;
  durationSec: number | null;
  fileId: string | null;
}

export class IntronFileError extends Error {
  constructor(message: string, readonly code: string, readonly recoverable = false) {
    super(message);
    this.name = "IntronFileError";
  }
}

/** Wrap raw little-endian PCM16 mono bytes into a WAV Buffer using the app's own
 *  encoder (no ffmpeg). readInt16LE is explicit so endianness never depends on the
 *  host CPU. */
export function pcm16ToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const n = pcm.length >> 1; // whole 2-byte samples; drop a stray trailing byte
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = pcm.readInt16LE(i * 2);
  const p: Pcm = { samples, sampleRate, channels: 1 };
  return encodeWav(p);
}

export type FetchLike = typeof fetch;

export async function transcribeFile(
  pcm: Buffer,
  opts: { apiKey: string; language: string; sampleRate?: number; timeoutMs?: number; fetchImpl?: FetchLike },
): Promise<FileTranscriptResult> {
  const wav = pcm16ToWav(pcm, opts.sampleRate ?? 16000);

  const form = new FormData();
  form.append("audio_file_name", "sautice-recording.wav");
  // Let fetch/FormData set the multipart boundary + Content-Type; never set it by hand.
  // Buffer is a Uint8Array at runtime; the cast satisfies the strict BlobPart type.
  const blob = new Blob([wav as unknown as BlobPart], { type: "audio/wav" });
  form.append("audio_file_blob", blob, "sautice-recording.wav");
  form.append("use_language_asr_input", opts.language);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45_000);
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(INTRON_FILE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}` }, // never logged
      body: form,
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new IntronFileError("file transcription timed out", "FILE_TIMEOUT", true);
    throw new IntronFileError(`file transcription request failed: ${(e as Error).message}`, "FILE_NETWORK", true);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw new IntronFileError("authentication failed", "AUTHENTICATION_ERROR", false);
  if (res.status === 429) throw new IntronFileError("rate limited", "RESOURCE_EXHAUSTED", true);
  if (!res.ok) {
    await res.text().catch(() => "");
    throw new IntronFileError(`file transcription failed (HTTP ${res.status})`, `FILE_HTTP_${res.status}`, res.status >= 500);
  }

  let body: { data?: { audio_transcript?: unknown; processed_audio_duration_in_seconds?: unknown; file_id?: unknown } };
  try { body = await res.json(); } catch { throw new IntronFileError("invalid response from the file API", "FILE_BAD_JSON", true); }

  const transcript = body?.data?.audio_transcript;
  if (typeof transcript !== "string") throw new IntronFileError("no transcript in the file response", "FILE_NO_TRANSCRIPT", true);

  return {
    transcript,
    durationSec: typeof body.data?.processed_audio_duration_in_seconds === "number" ? body.data.processed_audio_duration_in_seconds : null,
    fileId: typeof body.data?.file_id === "string" ? body.data.file_id : null,
  };
}
