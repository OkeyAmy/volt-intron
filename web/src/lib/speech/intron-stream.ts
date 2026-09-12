/**
 * Intron streaming STT client.
 *
 * Intron authenticates this socket with an `Authorization` header on the HTTP
 * handshake. Browsers cannot set handshake headers, which is why this runs on the
 * server and why a voice gateway is mandatory rather than a preference.
 *
 * Protocol notes taken from the live API, not only the docs:
 *  - Partial transcripts are SPARSE (1-2 for a 5s clip), not word-by-word.
 *  - The field name differs between messages: PARTIAL_TRANSCRIPT.transcript vs
 *    COMMITTED_TRANSCRIPT.transcript_text.
 *  - Several wire strings are misspelled upstream (AUDIO_CHUCK_ACK, chunck_id,
 *    CHUNCK_SIZE_TOO_SMALL). They are matched verbatim; do not "fix" them.
 *  - The server closes the socket right after COMMITTED_TRANSCRIPT.
 *  - Session lifetime 300s, idle gap 60s, chunks 1KB..32KB.
 */
import WebSocket from "ws";

export const INTRON_STT_URL = "wss://infer.voice.intron.io/stt/v1/stream";

/** Code-switched pairs. Selecting one of these is how Sahara is invoked — there is no model param. */
export const CODE_SWITCHED = {
  "yo": "Yoruba-English",
  "ig": "Igbo-English",
  "ha": "Hausa-English",
  "pcm": "Pidgin-English",
} as const;

export type LanguageCode = keyof typeof CODE_SWITCHED | "en";

export interface StreamOptions {
  apiKey: string;
  language: LanguageCode;
  sampleRate?: number;
  onPartial?: (text: string) => void;
  onOpen?: (session: { sessionId: string; creditBalance: number }) => void;
  signal?: AbortSignal;
}

export interface StreamResult {
  transcript: string;
  transcriptId: string | null;
  audioLen: number | null;
  partialCount: number;
  msToFirstPartial: number | null;
  msTotal: number;
}

export class IntronStreamError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "IntronStreamError";
  }
}

const MIN_CHUNK = 1024;          // server rejects below this
const MAX_CHUNK = 32 * 1024;     // and above this
const CHUNK = 8 * 1024;

/** Fatal message types that end the session. */
const FATAL = new Set([
  "ERROR", "INPUT_ERROR", "AUTHENTICATION_ERROR", "QUOTA_EXCEEDED",
  "RESOURCE_EXHAUSTED", "CHUNCK_SIZE_TOO_SMALL", "CHUNK_SIZE_TOO_LARGE",
  "INSUFFICIENT_AUDIO_ACTIVITY", "SESSION_TIME_LIMIT_EXCEEDED",
  "CHUNK_ID_MISMATCH_WITH_TOTAL",
]);

/**
 * Send one utterance of PCM16 mono audio and resolve with the committed transcript.
 * One short session per utterance: the socket cannot be resumed, so keeping
 * sessions brief bounds what a drop can cost.
 */
export function transcribeStream(pcm16: Buffer, opts: StreamOptions): Promise<StreamResult> {
  const sampleRate = opts.sampleRate ?? 16000;
  const url =
    `${INTRON_STT_URL}?sample_rate=${sampleRate}&bit_rate=16&num_channels=1` +
    `&use_language_asr_input=${encodeURIComponent(opts.language)}`;

  return new Promise<StreamResult>((resolve, reject) => {
    const started = Date.now();
    let msToFirstPartial: number | null = null;
    let partialCount = 0;
    let settled = false;

    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      try { ws.close(); } catch { /* already closing */ }
      fn();
    };
    const onAbort = () => finish(() => reject(new IntronStreamError("aborted", "ABORTED")));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    ws.on("open", () => {
      let ackId = 0;
      for (let i = 0; i < pcm16.length; i += CHUNK) {
        const slice = pcm16.subarray(i, i + CHUNK);
        // A trailing slice under 1KB would be rejected; fold it into nothing rather
        // than send an invalid frame. Callers pad utterances, so this is rare.
        if (slice.length < MIN_CHUNK && i + CHUNK >= pcm16.length) break;
        ws.send(JSON.stringify({
          message_type: "INPUT_AUDIO_CHUNK",
          audio_base_64: slice.toString("base64"),
          ack_id: ++ackId,
        }));
      }
      ws.send(JSON.stringify({ message_type: "COMMIT" }));
    });

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const type = msg.message_type as string;

      if (type === "SESSION_CREATED") {
        opts.onOpen?.({
          sessionId: String(msg.session_id ?? ""),
          creditBalance: Number(msg.credit_balance ?? 0),
        });
      } else if (type === "PARTIAL_TRANSCRIPT") {
        partialCount++;
        msToFirstPartial ??= Date.now() - started;
        opts.onPartial?.(String(msg.transcript ?? ""));
      } else if (type === "COMMITTED_TRANSCRIPT") {
        finish(() => resolve({
          transcript: String(msg.transcript_text ?? ""),
          transcriptId: (msg.transcript_id as string) ?? null,
          audioLen: (msg.audio_len as number) ?? null,
          partialCount,
          msToFirstPartial,
          msTotal: Date.now() - started,
        }));
      } else if (FATAL.has(type)) {
        finish(() => reject(new IntronStreamError(
          String(msg.message ?? msg.status ?? type), type)));
      }
    });

    ws.on("error", (err) =>
      finish(() => reject(new IntronStreamError(err.message, "SOCKET_ERROR"))));

    ws.on("close", () =>
      finish(() => reject(new IntronStreamError(
        "socket closed before a transcript was committed", "CLOSED_EARLY"))));
  });
}

