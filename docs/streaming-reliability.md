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

## Not done here (needs external inputs)

- The live browser→gateway→Sahara recording (needs `INTRON_API_KEY` + a permitted
  audio fixture; `web/scripts/smoke-intron.mts` still points at a `fixtures/`
  file that is absent from the tree).
- A Sahara **file-transcription fallback** for recoverable streaming failures — the
  REST contract could not be verified from the docs during the audit, so it is left
  unimplemented rather than guessed.
- The product recorder UI (`page.tsx` is still a placeholder).

See `web/tests/intron-stream.test.ts` for the regression matrix and
`web/tests/wav.test.ts` for the resampler fix.
