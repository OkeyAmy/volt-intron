/**
 * Intron streaming STT client.
 *
 * Intron authenticates this socket with an `Authorization` header on the HTTP
 * handshake. Browsers cannot set handshake headers, which is why this runs on the
 * server and why a voice gateway is mandatory rather than a preference.
 *
 * Protocol notes taken from the live API and the streaming docs
 * (https://docs.voice.intron.io/docs/stt/streaming):
 *  - Normal order is SESSION_CREATED, then audio/ACKs/partials, then COMMIT ->
 *    COMMITTED_TRANSCRIPT, then the server closes the socket. Audio sent before
 *    SESSION_CREATED is not part of the documented flow, so we gate on it.
 *  - Partial transcripts are SPARSE (1-2 for a 5s clip), not word-by-word, and a
 *    short clip can finish with none. Absence of partials is not a failure.
 *  - The field name differs between messages: PARTIAL_TRANSCRIPT.transcript vs
 *    COMMITTED_TRANSCRIPT.transcript_text.
 *  - Several wire strings have been observed misspelled upstream (AUDIO_CHUCK_ACK,
 *    chunck_id, CHUNCK_SIZE_TOO_SMALL). We accept both the documented and the
 *    observed spelling and keep the original event name in diagnostics.
 *  - Session lifetime 300s, idle gap 60s, chunks 1KB..32KB.
 *
 * Why this file was rewritten: the previous version began sending audio on the
 * transport `open` event (before the service session existed), discarded a
 * sub-1KB audio tail in the complete-file path, had no bounded waits, and threw
 * away the WebSocket close code/reason -- collapsing every early close into an
 * opaque "socket closed before the transcript was committed". Both entry points
 * now share one state machine, one packetizer, and one set of deadlines.
 */
import WebSocket from "ws";
import { performance } from "node:perf_hooks";

export const INTRON_STT_URL = "wss://infer.voice.intron.io/stt/v1/stream";

/** Code-switched pairs. Selecting one of these is how Sahara is invoked -- there is no model param. */
export const CODE_SWITCHED = {
  "yo": "Yoruba-English",
  "ig": "Igbo-English",
  "ha": "Hausa-English",
  "pcm": "Pidgin-English",
} as const;

export type LanguageCode = keyof typeof CODE_SWITCHED | "en";

/**
 * Application-level deadlines, in ms. These are OUR bounds, chosen so a stuck
 * session fails fast with a useful message instead of hanging (the reported
 * "taking a whole lot of time"). They sit well inside Intron's 300s session and
 * 60s idle ceilings; `finalizeMs` in particular reserves time for the provider to
 * commit before its own limits bite. Override per call when a trace justifies it.
 */
export interface Deadlines {
  /** Transport handshake: `open` must arrive within this. */
  connectMs: number;
  /** Service readiness: SESSION_CREATED must arrive within this of `open`. */
  readyMs: number;
  /** Finalisation: COMMITTED_TRANSCRIPT must arrive within this of COMMIT. */
  finalizeMs: number;
}

export const DEFAULT_DEADLINES: Deadlines = {
  connectMs: 10_000,
  readyMs: 10_000,
  finalizeMs: 20_000,
};

/** Minimal shape of the `ws` WebSocket we rely on; also what test fakes implement. */
export interface WebSocketLike {
  readonly readyState: number;
  on(event: "open", cb: () => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: (code: number, reason: unknown) => void): void;
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string, opts: { headers: Record<string, string> }) => WebSocketLike;

const defaultWsFactory: WsFactory = (url, opts) => new WebSocket(url, opts) as unknown as WebSocketLike;

