# Sautice STT Benchmark

Compares ASR providers on **Nigerian / West-African-accented speech** for the
Sautice voice-to-invoice product. Two tracks with deliberately different
validity claims.

## Tracks

| Track | What it measures | Method | Comparability |
|---|---|---|---|
| **Track 1 — ASR quality** | Raw transcription accuracy | WER/CER via `jiwer` over open, human-transcribed corpora, with frozen whisper-normalizer preprocessing, stratified by accent/language | Industry-standard (OpenASR / MLPerf-style). This is the headline number. |
| **Track 2 — product probe** | Voice → invoice accuracy of the *Sautice stack* | Transcription fed through the Sautice heuristic invoice parser (customer match, quantities, prices); scored exact / off≤10% / catastrophic / blocked | **NOT a benchmark.** Scores conflate ASR + parser and don't transfer outside Sautice. Reported only to guide Sautice's provider choice. |
| **Track 3 — code-switched speech** | WER/CER and invoice outcome on **code-switched** speech (Pidgin/Yoruba/Igbo/Hausa + English) | Consented recordings from `scripts/recorder`, human verbatim references (`data/sautibench/TRANSCRIPTION.md`), same frozen normalisation; invoice scored over all clips and over clips where the human reference itself yields the exact invoice | A controlled, consented commerce **read-speech** benchmark — not spontaneous conversation. Small n; reported with n, speakers and audio seconds. |

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

## References — data sources

| Source | Link | Usage here |
|---|---|---|
| Nigerian pidgin v1.0 | https://huggingface.co/datasets/asr-nigerian-pidgin/nigerian-pidgin-1.0 | 10 clips (train split) |
| AlaminI Nigerian Common Voice | https://huggingface.co/datasets/AlaminI/nigerian_common_voice_dataset | 20 clips, 5 per language: english/hausa/igbo/yoruba (train split) |
| McGill-NLP NaijaS2ST | https://huggingface.co/datasets/McGill-NLP/NaijaS2ST | 30 clips, EN ×15 + EY ×15 (dev split, dev-00000) |
| Intron Multimodal Benchmarking (methodology colone) | https://github.com/intron-innovation/Intron-Multimodal-Benchmarking | Reference harness + published per-language WER baselines (Sahara, Gemini, Whisper-derived) for cross-checks |

Methodology references: NIST OpenASR evaluation plan (sclite WER/CER scoring)
https://www.nist.gov/itl/iad/mltg/openasr-challenge · Open ASR Leaderboard
(WER + RTFx, normalization, transparency) https://arxiv.org/abs/2510.06961 ·
Gladia benchmarking guide https://docs.gladia.io/chapters/pre-recorded-stt/benchmarking ·
AssemblyAI how-to-evaluate https://www.assemblyai.com/blog/how-to-evaluate-speech-recognition-models

Metric references (2026 multilingual practice — why we report CER and NWER
alongside WER):
- OpenWER — cross-lingual scoring; language-specific normalization cuts
  multilingual WER up to ~25 pt vs whisper-normalizer+jiwer, so our WER for
  hausa/igbo/yoruba is an **upper bound** https://arxiv.org/abs/2606.21237
- FER/TER — WER misreads tonal/phonetic loss as lexical error for African
  languages (Yoruba BERT e.g. WER 78.8% vs CER 30.5%); complement with CER
  https://aclanthology.org/2026.africanlp-main.14/
- AfriVox-v2 — production metrics EWER/NWER (entity/numeric WER) as the
  deployment-critical numbers https://arxiv.org/abs/2605.03590

Splits/licenses are as declared on each Hugging Face dataset card; the
`dev` vs `train` split selection is frozen in `pilot_manifest_info.json`.

## Track 2 assets

- **Recorded briefs** (primary): the repository owner's own voice, reading the
  SautiBench money scripts. The **source files are committed** — `benchmarks/data/
  created/test1.m4a … test9.m4a` — for full transparency and auditability.
  The derived 16k mono wavs (`data/audio/16k/recorded_*.wav`) are _not_
  committed; they regenerate from the sources via `--add-recordings`.
- **Synthetic TTS briefs** (deprecated auxiliary): Intron-TTS clips under
  `benchmarks/data/sautibench/tts/` (git-ignored; regenerable).

### Recorded briefs manifest