export const _internal = { MIN_CHUNK, MAX_CHUNK, CHUNK, FATAL };

/* ------------------------------------------------------------------------- */

export type SessionEvent =
  | { type: "open"; sessionId: string; creditBalance: number }
  | { type: "partial"; text: string }
  | { type: "final"; result: StreamResult }
  | { type: "error"; code: string; message: string };

/**
 * Incremental session: audio is forwarded to Intron as it arrives rather than
 * buffered until the speaker stops. This is what makes partial transcripts appear
 * while someone is still talking, which is the difference between a voice product
 * and a recorder with extra steps.
 *
 * Chunks are re-packed to the 1KB..32KB window the server enforces, because a
 * browser's frame size has no reason to match it.
 */
export class IntronStreamSession {
  private ws: WebSocket;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private ackId = 0;
  private committed = false;
  private settled = false;
  private started = Date.now();
  private partialCount = 0;
  private msToFirstPartial: number | null = null;
  private opened = false;

  constructor(
    private opts: { apiKey: string; language: LanguageCode; sampleRate?: number },
    private emit: (e: SessionEvent) => void,
  ) {
    const sr = opts.sampleRate ?? 16000;
    const url =
      `${INTRON_STT_URL}?sample_rate=${sr}&bit_rate=16&num_channels=1` +
      `&use_language_asr_input=${encodeURIComponent(opts.language)}`;
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });

    this.ws.on("open", () => { this.opened = true; this.flush(false); });
    this.ws.on("message", (raw) => this.onMessage(raw.toString()));
    this.ws.on("error", (e) => this.fail("SOCKET_ERROR", e.message));
    this.ws.on("close", () => {
      if (!this.settled) this.fail("CLOSED_EARLY", "socket closed before a transcript was committed");
    });
  }

  /** Queue PCM16 audio. Safe to call before the socket has opened. */
  push(chunk: Buffer): void {
    if (this.committed || this.settled) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.opened) this.flush(false);
  }

  /** Signal end of utterance. Intron replies with COMMITTED_TRANSCRIPT, then closes. */
  commit(): void {
    if (this.committed || this.settled) return;
    this.committed = true;
    const send = () => { this.flush(true); this.ws.send(JSON.stringify({ message_type: "COMMIT" })); };
    if (this.opened) send(); else this.ws.once("open", send);
  }

  close(): void {
    this.settled = true;
    try { this.ws.close(); } catch { /* already closing */ }
  }

  private flush(final: boolean): void {
    while (this.pendingBytes >= (final ? 1 : MIN_CHUNK)) {
      const take = Math.min(this.pendingBytes, MAX_CHUNK);
      if (!final && take < MIN_CHUNK) break;
      const merged = Buffer.concat(this.pending, this.pendingBytes);
      const slice = merged.subarray(0, take);
      const rest = merged.subarray(take);
      this.pending = rest.length ? [rest] : [];
      this.pendingBytes = rest.length;
      // A final remainder under 1KB would be rejected outright; pad it with silence
      // so the tail of an utterance is not silently discarded.
      const payload = final && slice.length < MIN_CHUNK
        ? Buffer.concat([slice, Buffer.alloc(MIN_CHUNK - slice.length)])
        : slice;
      this.ws.send(JSON.stringify({
        message_type: "INPUT_AUDIO_CHUNK",
        audio_base_64: payload.toString("base64"),
        ack_id: ++this.ackId,
      }));
      if (!this.pendingBytes) break;
    }
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    const type = msg.message_type as string;

    if (type === "SESSION_CREATED") {
      this.emit({
        type: "open",
        sessionId: String(msg.session_id ?? ""),
        creditBalance: Number(msg.credit_balance ?? 0),
      });
    } else if (type === "PARTIAL_TRANSCRIPT") {
      this.partialCount++;
      this.msToFirstPartial ??= Date.now() - this.started;
      this.emit({ type: "partial", text: String(msg.transcript ?? "") });
    } else if (type === "COMMITTED_TRANSCRIPT") {
      this.settled = true;
      this.emit({
        type: "final",
        result: {
          transcript: String(msg.transcript_text ?? ""),
          transcriptId: (msg.transcript_id as string) ?? null,
          audioLen: (msg.audio_len as number) ?? null,
          partialCount: this.partialCount,
          msToFirstPartial: this.msToFirstPartial,
          msTotal: Date.now() - this.started,
        },
      });
    } else if (FATAL.has(type)) {
      this.fail(type, String(msg.message ?? msg.status ?? type));
    }
  }

  private fail(code: string, message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.emit({ type: "error", code, message });
    try { this.ws.close(); } catch { /* already closing */ }
  }
}