export interface StreamOptions {
  apiKey: string;
  language: LanguageCode;
  sampleRate?: number;
  onPartial?: (text: string) => void;
  onOpen?: (session: { sessionId: string; creditBalance: number }) => void;
  signal?: AbortSignal;
  /** Partial override of the default deadlines. */
  deadlines?: Partial<Deadlines>;
  /** Inject a WebSocket implementation. Defaults to `ws`; tests pass a fake. */
  wsFactory?: WsFactory;
  /**
   * Reconnect up to this many times before the service confirms SESSION_CREATED.
   * Pre-session failures cost no credits, and the upstream is measurably flaky at
   * connect time, so a retrying client is materially more reliable. Post-session
   * failures are never retried. Default 1 (no reconnect).
   */
  maxAttempts?: number;
  /**
   * Release upstream audio frames one every `paceMs` instead of in a burst, and
   * delay COMMIT until the queue drains. Set for clients that hand the whole
   * utterance over at once; the upstream drops frames under a sudden burst.
   * Default 0 (no pacing, identical to the original behaviour).
   */
  paceMs?: number;
}

export interface StreamResult {
  transcript: string;
  transcriptId: string | null;
  audioLen: number | null;
  partialCount: number;
  /** Time from session start to the first partial, or null if none arrived. */
  msToFirstPartial: number | null;
  /** Total wall time of the session. */
  msTotal: number;
  /**
   * Time from COMMIT to the final transcript, measured separately from msTotal so
   * post-recording latency can be told apart from time spent speaking.
   */
  msStopToFinal: number | null;
}

/** Stage the session was in when it settled -- surfaced in diagnostics, not to end users. */
export type StreamStage =
  | "connecting"
  | "awaiting_ready"
  | "streaming"
  | "draining"
  | "awaiting_final"
  | "done";

export class IntronStreamError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail: {
      stage?: StreamStage;
      /** The provider's original event name, misspellings preserved. */
      providerEvent?: string;
      closeCode?: number;
      closeReason?: string;
      /** Whether replaying the same audio (stream retry or file fallback) may help. */
      recoverable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "IntronStreamError";
  }
}

const MIN_CHUNK = 1024;          // server rejects below this
const MAX_CHUNK = 32 * 1024;     // and above this
const CHUNK = 8 * 1024;          // preferred packet size

/**
 * Terminal provider errors. Both the documented spelling and the observed
 * misspelling are listed; the original event name is kept in diagnostics.
 * `recoverable` says whether replaying the SAME audio could succeed -- a bad key
 * or exhausted credit never will, a transient capacity error might.
 */
const FATAL: Record<string, { recoverable: boolean }> = {
  ERROR: { recoverable: false },
  INPUT_ERROR: { recoverable: false },
  AUTHENTICATION_ERROR: { recoverable: false },
  QUOTA_EXCEEDED: { recoverable: false },
  RESOURCE_EXHAUSTED: { recoverable: true },
  CHUNK_SIZE_TOO_SMALL: { recoverable: false },
  CHUNCK_SIZE_TOO_SMALL: { recoverable: false }, // observed misspelling
  CHUNK_SIZE_TOO_LARGE: { recoverable: false },
  INSUFFICIENT_AUDIO_ACTIVITY: { recoverable: false },
  SESSION_TIME_LIMIT_EXCEEDED: { recoverable: false },
  CHUNK_ID_MISMATCH_WITH_TOTAL: { recoverable: false },
};

function fatalInfo(type: string): { recoverable: boolean } | undefined {
  return FATAL[type];
}

const WS_OPEN = 1;

function buildUrl(language: LanguageCode, sampleRate: number): string {
  return (
    `${INTRON_STT_URL}?sample_rate=${sampleRate}&bit_rate=16&num_channels=1` +
    `&use_language_asr_input=${encodeURIComponent(language)}`
  );
}

function toStringData(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
  return String(data);
}

function decodeReason(reason: unknown): string {
  if (reason instanceof Buffer) return reason.toString();
  if (typeof reason === "string") return reason;
  return "";
}

