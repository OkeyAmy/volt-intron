# Sautice STT Benchmark — Locked Plan (v4)

Date: 2026-09-15. Status: **locked**, building.

## 1. Goal

Measure 4 speech-to-text providers on Nigerian / African-accented speech, scored two ways:

- **Track 1 — ASR quality:** Word Error Rate (WER) and Character Error Rate (CER) against
  frozen reference transcripts, via `jiwer` + `whisper-normalizer` normalization.
- **Track 2 — Money outcome:** transcript is pushed through the Sautice invoice engine
  (`heuristic_extract` → `build_draft` + `sautice.nlp.naira`) and scored on whether the
  final invoice fields match ground truth kobo. This is the metric that pays for a
  voice-to-invoice product: a missed word only matters if it moves money.

Every provider runs on the **same** clips (16 kHz mono WAV), the **same** per-provider
language hints, and the **same** timeouts. Reference transcripts are frozen before the
first provider score is produced.

## 2. Corpus (final, ~70 clips, open-access only, ≤ 2.5 GB pull)

| Source | Split / files | Rows | Pull MB | Clips |
|---|---|---|---|---|
| `asr-nigerian-pidgin/nigerian-pidgin-1.0` (CC-BY-4.0, open) | `data/train-00000-of-00002-06caf65bef6a8834.parquet` | 1,518 | 298.8 | 10 (Pidgin) |
| `AlaminI/nigerian_common_voice_dataset` (Apache-2.0, open) | `{english,hausa,igbo,yoruba}/train-00000-of-00001.parquet` | 22,295 | 551.4 | 20 (5/language) |
| `McGill-NLP/NaijaS2ST` **dev only** (CC BY 4.0, open) | `data/dev-0000..0002-of-00012.parquet` (scan-and-stop) | 7,500 (dev) | ~1,537 cap 1,650 | 30 (10 × EN/EY/EB) |
| SautiBench → Intron TTS | Intron TTS (live API) | — | 0 | 10 (synthetic) |

- **Pull-then-build.** Downloads are whole-file, resumable (`huggingface_hub` byte-resume) because
  the network is unstable; streaming is rejected. After sampling, the raw parquet caches are purged.
- **Sampling at build time.** `load_data.py` scans the local parquet, keeps clips with speaker
  accents represented in Sautice's market, samples the *shortest* clips in the 3–20 s band to hit
  targets, resamples to 16 kHz mono, writes `data/audio/16k/*.wav`, and freezes
  `data/pilot_manifest.csv`. All randomness is seeded.
- **NaijaS2ST strategy.** Dev shards are downloaded one at a time in order and scanned locally for
  `EN*` / `EY*` / `EB*` (Northern / Southern / British-Nigerian accents, recovered from the clips's
  `user_id` prefix). Keep a shard only if it contains accent rows; stop when 30 clips are banked or
  the cap is hit. The datasets-server `/filter` API is unreliable (HTTP 500 / index loading) so the
  code never depends on it. If the cap hits before 30 clips, fewer clips are banked and the report
  records the degradation.
- **Gated/removed:** `intronhealth/AfriSwitch`, `intronhealth/afrispeech-200`, `SilencioNetwork/*`,
  `benjaminogbonna/nigerian_accented_english_dataset` (CV-derived), `Tushe/nigerian-speech-accent`
  (poor quality + unclear license), `asapp/mass`, `UBC-NLP/MaSS` — all excluded.

## 3. Providers (Track 1 + Track 2)

| id | Provider | Model | Language hint |
|---|---|---|---|
| `intron_sahara` | Intron Sahara — `wss://infer.voice.intron.io/stt/v1/stream?sample_rate=16000&bit_rate=16&num_channels=1&use_language_asr_input=<code>` | Sahara | native ISO code per clip |
| `groq_whisper` | Groq (OpenAI-compatible) | `whisper-large-v3-turbo` | en; pidgin→en |
| `gemini` | Google REST `generateContent` | `gemini-3-flash-preview` | prompt says "spoken <lang>" |
| `elevenlabs` | ElevenLabs REST `/v1/speech-to-text` | `scribe_v1` | `language_code` per clip |

ASR provider interface (all four fit it):

```python
class ASRProvider(ABC):
    name: str
    def transcribe(self, audio_path: str, language: str, timeout_s: float = 120) -> Result:
        # Result = {"text": str, "provider": str, "audio": str, "language": str,
        #           "latency_s": float, "audio_sec": float, "ok": bool, "error": Optional[str]}
```

## 4. Layout

```
benchmarks/
  PLAN.md
  load_data.py          # phase 1 pull + phase 2 build (offline); idempotent
  run.py                # phase 3 orchestration: providers x cells, caching, report
  providers/            # base.py (ABC + Result), registry.py, intron_sahara.py,
                        #   groq_whisper.py, gemini.py, elevenlabs.py
  eval/                 # metrics.py, money_outcome.py, sautibench_tts.py
  data/                 # pilot_manifest.csv (frozen), audio/16k/*.wav,
                        #   corpora/ (pulled parquet, purged after build),
                        #   sautibench/ (scenarios.json, roster.json, prompts.jsonl, tts/*.wav)
  outputs/<tag>/        # per_cell.jsonl, results.json, report.md
```

## 5. Frozen policy

1. Same clips, same 16 kHz mono files, same timeouts for all providers.
2. Reference transcripts frozen in the manifest before any provider runs.
3. WER/CER normalization (jiwer + whisper-normalizer, inaudible-tag and filler cleaning from
   `Intron-Multimodal-Benchmarking`) is locked before the first score.
4. Money pipeline uses the checked-in `sautice` engine and the SautiBench roster/scenarios only.
   TTS-synth rows are labelled `source=synthetic` and never mixed into per-accent aggregates.
5. Contamination log: any clip whose normalised reference matches a provider hypothesis verbatim
   is flagged, not assumed clean.

## 6. Efficiency & budget guardrails

- Intron balance ~1530 credits; burn ≈ 0.44 credits/s. Budget for ~250 credits
  (~70 clips × ~8 s audio × 0.44). **Hard stop at 200 credits remaining.**
- Results cached per `(provider, audio_hash)` in `outputs/cache/` so re-runs never re-spend.
- Timeline: pull/build ~10–20 min; Track 1 ~5–10 min; Track 2 ~instant (local engine).
- Venv: reverts to `jiwer whisper-normalizer pandas huggingface_hub pyarrow openai python-dotenv`
  (the `datasets` package is skipped — it pulls heavy transitive deps and we do whole-file pull +
  local parquet scanning, so `huggingface_hub` + `pyarrow` are enough).

## 7. Execution order

1. `PLAN.md` (this file) — locked. ✅
2. Dev deps installed (`uv add --dev`).
3. `load_data.py` runs: pull files → scan → sample → resample → purge caches → freeze manifest.
4. Providers implemented and ported from `Intron-Multimodal-Benchmarking/scripts/models/`.
5. `eval/` implemented (metrics, money_outcome, sautibench_tts).
6. Smoke run: `intron_sahara` alone over the 10 EN clips (~30 credits) to validate env + pipeline.
7. Full run: all 4 providers × ~70 cells; report to `outputs/<tag>/report.md`.