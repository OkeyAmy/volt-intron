# Research log — verified facts

Every claim here was verified by a live call or an official source. Documentation-derived
claims are marked **[doc]**; things we observed ourselves are marked **[observed]** with a date.

---

## 1. Credentials (2026-09-11)

- `.env` holds two Intron keys (one commented). **Both authenticate.** [observed]
- Auth probe: `GET /file/v1/status/probe-nonexistent-id` with a valid key returns
  `HTTP 500 {"message":"file not found"}`. An invalid key returns
  `403 {"message":"permission denied,access-key error"}`. So **a 500 here means auth passed**.
- **Undocumented status code:** the docs describe only 200/400/503. We observed **500** for a
  missing resource. Never branch on documented codes alone. [observed]

## 2. Credit budget — a real constraint (2026-09-11)

`SESSION_CREATED.credit_balance` was **1526.55** at first use.
A 4.88 s streaming call consumed **2.15 credits** ⇒ **≈0.44 credits per second of audio**.

> A 100-clip × 5 s benchmark run costs ≈220 credits. We have room for roughly 6–7 full runs.
> **Every ASR call must be cached on disk and keyed by (audio hash, model, language).**

## 3. Streaming STT works, and forces our architecture (2026-09-11) [observed]

`wss://infer.voice.intron.io/stt/v1/stream?sample_rate=16000&bit_rate=16&num_channels=1&use_language_asr_input=<code>`
with `Authorization: Bearer` **as a handshake header**. Confirmed working from Python
(`websockets`, `additional_headers`). Browsers cannot set WS handshake headers ⇒ **the backend
gateway is mandatory, not a design preference.**

- `SESSION_CREATED.configs` echoes an undocumented **`use_language_asr_output`**, which mirrors
  the input language. `use_prompt_id` is present and null.
- **Partials are sparse** — 1–2 for a 4.9 s clip, not word-by-word. The UI must not promise
  word-level live captions.
- Field name changes between messages: `PARTIAL_TRANSCRIPT.transcript` vs
  `COMMITTED_TRANSCRIPT.transcript_text`.

## 4. THE HEADLINE FINDING: catastrophic money errors are real (2026-09-11) [observed]

Same audio, same session, only `use_language_asr_input` differs.

**Ground truth:** *"Your total na sixty-four thousand five hundred naira. Make I create am?"*

| Language code | Transcript | Money outcome |
|---|---|---|
| `pcm` (Pidgin–English) | "Your total na **645** naira make i clean am" | **₦645 — wrong by 100×** |
| `en` (English) | "Your total na **64,500** naira. Nikai Cream. Make I create harm." | Correct number, mangled words |

Two things follow, and they are the spine of the submission:

1. **A word error and a money error are not the same thing.** The `pcm` transcript is arguably
   *more* fluent, yet it is the one that would have issued an invoice for 1/100th of the value.
   WER cannot see this. Our outcome taxonomy can.
2. **Language-code choice materially changes the result**, and there is no auto-detection.
   This makes the planned language-code mismatch experiment clearly worth running.

> Caveat: this clip is Intron TTS output, which is out-of-distribution for ASR. It is a
> **protocol smoke test, not evidence**. Real human speech (SautiBench) is what we will report.
> We record it here because it shaped the design, not because it is a result.

## 5. TTS works but is slow — design around it (2026-09-11) [observed]

`POST /tts/v1/generate`, `voice_language`/`voice_accent`/`voice_gender`.

| Text | Chars | Audio out | Wall time |
|---|---|---|---|
| Short Pidgin confirmation | 72 | 4 s | **9.2 s** |
| Longer English/Yoruba | 324 | 29 s | **18.7 s** |

- **Character-limit contradiction resolved:** the documented "100" is wrong — **324 chars were
  accepted**. The real ceiling is higher than 100; we simply keep responses short anyway.
- **Latency ≈ 5 s fixed overhead + ~0.6× audio duration.** Far too slow to block a
  conversational turn.
- **`audio_path` is served over plain `http://` S3.** An HTTPS app embedding it directly would
  hit mixed-content blocking ⇒ **proxy TTS audio through our backend.**

**Design consequences:** TTS never blocks the UI — text renders immediately, audio attaches when
it arrives. Clarification prompts come from a bounded template set, so they are **pre-generated
and cached by text hash**; only totals need live synthesis.

## 6. Verified language codes [doc + observed]

Code-switched pairs, set via `use_language_asr_input`: `yo` Yoruba–English · `ig` Igbo–English ·
`ha` Hausa–English · `pcm` Pidgin–English. `pcm` and `en` both confirmed working live.
There is **no `model` parameter** — "Sahara v2.5" is selected implicitly by these codes, and no
response field identifies which model served the request. We will describe exactly what we
invoked and never assert a version we cannot verify.