/**
 * The shared session core. Both `transcribeStream` and `IntronStreamSession`
 * delegate here so there is exactly one implementation of readiness gating,
 * packetisation, tail handling, deadlines and terminal-state logic.
 */
class SessionCore {
  private ws!: WebSocketLike;
  private deadlines: Deadlines;

  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private ackId = 0;

  private ready = false;       // SESSION_CREATED seen (service ready, not just socket open)
  private commitRequested = false;
  private commitSent = false;
  private settled = false;

  private stage: StreamStage = "connecting";
  private startedAt = performance.now();
  private commitAt: number | null = null;
  private partialCount = 0;
  private msToFirstPartial: number | null = null;

  /** Original (pre-padding) audio bytes actually forwarded; padding is tracked apart. */
  private originalBytesSent = 0;
  private padBytesSent = 0;

  private timers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Paced send queue. When `paceMs > 0`, audio frames are released one every
   * `paceMs` instead of in a burst, and COMMIT is deferred until the queue
   * drains. The upstream drops sessions fed a whole utterance at once; a real
   * recorder trickles audio in but test clients may not.
   */
  private sendQueue: string[] = [];
  private draining = false;
  private commitPending = false;

  /** Upstream sockets created so far; used to bound pre-session reconnects. */
  private attempts = 0;
  private readonly maxAttempts: number;
  private readonly paceMs: number;

  constructor(
    private url: string,
    private headers: Record<string, string>,
    deadlines: Partial<Deadlines> | undefined,
    private wsFactory: WsFactory,
    private handlers: {
      onOpen?: (s: { sessionId: string; creditBalance: number }) => void;
      onPartial?: (text: string) => void;
      onFinal: (r: StreamResult) => void;
      onError: (e: IntronStreamError) => void;
    },
    maxAttempts = 1,
    paceMs = 0,
  ) {
    this.deadlines = { ...DEFAULT_DEADLINES, ...deadlines };
    this.maxAttempts = maxAttempts;
    this.paceMs = paceMs;
    this.beginAttempt();
  }

  /**
   * Open the upstream socket for one attempt. Audio already queued in `pending`
   * survives a reconnect: nothing was delivered to a session that never started.
   */
  private beginAttempt(): void {
    this.attempts++;
    this.ready = false;
    this.stage = "connecting";
    this.ackId = 0;
    this.sendQueue = [];
    this.draining = false;
    this.commitPending = false;

    this.ws = this.wsFactory(this.url, { headers: this.headers });

    this.armTimer(this.deadlines.connectMs, () =>
      this.maybeRetry("CONNECT_TIMEOUT", "timed out before the connection opened", { recoverable: true }));

    this.ws.on("open", () => this.onOpen());
    this.ws.on("message", (data) => this.onMessage(toStringData(data)));
    this.ws.on("error", (err) =>
      this.maybeRetry("SOCKET_ERROR", err?.message || "socket error", { recoverable: true }));
    this.ws.on("close", (code, reason) => this.onClose(code, decodeReason(reason)));
  }

  /**
   * Reconnect policy: failures before SESSION_CREATED cost nothing (no session was
   * billed), and the upstream is measurably flaky at connect time (it occasionally
   * sends a frame Node's `ws` cannot parse, which Py's parser tolerates). So retry
   * up to `maxAttempts` while pre-ready, then surface the real error. A failure
   * after the session exists is never retried.
   */
  private maybeRetry(
    code: string,
    message: string,
    detail: { recoverable?: boolean; providerEvent?: string; closeCode?: number; closeReason?: string },
  ): void {
    if (this.settled) return;
    if (this.ready || this.attempts >= this.maxAttempts) { this.fail(code, message, detail); return; }
    this.armTimer(200 * this.attempts, () => { if (!this.settled) this.beginAttempt(); });
  }

