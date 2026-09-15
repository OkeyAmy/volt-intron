# Sautice STT Benchmark — `pilot`

Generated: 2026-09-15

Two tracks, distinct validity claims:
- **Track 1 — ASR quality (industry-standard metrics).** WER/CER via `jiwer` with frozen whisper-normalizer preprocessing over open, human-transcribed corpora (Nigerian Common Voice subset, NaijaS2ST, Nigerian pidgin), stratified by accent/language. Comparable to OpenASR/MLPerf-style reporting.
- **Track 2 — Sautice product probe (NOT a benchmark).** End-to-end voice→invoice accuracy of the Sautice stack (ASR + Sautice heuristic parser). Scores conflate both systems and are not comparable outside Sautice; reported for downstream-provider decisions only.

## Methodology & transparency (industry-standard)
- **Scoring:** WER = (S + D + I) / N and CER via `jiwer`, computed on **symmetrically normalized** reference + hypothesis (whisper-normalizer: `EnglishTextNormalizer` for english, `BasicTextNormalizer(remove_diacritics)` for the rest). Scheme is frozen in `benchmarks/eval/metrics.py`.
- **Auditability:** every raw hypothesis is published in `outputs/pilot/transcripts/<provider>.tsv` (reference, raw hypothesis, normalized WER/CER, ins/del/sub counts, latency). Any aggregate below re-derives from those rows; each cell asserts WER == (S+D+I)/N at scoring time.
- **Provenance:** corpora pinned by Hugging Face repo + split (see `benchmarks/README.md` → References). Audio pipeline: 16k mono PCM via ffmpeg.
- **Reproducibility:** env pinned via `uv.lock`; `results.json` records git commit, dependency versions, provider model snapshots and the CI method.

## Track 1 — ASR quality (standard)
| provider | n (corpus) | norm WER (95% CI) | median (IQR) | norm CER | NWER (numbers) | basic WER | RTFx (audio/s) | latency | cost est. (cr) |
|---|---|---|---|---|---|---|---|---|---|
| elevenlabs | 60 | 17.0% (±7.3) | 0.0% (0.0–25.0) | 6.7% | 10.5% (n=4) | 17.1% | 1.1x | 3.2s | 84.3 |
| groq_whisper | 55 | 38.2% (±10.9) | 20.0% (0.0–81.7) | 18.8% | 9.0% (n=4) | 38.0% | 1.3x | 2.5s | 77.7 |
| intron_sahara | 60 | 16.4% (±5.5) | 10.6% (0.0–27.6) | 7.2% | 14.7% (n=4) | 17.3% | 0.2x | 19.5s | 84.3 |

### Track 1 — error types (norm scoring, corpus; % of reference words)
| provider | subs | dels | ins | (word match) | n words |
|---|---|---|---|---|---|
| elevenlabs | 12.0% | 3.4% | 1.9% | 82.7% | 475 |
| groq_whisper | 26.0% | 7.9% | 2.2% | 64.0% | 458 |
| intron_sahara | 11.0% | 5.3% | 1.3% | 82.4% | 472 |

### Track 1 — accent / language / source breakdown (norm WER)
**elevenlabs**
- accent: EN 5.6% (n=15) · EY 7.8% (n=15) · nigerian-cv 16.1% (n=20) · pidgin 49.5% (n=10)
- language: english 6.2% (n=35) · hausa 24.7% (n=5) · igbo 23.3% (n=5) · pidgin 49.5% (n=10) · yoruba 13.0% (n=5)
- source: alamin-cv 16.1% (n=20) · naija-s2st 6.7% (n=30) · nigerian-pidgin 49.5% (n=10)

**groq_whisper**
- accent: EN 12.1% (n=15) · EY 9.1% (n=15) · nigerian-cv 66.9% (n=15) · pidgin 77.9% (n=10)
- language: english 11.1% (n=35) · hausa 92.0% (n=5) · pidgin 77.9% (n=10) · yoruba 94.6% (n=5)
- source: alamin-cv 66.9% (n=15) · naija-s2st 10.6% (n=30) · nigerian-pidgin 77.9% (n=10)

