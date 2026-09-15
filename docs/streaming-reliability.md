# Sahara streaming reliability — root cause and fix

_Branch: `fix/sahara-transcription-reliability`. Audited and fixed against commit
`56e952410f295deb67310a1a27980684ec5881ca` (main, 2026-09-12)._

## Reported failure

> "I recorded my voice and it was taking a whole lot of time and at the end it
> showed the socket closed before the transcript was committed."

That message is generated locally by the streaming client
(`web/src/lib/speech/intron-stream.ts`), not by the provider. It marked the stage
that failed — a socket close before a committed transcript — but threw away every
detail of *why*, and there was no bounded wait, so a slow or dropped session
presented as a long hang ending in one opaque error.

## What was actually wrong

Each item below was reproduced by direct execution against this checkout, or read
directly from source. The exact deployed-session cause was **not** reproduced (no
Intron credentials, no permitted audio fixture, and `web/src/app/page.tsx` is a
placeholder with no product recorder UI to drive).

| # | Defect | Evidence | Status |
|---|--------|----------|--------|
| 1 | `transcribeStream()` discarded a sub-1KB audio tail | 8992 input PCM bytes → 8192 sent, **800 dropped** (the trailing slice was `break`-ed away). The incremental session *padded* the same tail — the two disagreed. | Reproduced |
| 2 | Audio was sent on transport `open`, before `SESSION_CREATED` | Both helpers looped and sent on the socket `open` event. Not the documented order. | Source |
| 3 | No application-level deadlines | No bound on connect, service readiness, or commit→final. This is the "taking a whole lot of time". | Source |
| 4 | Close code/reason discarded | The `close` handler collapsed every early close into a generic `CLOSED_EARLY` with no diagnostics. | Source |
| 5 | Canonical error spelling ignored | `FATAL` matched legacy `CHUNCK_SIZE_TOO_SMALL` but not canonical `CHUNK_SIZE_TOO_SMALL`, so that error → close → `CLOSED_EARLY`. | Source |
| 6 | Normal completion already guarded | `COMMITTED_TRANSCRIPT` then close already resolved once. **Not** broken; preserved as-is. | Source |

## The fix

Both entry points (`transcribeStream` and `IntronStreamSession`) now delegate to a
single `SessionCore` state machine, so readiness gating, packetisation, tail
handling and terminal-state logic have exactly one implementation.

- **Readiness gating.** Audio is queued while connecting and released only after
  `SESSION_CREATED`. Transport `open` is distinguished from service readiness.
- **Deferred, one-time commit.** A commit requested before readiness/drainage is
  remembered and performed after the audio drains. Repeated `commit()` never
  produces a second upstream `COMMIT`.
- **Whole utterance preserved.** The packetiser emits 1KB..32KB frames covering
  every byte. A final remainder under 1KB is kept by borrowing from the previous
  frame; only a whole utterance smaller than 1KB is padded with silence, and that
  padding is tracked apart from real audio (`metrics().padBytesSent`).
- **Bounded waiting.** Configurable deadlines — `connectMs`, `readyMs`,
  `finalizeMs` (defaults 10s / 10s / 20s) — each produce exactly one typed
  terminal error. They sit well inside Intron's 300s session and 60s idle ceilings;
  `finalizeMs` reserves time for the provider to commit. Override per call when a
  real trace justifies it.
- **Honest diagnostics.** `IntronStreamError.detail` carries `stage`, the original
  `providerEvent` (misspellings preserved), `closeCode`, `closeReason`, and a
  `recoverable` flag (a bad key or exhausted credit is not recoverable; a transient
  capacity error or an early close may be). Durations use a monotonic clock and
  report `msStopToFinal` separately from `msTotal`.
- **Settle exactly once.** Stale messages after success/failure/cancel are ignored;
  timers and the socket are released on every terminal path.
- **Testable without keys.** A `wsFactory` option injects the WebSocket, so the
  regression suite drives a fake upstream with no network or credentials.

## Verified against the live endpoint

A real streaming round trip through the rewritten client succeeded against
`wss://infer.voice.intron.io/stt/v1/stream` with a configured `INTRON_API_KEY`:

