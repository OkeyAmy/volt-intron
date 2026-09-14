/**
 * Regression suite for the Sahara streaming lifecycle.
 *
 * The reported failure was an opaque "socket closed before the transcript was
 * committed" after a long wait. These tests pin the behaviours that make that
 * bounded and diagnosable, plus the audio-tail and readiness-gating bugs found in
 * the audit. A fake WebSocket stands in for the upstream so nothing here needs a
 * key, credits, or the network.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  transcribeStream,
  IntronStreamSession,
  IntronStreamError,
  type WebSocketLike,
  type WsFactory,
} from "@/lib/speech/intron-stream";

const OPEN = 1;
const CLOSED = 3;

/** A scriptable stand-in for `ws`. Tests fire provider events by hand.
 * Not declared `implements WebSocketLike` so the single `on` signature stays
 * simple; `withSocket` casts it to the interface at the injection boundary. */
class FakeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closeArgs: [number?, string?] | null = null;
  failSend = false;
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};

  on(event: string, cb: (...a: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  send(data: string, cb?: (err?: Error) => void): void {
    if (this.failSend) { cb?.(new Error("send boom")); return; }
    this.sent.push(JSON.parse(data));
    cb?.();
  }
  close(code?: number, reason?: string): void {
    if (this.closeArgs) return;
    this.closeArgs = [code, reason];
    this.readyState = CLOSED;
  }
  private emit(event: string, ...args: unknown[]): void {
    (this.handlers[event] ?? []).slice().forEach((h) => h(...args));
  }
  fireOpen(): void { this.readyState = OPEN; this.emit("open"); }
  fireMessage(obj: Record<string, unknown>): void { this.emit("message", Buffer.from(JSON.stringify(obj))); }
  fireError(msg: string): void { this.emit("error", new Error(msg)); }
  fireClose(code = 1000, reason = ""): void { this.readyState = CLOSED; this.emit("close", code, Buffer.from(reason)); }

  chunks(): Record<string, unknown>[] { return this.sent.filter((m) => m.message_type === "INPUT_AUDIO_CHUNK"); }
  commits(): Record<string, unknown>[] { return this.sent.filter((m) => m.message_type === "COMMIT"); }
  /** All audio bytes actually forwarded (padding included). */
  decodedAudio(): Buffer {
    return Buffer.concat(this.chunks().map((m) => Buffer.from(String(m.audio_base_64), "base64")));
  }
}

function withSocket(): { factory: WsFactory; socket: () => FakeSocket } {
  let sock: FakeSocket | null = null;
  return {
    factory: () => { sock = new FakeSocket(); return sock as unknown as WebSocketLike; },
    socket: () => { if (!sock) throw new Error("socket not created"); return sock; },
  };
}

afterEach(() => vi.useRealTimers());

const KEY = "test-key";

/** Await a promise expected to reject, returning the typed error. */
async function expectReject(p: Promise<unknown>): Promise<IntronStreamError> {
  try {
    await p;
    throw new Error("expected the stream to reject, but it resolved");
  } catch (e) {
    return e as IntronStreamError;
  }
}

describe("readiness gating", () => {
  it("sends no audio or commit before SESSION_CREATED", async () => {
    const { factory, socket } = withSocket();
    const p = transcribeStream(Buffer.alloc(4096, 1), { apiKey: KEY, language: "pcm", wsFactory: factory });

    socket().fireOpen();
    // Transport is open but the service has not confirmed the session yet.
    expect(socket().sent).toEqual([]);

    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s1", credit_balance: 5 });
    // Now, and only now, audio and the commit go out.
    expect(socket().chunks().length).toBeGreaterThan(0);
    expect(socket().commits().length).toBe(1);

    socket().fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "abeg" });
    await expect(p).resolves.toMatchObject({ transcript: "abeg" });
  });
});