**intron_sahara**
- accent: EN 9.1% (n=15) · EY 6.0% (n=15) · nigerian-cv 18.5% (n=20) · pidgin 38.9% (n=10)
- language: english 7.4% (n=35) · hausa 14.7% (n=5) · igbo 31.3% (n=5) · pidgin 38.9% (n=10) · yoruba 21.2% (n=5)
- source: alamin-cv 18.5% (n=20) · naija-s2st 7.6% (n=30) · nigerian-pidgin 38.9% (n=10)

### Track 1 — per-language WER vs CER (where big gap = tonal/phonetic loss misread as lexical error; see Ref. OpenWER / ACL FER)
| provider | language | WER | CER | gap (WER−CER) |
|---|---|---|---|---|
| elevenlabs | english | 6.2% | 2.0% | +4.2 |
| elevenlabs | hausa | 24.7% | 7.5% | +17.2 |
| elevenlabs | igbo | 23.3% | 4.9% | +18.4 |
| elevenlabs | pidgin | 49.5% | 25.4% | +24.1 |
| elevenlabs | yoruba | 13.0% | 2.6% | +10.4 |
| groq_whisper | english | 11.1% | 5.5% | +5.7 |
| groq_whisper | hausa | 92.0% | 37.4% | +54.6 |
| groq_whisper | pidgin | 77.9% | 43.0% | +34.9 |
| groq_whisper | yoruba | 94.6% | 45.3% | +49.3 |
| intron_sahara | english | 7.4% | 3.4% | +4.0 |
| intron_sahara | hausa | 14.7% | 3.7% | +11.0 |
| intron_sahara | igbo | 31.3% | 6.1% | +25.3 |
| intron_sahara | pidgin | 38.9% | 23.2% | +15.7 |
| intron_sahara | yoruba | 21.2% | 6.3% | +15.0 |

Notes on Track 1 metrics: **CER** is the linguistically-valid signal for tone/accent African languages (2026 ACL work shows WER misreads phonetic loss as lexical error — Yoruba e.g. BERT WER 78.8% vs CER 30.5%). **NWER** = WER over only clips whose reference contains a digit — the deployment signal that matters for money amounts (AfriVox-v2). WER reads high for these languages largely due to missing language-specific normalization (OpenWER); read it as an upper bound.

## Track 2 — Sautice product probe (ASR + Sautice parser; separate validity)
| provider | n | exact | off≤10% | catastrophic>10% | blocked | exact rate |
|---|---|---|---|---|---|---|
| elevenlabs recorded briefs | 7 | 3 | 2 | 0 | 2 | 42.9% |
| groq_whisper recorded briefs | 7 | 0 | 0 | 0 | 7 | 0.0% |
| intron_sahara recorded briefs | 7 | 1 | 0 | 0 | 6 | 14.3% |
| elevenlabs synthetic TTS (deprecated) | 1 | 1 | 0 | 0 | 0 | 100.0% |
| groq_whisper synthetic TTS (deprecated) | 1 | 0 | 0 | 0 | 1 | 0.0% |
| intron_sahara synthetic TTS (deprecated) | 1 | 0 | 0 | 0 | 1 | 0.0% |

### Supplementary — recorded briefs WER (paired to canonical scripts)
| provider | n | norm WER |
|---|---|---|
| elevenlabs | 7 | 14.5% |
| groq_whisper | 7 | 29.0% |
| intron_sahara | 7 | 60.6% |

Notes: Track 2 blocked rows are cases the parser could not resolve (ASR hallucination or normalization gap in Sautice customer matching). Recorded rows are live human recordings of the SautiBench money briefs; synthetic rows are Intron-TTS clips retained as an auxiliary signal.
