# Sautice STT Benchmark

Compares ASR providers on **Nigerian / West-African-accented speech** for the
Sautice voice-to-invoice product. Two tracks with deliberately different
validity claims.

## Tracks

| Track | What it measures | Method | Comparability |
|---|---|---|---|
| **Track 1 — ASR quality** | Raw transcription accuracy | WER/CER via `jiwer` over open, human-transcribed corpora, with frozen whisper-normalizer preprocessing, stratified by accent/language | Industry-standard (OpenASR / MLPerf-style). This is the headline number. |
| **Track 2 — product probe** | Voice → invoice accuracy of the *Sautice stack* | Transcription fed through the Sautice heuristic invoice parser (customer match, quantities, prices); scored exact / off≤10% / catastrophic / blocked | **NOT a benchmark.** Scores conflate ASR + parser and don't transfer outside Sautice. Reported only to guide Sautice's provider choice. |

## Corpus (Track 1)

60 human clips, all open-license, pulled and pinned locally by
`benchmarks.load_data` (Phase 1 pull, Phase 2 build). Nothing is streamed at
test time — the 16k mono wavs live on disk.

| Source | Clips | Languages |
|---|---|---|
| `asr-nigerian-pidgin` (v1.0) | 10 | pidgin |
| AlaminI Nigerian Common Voice | 20 | english, hausa, igbo, yoruba (5 each) |
| McGill-NLP NaijaS2ST (dev shards) | 30 | english (EN ×15 + EY ×15 from dev-00000; EB unavailable there) |

Verify the manifest: `uv run python -m benchmarks.load_data --info` (or read
`benchmarks/data/pilot_manifest.csv`).

## Track 2 assets

- **Recorded briefs** (primary): real human recordings of the SautiBench money
  scripts in `benchmarks/data/created/` (voice = PII, git-ignored), mapped to
  scenarios by `benchmarks/data/created/mapping.json` (committed).
- **Synthetic TTS briefs** (deprecated auxiliary): Intron-TTS clips under
  `benchmarks/data/sautibench/tts/` (git-ignored; regenerable).

Ingest your own recordings:

```
uv run python -m benchmarks.run \
  --add-recordings benchmarks/data/created \
  --add-recordings-mapping benchmarks/data/created/mapping.json
```

## Providers

| Provider | Env keys | Default model | Notes |
|---|---|---|---|
| intron_sahara | `INTRON_API_KEY` | Sahara streaming STT | 0.44 credits per audio-second; motel retry+backoff against server throttle |
| groq_whisper | `GROQ_API_KEY` | `whisper-large-v3-turbo` | OpenAI-compatible endpoint |
| gemini | `GEMINI_API_KEY`, `GEMINI_API_KEY_2` (…also `GENAI_API_KEY`, `GOOGLE_API_KEY`) | `gemini-3-flash-preview` | Keys rotate automatically on 429/quota with backoff |
| elevenlabs | `ELEVENLABS_API_KEY` | `scribe_v1` | Rest single-audio upload |

Providers with missing env keys are auto-skipped.

## Usage

```
# 1. (once) build the corpus — downloads ~1.5 GB, resumable
uv run python -m benchmarks.load_data

# 2. score: cached cells are never re-billed; re-runs are free
uv run python -m benchmarks.run --tag pilot --balance 1353.77
uv run python -m benchmarks.run --providers groq_whisper gemini elevenlabs --tag pilot
```

Results land in `benchmarks/outputs/<tag>/`:

- `report.md` — human-readable, two-track tables
- `results.json` — full summary (per-provider WER/CER, breakdowns, money outcomes)
- `cost.json` — cost ledger (see below)
- `per_cell.jsonl` — per-utterance rows incl. transcripts (local only, git-ignored)

## Cost transparency

Billing is a real constraint, so spend is tracked at three levels:

1. **Per run, stdout:** `est fresh Intron burn this run ~N credits` plus
   `[cache]` vs `[ok]` markers so you see exactly which cells were billed.
2. **`cost.json`** (committed): projected full-corpus Intron cost
   (`0.44 × audio_sec`), audio seconds per provider, fresh cells vs cache hits
   for that run, and the `--balance` snapshot you passed in.
3. **Hard-stop:** the runner aborts before it would push the Intron balance
   under the floor (`--balance` – 200).

Pass `--balance` the real Intron balance you read from
https://voice.intron.io dashboard. Cache only stores successful cells — failed
calls are never cached and will re-bill on retry.

## Reproducibility & what's local

| Artifact | Git | Why |
|---|---|---|
| `pilot_manifest.csv`, `pilot_manifest_info.json`, `mapping.json`, `record_prompts.md` | committed | provenance / config, tiny |
| `outputs/*/report.md`, `results.json`, `cost.json` | committed | aggregate evidence |
| `data/hub_cache/` (2.8 GB parquet) | ignored | regenerable via `load_data`; pull is resumable |
| `data/**/audio/` (16k wavs) | ignored | regenerable, large |
| `data/sautibench/tts/` | ignored | AI-generated, credits to recreate |
| `data/created/*.m4a` + `recorded_*.wav` | ignored | voice = PII |
| `outputs/cache/`, `outputs/*/per_cell.jsonl` | ignored | credit cache + transcripts must stay local |

To rebuild everything from a clean clone: set the four provider keys,
`uv run python -m benchmarks.load_data`, then re-run. The only things that
cannot be rebuilt are the user recordings (kept locally) and provider credits.

## Frozen scoring policy

Normalization + the Sautice money parser are locked before any provider score
is produced; changing them after results exist invalidates the comparison.
See `benchmarks/eval/metrics.py` and `benchmarks/eval/money_outcome.py`.