describe("audio tail preservation", () => {
  it("forwards every byte of an 8992-byte utterance (the reproduced 800-byte tail)", async () => {
    const { factory, socket } = withSocket();
    const audio = Buffer.alloc(8992);
    for (let i = 0; i < audio.length; i++) audio[i] = i % 251;
    const p = transcribeStream(audio, { apiKey: KEY, language: "pcm", wsFactory: factory });

    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });

    // No discard: the forwarded audio equals the original exactly.
    expect(socket().decodedAudio().equals(audio)).toBe(true);

    socket().fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "ok" });
    await p;
  });

  it("pads a sub-1KB whole utterance rather than dropping it, and reports padding apart from audio", () => {
    const { factory, socket } = withSocket();
    const events: string[] = [];
    const session = new IntronStreamSession(
      { apiKey: KEY, language: "pcm", wsFactory: factory },
      (e) => events.push(e.type),
    );
    const tail = Buffer.alloc(800, 7);
    session.push(tail);
    session.commit();
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });

    // One frame went out, padded up to the 1KB floor...
    expect(socket().decodedAudio().length).toBe(1024);
    // ...but the first 800 bytes are the real audio, untouched.
    expect(socket().decodedAudio().subarray(0, 800).equals(tail)).toBe(true);
    // ...and the metrics keep real audio and silence apart.
    expect(session.metrics().originalBytesSent).toBe(800);
    expect(session.metrics().padBytesSent).toBe(224);
  });
});

describe("terminal states", () => {
  it("succeeds with no partials", async () => {
    const { factory, socket } = withSocket();
    const p = transcribeStream(Buffer.alloc(2048, 1), { apiKey: KEY, language: "pcm", wsFactory: factory });
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    socket().fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "no partials here" });
    const r = await p;
    expect(r.partialCount).toBe(0);
    expect(r.transcript).toBe("no partials here");
  });

  it("treats final-then-close as one success, not an early-close error", async () => {
    const { factory, socket } = withSocket();
    const p = transcribeStream(Buffer.alloc(2048, 1), { apiKey: KEY, language: "pcm", wsFactory: factory });
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    socket().fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "done" });
    socket().fireClose(1000, "normal"); // arrives right after the final; must be ignored
    await expect(p).resolves.toMatchObject({ transcript: "done" });
  });

  it("reports a close before final with its code and reason, marked recoverable", async () => {
    const { factory, socket } = withSocket();
    const p = transcribeStream(Buffer.alloc(2048, 1), { apiKey: KEY, language: "pcm", wsFactory: factory });
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    socket().fireClose(1006, "abnormal closure");
    const err = await expectReject(p);
    expect(err).toBeInstanceOf(IntronStreamError);
    expect(err.code).toBe("CLOSED_EARLY");
    expect(err.detail.closeCode).toBe(1006);
    expect(err.detail.closeReason).toBe("abnormal closure");
    expect(err.detail.recoverable).toBe(true);
  });

  it.each(["CHUNK_SIZE_TOO_SMALL", "CHUNCK_SIZE_TOO_SMALL"])(
    "preserves the %s error into a typed failure instead of collapsing to CLOSED_EARLY",
    async (variant) => {
      const { factory, socket } = withSocket();
      const p = transcribeStream(Buffer.alloc(2048, 1), { apiKey: KEY, language: "pcm", wsFactory: factory });
      socket().fireOpen();
      socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
      socket().fireMessage({ message_type: variant, message: "frame too small" });
      socket().fireClose(1000, ""); // must not overwrite the real error
      const err = await expectReject(p);
      expect(err.code).toBe(variant);
      expect(err.detail.providerEvent).toBe(variant);
      expect(err.detail.recoverable).toBe(false);
    },
  );
});

describe("bounded waiting", () => {
  it("fails with CONNECT_TIMEOUT when the socket never opens", async () => {
    vi.useFakeTimers();
    const { factory } = withSocket();
    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, deadlines: { connectMs: 1000 },
    });
    const settled = expectReject(p);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await settled).code).toBe("CONNECT_TIMEOUT");
  });

  it("fails with READY_TIMEOUT when SESSION_CREATED never arrives", async () => {
    vi.useFakeTimers();
    const { factory, socket } = withSocket();
    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, deadlines: { readyMs: 1000 },
    });
    const settled = expectReject(p);
    socket().fireOpen();
    await vi.advanceTimersByTimeAsync(1001);
    expect((await settled).code).toBe("READY_TIMEOUT");
  });

  it("fails with FINALIZE_TIMEOUT when no final follows the commit", async () => {
    vi.useFakeTimers();
    const { factory, socket } = withSocket();
    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, deadlines: { finalizeMs: 1000 },
    });
    const settled = expectReject(p);
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    await vi.advanceTimersByTimeAsync(1001);
    expect((await settled).code).toBe("FINALIZE_TIMEOUT");
  });
});