  private armTimer(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    // Do not keep the process alive on account of a pending deadline.
    (t as unknown as { unref?: () => void }).unref?.();
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private onOpen(): void {
    if (this.settled) return;
    this.clearTimers(); // connect deadline met
    this.stage = "awaiting_ready";
    this.armTimer(this.deadlines.readyMs, () =>
      this.maybeRetry("READY_TIMEOUT", "the service did not create a session in time", { recoverable: true }));
    // Deliberately do NOT send audio here: wait for SESSION_CREATED.
  }

  /** Queue PCM16 audio. Safe before the socket opens or the service is ready. */
  push(chunk: Buffer): void {
    if (this.commitRequested || this.settled) return;
    if (chunk.length === 0) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.ready) this.flush(false);
  }

  /**
   * Request commit. If the service is not ready yet, or audio is still queued,
   * the commit is remembered and performed after drainage. Idempotent: repeated
   * calls never produce a second upstream COMMIT.
   */
  commit(): void {
    if (this.commitRequested || this.settled) return;
    this.commitRequested = true;
    if (this.ready) this.drainAndCommit();
    // else: performed from onReady()
  }

  /** Cancel: settle as an error and release the socket. */
  cancel(): void {
    if (this.settled) return;
    this.fail("ABORTED", "aborted", { recoverable: true });
  }

  private onReady(sessionId: string, creditBalance: number): void {
    this.ready = true;
    this.clearTimers(); // readiness deadline met
    this.stage = "streaming";
    this.handlers.onOpen?.({ sessionId, creditBalance });
    this.flush(false);
    if (this.commitRequested) this.drainAndCommit();
  }

  private drainAndCommit(): void {
    if (this.commitSent) return;
    this.stage = "draining";
    this.flush(true);            // send every remaining sample, tail preserved
    this.commitSent = true;
    if (this.paceMs > 0) {
      // Whole-utterance clients dump everything at once; without pacing the burst
      // trips the upstream's frame handler. Release paced, then commit last.
      this.commitPending = true;
      this.drain();
    } else {
      this.emitCommit();
    }
  }

  /** Transmit the upstream COMMIT and start the final-wait deadline. */
  private emitCommit(): void {
    if (this.settled) return;
    this.commitAt = performance.now();
    this.transmit(JSON.stringify({ message_type: "COMMIT" }));
    this.stage = "awaiting_final";
    this.armTimer(this.deadlines.finalizeMs, () =>
      this.fail("FINALIZE_TIMEOUT", "no final transcript arrived after the recording was committed", {
        recoverable: true,
      }));
  }

  /**
   * Packetise `pending` into 1KB..32KB frames.
   *  - Not final: emit whole frames but never strand a sub-1KB remainder mid-stream
   *    (it stays queued for the next push or the final flush).
   *  - Final: emit everything. Never discard real samples. If the WHOLE utterance is
   *    under 1KB, pad the single frame with silence; otherwise borrow from the
   *    penultimate frame so the last frame is a valid size. Padding is counted apart
   *    from real audio so duration reporting stays honest.
   */
  private flush(final: boolean): void {
    while (this.pendingBytes > 0) {
      let take = Math.min(this.pendingBytes, MAX_CHUNK);
      const leftover = this.pendingBytes - take;

      if (!final) {
        if (this.pendingBytes < MIN_CHUNK) break;              // wait for more audio
        if (leftover > 0 && leftover < MIN_CHUNK) break;       // don't create an unsendable tail
      } else if (leftover > 0 && leftover < MIN_CHUNK) {
        // Borrow so the final frame is >= MIN_CHUNK instead of an invalid remainder.
        take = this.pendingBytes - MIN_CHUNK;
      }

      const merged = this.pendingBytes === take && this.pending.length === 1
        ? this.pending[0]
        : Buffer.concat(this.pending, this.pendingBytes);
      const slice = merged.subarray(0, take);
      const rest = merged.subarray(take);
      this.pending = rest.length ? [rest] : [];
      this.pendingBytes = rest.length;

      let payload = slice;
      if (final && slice.length < MIN_CHUNK) {
        const pad = MIN_CHUNK - slice.length;
        payload = Buffer.concat([slice, Buffer.alloc(pad)]);
        this.padBytesSent += pad;
      }
      this.originalBytesSent += slice.length;

      this.send({
        message_type: "INPUT_AUDIO_CHUNK",
        audio_base_64: payload.toString("base64"),
        ack_id: ++this.ackId,
      });

      if (!final && this.pendingBytes < MIN_CHUNK) break;
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.settled) return;
    const json = JSON.stringify(obj);
    if (this.paceMs > 0) {
      this.sendQueue.push(json);
      this.drain();
      return;
    }
    this.transmit(json);
  }

