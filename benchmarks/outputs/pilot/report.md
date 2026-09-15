# Sautice STT Benchmark — `pilot`

Generated: 2026-09-15

Two tracks, distinct validity claims:
- **Track 1 — ASR quality (industry-standard metrics).** WER/CER via `jiwer` with frozen whisper-normalizer preprocessing over open, human-transcribed corpora (Nigerian Common Voice subset, NaijaS2ST, Nigerian pidgin), stratified by accent/language. Comparable to OpenASR/MLPerf-style reporting.
- **Track 2 — Sautice product probe (NOT a benchmark).** End-to-end voice→invoice accuracy of the Sautice stack (ASR + Sautice heuristic parser). Scores conflate both systems and are not comparable outside Sautice; reported for downstream-provider decisions only.

## Methodology & transparency (industry-standard)
- **Scoring:** WER = (S + D + I) / N and CER via `jiwer`, computed on **symmetrically normalized** reference + hypothesis (whisper-normalizer: `EnglishTextNormalizer` for english, `BasicTextNormalizer(remove_diacritics)` for the rest). Scheme is frozen in `benchmarks/eval/metrics.py`.
- **Diacritics-preserving companion (`WER diac-p`):** same normalization but keeps tone diacritics (`preserve_marks=True`), so tonal error is scored instead of erased. `tone gap = norm − diac-p` (<0 means the frozen scheme flattered the provider by dropping tone marks). 2026 African-ASR practice (FER/TER, OpenWER); identical to `norm` for english by construction.
- **Macro averages:** unweighted mean over per-language means (WAXAL/SimbaBench convention) so each language counts once; the sample mean is pooled over clips.
- **Auditability:** every raw hypothesis is published in `outputs/pilot/transcripts/<provider>.tsv` (reference, raw hypothesis, normalized WER/CER incl. diac-p, ins/del/sub counts, latency). Any aggregate below re-derives from those rows; each cell asserts WER == (S+D+I)/N at scoring time for both norm and diac-p.
- **Provenance:** corpora pinned by Hugging Face repo + split (see `benchmarks/README.md` → References). Audio pipeline: 16k mono PCM via ffmpeg.
- **Reproducibility:** env pinned via `uv.lock`; `results.json` records git commit, dependency versions, provider model snapshots and the CI method.

## Track 1 — ASR quality (standard)
| provider | n (corpus) | norm WER (95% CI) | median (IQR) | norm CER | WER diac-p | tone gap | NWER (numbers) | macro WER | macro CER | RTFx | latency | cost est. (cr) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| elevenlabs | 60 | 18.5% (±7.6) | 3.9% (0.0–25.0) | 7.8% | 21.9% | -3.4 | 10.5% (n=4) | 25.9% | 10.7% | 1.6x | 2.4s | 84.3 |
| groq_whisper | 55 | 38.2% (±10.9) | 20.0% (0.0–81.7) | 18.8% | 38.7% | -0.5 | 9.0% (n=4) | 68.9% | 32.8% | 1.5x | 2.3s | 77.7 |
| intron_sahara | 60 | 16.4% (±5.5) | 10.6% (0.0–27.6) | 7.2% | 19.1% | -2.6 | 14.7% (n=4) | 22.7% | 8.5% | 0.1x | 21.0s | 84.3 |

### Track 1 — error types (norm scoring, corpus; % of reference words)
| provider | subs | dels | ins | (word match) | n words |
|---|---|---|---|---|---|
| elevenlabs | 14.2% | 3.9% | 1.7% | 82.0% | 466 |
| groq_whisper | 26.6% | 8.0% | 2.2% | 65.4% | 448 |
| intron_sahara | 11.2% | 5.4% | 1.3% | 83.5% | 466 |

### Track 1 — accent / language / source breakdown (norm WER)
**elevenlabs**
- accent: EN 5.6% (n=15) · EY 7.8% (n=15) · nigerian-cv 18.0% (n=20) · pidgin 54.8% (n=10)
- language: english 6.2% (n=35) · hausa 19.7% (n=5) · igbo 23.3% (n=5) · pidgin 54.8% (n=10) · yoruba 25.7% (n=5)
- source: alamin-cv 18.0% (n=20) · naija-s2st 6.7% (n=30) · nigerian-pidgin 54.8% (n=10)

**groq_whisper**
- accent: EN 12.1% (n=15) · EY 9.1% (n=15) · nigerian-cv 66.9% (n=15) · pidgin 77.9% (n=10)
- language: english 11.1% (n=35) · hausa 92.0% (n=5) · pidgin 77.9% (n=10) · yoruba 94.6% (n=5)
- source: alamin-cv 66.9% (n=15) · naija-s2st 10.6% (n=30) · nigerian-pidgin 77.9% (n=10)

**intron_sahara**
- accent: EN 9.1% (n=15) · EY 6.0% (n=15) · nigerian-cv 18.5% (n=20) · pidgin 38.9% (n=10)
- language: english 7.4% (n=35) · hausa 14.7% (n=5) · igbo 31.3% (n=5) · pidgin 38.9% (n=10) · yoruba 21.2% (n=5)
- source: alamin-cv 18.5% (n=20) · naija-s2st 7.6% (n=30) · nigerian-pidgin 38.9% (n=10)

### Track 1 — per-language WER vs CER vs tone loss (macro at bottom)
| provider | language | n | WER | WER diac-p | CER | gap (WER−CER) | tone gap (norm−diac) |
|---|---|---|---|---|---|---|---|
| elevenlabs | english | 35 | 6.2% | 6.2% | 2.0% | +4.2 | +0.0 |
| elevenlabs | hausa | 5 | 19.7% | 19.7% | 5.6% | +14.1 | +0.0 |
| elevenlabs | igbo | 5 | 23.3% | 56.2% | 4.9% | +18.4 | -32.9 |
| elevenlabs | pidgin | 10 | 54.8% | 54.8% | 27.7% | +27.2 | +0.0 |
| elevenlabs | yoruba | 5 | 25.7% | 33.6% | 13.1% | +12.6 | -7.9 |
| elevenlabs | **macro (unwtd over 5 langs)** | — | 25.9% | 34.1% | 10.7% | — | — |
| groq_whisper | english | 35 | 11.1% | 11.1% | 5.5% | +5.7 | +0.0 |
| groq_whisper | hausa | 5 | 92.0% | 92.0% | 37.4% | +54.6 | +0.0 |
| groq_whisper | pidgin | 10 | 77.9% | 77.9% | 43.0% | +34.9 | +0.0 |
| groq_whisper | yoruba | 5 | 94.6% | 100.0% | 45.3% | +49.3 | -5.4 |
| groq_whisper | **macro (unwtd over 4 langs)** | — | 68.9% | 70.2% | 32.8% | — | — |
| intron_sahara | english | 35 | 7.4% | 7.4% | 3.4% | +4.0 | +0.0 |
| intron_sahara | hausa | 5 | 14.7% | 14.7% | 3.7% | +11.0 | +0.0 |
| intron_sahara | igbo | 5 | 31.3% | 54.2% | 6.1% | +25.3 | -22.9 |
| intron_sahara | pidgin | 10 | 38.9% | 38.9% | 23.2% | +15.7 | +0.0 |
| intron_sahara | yoruba | 5 | 21.2% | 29.9% | 6.3% | +15.0 | -8.6 |
| intron_sahara | **macro (unwtd over 5 langs)** | — | 22.7% | 29.0% | 8.5% | — | — |

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