describe("robustness", () => {
  it("surfaces a send failure instead of losing audio silently", async () => {
    const { factory, socket } = withSocket();
    const p = transcribeStream(Buffer.alloc(2048, 1), { apiKey: KEY, language: "pcm", wsFactory: factory });
    socket().failSend = true;
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    expect((await expectReject(p)).code).toBe("SEND_FAILED");
  });

  it("never sends a second upstream COMMIT on repeated commit()", () => {
    const { factory, socket } = withSocket();
    const session = new IntronStreamSession({ apiKey: KEY, language: "pcm", wsFactory: factory }, () => {});
    session.push(Buffer.alloc(2048, 1));
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    session.commit();
    session.commit();
    session.commit();
    expect(socket().commits().length).toBe(1);
  });

  it("ignores a stale message arriving after success", async () => {
    const { factory, socket } = withSocket();
    let finals = 0;
    const session = new IntronStreamSession(
      { apiKey: KEY, language: "pcm", wsFactory: factory },
      (e) => { if (e.type === "final") finals++; },
    );
    session.push(Buffer.alloc(2048, 1));
    session.commit();
    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    socket().fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "first" });
    socket().fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "stale" });
    expect(finals).toBe(1);
  });

  it("rejects with ABORTED when the signal is already aborted", async () => {
    const { factory } = withSocket();
    const ac = new AbortController();
    ac.abort();
    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, signal: ac.signal,
    });
    expect((await expectReject(p)).code).toBe("ABORTED");
  });

  it("closes the socket on abort mid-flight", async () => {
    const { factory, socket } = withSocket();
    const ac = new AbortController();
    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, signal: ac.signal,
    });
    socket().fireOpen();
    ac.abort();
    expect(socket().closeArgs).not.toBeNull();
    expect((await expectReject(p)).code).toBe("ABORTED");
  });
});

describe("opt-in reconnect (pre-session retry)", () => {
  it("reconnects before SESSION_CREATED, at most maxAttempts times, then succeeds", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory: WsFactory = (() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocketLike;
    }) as WsFactory;

    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, maxAttempts: 3,
    });

    sockets[0].fireOpen();
    sockets[0].fireError("upstream hiccup");
    await vi.advanceTimersByTimeAsync(250); // backoff -> attempt 2
    expect(sockets.length).toBe(2);

    sockets[1].fireOpen();
    sockets[1].fireClose(1006, "burst");
    await vi.advanceTimersByTimeAsync(500); // backoff -> attempt 3
    expect(sockets.length).toBe(3);

    sockets[2].fireOpen();
    sockets[2].fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    sockets[2].fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "recovered" });
    await expect(p).resolves.toMatchObject({ transcript: "recovered" });
  });

  it("surfaces CLOSED_EARLY once pre-session attempts are exhausted", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory: WsFactory = (() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocketLike;
    }) as WsFactory;

    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, maxAttempts: 2,
    });

    sockets[0].fireOpen();
    sockets[0].fireClose(1006, "");
    await vi.advanceTimersByTimeAsync(250);
    sockets[1].fireOpen();
    sockets[1].fireClose(1006, "");
    const err = await expectReject(p);
    expect(err.code).toBe("CLOSED_EARLY");
    expect(err.detail.closeCode).toBe(1006);
  });

  it("does not retry a failure that happens after the session exists", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory: WsFactory = (() => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocketLike;
    }) as WsFactory;

    const p = transcribeStream(Buffer.alloc(2048, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, maxAttempts: 3,
    });
    sockets[0].fireOpen();
    sockets[0].fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });
    sockets[0].fireClose(1006, "abnormal closure");
    const err = await expectReject(p);
    expect(err.code).toBe("CLOSED_EARLY");
    expect(sockets.length).toBe(1);
  });
});

describe("opt-in pacing (whole-utterance clients)", () => {
  it("releases one frame at a time and defers COMMIT until the queue drains", async () => {
    vi.useFakeTimers();
    const { factory, socket } = withSocket();
    // 40KB > MAX_CHUNK (32KB), so flush produces at least two frames.
    const p = transcribeStream(Buffer.alloc(40000, 1), {
      apiKey: KEY, language: "pcm", wsFactory: factory, paceMs: 100,
    });

    socket().fireOpen();
    socket().fireMessage({ message_type: "SESSION_CREATED", session_id: "s", credit_balance: 1 });

    // First frame goes out immediately; the second and the COMMIT are queued.
    expect(socket().chunks().length).toBe(1);
    expect(socket().commits().length).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(socket().chunks().length).toBe(2);
    expect(socket().commits().length).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(socket().commits().length).toBe(1);

    socket().fireMessage({ message_type: "COMMITTED_TRANSCRIPT", transcript_text: "paced" });
    await expect(p).resolves.toMatchObject({ transcript: "paced" });
  });
});