  private transmit(json: string): void {
    if (this.settled) return;
    if (this.ws.readyState !== WS_OPEN) return;
    this.ws.send(json, (err) => {
      if (err && !this.settled) this.fail("SEND_FAILED", err.message, { recoverable: true });
    });
  }

  /** Release queued frames one per `paceMs`. COMMIT fires once the queue is empty. */
  private drain(): void {
    if (this.settled) return;
    if (this.sendQueue.length === 0) {
      if (this.commitPending) {
        this.commitPending = false;
        this.emitCommit();
      }
      return;
    }
    if (this.draining) return;
    this.draining = true;
    this.transmit(this.sendQueue.shift()!);
    const t = setTimeout(() => {
      this.draining = false;
      this.drain();
    }, this.paceMs);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  private onMessage(raw: string): void {
    if (this.settled) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; } // tolerate non-JSON frames
    const type = String(msg.message_type ?? "");

    if (type === "SESSION_CREATED") {
      if (!this.ready) this.onReady(String(msg.session_id ?? ""), Number(msg.credit_balance ?? 0));
      return;
    }
    if (type === "PARTIAL_TRANSCRIPT") {
      this.partialCount++;
      this.msToFirstPartial ??= performance.now() - this.startedAt;
      this.handlers.onPartial?.(String(msg.transcript ?? ""));
      return;
    }
    if (type === "COMMITTED_TRANSCRIPT") {
      this.succeed(msg);
      return;
    }
    const fatal = fatalInfo(type);
    if (fatal) {
      this.fail(type, String(msg.message ?? msg.status ?? type), {
        recoverable: fatal.recoverable,
        providerEvent: type,
      });
    }
    // Unknown, non-terminal messages are ignored for forward compatibility.
  }

  private succeed(msg: Record<string, unknown>): void {
    if (this.settled) return;
    this.settled = true;
    this.stage = "done";
    this.clearTimers();
    const now = performance.now();
    const result: StreamResult = {
      transcript: String(msg.transcript_text ?? ""),
      transcriptId: (msg.transcript_id as string) ?? null,
      audioLen: (msg.audio_len as number) ?? null,
      partialCount: this.partialCount,
      msToFirstPartial: this.msToFirstPartial,
      msTotal: now - this.startedAt,
      msStopToFinal: this.commitAt != null ? now - this.commitAt : null,
    };
    try { this.ws.close(); } catch { /* already closing */ }
    this.handlers.onFinal(result);
  }

  private onClose(code: number, reason: string): void {
    if (this.settled) return;
    // A close before a final transcript is a real failure. Pre-session it is also a
    // cheap reconnect point; post-session it is terminal. Preserve what happened.
    this.maybeRetry("CLOSED_EARLY", "the connection closed before a transcript was committed", {
      recoverable: true,
      closeCode: code,
      closeReason: reason,
    });
  }

  private fail(
    code: string,
    message: string,
    detail: { recoverable?: boolean; providerEvent?: string; closeCode?: number; closeReason?: string },
  ): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    const err = new IntronStreamError(message, code, { ...detail, stage: this.stage });
    try { this.ws.close(); } catch { /* already closing */ }
    this.handlers.onError(err);
  }

  /** Diagnostics for the current (unsettled or settled) session, safe to log. */
  metrics(): { originalBytesSent: number; padBytesSent: number; partialCount: number; stage: StreamStage } {
    return {
      originalBytesSent: this.originalBytesSent,
      padBytesSent: this.padBytesSent,
      partialCount: this.partialCount,
      stage: this.stage,
    };
  }
}