| source | scenario | heard in transcript (Sahara) | duration | scoring status |
|---|---|---|---|---|
| `test1.m4a` | s01 | 5 …Dangote Cement…12,500…Adebayo Stores | 5.9s | mapped — scored |
| `test2.m4a` | s02 | 3…BUA…12,100 + 2…Emulsion…8,000…Chinedu | 8.2s | mapped — scored |
| `test3.m4a` | s03 | 10 lengths iron rod…8,500…Musa Hardware | 4.6s | mapped — scored |
| `test4.m4a` | — | *(ASR returned empty; re-record needed)* | 5.3s | held out — no mapping |
| `test5.m4a` | s05 | 1 trip Sharp Sand…85,000…Funmilayo Trading | 6.2s | mapped — scored |
| `test6.m4a` | s13 | 12…PVC pipe…4,200…Rahman Tijani | 7.0s | mapped — scored |
| `test7.m4a` | s28 | 3 trips granite…120,000 + 2 trips sharp sand…85,000…Chinedu | 7.7s | mapped — scored |
| `test8.m4a` | — | 4 …Dangote Cement…12,500 *(no customer heard)* | 4.3s | held out — no mapping |
| `test9.m4a` | s15 | 5 units waterproff additive…6,500…Musa & Brothers | 6.9s | mapped — scored |

Mappings live in `benchmarks/data/created/mapping.json`; edit it, add
`"confirmed": true`, and re-run `--add-recordings` to ingest a held-out file
once you know its scenario.

Ingest the recordings:

```
uv run python -m benchmarks.run \
  --add-recordings benchmarks/data/created \
  --add-recordings-mapping benchmarks/data/created/mapping.json
```

## Track 3 — code-switched recordings

1. Speakers record with the consent recorder (served by the app at `/recorder.html`,
   or `scripts/recorder/sautice-recorder.html`). Each downloads `sautibench_<ID>.zip`.
2. Unzip each into its own folder under `benchmarks/data/sautibench/recordings/<ID>/`
   (git-ignored: voice is personal data).
3. Generate the reference sheet, then have a speaker of the language type every
   reference by hand, following `data/sautibench/TRANSCRIPTION.md`:
   `uv run python -m benchmarks.run --codeswitch-template benchmarks/data/sautibench/recordings`
4. Ingest (skips and lists any clip without consent, a reference, 16 kHz mono audio,
   or ≤60 s duration):
   `uv run python -m benchmarks.run --add-codeswitch benchmarks/data/sautibench/recordings`
5. Run all providers as usual; Track 3 appears in `report.md`.

### Language hints (verified against each API on 2026-09-15)

| Language | Sahara | Groq Whisper | Gemini | ElevenLabs |
|---|---|---|---|---|
| Pidgin + English | `pcm` | `en` (no Pidgin code) | prompt names the language | none (API rejects `pcm`) |
| Yoruba + English | `yo` | `yo` | prompt | `yo` (accepted, not listed in docs) |
| Igbo + English | `ig` | none (API rejects `ig`) | prompt | `ig` |
| Hausa + English | `ha` | `ha` | prompt | `ha` |

Each provider gets its best documented configuration, so the comparison is not
hint-for-hint identical; the report says so.

## Providers

| Provider | Env keys | Default model | Notes |
|---|---|---|---|
| intron_sahara | `INTRON_API_KEY` | Sahara streaming STT | 0.44 credits per audio-second; motel retry+backoff against server throttle |
| groq_whisper | `GROQ_API_KEY` | `whisper-large-v3-turbo` | OpenAI-compatible endpoint |
| gemini | `GEMINI_API_KEY`, `GEMINI_API_KEY_2` (…also `GENAI_API_KEY`, `GOOGLE_API_KEY`) | `gemini-3.8-flash` | Keys rotate automatically on 429/quota with backoff |
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

Partial runs merge: re-running a single provider under the same tag updates only
that provider's cells; other providers' results are preserved.

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
| `outputs/*/transcripts/<provider>.tsv` | committed | raw per-cell hypotheses (reference + raw text + ins/del/sub + WER/CER) — the transparency artifact every aggregate re-derives from |
| `outputs/*/ref_audit.md`, `ref_audit.tsv` | committed | reference-quality audit + flagged cells (incl. provider API failures) |
| `data/hub_cache/` (2.8 GB parquet) | ignored | regenerable via `load_data`; pull is resumable |
| `data/**/audio/` (16k wavs) | ignored | regenerable, large |
| `data/sautibench/tts/` | ignored | AI-generated, credits to recreate |
| `data/created/test*.m4a` | **committed** | source recordings, published for transparency (owner's own voice) |
| `data/created/*.wav`, `data/audio/16k/recorded_*.wav` | ignored | derived 16k mono, regenerated via `--add-recordings` |
| `outputs/cache/`, `outputs/*/per_cell.jsonl` | ignored | credit cache + transcripts must stay local |

To rebuild everything from a clean clone: set the four provider keys,
`uv run python -m benchmarks.load_data`, then re-run. The only things that
cannot be rebuilt are the user recordings (kept locally) and provider credits.

## Frozen scoring policy

Normalization + the Sautice money parser are locked before any provider score
is produced; changing them after results exist invalidates the comparison.
See `benchmarks/eval/metrics.py` and `benchmarks/eval/money_outcome.py`.