```
audio: 9.63s  308088 bytes PCM16 @16k mono
--- use_language_asr_input=pcm ---
  session 4e5be7eb…  credits 1509.35
  partial: Good afternoon
  ... (4 partials)
  partials=4  firstPartial=5459ms  stopToFinal=9662ms  total=11513ms
  FINAL: "Good afternoon, please record an invoice for 5 bags of cement at 12500 ...
          125 naira each for customer mosa"
```

This confirms auth handshake, readiness gating, packetisation, commit and the final
transcript end to end, plus the WAV path on real 22.05kHz→16kHz input (duration
preserved 9.63s→9.63s). The clip is Windows SAPI **English TTS** used only to smoke
the pipeline — it is **not** a code-switching or quality benchmark, and the mixed
`12500`/`125 naira` reading is the provider's output on synthetic speech, not a
client bug. `web/scripts/smoke-intron.mts` now validates its language argument,
prints redacted diagnostics, and exits non-zero on failure.

## Not done here (needs external inputs)

- Live validation with **real Nigerian code-switched speech** (the run above used
  synthetic English TTS; product-quality per language pair still needs human clips).
- A Sahara **file-transcription fallback** for recoverable streaming failures — the
  REST contract could not be verified from the docs during the audit, so it is left
  unimplemented rather than guessed.
- The product recorder UI (`page.tsx` is still a placeholder).

See `web/tests/intron-stream.test.ts` for the regression matrix and
`web/tests/wav.test.ts` for the resampler fix.

## Production incident: "Invalid WebSocket frame: FIN must be set"

On the Render deployment, recording from a phone intermittently failed with
`Invalid WebSocket frame: FIN must be set` (the `ws` library's
`WS_ERR_EXPECTED_FIN`). The WebSocket spec forbids fragmented control frames; some
proxies between the gateway and Intron deliver a control frame with FIN unset, and
`ws` rejects it — a **transport/protocol** failure, not bad audio. It surfaced as a
raw error and destroyed the recording.

### Fix: an Intron **file-transcription fallback** (same provider, different transport)

Streaming stays the primary path. The gateway now also keeps a **bounded in-memory
copy** of the current utterance (PCM16, capped at 60s ≈ 1.92 MB — fits Intron's 120s
file limit). On a **recoverable** streaming failure the recording is not lost:

- **breaks while speaking** → the gateway marks the session degraded and tells the
  browser *"Keep speaking — we'll process your recording when you stop."*; the mic
  keeps recording and buffering.
- **breaks after Stop/commit** → the gateway immediately runs the fallback.

The fallback (`web/src/lib/speech/intron-file.ts`) wraps the buffered PCM into a WAV
with the app's own `encodeWav` (no ffmpeg) and POSTs it to Intron's sync file API
(`POST https://infer.voice.intron.io/file/v1/upload/sync`, multipart
`audio_file_name`/`audio_file_blob`/`use_language_asr_input`, `Authorization: Bearer`,
transcript at `data.audio_transcript`). This is **still Sahara/Intron** — no other
provider is introduced.

### Error classification

| Class | Codes | Behaviour |
|---|---|---|
| Recoverable transport | `WS_ERR_EXPECTED_FIN`/`SOCKET_ERROR`, `CLOSED_EARLY`, `CONNECT_TIMEOUT`, `READY_TIMEOUT`, `FINALIZE_TIMEOUT`, 5xx/429 on file | keep the recording → file fallback |
| Non-recoverable | `AUTHENTICATION_ERROR`, `QUOTA_EXCEEDED`, bad input | no retry/fallback; friendly "type instead" |

The user never sees a raw code — `web/src/lib/speech/errors.ts` maps everything to a
calm message. One transcript result wins (stream **or** file).

### Retry budget

Two layers were collapsed: the browser reconnects only if the **browser→gateway**
socket fails before a session; recovery from Intron's own transport errors is the
**gateway's** job (fallback), so the browser no longer reconnects on an upstream
error — preventing a retry storm.

### Verified

- Unit: `web/tests/intron-file.test.ts` (WAV validity, multipart + Bearer, key never
  in URL/body, 401→non-recoverable, 429/5xx→recoverable, no-transcript, timeout) and
  the error-mapper. Mocked fetch — no credits spent.
- Live: a real recording sent through the **file API** returned a correct transcript
  (≈9.6s audio, ~12s latency), confirming the fallback end to end.