/**
 * Send one utterance of PCM16 mono audio and resolve with the committed transcript.
 * One short session per utterance: the socket cannot be resumed, so keeping
 * sessions brief bounds what a drop can cost.
 */
export function transcribeStream(pcm16: Buffer, opts: StreamOptions): Promise<StreamResult> {
  const sampleRate = opts.sampleRate ?? 16000;
  const url = buildUrl(opts.language, sampleRate);
  const wsFactory = opts.wsFactory ?? defaultWsFactory;

  return new Promise<StreamResult>((resolve, reject) => {
    // `onAbort` closes over `core`; it is only ever invoked after construction below.
    const onAbort = () => core.cancel();

    const core = new SessionCore(url, { Authorization: `Bearer ${opts.apiKey}` }, opts.deadlines, wsFactory, {
      onOpen: opts.onOpen,
      onPartial: opts.onPartial,
      onFinal: (r) => { opts.signal?.removeEventListener("abort", onAbort); resolve(r); },
      onError: (e) => { opts.signal?.removeEventListener("abort", onAbort); reject(e); },
    }, opts.maxAttempts, opts.paceMs);

    if (opts.signal?.aborted) { core.cancel(); return; }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // Whole utterance is known up front: queue it, then request commit. Readiness
    // gating and tail handling are enforced by the core, not here.
    core.push(pcm16);
    core.commit();
  });
}

/* ------------------------------------------------------------------------- */

export type SessionEvent =
  | { type: "open"; sessionId: string; creditBalance: number }
  | { type: "partial"; text: string }
  | { type: "final"; result: StreamResult }
  | { type: "error"; code: string; message: string; detail: IntronStreamError["detail"] };

/**
 * Incremental session: audio is forwarded to Intron as it arrives rather than
 * buffered until the speaker stops. This is what makes partial transcripts appear
 * while someone is still talking, which is the difference between a voice product
 * and a recorder with extra steps.
 *
 * Backed by the same SessionCore as `transcribeStream`, so readiness gating,
 * packetisation and tail handling are identical across both entry points.
 */
export class IntronStreamSession {
  private core: SessionCore;

  constructor(
    opts: { apiKey: string; language: LanguageCode; sampleRate?: number; deadlines?: Partial<Deadlines>; wsFactory?: WsFactory; maxAttempts?: number; paceMs?: number },
    private emit: (e: SessionEvent) => void,
  ) {
    const url = buildUrl(opts.language, opts.sampleRate ?? 16000);
    const wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.core = new SessionCore(url, { Authorization: `Bearer ${opts.apiKey}` }, opts.deadlines, wsFactory, {
      onOpen: (s) => emit({ type: "open", ...s }),
      onPartial: (text) => emit({ type: "partial", text }),
      onFinal: (result) => emit({ type: "final", result }),
      onError: (e) => emit({ type: "error", code: e.code, message: e.message, detail: e.detail }),
    }, opts.maxAttempts, opts.paceMs);
  }

  /** Queue PCM16 audio. Safe to call before the socket has opened. */
  push(chunk: Buffer): void { this.core.push(chunk); }

  /** Signal end of utterance. Intron replies with COMMITTED_TRANSCRIPT, then closes. */
  commit(): void { this.core.commit(); }

  /** Abandon the session (user cancelled / navigated away). */
  close(): void { this.core.cancel(); }

  /** Redacted diagnostics for logging. */
  metrics() { return this.core.metrics(); }
}

export const _internal = { MIN_CHUNK, MAX_CHUNK, CHUNK, FATAL };
